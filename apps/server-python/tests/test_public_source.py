"""Synthetic public DNS + owned loopback socket; production never accepts private endpoints."""
import asyncio
import json
from pathlib import Path
import socket
import ssl
from unittest.mock import AsyncMock, patch

import httpcore
import pytest

from openbot_server.public_source import (PublicWebClient,PublicWebError,PythonHTMLText,SearchConfiguration,
    normalize_source_url,task_source_urls,select_search_configuration)
from openbot_server.plugin_transport import public_address


@pytest.fixture
def anyio_backend():return 'asyncio'


@pytest.fixture
def converter():
    return PythonHTMLText()


@pytest.fixture
async def web_remote(converter):
    state=dict(requests=[],status=200,headers={'content-type':'text/plain'},body=b'Synthetic public evidence',resolves=[],tls=[])
    connections=set()
    async def handle(reader,writer):
        task=asyncio.current_task();connections.add(task)
        try:
            raw=await reader.readuntil(b'\r\n\r\n')
            lines=raw.decode().split('\r\n');headers=dict(line.split(': ',1) for line in lines[1:] if ': ' in line)
            content=await reader.readexactly(int(headers.get('Content-Length','0')))
            state['requests'].append(dict(line=lines[0],headers=headers,body=content))
            callback=state.get('on_request')
            if callback:await callback()
            if state.get('lose'):return
            body=state['body'];returned={**state['headers'],'content-length':str(len(body)),'connection':'close'}
            writer.write(('HTTP/1.1 '+str(state['status'])+' Fixture\r\n'+''.join(k+': '+v+'\r\n' for k,v in returned.items())+'\r\n').encode()+body)
            await writer.drain()
        finally:
            writer.close();await writer.wait_closed();connections.discard(task)
    server=await asyncio.start_server(handle,'127.0.0.1',0)
    port=server.sockets[0].getsockname()[1]
    class TestStream(httpcore.AsyncNetworkStream):
        def __init__(self,stream):self.stream=stream
        async def read(self,max_bytes,timeout=None):return await self.stream.read(max_bytes,timeout)
        async def write(self,buffer,timeout=None):return await self.stream.write(buffer,timeout)
        async def aclose(self):return await self.stream.aclose()
        def get_extra_info(self,info):return self.stream.get_extra_info(info)
        async def start_tls(self,ssl_context,server_hostname=None,timeout=None):
            assert ssl_context.check_hostname and ssl_context.verify_mode==ssl.CERT_REQUIRED
            state['tls'].append(server_hostname)
            return self  # Test-only mapping: owned plain HTTP socket behind a public HTTPS identity.
    class TestBackend(httpcore.AsyncNetworkBackend):
        def __init__(self,host,address):self.host,self.address=host,address
        async def connect_tcp(self,host,port,timeout=None,**kwargs):
            assert host==self.host and port==443 and public_address(self.address)
            stream=await httpcore.AnyIOBackend().connect_tcp('127.0.0.1',state['port'],timeout=timeout)
            return TestStream(stream)
        async def connect_unix_socket(self,*args,**kwargs):pytest.fail('No Unix sockets')
        async def sleep(self,*args):pytest.fail('No retry')
    async def resolve(host):
        state['resolves'].append(host)
        if state.get('on_resolve'):await state['on_resolve']()
        return state.get('addresses',[(socket.AF_INET,'93.184.216.34')])
    state['port']=port;state['client']=PublicWebClient(converter,_resolver=resolve,_backend_factory=TestBackend)
    yield state
    server.close();await server.wait_closed()
    for task in connections:task.cancel()
    if connections:await asyncio.gather(*connections,return_exceptions=True)


def kimi(base='https://api.moonshot.cn/v1',model='kimi-k3',revision='r1'):
    return SearchConfiguration('kimi',revision,'synthetic-kimi-secret',dict(source='singleton',revision=revision,
        provider='moonshot',model=model,baseUrl=base,protocol='chat-completions-v1'))


@pytest.mark.parametrize('url',['http://example.com','https://user:pass@example.com','https://example.com:8443',
    'https://localhost','https://a.internal','https://a.test','https://example.com/\npath','https://a\\b.com',
    'https://127.0.0.1','https://2130706433','https://127.1','https://0177.0.0.1','https://0x7f000001',
    'https://[::ffff:127.0.0.1]','https://[2002:7f00:1::]','https://example.com.'])
def test_rejects_ambiguous_private_or_alternate_authority(url):
    with pytest.raises(PublicWebError):normalize_source_url(url)


def test_source_urls_and_canonicalization():
    assert normalize_source_url('https://EXAMPLE.com:443/a#b')=='https://example.com/a'
    assert task_source_urls('看 https://example.com， https://example.org。 https://example.com/#a https://example.net/c https://other.org')==[
        'https://example.com/','https://example.org/','https://example.net/c']


