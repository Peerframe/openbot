"""Real PostgreSQL authority and real official-SDK MCP lifecycle regressions."""
import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
import json
import hashlib
import secrets
import os
from pathlib import Path
import shutil
import socket
import subprocess
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from mcp.server.fastmcp import FastMCP
import psycopg
import pytest
import uvicorn

from openbot_server.authority import AuthenticationRequired
from openbot_server.plugin_inputs import PluginError, LegacyManifestCodec, check_schema
from openbot_server.plugin_service import PluginService
from openbot_server.plugin_store import FilePluginStore
from openbot_server.plugin_transport import MCPConnector, PluginHTTPTransport, normalize_endpoint, public_address


@pytest.fixture
def anyio_backend():return 'asyncio'


@pytest.fixture(scope='module')
def fixture():
    path=os.environ.get('OPENBOT_CONTROL_TEST_FIXTURE')
    if not path:pytest.skip('Owned synthetic PostgreSQL fixture required')
    data=json.loads(Path(path).read_text());parsed=urlparse(data['dsn'])
    assert parsed.hostname=='127.0.0.1' and parsed.path.startswith('/openbot_control_test_')
    data['_runs']=[]
    yield data
    with psycopg.connect(data['dsn']) as connection:
        connection.execute('DELETE FROM runs WHERE id=ANY(%s)',(data['_runs'],))


@pytest.fixture
async def remote(request):
    app=FastMCP('fixture',json_response=getattr(request,'param',True),log_level='CRITICAL')
    effects=[]; requests=[]
    @app.tool()
    def read_value() -> str:
        return '42'
    @app.tool()
    def write_note(note: str) -> str:
        effects.append(note)
        return 'saved'
    @app.resource('notes://public/info')
    def info() -> str:
        return 'Untrusted resource'
    @app.resource('ui://fixture/card',mime_type='text/html;profile=mcp-app')
    def card() -> str:
        return '<html><body>Untrusted app</body></html>'
    @app.prompt()
    def compose(topic: str) -> str:
        return 'Write about '+topic
    inner=app.streamable_http_app()
    async def tracked(scope,receive,send):
        if scope['type']=='http':requests.append((scope['method'],dict(scope['headers'])))
        await inner(scope,receive,send)
    listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen();listener.setblocking(False)
    port=listener.getsockname()[1]
    server=uvicorn.Server(uvicorn.Config(tracked,log_level='critical',lifespan='on'))
    task=asyncio.create_task(server.serve(sockets=[listener]))
    async with asyncio.timeout(5):
        while not server.started:
            if task.done():await task
            await asyncio.sleep(.01)
    try:yield {'endpoint':f'http://127.0.0.1:{port}/mcp','effects':effects,'requests':requests,'app':app}
    finally:
        server.should_exit=True
        await asyncio.wait_for(task,5)
        listener.close()


async def service(fixture,tmp_path,remote,**options):
    async def scope(run):
        async with await psycopg.AsyncConnection.connect(fixture['dsn']) as connection:
            cursor=await connection.execute(
                'SELECT r.id FROM runs r JOIN channel_bots cb ON cb.channel_id=r.channel_id AND cb.bot_id=r.bot_id '
                "WHERE r.id=%s AND r.channel_id=%s AND r.bot_id=%s AND r.status='running' AND r.execution_profile='none'",
                (run['id'],run['channelId'],run['botId']))
            if await cursor.fetchone() is None:raise PluginError('forbidden')
    instance=PluginService(fixture['dsn'],tmp_path.resolve()/'state.json',local_endpoints=[remote['endpoint']],
                           assert_run_scope=scope,**options)
    return instance


async def installed(instance,fixture,remote,mode='read'):
    value={'name':'Fixture','endpoint':remote['endpoint'],'token':'synthetic-plugin-token'}
    preview=await instance.preview(fixture['token'],value)
    plugin=await instance.install(fixture['token'],{**value,'reviewedDigest':preview['digest']})
    assert not plugin['enabled'] and 'token' not in plugin
    plugin=await instance.set_enabled(fixture['token'],plugin['id'],{'revision':plugin['revision'],'enabled':True})
    plugin=await instance.grant(fixture['token'],plugin['id'],fixture['botId'],{'revision':plugin['revision'],
        'tools':[{'name':'read_value','mode':'read'},{'name':'write_note','mode':mode}],
        'resources':['notes://public/info','ui://fixture/card'],'prompts':['compose']})
    return plugin


