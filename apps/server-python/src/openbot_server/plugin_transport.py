"""Official MCP SDK with an exact-endpoint, DNS-pinned bounded HTTP adapter."""
import asyncio
from contextlib import asynccontextmanager
from datetime import timedelta
import ipaddress
import logging
import json
import re
import socket
import ssl
from urllib.parse import urlsplit, urlunsplit

import anyio
import httpcore
import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.types import Implementation
from pydantic import AnyUrl

from .plugin_inputs import PluginError, Tool, Resource, Prompt, ResourceResult, PromptResult, bounded, parse, check_schema

# The SDK may log untrusted messages/session IDs. Errors remain static Server DTOs instead.
for _name in ('mcp.client.streamable_http','mcp.client.session','mcp.shared.session'):
    logging.getLogger(_name).setLevel(logging.CRITICAL)


def public_address(value):
    try:
        if '%' in value: return False
        address=ipaddress.ip_address(value)
        if not address.is_global or address.is_multicast or address.is_reserved: return False
        if address.version==6:
            return address in ipaddress.ip_network('2000::/3') and not address.sixtofour and not address.teredo
        return True
    except ValueError:
        return False


def normalize_endpoint(value, local_endpoints=()):
    try:
        if not isinstance(value,str) or len(value)>2048 or value.strip()!=value or re.search(r'[\x00-\x20\x7f\\]',value):
            raise ValueError()
        url=urlsplit(value)
        if url.username is not None or url.password is not None or '?' in value or '#' in value or not url.hostname:
            raise ValueError()
        hostname=url.hostname.encode('idna').decode().lower()
        port=url.port
        host='['+hostname+']' if ':' in hostname else hostname
        if port is not None and port != (443 if url.scheme=='https' else 80):host+=':'+str(port)
        normalized=str(httpx.URL(urlunsplit((url.scheme.lower(),host,url.path or '/', '', ''))))
        local=hostname in ('127.0.0.1','::1') and normalized in local_endpoints
        if local and url.scheme in ('http','https'):return normalized
        if url.scheme!='https':raise ValueError()
        try:
            ipaddress.ip_address(hostname)
            if not public_address(hostname):raise ValueError()
        except ValueError:
            if re.fullmatch(r'[0-9.]+',hostname) or ':' in hostname:raise ValueError()
            if '.' not in hostname or re.search(r'\.(local|localhost|internal|test|invalid|onion)$',hostname,re.I):raise ValueError()
        return normalized
    except (ValueError,UnicodeError,httpx.InvalidURL):
        raise PluginError('invalid') from None


class PinnedBackend(httpcore.AsyncNetworkBackend):
    def __init__(self,host,address):
        self.host,self.address=host,address
        self.backend=httpcore.AnyIOBackend()

    async def connect_tcp(self,host,port,timeout=None,local_address=None,socket_options=None):
        if host!=self.host:raise PluginError('forbidden')
        return await self.backend.connect_tcp(self.address,port,timeout=timeout,
                                              local_address=local_address,socket_options=socket_options)

    async def connect_unix_socket(self,*args,**kwargs):
        raise PluginError('forbidden')

    async def sleep(self,seconds):
        raise PluginError('unavailable')


