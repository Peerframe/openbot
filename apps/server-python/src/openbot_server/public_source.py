"""Bounded public HTTPS evidence. No ambient credentials, cookies, proxies or retry policy."""
import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
import ipaddress
import json
from pathlib import Path
import re
import socket
import ssl
import sys
from urllib.parse import urlsplit, urlunsplit

import httpcore
import httpx

from .plugin_transport import PinnedBackend, public_address
from .work_model_activity import configuration_record

MAX_PAGE_BYTES = 512 * 1024
MAX_TEXT_BYTES = 6000
MAX_SEARCH_BYTES = 256 * 1024
_TAVILY = 'https://api.tavily.com/search'
_KIMI_BASES = ('https://api.moonshot.cn/v1', 'https://api.moonshot.ai/v1')


class PublicWebError(Exception):
    def __init__(self, code='tool_unavailable'):
        if code not in ('tool_unavailable','tool_denied','task_limit','invalid_input'):
            code='tool_unavailable'
        self.code=code
        super().__init__(code)


def _json(value):
    return json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False)


def _units(value):
    return len(value.encode('utf-16-le')) // 2


def _clip(value, size):
    return value.encode('utf-8')[:size].decode('utf-8',errors='ignore')


def _now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')


def normalize_source_url(value):
    """Reject ambiguous legacy host syntax instead of allowing URL/DNS parser disagreement."""
    try:
        if type(value) is not str or _units(value)>2048 or re.search(r'[\x00-\x20\x7f\\]',value):
            raise ValueError()
        raw=urlsplit(value)
        if raw.scheme!='https' or not raw.hostname or raw.username is not None or raw.password is not None or raw.port not in (None,443):
            raise ValueError()
        url=httpx.URL(urlunsplit((raw.scheme,raw.netloc,raw.path or '/',raw.query,'')))
        host=url.host
        # HTTPX/stdlib do not implement WHATWG's octal/short/decimal IPv4 forms. Refuse them.
        try:
            address=ipaddress.ip_address(host)
            if not public_address(str(address)):raise PublicWebError('tool_denied')
        except ValueError:
            if ('.' not in host or ':' in host or '%' in host or host.endswith('.')
                    or re.fullmatch(r'[0-9.]+',host) or re.search(r'(^|\.)(0x[0-9a-f]+|[0-9]+)$',host,re.I)
                    or re.search(r'(^|\.)(localhost|local|internal|test|invalid|onion)$',host,re.I)):
                raise ValueError()
            if not re.fullmatch(r'[a-z0-9.-]+',host,re.I) or any(not x or len(x)>63 or x[0]=='-' or x[-1]=='-' for x in host.split('.')):
                raise ValueError()
        return str(url.copy_with(port=None))
    except PublicWebError:raise
    except (ValueError,UnicodeError,httpx.InvalidURL):
        raise PublicWebError('invalid_input') from None


def task_source_urls(instruction):
    values=[]
    for found in re.findall(r'https://[^\s<>"\'`，。；！？（）]+',instruction,re.I):
        try:value=normalize_source_url(re.sub(r'[),.;!?，。；！？）]+$','',found))
        except PublicWebError:continue
        if value not in values:values.append(value)
        if len(values)==3:break
    return values


def query_input(arguments):
    try:
        if type(arguments) is not dict or set(arguments)!={'query'} or type(arguments['query']) is not str:raise ValueError()
        value=arguments['query'].strip()
        if not 1<=_units(value)<=1000:raise ValueError()
        return value
    except (ValueError,UnicodeError):raise PublicWebError('invalid_input') from None