def run(fixture):
    value={'id':str(uuid4()),'botId':fixture['botId'],'channelId':fixture['channelId']}
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute("INSERT INTO runs(id,channel_id,bot_id,execution_profile,instruction,title,status) VALUES (%s,%s,%s,'none','Synthetic plugin check','Plugin check','running')",(value['id'],value['channelId'],value['botId']))
    fixture['_runs'].append(value['id'])
    return value


def call(plugin,name='read_value',arguments=None):
    return {'pluginId':plugin['id'],'revision':plugin['revision'],'toolName':name,'arguments':arguments or {}}


async def pending(instance,fixture):
    async with asyncio.timeout(5):
        while True:
            values=(await instance.snapshot(fixture['token']))['pendingCalls']
            if values:return values[0]
            await asyncio.sleep(.01)


@pytest.mark.anyio
@pytest.mark.parametrize('remote',[True,False],indirect=True)
async def test_real_owner_install_calls_resources_prompts_and_cleanup(fixture,tmp_path,remote):
    instance=await service(fixture,tmp_path,remote)
    plugin=await installed(instance,fixture,remote)
    active=run(fixture)
    assert len((await instance.snapshot(fixture['token']))['plugins'])==1
    assert len((await instance.catalog(active))['tools'])==2
    assert (await instance.call(active,call(plugin)))['result']['content'][0]['text']=='42'
    scope={'channelId':fixture['channelId'],'botId':fixture['botId']}
    assert len((await instance.owner_content_catalog(fixture['token'],scope))['items'])==3
    for kind,name,args in [('resource','notes://public/info',{}),('resource','ui://fixture/card',{}),('prompt','compose',{'topic':'evidence'})]:
        value={'pluginId':plugin['id'],'revision':plugin['revision'],'kind':kind,'name':name,'arguments':args}
        result=await instance.owner_read_content(fixture['token'],scope,value)
        assert result['untrusted'] is True
    assert any(method=='DELETE' for method,_ in remote['requests'])
    assert all(headers.get(b'authorization')==b'Bearer synthetic-plugin-token' for _,headers in remote['requests'])
    assert all(method!='GET' for method,_ in remote['requests'])
    assert b'synthetic-plugin-token' not in (tmp_path/'state.json').read_bytes()
    restarted=await service(fixture,tmp_path,remote)
    assert (await restarted.snapshot(fixture['token']))['plugins']==[plugin]
    result=await restarted.remove(fixture['token'],plugin['id'],{'revision':plugin['revision']})
    assert result=={'deleted':True}
    assert (await restarted.snapshot(fixture['token']))['plugins']==[]


@pytest.mark.anyio
async def test_single_consumption_approval_and_argument_snapshot(fixture,tmp_path,remote):
    instance=await service(fixture,tmp_path,remote)
    plugin=await installed(instance,fixture,remote,'confirm')
    value=call(plugin,'write_note',{'note':'reviewed'})
    task=asyncio.create_task(instance.call(run(fixture),value))
    view=await pending(instance,fixture)
    value['arguments']['note']='mutated'
    assert remote['effects']==[] and view['arguments']=={'note':'reviewed'}
    results=await asyncio.gather(instance.decide(fixture['token'],view['id'],{'decision':'approve'}),
                                 instance.decide(fixture['token'],view['id'],{'decision':'approve'}),return_exceptions=True)
    assert sum(isinstance(item,dict) for item in results)==1
    assert (await task)['untrusted'] and remote['effects']==['reviewed']
    audit=(await instance.store.read())['audit']
    assert sum(event['phase']=='dispatching' for event in audit)==1
    assert all('arguments' not in event and 'result' not in event for event in audit)


@pytest.mark.anyio
@pytest.mark.parametrize('action',['reject','expire','disable','cancel'])
async def test_approval_never_dispatches_after_denial(fixture,tmp_path,remote,action):
    instance=await service(fixture,tmp_path,remote,approval_timeout_ms=150 if action=='expire' else 10000)
    plugin=await installed(instance,fixture,remote,'confirm')
    signal=asyncio.Event()
    task=asyncio.create_task(instance.call(run(fixture),call(plugin,'write_note',{'note':'never'}),signal=signal))
    view=await pending(instance,fixture)
    if action=='reject':await instance.decide(fixture['token'],view['id'],{'decision':'reject'})
    if action=='disable':await instance.set_enabled(fixture['token'],plugin['id'],{'revision':plugin['revision'],'enabled':False})
    if action=='cancel':signal.set()
    with pytest.raises(PluginError) as caught:await asyncio.wait_for(task,5)
    assert caught.value.code=={'reject':'rejected','expire':'expired','disable':'unavailable','cancel':'unavailable'}[action]
    assert remote['effects']==[] and not instance._active and not instance._pending
    assert remote['requests'][-1][0]=='DELETE'


