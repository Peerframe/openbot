"""Owned PostgreSQL and public enrollment/WS; synthetic browser, model and SDK history."""
import asyncio
import base64
from contextlib import asynccontextmanager
from dataclasses import replace
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import httpx
import httpx2
import psycopg
from psycopg.types.json import Jsonb
import pytest
pytest.importorskip('pydantic_ai', reason='Locked Worker profile required')

from openbot_server.app import create_app
from openbot_server.database import PostgresReadStore, StoreUnavailable
from openbot_server.control_errors import ControlError
from openbot_server.owner_files import OwnerFiles
from openbot_server.task_inputs import CreateMessageInput
from openbot_server.task_store import PostgresTaskStore
from openbot_server.work_browser_installation import browser_profiles_from_file
from openbot_server.work_browser_profiles import BrowserProfiles
from openbot_server.work_deferred import operation_key
from openbot_server.work_corrections import CorrectionStore
from openbot_server.work_effects import execute_action, recover_action
from openbot_server.work_product_browser import ProductWorkBrowser, capture_observation
from openbot_server.work_product_runtime import ProductWorkRuntime
from openbot_server.work_sources import WorkSourceAdmission
from openbot_server.work_task_profiles import product_capabilities
from openbot_server.work_temporal_effect import ToolRequest
from openbot_server.work_values import WorkConflict, InvalidWork, canonical
from test_browser_sessions import server, worker, opened, command, enroll_worker, FRAME
from test_work_task_profiles import setup, bound, profile
from test_work_product_model import binding, selected, product, request, response, SCOPE

# An actual small PNG, while page contents and browser behavior remain synthetic.
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQf8AAAAASUVORK5CYII=')


@pytest.fixture
def configured(setup, tmp_path):
    f = setup
    f.seed = dict(dsn=f.dsn, token=f.token, botId=f.bot, node='capture-'+str(uuid4()))
    root = tmp_path/'attachments'; root.mkdir(mode=0o700)
    f.owner = SimpleNamespace(files=OwnerFiles(root), model=f.settings, model_connections=f.connections, plugins=None)
    f.store.browser_profiles = BrowserProfiles(f.connections, routes={f.bot:f.seed['node']})
    f.sources = WorkSourceAdmission(f.store, token_limit=1000000)
    profile(f, 'docker-linux')
    yield f
    with psycopg.connect(f.dsn) as db:
        db.execute('DELETE FROM work_browser_page_scopes WHERE task_id IN (SELECT task_id FROM work_browser_profiles WHERE bot_id=%s)', (f.bot,))
        db.execute('DELETE FROM work_browser_profiles WHERE bot_id=%s', (f.bot,))
        db.execute('DELETE FROM run_events WHERE bot_id=%s', (f.bot,))
        for table in ('node_identity_events','node_enrollment_tokens','node_credentials','nodes'):
            column = 'id' if table == 'nodes' else 'node_id'
            db.execute(f'DELETE FROM {table} WHERE {column}=%s', (f.seed['node'],))


async def channel_task(f):
    selection = await selected(f)
    profile(f, 'docker-linux', dict(connectionId=selection['id'],modelId='queued-model'))
    result = await PostgresTaskStore(f.dsn, model_connections=f.connections, work_sources=f.sources).submit(
        f.token, f.channel, CreateMessageInput(content='Capture the current browser as a PNG file. Do not interpret the page.', botId=f.bot))
    with psycopg.connect(f.dsn) as db:
        tid = db.execute('SELECT task_id FROM work_sources WHERE legacy_run_id=%s', (result.run.id,)).fetchone()[0]
    return await bound(f, await f.store.snapshot(f.token, tid))


@asynccontextmanager
async def capture_host(f, hook=None):
    async def frame(value):
        if hook is not None:
            await hook(value)
        return dict(**{k:v for k,v in FRAME.items() if k!='base64'}, base64=base64.b64encode(PNG).decode())
    async with server(f.seed) as (service, registry, http, url):
        async with worker(f.seed,http,url,hook=frame) as (calls, ws):
            view = await opened(http,f.seed)
            f.owner.worker_registry, f.owner.browser = registry, service
            f.capture = ProductWorkBrowser(f.store,object(),SCOPE,f.results,registry,service.gate)
            yield calls, http, view, registry