@dataclass(frozen=True)
class SearchConfiguration:
    """Trusted Owner-config projection. revision must change for every credential/config change.

    For Kimi, model is the *current selected* ProductWorkModel configuration_record, including
    model/revision/connection. The callback must verify current Owner enablement and permissions.
    Neither this data carrier nor a model-supplied object grants dispatch authority.
    """
    provider: str
    revision: str
    api_key: str = field(repr=False)
    model: dict | None = None

    def snapshot(self):
        if (type(self.revision) is not str or not 1<=len(self.revision)<=128 or type(self.api_key) is not str
                or not re.fullmatch(r'[\x21-\x7e]{1,2048}',self.api_key)):
            raise PublicWebError('tool_denied')
        if self.provider=='tavily' and self.model is None:
            return dict(provider='tavily',revision=self.revision)
        if self.provider=='kimi':
            try:model=configuration_record(self.model)
            except Exception:raise PublicWebError('tool_denied') from None
            if (model['provider'] not in ('moonshot','kimi') or model['baseUrl'] not in _KIMI_BASES
                    or model['protocol']!='chat-completions-v1'):
                raise PublicWebError('tool_denied')
            return dict(provider='kimi',revision=self.revision,model=model)
        raise PublicWebError('tool_denied')

    @property
    def endpoint(self):
        snapshot=self.snapshot()
        return _TAVILY if self.provider=='tavily' else snapshot['model']['baseUrl']+'/formulas/moonshot/web-search:latest/fibers'


def select_search_configuration(*, tavily=None, selected_model=None):
    """Tavily takes precedence; no fallback after a configured selection fails validation."""
    if tavily is not None:
        if type(tavily) is not SearchConfiguration or tavily.provider!='tavily':raise PublicWebError('tool_denied')
        tavily.snapshot();return tavily
    if selected_model is not None:
        if type(selected_model) is not SearchConfiguration or selected_model.provider!='kimi':raise PublicWebError('tool_denied')
        selected_model.snapshot();return selected_model
    return None


# A fixed isolated Python program: HTML is stdin data, never executable code. The private
# tree-builder hook is pinned to Beautiful Soup 4.15.0 and covered by adversarial bounds tests.
_CONVERT = r'''
import sys,json,warnings
for path in json.loads(sys.argv[1]):sys.path.insert(0,path)
import bs4
if bs4.__version__!='4.15.0':sys.exit(2)
warnings.simplefilter('ignore')
class BoundedSoup(bs4.BeautifulSoup):
    def handle_starttag(self,*args,**kwargs):
        self.endData()
        if len(self.tagStack)>40 or len(self.currentTag.contents)>=1000:raise ValueError()
        self._openbot_nodes+=1
        if self._openbot_nodes>50000:raise ValueError()
        return super().handle_starttag(*args,**kwargs)
    def __init__(self,markup):
        self._openbot_nodes=0
        super().__init__(markup,'html.parser')
try:
    raw=sys.stdin.buffer.read(524289)
    if len(raw)>524288:sys.exit(2)
    soup=BoundedSoup(raw.decode('utf-8',errors='strict'))
    stack=[soup];nodes=0
    while stack:
        node=stack.pop();nodes+=1
        if nodes>50000:raise ValueError()
        if isinstance(node,bs4.Tag):
            if len(node.contents)>1000:raise ValueError()
            stack.extend(node.contents)
    for tag in soup.find_all(['script','style','iframe','noscript','img','template']):tag.decompose()
    output=soup.get_text('\n',strip=True)
    sys.stdout.buffer.write(output.encode('utf-8'))
except Exception:sys.exit(2)
'''