@pytest.mark.anyio
async def test_owner_scope_stale_revision_update_and_real_catalog_change(fixture,tmp_path,remote):
    instance=await service(fixture,tmp_path,remote)
    plugin=await installed(instance,fixture,remote)
    with pytest.raises(AuthenticationRequired):await instance.snapshot('x'*43)
    with pytest.raises(PluginError):await instance.owner_content_catalog(fixture['token'],{'channelId':str(uuid4()),'botId':fixture['botId']})
    with pytest.raises(PluginError):await instance.call(run(fixture),call(plugin,'write_note',{'unexpected':True}))
    @remote['app'].tool()
    def newly_declared() -> str:return 'new'
    with pytest.raises(PluginError) as caught:await instance.call(run(fixture),call(plugin))
    assert caught.value.code=='conflict'
    preview=await instance.preview_update(fixture['token'],plugin['id'],{'revision':plugin['revision']})
    assert preview['changed']
    updated=await instance.apply_update(fixture['token'],plugin['id'],{'revision':plugin['revision'],'reviewedDigest':preview['manifest']['digest']})
    assert updated['grants']==[] and updated['enabled'] is False
    with pytest.raises(PluginError) as stale:await instance.set_enabled(fixture['token'],plugin['id'],{'revision':plugin['revision'],'enabled':True})
    assert stale.value.code=='conflict'


@pytest.mark.anyio
async def test_corrupt_keyless_unsafe_state_never_becomes_empty(tmp_path):
    path=tmp_path.resolve()/'state.json'
    store=FilePluginStore(path)
    await store.transaction(lambda state:state['audit'].append({'at':'test','phase':'test','pluginId':'test'}))
    (tmp_path/'state.json.key').unlink()
    with pytest.raises(PluginError):FilePluginStore(path)
    with pytest.raises(PluginError):await store.read()
    path.write_text('not-json');path.chmod(0o644)
    with pytest.raises(PluginError):FilePluginStore(path)


@pytest.mark.anyio
async def test_failed_authority_exit_restores_previous_ciphertext(tmp_path):
    store=FilePluginStore(tmp_path.resolve()/'state.json')
    await store.transaction(lambda state:state['audit'].append({'at':'before','phase':'before','pluginId':'test'}))
    old=(tmp_path/'state.json').read_bytes()
    @asynccontextmanager
    async def revoked():
        yield
        raise AuthenticationRequired()
    with pytest.raises(AuthenticationRequired):
        await store.transaction(lambda state:state['audit'].clear(),authority=revoked)
    assert (tmp_path/'state.json').read_bytes()==old
    assert (await store.read())['audit'][0]['phase']=='before'


@pytest.mark.parametrize('url',['http://example.com/mcp','https://localhost/mcp','https://127.0.0.1/mcp',
    'https://[::1]/mcp','https://a.local/mcp','https://u:p@example.com/mcp','https://example.com/mcp?token=x',
    'https://example.com/mcp#x',' https://example.com/mcp','https://example.com\\@127.0.0.1/'])
def test_endpoint_rejections(url):
    with pytest.raises(PluginError):normalize_endpoint(url)


@pytest.mark.parametrize('address',['127.0.0.1','10.0.0.1','100.64.0.1','169.254.169.254','224.0.0.1','::1','::ffff:8.8.8.8','2002:0808:0808::1','2001:db8::1'])
def test_address_rejections(address):assert not public_address(address)


def test_schema_positions_and_unsupported_dialects():
    check_schema({'type':'object','properties':{'$ref':{'type':'string'}},'const':{'pattern':'data'}})
    for extra in ({'$ref':'https://evil.invalid/'},{'pattern':'a+'},{'$async':True},{'prefixItems':[]},{'$schema':'https://json-schema.org/draft/2020-12/schema'}):
        with pytest.raises(PluginError):check_schema({'type':'object',**extra})
    with pytest.raises(PluginError):check_schema({'type':'object','properties':{'x':{'format':'uri'}}})