class PluginHTTPTransport(httpx.AsyncBaseTransport):
    def __init__(self,endpoint,token=None,local_endpoints=(),resolver=None,before_request=None):
        if before_request is not None and not callable(before_request):raise PluginError('forbidden')
        self.endpoint=normalize_endpoint(endpoint,local_endpoints)
        self.token=token
        self.local_endpoints=tuple(local_endpoints)
        self.resolver=resolver
        self.session_id=None
        self.cleanup=False
        self.before_request=before_request

    async def handle_async_request(self,request):
        if str(request.url)!=self.endpoint:raise PluginError('forbidden')
        if request.method=='GET':return httpx.Response(405,content=b'',request=request)
        terminating=request.method=='DELETE'
        body=await request.aread()
        sid=request.headers.get('mcp-session-id')
        if terminating:
            if not self.cleanup or sid!=self.session_id or not sid or not re.fullmatch(r'[\x21-\x7e]{1,512}',sid) or body:
                raise PluginError('forbidden')
        elif request.method!='POST' or len(body)>24*1024:
            raise PluginError('invalid')
        limit=8*1024 if terminating else 256*1024
        try:
            async with asyncio.timeout(5 if terminating else 30):
                host=request.url.host
                try:
                    address=ipaddress.ip_address(host)
                    addresses=[(socket.AF_INET if address.version==4 else socket.AF_INET6,str(address))]
                except ValueError:
                    if self.resolver is not None:addresses=await self.resolver(host)
                    else:
                        values=await asyncio.get_running_loop().getaddrinfo(host,request.url.port or 443,type=socket.SOCK_STREAM)
                        addresses=list(dict.fromkeys((row[0],row[4][0]) for row in values))
                local=host in ('127.0.0.1','::1') and self.endpoint in self.local_endpoints
                if not addresses or len(addresses)>32:raise PluginError('forbidden')
                for family,address in addresses:
                    version=ipaddress.ip_address(address).version
                    if family!=(socket.AF_INET if version==4 else socket.AF_INET6) or (not local and not public_address(address)):
                        raise PluginError('forbidden')
                headers={'Host':request.url.netloc.decode(),'Accept':'application/json, text/event-stream',
                         'Content-Type':'application/json','Accept-Encoding':'identity','Content-Length':str(len(body))}
                for name in ('mcp-session-id','mcp-protocol-version'):
                    value=request.headers.get(name)
                    if value:
                        if not re.fullmatch(r'[\x21-\x7e]{1,512}',value):raise PluginError('invalid')
                        headers[name]=value
                if self.token:headers['Authorization']='Bearer '+self.token
                async with httpcore.AsyncConnectionPool(ssl_context=ssl.create_default_context(),max_connections=1,
                        max_keepalive_connections=0,retries=0,network_backend=PinnedBackend(host,addresses[0][1])) as pool:
                    if self.before_request is not None and not terminating:
                        message=json.loads(body)
                        if message.get('method') in ('tools/call','resources/read'):
                            # This callback is trusted composition, not an MCP parameter. DNS and
                            # request bounds are already checked; no SQL lock spans the response.
                            await self.before_request(message)
                    response=await pool.handle_async_request(httpcore.Request(request.method,self.endpoint,
                            headers=list(headers.items()),content=body,extensions={'timeout':{'connect':5,'read':30,'write':30,'pool':5}}))
                    try:
                        returned=httpx.Headers(response.headers)
                        if 300<=response.status<400 or returned.get('content-encoding','identity')!='identity':raise PluginError('unavailable')
                        if int(returned.get('content-length','0'))>limit:raise PluginError('unavailable')
                        content_type=returned.get('content-type','')
                        if not terminating and response.status not in (202,204) and not re.match(r'^(application/json|text/event-stream)(\s*;|$)',content_type,re.I):
                            raise PluginError('unavailable')
                        chunks=[]; size=0
                        async for chunk in response.aiter_stream():
                            size+=len(chunk)
                            if size>limit:raise PluginError('unavailable')
                            chunks.append(chunk)
                        output_headers={}
                        if content_type:output_headers['content-type']=content_type
                        session=returned.get('mcp-session-id')
                        if session:
                            if not re.fullmatch(r'[\x21-\x7e]{1,512}',session):raise PluginError('unavailable')
                            self.session_id=session
                            output_headers['mcp-session-id']=session
                        return httpx.Response(response.status,headers=output_headers,content=b''.join(chunks),request=request)
                    finally:
                        await response.aclose()
        except PluginError:raise
        except Exception:raise PluginError('unavailable') from None


class BoundedSession(ClientSession):
    async def _validate_tool_result(self,name,result):
        # Pinned SDK extension: never call generic jsonschema.validate with imported refs/dialects.
        if name not in self._tool_output_schemas:raise PluginError('conflict')
        schema=self._tool_output_schemas[name]
        if schema is not None:
            validator=check_schema(schema)
            bounded(result.structuredContent,12*1024)
            if result.structuredContent is None or not validator.is_valid(result.structuredContent):
                raise PluginError('invalid')