@pytest.mark.anyio
async def test_real_socket_pins_dns_and_omits_authority_headers(web_remote,monkeypatch):
    monkeypatch.setenv('HTTPS_PROXY','http://127.0.0.1:1');monkeypatch.setenv('TAVILY_API_KEY','ambient-secret')
    gate=AsyncMock()
    result=await web_remote['client'].read('https://example.com/evidence#ignored',before_send=gate)
    assert result['url']=='https://example.com/evidence' and result['text']=='Synthetic public evidence'
    assert not result['truncated'] and result['fetchedAt'].endswith('Z')
    assert web_remote['resolves']==['example.com'] and web_remote['tls']==['example.com']
    headers={k.lower():v for k,v in web_remote['requests'][0]['headers'].items()}
    assert headers['host']=='example.com' and 'authorization' not in headers and 'cookie' not in headers
    gate.assert_awaited_once()


@pytest.mark.anyio
@pytest.mark.parametrize('addresses',[[],[(socket.AF_INET,'93.184.216.34'),(socket.AF_INET,'127.0.0.1')],
    [(socket.AF_INET6,'93.184.216.34')],[(socket.AF_INET,'198.18.0.1')],[(socket.AF_INET,'93.184.216.34')]*33])
async def test_bad_dns_never_connects(web_remote,addresses):
    web_remote['addresses']=addresses;gate=AsyncMock()
    with pytest.raises(PublicWebError):await web_remote['client'].read('https://example.com',before_send=gate)
    assert not web_remote['requests'];gate.assert_not_awaited()


@pytest.mark.anyio
@pytest.mark.parametrize('change',[{'status':302,'headers':{'location':'https://other.org','content-type':'text/plain'}},
    {'headers':{'content-type':'application/pdf'}},{'headers':{'content-type':'text/plain','content-encoding':'gzip'}},
    {'body':b'\xff'},{'body':b'x'*(512*1024+1)},{'body':b' \x00 '}],ids=['redirect','binary','compression','utf8','body-limit','empty'])
async def test_response_denials_one_send(web_remote,change):
    web_remote.update(change)
    with pytest.raises(PublicWebError):await web_remote['client'].read('https://example.com',before_send=AsyncMock())
    assert len(web_remote['requests'])==1


@pytest.mark.anyio
async def test_python_html_semantics_and_utf8_bound(web_remote):
    web_remote['headers']={'content-type':'text/html; charset=utf-8'}
    web_remote['body']=b'<h1>Title</h1><p>A &amp; <a href="http://127.0.0.1/secret">visible link</a></p><table><tr><th>Item</th><th>Value</th></tr><tr><td>One</td><td>Two</td></tr></table><script>SECRET</script><style>SECRET</style><iframe>SECRET</iframe><noscript>SECRET</noscript><img alt="SECRET" src="https://evil.org"><template>SECRET</template>'
    result=await web_remote['client'].read('https://example.com',before_send=AsyncMock())
    assert all(word in result['text'] for word in ('Title','A &','visible link','Item','Value','One','Two'))
    assert not any(word in result['text'] for word in ('SECRET','127.0.0.1','href','evil.org'))
    assert len(web_remote['requests'])==1
    web_remote['body']=('<p>'+'中'*5000+'</p>').encode()
    result=await web_remote['client'].read('https://example.com',before_send=AsyncMock())
    assert result['truncated'] and len(result['text'].encode())==6000 and '�' not in result['text']


@pytest.mark.anyio
@pytest.mark.parametrize('html',['<div>'*42+'x'+'</div>'*42,'<div>'+'<br>'*1001+'</div>'])
async def test_parser_tree_limits_fail_closed(converter,html):
    with pytest.raises(PublicWebError):await converter(html.encode())


@pytest.mark.anyio
async def test_cancellation_during_dns_never_dispatches(web_remote):
    started=asyncio.Event()
    async def hang():started.set();await asyncio.Event().wait()
    web_remote['on_resolve']=hang
    task=asyncio.create_task(web_remote['client'].read('https://example.com',before_send=AsyncMock()))
    await started.wait();task.cancel()
    with pytest.raises(asyncio.CancelledError):await task
    assert not web_remote['requests']


@pytest.mark.anyio
@pytest.mark.parametrize('base',['https://api.moonshot.cn/v1','https://api.moonshot.ai/v1'])
async def test_kimi_exact_endpoint_and_opaque_result(web_remote,base):
    output='----MOONSHOT ENCRYPTED BEGIN----opaque\nvalue'
    web_remote.update(headers={'content-type':'application/json'},body=json.dumps(dict(status='succeeded',context=dict(encrypted_output=output))).encode())
    result=await web_remote['client'].search({'query':' public research '},kimi(base),before_send=AsyncMock())
    assert result==output
    request=web_remote['requests'][0]
    assert request['line']=='POST /v1/formulas/moonshot/web-search:latest/fibers HTTP/1.1'
    assert json.loads(request['body'])==dict(name='web_search',arguments='{"query":"public research"}')
    assert request['headers']['Authorization']=='Bearer synthetic-kimi-secret'