def test_manifest_is_exact_existing_node_algorithm():
    tools=[{'name':'A','description':'中文','inputSchema':{'type':'object','properties':{'Z':{'const':1.0},'a':{'const':1e-7},'_':{'const':-0.0},'10':{},'2':{},'é':{},'中':{}},'additionalProperties':False}},
           {'name':'a','description':'','inputSchema':{'type':'object'}}]
    codec=LegacyManifestCodec()
    actual=codec.manifest('Fixture','https://example.com/mcp',tools)
    script="const {createHash}=require('node:crypto');const x=JSON.parse(require('node:fs').readFileSync(0,'utf8'));function c(v){return Array.isArray(v)?v.map(c):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,c(v)])):v;}x.tools.sort((a,b)=>a.name.localeCompare(b.name));console.log(createHash('sha256').update(JSON.stringify(c(x))).digest('hex'));"
    expected=subprocess.run([shutil.which('node'),'-e',script],input=json.dumps({'name':'Fixture','endpoint':'https://example.com/mcp','tools':tools}),text=True,capture_output=True,check=True).stdout.strip()
    assert actual['digest']==expected


@pytest.mark.anyio
async def test_real_run_revocation_blocks_dispatch(fixture,tmp_path,remote):
    instance=await service(fixture,tmp_path,remote)
    plugin=await installed(instance,fixture,remote,'confirm')
    active=run(fixture)
    task=asyncio.create_task(instance.call(active,call(plugin,'write_note',{'note':'never'})))
    view=await pending(instance,fixture)
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute("UPDATE runs SET status='cancelled' WHERE id=%s",(active['id'],))
    with pytest.raises(PluginError):await instance.decide(fixture['token'],view['id'],{'decision':'approve'})
    await instance.close()
    with pytest.raises(PluginError):await task
    assert remote['effects']==[]


@pytest.mark.anyio
async def test_real_session_expiry_at_publication_restores_state(fixture,tmp_path,remote):
    instance=await service(fixture,tmp_path,remote)
    token=secrets.token_urlsafe(32);digest=hashlib.sha256(token.encode()).hexdigest()
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute("INSERT INTO auth_sessions(id,token_digest,expires_at) VALUES (%s,%s,clock_timestamp()+interval '0.3 second')",(str(uuid4()),digest))
    async def change(state):
        await asyncio.sleep(.4)
        state['audit'].append({'at':'now','phase':'should-rollback','pluginId':'test'})
    try:
        with pytest.raises(AuthenticationRequired):
            await instance.store.transaction(change,authority=lambda:instance._owner_guard(token))
        assert (await instance.store.read())=={'plugins':[],'audit':[]}
    finally:
        with psycopg.connect(fixture['dsn']) as connection:connection.execute('DELETE FROM auth_sessions WHERE token_digest=%s',(digest,))


@pytest.mark.anyio
async def test_uninjected_runtime_scope_is_closed(fixture,tmp_path,remote):
    instance=PluginService(fixture['dsn'],tmp_path.resolve()/'state.json',local_endpoints=[remote['endpoint']])
    with pytest.raises(PluginError) as caught:await instance.catalog(run(fixture))
    assert caught.value.code=='forbidden'


@pytest.fixture(scope='module')
def legacy_bundle(tmp_path_factory):
    source=os.environ.get('OPENBOT_TS_SOURCE_ROOT')
    if not source:pytest.skip('Set OPENBOT_TS_SOURCE_ROOT for actual retained TS interoperability')
    source=Path(source)
    target=tmp_path_factory.mktemp('plugin-node').resolve()/'legacy.cjs'
    script="""const fs=require('node:fs'),path=require('node:path');const v=JSON.parse(fs.readFileSync(0,'utf8'));
require(path.join(v.root,'node_modules/esbuild')).buildSync({stdin:{contents:`export {pluginManifest} from ${JSON.stringify(path.join(v.root,'tests/oracles/legacy-server/src/plugin-types.ts'))};export {FilePluginStore} from ${JSON.stringify(path.join(v.root,'tests/oracles/legacy-server/src/plugin-store.ts'))};`,resolveDir:v.root},outfile:v.target,bundle:true,platform:'node',format:'cjs',alias:{'@openbot/protocol':path.join(v.root,'packages/protocol/src/index.ts'),'@openbot/windows-secret-acl':path.join(v.root,'packages/windows-secret-acl/src/index.ts')}});"""
    subprocess.run([shutil.which('node'),'-e',script],input=json.dumps({'root':str(source),'target':str(target)}),text=True,check=True,capture_output=True)
    return target


def node_legacy(bundle,script,value):
    completed=subprocess.run([shutil.which('node'),'-e',"const lib=require(process.argv[1]);const value=JSON.parse(require('node:fs').readFileSync(0,'utf8'));"+script,str(bundle)],input=json.dumps(value),text=True,capture_output=True,check=True)
    return json.loads(completed.stdout)