async def prepare(f,b,*,approve=None):
    b.activity = 'capture-'+uuid4().hex
    plan = await f.capture.prepare(b.context,ToolRequest('capture_browser',{},canonical({})[1]))
    fence = await f.capture.binding.claim(b.context)
    intent = dict(kind='deferred_tool',tool='capture_browser',arguments={},effect=plan.intent)
    key = operation_key(b.accepted,b.activity)
    action = await f.store.propose(b.context.task_id,b.context.run_id,fence=fence,action_key=key,intent=intent,
        reserved_tokens=0,requires_approval=True,correction_context=b.context.correction_token)
    if approve is not None:
        await f.store.decide(f.token,action,intent_digest=canonical(intent)[1],approved=approve)
    services = await f.capture.load(b.context,intent)
    async def execute():
        return await execute_action(f.store,task_id=b.context.task_id,run_id=b.context.run_id,fence=fence,
            action_key=key,intent=intent,reserved_tokens=0,requires_approval=True,
            adapter=services.adapter,verifier=services.verifier,correction_context=b.context.correction_token)
    return SimpleNamespace(id=action,intent=intent,services=services,execute=execute)


async def row(f,action):
    async with f.store._transaction(trusted=True) as db:
        _, value = await f.store._action(db,action)
        return value


def test_profile_requires_owner_opened_host_and_keeps_model_snapshot(configured):
    f=configured
    async def check():
        async with server(f.seed) as (_, _, http, url):
            async with worker(f.seed,http,url):
                with pytest.raises(WorkConflict, match='browser_identity_changed'):
                    await channel_task(f)
                with psycopg.connect(f.dsn) as db:
                    assert db.execute('SELECT count(*) FROM work_tasks WHERE bot_id=%s',(f.bot,)).fetchone()[0]==0
                await opened(http,f.seed)
                b=await channel_task(f)
                profile(f,'docker-linux',dict(connectionId=str(uuid4()),modelId='later-model'))
                async with f.store._transaction(trusted=True) as db:
                    task=await f.store._task(db,b.context.task_id,read=True)
                    snap,digest=await f.store.browser_profiles.resolve_in_transaction(db,task)
                    assert snap.modelSelection.modelId=='queued-model' and len(digest)==64
                    assert product_capabilities(dict(source_kind='channel',execution_profile='docker-linux',
                        browser_profile_digest=digest))==frozenset(('model','report','result_review','channel_reads','attachments','browser_capture'))
                with psycopg.connect(f.dsn) as db:
                    assert db.execute('SELECT count(*) FROM work_command_profiles WHERE task_id=%s',(b.context.task_id,)).fetchone()[0]==0
    asyncio.run(check())


def test_public_approval_capture_replay_review_and_exact_png_download(configured):
    f=configured
    async def check():
        async with capture_host(f) as (calls, _, _, _):
            b=await channel_task(f)
            f.next_text='The captured PNG is attached. I have not interpreted its contents.'
            def provider(req):
                answer=response(req)
                if 'choices' in answer: answer['choices'][0]['message']['content']=f.next_text
                else: answer['output'][0]['content'][0]['text']=f.next_text
                return httpx2.Response(200,json=answer)
            runtime=ProductWorkRuntime(f.store,object(),SCOPE,f.owner,model=product(f,provider),web=False)
            app=create_app(PostgresReadStore(f.dsn),owner_name=f.ownerName,secure_cookies=False,
                allowed_origins=('http://control.test',),work=f.store)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://control.test',
                    cookies={'openbot_session':f.token},headers={'Origin':'http://control.test'}) as api:
                with binding(b):
                    ports=await runtime.load_services(b.context)
                    assert 'capture_browser' in {t.name for t in ports.model_tools}
                    proposed=await prepare(f,b)
                    with pytest.raises(WorkConflict): await proposed.execute()
                    assert calls==[]
                    approved=await api.post('/api/v1/actions/'+proposed.id+'/decision',json=dict(
                        intentDigest=canonical(proposed.intent)[1],approved=True))
                    assert approved.status_code==200,approved.text
                    assert (await proposed.execute()).status=='applied'
                    assert len(calls)==1 and calls[0]['action']=={'kind':'observe'}
                    assert calls[0]['requestId']==proposed.id and calls[0]['sessionId']==b.context.task_id
                    assert (await proposed.execute()).status=='applied' and len(calls)==1
                    payload=await runtime.load_tool_result(b.context,await row(f,proposed.id))
                    assert payload['visualContentProvided'] is False
                    assert 'base64' not in json.dumps(payload) and f.seed['node'] not in json.dumps(payload)
                    assert len((await f.store.snapshot(f.token,b.context.task_id))['artifacts'])==0
                    b.activity='browser-producer'
                    answer=await ports.model_step(request())
                    b.activity='browser-review';f.next_text='{"accepted":true,"reason":"Exact PNG capture metadata supports a capture-only request."}'
                    fence=await runtime.binding.claim(b.context)
                    checked=await runtime.verifier.verify(b.context,answer.text)
                    assert checked.artifacts[0]['data']==PNG
                    assert 'visualContentProvided' in f.calls[-1].content.decode()
                    async with runtime.validation_scope(b.context):
                        completed=await f.store.complete(b.context.task_id,b.context.run_id,fence=fence,
                            expected_revision=checked.observed_revision,summary=answer.text,artifacts=checked.artifacts,
                            verification=checked.verification,correction_context=b.context.correction_token,
                            publication=lambda db:runtime.publication(b.context,db))
                downloaded=await api.get('/api/v1/artifacts/'+completed['artifacts'][0]['id'])
                assert downloaded.status_code==200 and downloaded.content==PNG
                assert downloaded.headers['content-type']=='image/png'
                assert len(calls)==1
    asyncio.run(check())