@pytest.mark.anyio
async def test_tavily_precedence_and_bounded_evidence(web_remote):
    rows=[dict(url='https://example.com/'+str(i)+'/'+'a'*1900,title='标题'*100,content='内容\x00'*3000,published_date='2026-09-25') for i in range(6)]
    web_remote.update(headers={'content-type':'application/json'},body=json.dumps({'results':rows},ensure_ascii=False).encode())
    # Keep the response under the source's 256-KiB byte limit.
    assert len(web_remote['body'])<=256*1024
    selected=select_search_configuration(tavily=SearchConfiguration('tavily','r1','synthetic-tavily-secret'),selected_model=kimi())
    result=await web_remote['client'].search({'query':' public '},selected,before_send=AsyncMock())
    parsed=json.loads(result)
    assert len(result.encode())<=16*1024 and parsed['truncated'] and len(parsed['results'])==5
    assert [x['url'] for x in parsed['results']]==[x['url'] for x in rows[:5]]
    assert all(x['truncated'] and '�' not in x['content'] for x in parsed['results'])
    req=web_remote['requests'][0]
    assert req['headers']['Host']=='api.tavily.com' and req['headers']['Authorization']=='Bearer synthetic-tavily-secret'
    assert json.loads(req['body'])==dict(query='public',max_results=5,search_depth='basic',include_answer=False,include_raw_content=False)


@pytest.mark.parametrize('base',['http://api.moonshot.cn/v1','https://api.moonshot.cn.evil.org/v1','https://api.moonshot.cn/v1/other'])
def test_no_custom_formula_endpoint(base):
    with pytest.raises(PublicWebError):kimi(base).snapshot()


@pytest.mark.anyio
@pytest.mark.parametrize('output',['x'*100001,'汉'*50000,'\x00'*30000],ids=['char-limit','utf8-limit','json-limit'])
async def test_never_truncates_kimi_ciphertext(web_remote,output):
    web_remote.update(headers={'content-type':'application/json'},body=json.dumps(dict(status='succeeded',context=dict(output=output)),ensure_ascii=False).encode())
    with pytest.raises(PublicWebError):await web_remote['client'].search({'query':'public'},kimi(),before_send=AsyncMock())
    assert len(web_remote['requests'])==1


@pytest.mark.anyio
async def test_accepts_complete_kimi_maximum(web_remote):
    output='x'*100000
    web_remote.update(headers={'content-type':'application/json'},body=json.dumps(dict(status='succeeded',context=dict(output=output))).encode())
    assert await web_remote['client'].search({'query':'public'},kimi(),before_send=AsyncMock())==output


@pytest.mark.anyio
async def test_python_converter_kills_and_reaps_on_cancellation(converter):
    import openbot_server.public_source as source
    with patch.object(source,'_CONVERT','import time; time.sleep(60)'):
        task=asyncio.create_task(converter(b'<p>synthetic</p>'))
        await asyncio.sleep(0.1);task.cancel()
        with pytest.raises(asyncio.CancelledError):await task


@pytest.mark.anyio
@pytest.mark.parametrize('response',[{}, {'status':'failed','context':{'output':'private upstream'}},
    {'status':'succeeded','context':{'output':'  '}},{'status':'succeeded','context':{'output':1}},
    {'status':'succeeded','context':{'output':'valid','encrypted_output':1}}])
async def test_formula_malformed_no_fallback(web_remote,response):
    web_remote.update(headers={'content-type':'application/json'},body=json.dumps(response).encode())
    with pytest.raises(PublicWebError,match='^tool_unavailable$'):
        await web_remote['client'].search({'query':'public'},kimi(),before_send=AsyncMock())
    assert len(web_remote['requests'])==1


@pytest.mark.anyio
@pytest.mark.parametrize('arguments',[{}, {'query':' '},{'query':'x'*1001},{'query':'valid','skipApproval':True}],ids=['missing','empty','length','extra'])
async def test_search_input_never_grants_configuration(web_remote,arguments):
    with pytest.raises(PublicWebError):await web_remote['client'].search(arguments,kimi(),before_send=AsyncMock())
    assert not web_remote['requests']


@pytest.mark.anyio
async def test_converter_ignores_external_doctype_and_processing_instructions(converter):
    result=await converter(b'<!DOCTYPE html SYSTEM "file:///etc/passwd"><?xml-stylesheet href="http://127.0.0.1/private"?><p>Safe &amp; visible</p>')
    assert result=='Safe & visible'