@pytest.mark.anyio
async def test_actual_typescript_store_bidirectional_and_manifest_parity(legacy_bundle,tmp_path):
    codec=LegacyManifestCodec()
    tools=[{'name':'echo','description':'中文','inputSchema':{'type':'object','const':{'Z':1.0,'a':-0.0,'_':1e-7,'2':2,'10':10,'é':True}}}]
    manifest=codec.manifest('Legacy','https://example.com/mcp',tools)
    legacy=node_legacy(legacy_bundle,"console.log(JSON.stringify(lib.pluginManifest(value.name,value.endpoint,value.tools)));",{'name':'Legacy','endpoint':'https://example.com/mcp','tools':tools})
    assert manifest==legacy
    path=tmp_path.resolve()/'state.json'
    plugin={**manifest,'id':str(uuid4()),'revision':str(uuid4()),'createdAt':'2026-09-24T00:00:00.000Z','enabled':False,'grants':[],'token':'synthetic-legacy-token'}
    node_legacy(legacy_bundle,"(async()=>{let s=new lib.FilePluginStore(value.path);await s.transaction(x=>x.plugins.push(value.plugin));console.log(JSON.stringify(await s.read()));})();",{'path':str(path),'plugin':plugin})
    store=FilePluginStore(path)
    assert (await store.read())['plugins']==[plugin]
    await store.transaction(lambda state:state['plugins'][0].update(enabled=True))
    returned=node_legacy(legacy_bundle,"(async()=>console.log(JSON.stringify(await new lib.FilePluginStore(value.path).read())))();",{'path':str(path)})
    assert returned['plugins'][0]['enabled'] is True and returned['plugins'][0]['token']=='synthetic-legacy-token'


@pytest.mark.anyio
async def test_existing_typescript_mcp_server_protocol(fixture,tmp_path):
    source=os.environ.get('OPENBOT_TS_SOURCE_ROOT')
    if not source:pytest.skip('Set OPENBOT_TS_SOURCE_ROOT for existing TS MCP fixture')
    target=tmp_path.resolve()/'example.mjs'
    build="""const fs=require('node:fs'),path=require('node:path'),v=JSON.parse(fs.readFileSync(0,'utf8'));
require(path.join(v.root,'node_modules/esbuild')).buildSync({stdin:{contents:`export {startExamplePlugin} from ${JSON.stringify(path.join(v.root,'tests/oracles/legacy-server/src/plugin-example.ts'))};`,resolveDir:v.root},outfile:v.target,bundle:true,platform:'node',format:'esm',banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});"""
    subprocess.run([shutil.which('node'),'-e',build],input=json.dumps({'root':source,'target':str(target)}),text=True,check=True,capture_output=True)
    script="const {startExamplePlugin}=await import(process.argv[1]);const app=await startExamplePlugin(0);console.log(app.endpoint);process.on('SIGTERM',()=>app.close().then(()=>process.exit(0)));"
    child=await asyncio.create_subprocess_exec(shutil.which('node'),'--input-type=module','-e',script,target.as_uri(),stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL)
    try:
        url=(await asyncio.wait_for(child.stdout.readline(),5)).decode().strip()
        assert url.startswith('http://127.0.0.1:')
        instance=await service(fixture,tmp_path,{'endpoint':url})
        value={'name':'Original TypeScript MCP','endpoint':url}
        preview=await instance.preview(fixture['token'],value)
        assert {t['name'] for t in preview['tools']}=={'sum_numbers','append_note'}
        plugin=await instance.install(fixture['token'],{**value,'reviewedDigest':preview['digest']})
        plugin=await instance.grant(fixture['token'],plugin['id'],fixture['botId'],{'revision':plugin['revision'],'tools':[{'name':'sum_numbers','mode':'read'}],
            'resources':['notes://current','ui://notebook/view.html'],'prompts':['review_note']})
        plugin=await instance.set_enabled(fixture['token'],plugin['id'],{'revision':plugin['revision'],'enabled':True})
        result=await instance.call(run(fixture),call(plugin,'sum_numbers',{'a':20,'b':22}))
        assert result['result']['content']==[{'type':'text','text':'42'}]
        result=await instance.owner_read_content(fixture['token'],{'channelId':fixture['channelId'],'botId':fixture['botId']},
            {'pluginId':plugin['id'],'revision':plugin['revision'],'kind':'resource','name':'ui://notebook/view.html'})
        assert result['untrusted'] and result['result']['contents'][0]['mimeType']=='text/html;profile=mcp-app'
    finally:
        if child.returncode is None:child.terminate()
        await asyncio.wait_for(child.wait(),5)