@pytest.mark.parametrize('change',['denied','cancel','member','credential','human','connection','claim','profile'])
def test_changed_authority_never_sends_capture(configured,change):
    f=configured
    async def check():
        async with capture_host(f) as (calls,http,view,registry):
            b=await channel_task(f)
            with binding(b):
                proposed=await prepare(f,b,approve=change!='denied')
                if change=='cancel':await f.store.cancel(f.token,b.context.task_id)
                elif change=='credential':await enroll_worker(f.seed,http)
                elif change=='human':
                    assert (await command(http,view,'take')).status_code==200
                    assert (await command(http,view,'release')).status_code==200
                elif change=='connection':
                    registry._nodes[f.seed['node']].connection_id=str(uuid4())
                else:
                    with psycopg.connect(f.dsn) as db:
                        if change=='member': db.execute('DELETE FROM channel_bots WHERE bot_id=%s',(f.bot,))
                        if change=='claim': db.execute("UPDATE work_claims SET expires_at=clock_timestamp()-interval '1 second' WHERE run_id=%s",(b.context.run_id,))
                        if change=='profile': db.execute('UPDATE work_browser_profiles SET profile_digest=%s WHERE task_id=%s',('0'*64,b.context.task_id))
                before=len(calls)
                try: result=await proposed.execute()
                except WorkConflict: pass
                else: assert result.status=='unknown'
                assert len(calls)==before
    asyncio.run(check())


def test_receipt_loss_restarts_with_lookup_only_and_validates_blob(configured):
    f=configured
    async def check():
        async with capture_host(f) as (calls,_,_,registry):
            b=await channel_task(f)
            with binding(b):
                proposed=await prepare(f,b,approve=True)
                with patch.object(proposed.services.adapter,'lookup',side_effect=RuntimeError('lost acknowledgement')):
                    assert (await proposed.execute()).status=='unknown'
                fresh=await f.capture.load(b.context,proposed.intent)
                registry._nodes[f.seed['node']].connection_id=str(uuid4())
                outcome=await recover_action(f.store,task_id=b.context.task_id,run_id=b.context.run_id,
                    action_id=proposed.id,adapter=fresh.adapter,verifier=fresh.verifier)
                assert outcome.status=='applied' and len(calls)==1
                original=await row(f,proposed.id)
                observed=await f.results.load(proposed.id,task_id=b.context.task_id,run_id=b.context.run_id,
                    intent_digest=original['intent_digest'])
                assert capture_observation(f.store.files,original,observed.value)[1]==PNG
                observed.value['image']['width']=2
                with pytest.raises(WorkConflict):capture_observation(f.store.files,original,observed.value)
                observed.value['image']['width']=1
                blob=f.store.files.directory/observed.value['image']['sha256']
                blob.write_bytes(b'x'*len(PNG))
                with pytest.raises(StoreUnavailable,match='work_file_integrity'):
                    await f.capture.load_result(b.context,original)
                assert len(calls)==1
    asyncio.run(check())