class MCPConnection:
    def __init__(self,session):self.session=session

    async def tools(self):
        if self.session.get_server_capabilities().tools is None:return []
        response=await self.session.list_tools()
        if response.nextCursor or len(response.tools)>32:raise PluginError('invalid')
        result=[]
        for tool in response.tools:
            value={'name':tool.name,'description':tool.description or '', 'inputSchema':tool.inputSchema}
            if tool.annotations is not None:value['annotations']=tool.annotations.model_dump(mode="json",exclude_none=True,by_alias=True)
            meta=tool.meta or {}
            if isinstance(meta.get('ui'),dict) and 'resourceUri' in meta['ui']:value['resourceUri']=meta['ui']['resourceUri']
            checked=parse(Tool,value)
            check_schema(checked['inputSchema'])
            if tool.outputSchema is not None:check_schema(tool.outputSchema)
            result.append(checked)
        return result

    async def resources(self):
        if self.session.get_server_capabilities().resources is None:return []
        response=await self.session.list_resources()
        if response.nextCursor or len(response.resources)>32:raise PluginError('invalid')
        return [parse(Resource,{'uri':str(item.uri),'name':item.name,'description':item.description or '',
                                **({'mimeType':item.mimeType} if item.mimeType else {})}) for item in response.resources]

    async def prompts(self):
        if self.session.get_server_capabilities().prompts is None:return []
        response=await self.session.list_prompts()
        if response.nextCursor or len(response.prompts)>32:raise PluginError('invalid')
        return [parse(Prompt,{'name':item.name,'description':item.description or '',
                    'arguments':[arg.model_dump(mode="json",exclude_none=True,by_alias=True) for arg in item.arguments or []]}) for item in response.prompts]

    async def read_resource(self,uri):
        response=await self.session.read_resource(AnyUrl(uri))
        return parse(ResourceResult,response.model_dump(mode="json",exclude_none=True,by_alias=True),160*1024)

    async def get_prompt(self,name,arguments):
        response=await self.session.get_prompt(name,arguments)
        return parse(PromptResult,response.model_dump(mode="json",exclude_none=True,by_alias=True),12*1024)

    async def call(self,name,arguments):
        response=await self.session.call_tool(name,arguments,read_timeout_seconds=timedelta(seconds=30))
        if response.isError or any(item.type!='text' for item in response.content):raise PluginError('unavailable')
        result={'content':[{'type':'text','text':item.text} for item in response.content]}
        if response.structuredContent is not None:result['structuredContent']=response.structuredContent
        bounded(result,12*1024)
        return result

    async def call_observed(self,name,arguments):
        """Retain an MCP error response as data for durable observation, never as success proof."""
        response=await self.session.call_tool(name,arguments,read_timeout_seconds=timedelta(seconds=30))
        if any(item.type!='text' for item in response.content):raise PluginError('unavailable')
        result={'content':[{'type':'text','text':item.text} for item in response.content], 'isError':response.isError}
        if response.structuredContent is not None:result['structuredContent']=response.structuredContent
        bounded(result,12*1024)
        return result


class MCPConnector:
    def __init__(self,local_endpoints=()):self.local_endpoints=tuple(local_endpoints)

    @asynccontextmanager
    async def __call__(self,endpoint,token=None,*,before_request=None):
        transport=PluginHTTPTransport(endpoint,token,self.local_endpoints,before_request=before_request)
        async with httpx.AsyncClient(transport=transport,follow_redirects=False,trust_env=False,timeout=30) as http:
            try:
                async with streamable_http_client(endpoint,http_client=http,terminate_on_close=False) as streams:
                    try:
                        async with BoundedSession(streams[0],streams[1],read_timeout_seconds=timedelta(seconds=30),
                                client_info=Implementation(name='openbot',version='0.1.0')) as session:
                            await session.initialize()
                            yield MCPConnection(session)
                    finally:
                        # Cleanup stays in the task owning SDK/AnyIO scopes and may outlive cancellation.
                        with anyio.CancelScope(shield=True):
                            if transport.session_id:
                                transport.cleanup=True
                                try:
                                    async with asyncio.timeout(5):
                                        await http.delete(endpoint,headers={'mcp-session-id':transport.session_id})
                                except BaseException:pass
                                finally:transport.cleanup=False
            except (PluginError, asyncio.CancelledError):raise
            except BaseExceptionGroup as group:
                def find(error):
                    if isinstance(error,PluginError):return error
                    if isinstance(error,BaseExceptionGroup):
                        for child in error.exceptions:
                            result=find(child)
                            if result:return result
                    return None
                raise find(group) or PluginError('unavailable') from None
            except Exception:raise PluginError('unavailable') from None