class PythonHTMLText:
    """Isolated bounded BS4 converter. Extra paths are only for synthetic release-source tests."""
    def __init__(self, *, _dependency_paths=()):
        self._paths=[str(Path(path).resolve(strict=True)) for path in _dependency_paths]

    async def __call__(self, body):
        if type(body) is not bytes or len(body)>MAX_PAGE_BYTES:raise PublicWebError('task_limit')
        process=None
        try:
            async with asyncio.timeout(3):
                process=await asyncio.create_subprocess_exec(sys.executable,'-I','-c',_CONVERT,_json(self._paths),
                    stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,env={},cwd='/')
                async def write():
                    process.stdin.write(body);await process.stdin.drain();process.stdin.close()
                async def read():
                    chunks=[];size=0
                    while chunk:=await process.stdout.read(16384):
                        size+=len(chunk)
                        if size>4*1024*1024:raise PublicWebError('task_limit')
                        chunks.append(chunk)
                    return b''.join(chunks)
                _,output=await asyncio.gather(write(),read())
                if await process.wait()!=0:raise PublicWebError()
                return output.decode('utf-8',errors='strict')
        except PublicWebError:raise
        except Exception:raise PublicWebError() from None
        finally:
            if process is not None and process.returncode is None:
                process.kill();await process.wait()


class PublicWebClient:
    """Pinned one-shot HTTP. Underscored injections are trusted synthetic test seams only.

    The resolver must still return exclusively public addresses. A test network backend may map
    that numeric destination to its owned loopback server; there is no private-network flag.
    """
    def __init__(self, converter=None, *, _resolver=None, _backend_factory=None):
        self.converter=converter or PythonHTMLText()
        self._resolver,self._backend_factory=_resolver,_backend_factory or PinnedBackend

    async def _addresses(self,host):
        try:
            address=ipaddress.ip_address(host)
            values=[(socket.AF_INET if address.version==4 else socket.AF_INET6,str(address))]
        except ValueError:
            if self._resolver is not None:values=await self._resolver(host)
            else:
                rows=await asyncio.get_running_loop().getaddrinfo(host,443,type=socket.SOCK_STREAM)
                values=list(dict.fromkeys((row[0],row[4][0]) for row in rows))
        if type(values) is not list or not 1<=len(values)<=32:raise PublicWebError('tool_denied')
        for family,address in values:
            try:version=ipaddress.ip_address(address).version
            except ValueError:raise PublicWebError('tool_denied') from None
            if family!=(socket.AF_INET if version==4 else socket.AF_INET6) or not public_address(address):
                raise PublicWebError('tool_denied')
        return values

    async def _request(self,url,*,body=None,key=None,before_send):
        url=normalize_source_url(url)
        parsed=httpx.URL(url);addresses=await self._addresses(parsed.host)
        headers={'Host':parsed.netloc.decode(),'Accept-Encoding':'identity'}
        search=body is not None
        if search:
            if url not in (_TAVILY, *[base+'/formulas/moonshot/web-search:latest/fibers' for base in _KIMI_BASES]):
                raise PublicWebError('tool_denied')
            headers.update({'Accept':'application/json','Content-Type':'application/json',
                            'Content-Length':str(len(body)),'Authorization':'Bearer '+key})
        else:
            if key is not None:raise PublicWebError('tool_denied')
            headers.update({'Accept':'text/html, text/plain;q=0.9','User-Agent':'OpenBot-SourceReader/1.0'})
        limit=MAX_SEARCH_BYTES if search else MAX_PAGE_BYTES
        async with httpcore.AsyncConnectionPool(ssl_context=ssl.create_default_context(),max_connections=1,
                max_keepalive_connections=0,retries=0,network_backend=self._backend_factory(parsed.host,addresses[0][1])) as pool:
            # Current authority is committed after DNS and immediately before one HTTP send.
            await before_send()
            response=await pool.handle_async_request(httpcore.Request('POST' if search else 'GET',url,
                headers=list(headers.items()),content=body or b'',extensions={'timeout':{'connect':5,'read':20 if search else 15,'write':5,'pool':5}}))
            try:
                returned=httpx.Headers(response.headers)
                kind=returned.get('content-type','')
                pattern=r'^application/json(\s*;|$)' if search else r'^text/(html|plain)(\s*;|$)'
                if ((not 200<=response.status<300 if search else response.status!=200)
                        or returned.get('content-encoding','identity').lower()!='identity' or not re.match(pattern,kind,re.I)):
                    raise PublicWebError()
                length=returned.get('content-length')
                if length is not None and (not re.fullmatch(r'[0-9]+',length) or int(length)>limit):raise PublicWebError('task_limit')
                chunks=[];size=0
                async for chunk in response.aiter_stream():
                    size+=len(chunk)
                    if size>limit:raise PublicWebError('task_limit')
                    chunks.append(chunk)
                return kind,b''.join(chunks)
            finally:await response.aclose()

    async def read(self,url,*,before_send):
        normalized=normalize_source_url(url)
        try:
            async with asyncio.timeout(15):
                kind,body=await self._request(normalized,before_send=before_send)
                raw=body.decode('utf-8',errors='strict')
                if kind.lower().startswith('text/html'):
                    if self.converter is None:raise PublicWebError()
                    raw=await self.converter(body)
                raw=re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]','',raw).strip()
                if not raw:raise PublicWebError()
                return dict(url=normalized,text=_clip(raw,MAX_TEXT_BYTES),truncated=len(raw.encode())>MAX_TEXT_BYTES,fetchedAt=_now())
        except PublicWebError:raise
        except Exception:raise PublicWebError() from None

    async def search(self,arguments,configuration,*,before_send):
        query=query_input(arguments)
        if type(configuration) is not SearchConfiguration:raise PublicWebError('tool_denied')
        endpoint=configuration.endpoint
        request=(dict(query=query,max_results=5,search_depth='basic',include_answer=False,include_raw_content=False)
            if configuration.provider=='tavily' else dict(name='web_search',arguments=_json(dict(query=query))))
        try:
            async with asyncio.timeout(20):
                _,body=await self._request(endpoint,body=_json(request).encode(),key=configuration.api_key,before_send=before_send)
                response=json.loads(body.decode('utf-8',errors='strict'))
                if configuration.provider=='tavily':return _tavily(response)
                if type(response) is not dict or response.get('status')!='succeeded' or type(response.get('context')) is not dict:raise ValueError()
                context=response['context']
                if any(key in context and type(context[key]) is not str for key in ('output','encrypted_output')):raise ValueError()
                output=context.get('output') or context.get('encrypted_output')
                if type(output) is not str or not output.strip():raise ValueError()
                if _units(output)>100000 or len(_json(output).encode())>128*1024:raise PublicWebError('task_limit')
                return output
        except PublicWebError:raise
        except Exception:raise PublicWebError() from None