def test_four_attempt_limit_is_task_wide(configured):
    f=configured
    async def check():
        async with capture_host(f) as (calls,_,_,_):
            b=await channel_task(f)
            with binding(b):
                for index in range(4):
                    if index==2:
                        corrections=CorrectionStore(f.store)
                        await corrections.request(f.token,b.context.task_id,run_id=b.context.run_id,
                            instruction='Capture another current screen without interpreting it.',
                            request_key='more-captures',expected_sequence=0)
                        revised=await corrections.freeze(b.context.task_id,b.context.run_id,'revised-capture')
                        b.context=replace(b.context,correction_token=revised['id'])
                    assert (await (await prepare(f,b,approve=True)).execute()).status=='applied'
                with pytest.raises(WorkConflict, match='browser_capture_limit'):
                    await prepare(f,b,approve=True)
                assert len(calls)==4
    asyncio.run(check())


@pytest.mark.parametrize('phase',['before-send','after-reply','receipt-lost'])
def test_dispatch_and_reply_gates_keep_uncertain_capture_lookup_only(configured,phase):
    f=configured
    async def check():
        task_id=None
        async def received(_):
            if phase=='after-reply':await f.store.cancel(f.token,task_id)
        async with capture_host(f,received) as (calls,_,_,registry):
            b=await channel_task(f);task_id=b.context.task_id
            with binding(b):
                proposed=await prepare(f,b,approve=True)
                send=registry.browser_command
                async def cancelled(*args,**kwargs):
                    await f.store.cancel(f.token,task_id)
                    return await send(*args,**kwargs)
                if phase=='before-send':registry.browser_command=cancelled
                if phase=='receipt-lost':
                    with patch.object(f.results,'save',side_effect=RuntimeError('synthetic lost receipt')):
                        assert (await proposed.execute()).status=='unknown'
                else:assert (await proposed.execute()).status=='unknown'
                assert len(calls)==(0 if phase=='before-send' else 1)
                fresh=await f.capture.load(b.context,proposed.intent)
                for _ in range(2):
                    recovered=await recover_action(f.store,task_id=b.context.task_id,run_id=b.context.run_id,
                        action_id=proposed.id,adapter=fresh.adapter,verifier=fresh.verifier)
                    assert recovered.status=='unknown'
                assert len(calls)==(0 if phase=='before-send' else 1)
                assert (await f.store.snapshot(f.token,b.context.task_id))['artifacts']==[]
    asyncio.run(check())


def test_private_configuration_is_opt_in_exact_and_does_not_normalize_ids(configured,tmp_path):
    f=configured
    assert browser_profiles_from_file(None,f.connections) is None
    config=tmp_path/'browser.json';config.write_text(json.dumps(dict(version=1,routes={f.bot:f.seed['node']})));config.chmod(0o600)
    assert browser_profiles_from_file(config,f.connections).routes=={f.bot:f.seed['node']}
    assert browser_profiles_from_file(config,f.connections).human_control is False
    config.write_text(json.dumps(dict(version=1,routes={f.bot:f.seed['node']},humanControl=True)))
    assert browser_profiles_from_file(config,f.connections).human_control is True
    config.write_text(json.dumps(dict(version=1,routes={f.bot:f.seed['node']},humanControl='true')))
    with pytest.raises(InvalidWork):browser_profiles_from_file(config,f.connections)
    config.chmod(0o644)
    with pytest.raises(InvalidWork,match='browser_installation_invalid'):browser_profiles_from_file(config,f.connections)
    config.chmod(0o600);config.write_text('{"version":1,"routes":{},"routes":{}}')
    with pytest.raises(InvalidWork):browser_profiles_from_file(config,f.connections)
    upper=f.bot.upper()
    assert BrowserProfiles(f.connections,routes={upper:f.seed['node']}).routes=={upper:f.seed['node']}
    for routes in ({}, {'not-a-uuid':'node'}, {f.bot:''}):
        with pytest.raises(ValueError): BrowserProfiles(f.connections,routes=routes)


