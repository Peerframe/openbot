"""Transport boundary regressions with real disposable loopback HTTP listeners."""
import asyncio
from contextlib import asynccontextmanager
import socket

import httpx
import pytest

from openbot_server.plugin_inputs import PluginError
from openbot_server.plugin_transport import PluginHTTPTransport


@pytest.fixture
def anyio_backend():return 'asyncio'


@asynccontextmanager
async def endpoint(status=200,headers=None,body=b'{}'):
    observed=[]
    async def handle(reader,writer):
        try:
            request=await reader.readuntil(b'\r\n\r\n')
            observed.append(request)
            supplied={'Content-Type':'application/json','Content-Length':str(len(body)),**(headers or {})}
            writer.write(f'HTTP/1.1 {status} response\r\n'.encode()+b''.join(f'{k}: {v}\r\n'.encode() for k,v in supplied.items())+b'\r\n'+body)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()
    server=await asyncio.start_server(handle,'127.0.0.1',0)
    address=f'http://127.0.0.1:{server.sockets[0].getsockname()[1]}/mcp'
    try:yield address,observed
    finally:server.close();await server.wait_closed()


@pytest.mark.anyio
@pytest.mark.parametrize('status,headers,body',[
    (302,{'Location':'https://example.com/stolen'},b''),
    (200,{'Content-Encoding':'gzip'},b'{}'),
    (200,{'Content-Length':str(300*1024)},b'{}'),
    (200,{'Content-Type':'text/html'},b'{}'),
    (200,{'mcp-session-id':'bad session'},b'{}'),
    (200,{},b'x'*(256*1024+1)),
])
async def test_rejects_redirect_encoding_size_type_and_session(status,headers,body):
    async with endpoint(status,headers,body) as (url,requests):
        transport=PluginHTTPTransport(url,'synthetic',[url])
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(PluginError):await client.post(url,json={})
        assert len(requests)==1


@pytest.mark.anyio
async def test_exact_target_methods_no_push_cookies_proxy_or_arbitrary_headers():
    async with endpoint() as (url,requests):
        transport=PluginHTTPTransport(url,'synthetic',[url])
        async with httpx.AsyncClient(transport=transport) as client:
            assert (await client.get(url)).status_code==405
            with pytest.raises(PluginError):await client.post(url+'/other',json={})
            with pytest.raises(PluginError):await client.delete(url,headers={'mcp-session-id':'session'})
            assert requests==[]
            await client.post(url,json={},headers={'Cookie':'private=ignored','X-Untrusted':'ignored','Authorization':'wrong'})
        assert len(requests)==1
        assert b'Cookie:' not in requests[0] and b'X-Untrusted:' not in requests[0]
        assert b'Bearer synthetic' in requests[0] and b'wrong' not in requests[0]


@pytest.mark.anyio
async def test_all_dns_answers_validated_before_connection():
    async def mixed(_):return [(socket.AF_INET,'8.8.8.8'),(socket.AF_INET,'127.0.0.1')]
    transport=PluginHTTPTransport('https://plugins.example.com/mcp',resolver=mixed)
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(PluginError) as caught:await client.post('https://plugins.example.com/mcp',json={})
        assert caught.value.code=='forbidden'


@pytest.mark.anyio
async def test_delete_requires_captured_session_and_cleanup_mode():
    async with endpoint(headers={'mcp-session-id':'captured'}) as (url,requests):
        transport=PluginHTTPTransport(url,None,[url])
        async with httpx.AsyncClient(transport=transport) as client:
            await client.post(url,json={})
            assert transport.session_id=='captured'
            transport.cleanup=True
            with pytest.raises(PluginError):await client.delete(url,headers={'mcp-session-id':'other'})
            await client.delete(url,headers={'mcp-session-id':'captured'})
        assert len(requests)==2 and requests[-1].startswith(b'DELETE ')


def test_endpoint_path_matches_url_serialization():
    from openbot_server.plugin_transport import normalize_endpoint
    assert normalize_endpoint('https://EXAMPLE.com:443/a/../文')=='https://example.com/%E6%96%87'