def _tavily(response):
    rows=response.get('results') if type(response) is dict else None
    if type(rows) is not list or not 1<=len(rows)<=20:raise PublicWebError()
    results=[]
    for row in rows:
        if (type(row) is not dict or any(type(row.get(k)) is not str for k in ('url','title','content'))
                or not row['content'] or _units(row['url'])>2048
                or ('published_date' in row and type(row['published_date']) is not str)):
            raise PublicWebError()
        # Search citations are untrusted data, not fetch authority. Retain original URLs, but
        # require a URL with a scheme like the source schema; fetching applies stricter rules.
        parsed=urlsplit(row['url'])
        if not parsed.scheme or (parsed.scheme in ('http','https','ftp') and not parsed.hostname):raise PublicWebError()
    for row in rows[:5]:
        item=dict(url=row['url'],title=_clip(row['title'],256),content=_clip(row['content'],2000),
            truncated=len(row['title'].encode())>256 or len(row['content'].encode())>2000)
        if row.get('published_date'):item['publishedAt']=_clip(row['published_date'],100)
        results.append(item)
    evidence=dict(provider='tavily',retrievedAt=_now(),truncated=len(rows)>5,results=results)
    output=_json(evidence)
    while len(output.encode())>16*1024:
        item=max(results,key=lambda x:len(x['content'].encode()))
        size=len(item['content'].encode())
        if size<2:raise PublicWebError('task_limit')
        item['content']=_clip(item['content'],size//2);item['truncated']=True
        output=_json(evidence)
    return output