@pytest.mark.parametrize('enabled', [False, True])
def test_configured_route_selects_original_host_and_only_explicitly_enables_handover(configured,enabled):
    f=configured
    profiles=f.store.browser_profiles
    profiles.human_control=enabled
    async def check():
        async with server(f.seed,configured=False,profiles=profiles) as (service,registry,http,url):
            async with worker(f.seed,http,url) as (calls,_):
                # An available unrelated host must never stand in for the deployment route.
                profiles.routes[f.bot]='absent-original-host'
                assert (await http.post(f'/api/v1/bots/{f.bot}/browser')).status_code==503
                profiles.routes[f.bot]=f.seed['node']
                view=await opened(http,f.seed)
                assert view['nodeId']==f.seed['node'] and view['controlAvailable'] is enabled
                assert (await command(http,view,'take')).status_code==(200 if enabled else 503)
                if enabled:
                    with pytest.raises(ControlError):
                        async with service.gate.agent(f.bot):pass
                    assert (await command(http,view,'release')).json()['control']=='available'
                    async with service.gate.agent(f.bot):pass
                profiles.routes[f.bot]='changed-host'
                assert (await http.post(f'/api/v1/bots/{f.bot}/browser')).json()['error']=='browser_route_changed'
                before=len(calls)
                assert (await command(http,view,'observe')).json()['error']=='browser_route_changed'
                del profiles.routes[f.bot]
                assert (await command(http,view,'observe')).json()['error']=='browser_route_changed'
                assert len(calls)==before
    asyncio.run(check())


@pytest.mark.parametrize('phase', ['dispatch','reply'])
def test_handover_route_change_is_checked_at_actual_effect_and_publication(configured,phase):
    f=configured
    profiles=f.store.browser_profiles
    profiles.human_control=True
    async def hook(value):
        if phase=='reply':profiles.routes.clear()
    async def check():
        async with server(f.seed,configured=False,profiles=profiles) as (service,registry,http,url):
            async with worker(f.seed,http,url,hook=hook) as (calls,_):
                view=await opened(http,f.seed)
                send=registry.browser_command
                async def changed(*args,**kwargs):
                    profiles.routes.clear()
                    return await send(*args,**kwargs)
                if phase=='dispatch':registry.browser_command=changed
                result=await command(http,view,'take')
                assert result.status_code==409 and 'frame' not in result.json()
                assert len(calls)==(0 if phase=='dispatch' else 1)
                with pytest.raises(ControlError):
                    async with service.gate.agent(f.bot):pass
    asyncio.run(check())


def test_human_opt_in_does_not_enable_an_unrouted_employee(configured):
    f=configured
    profiles=BrowserProfiles(f.connections,routes={str(uuid4()):f.seed['node']},human_control=True)
    async def check():
        async with server(f.seed,configured=False,profiles=profiles) as (_,_,http,url):
            async with worker(f.seed,http,url) as (calls,_):
                view=await opened(http,f.seed)
                assert view['controlAvailable'] is False
                assert (await command(http,view,'take')).status_code==503
                assert calls==[]
                assert (await command(http,view,'observe')).status_code==200
    asyncio.run(check())


def test_actual_node_provider_and_work_share_the_same_capture(configured):
    f=configured
    async def check():
        async with server(f.seed,configured=False) as (service,registry,http,url):
            credential=await enroll_worker(f.seed,http)
            script=Path(__file__).parent/'fixtures/work-browser-node.mjs'
            child=await asyncio.create_subprocess_exec('node','--import','tsx',str(script),
                cwd=Path(__file__).resolve().parents[3],stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
            try:
                child.stdin.write(json.dumps(dict(nodeId=f.seed['node'],botId=f.bot,serverUrl=url,
                    credential=credential,png=base64.b64encode(PNG).decode())).encode())
                await child.stdin.drain();child.stdin.close()
                async with asyncio.timeout(10):
                    assert await child.stdout.readline()==b'{"started":true}\n'
                    while not registry.list():await asyncio.sleep(.02)
                await opened(http,f.seed)
                f.capture=ProductWorkBrowser(f.store,object(),SCOPE,f.results,registry,service.gate)
                b=await channel_task(f)
                with binding(b):
                    proposed=await prepare(f,b,approve=True)
                    assert (await proposed.execute()).status=='applied'
                    async with asyncio.timeout(2):
                        assert json.loads(await child.stdout.readline())=={'captures':1}
                    assert (await f.capture.artifacts(b.context))[0]['data']==PNG
                    assert (await proposed.execute()).status=='applied'
                    assert (await row(f,proposed.id))['actual_tokens']==0
            finally:
                if child.returncode is None:child.terminate()
                try:await asyncio.wait_for(child.wait(),5)
                except TimeoutError:child.kill();await child.wait()
                # This helper never logs configuration or credentials.
                error=await child.stderr.read()
                assert not error,error.decode()[:2048]
    asyncio.run(check())
