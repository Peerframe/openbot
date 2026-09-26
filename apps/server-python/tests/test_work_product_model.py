"""Real SQL/settings/provider SDK; synthetic HTTP and the current engine's SDK/history seam."""
import asyncio
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx2
import psycopg
from psycopg.types.json import Jsonb
import pytest
pytest.importorskip('pydantic_ai',reason='Optional Worker SDK profile is required')
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'agent-runtime-python/src'))
from pydantic_ai.messages import ModelRequest, UserPromptPart
from openbot_agent_runtime.contracts import ModelStepRequest
from openbot_server.control_errors import ControlError
from openbot_server.model_connections import ModelConnectionsService
from openbot_server.model_connections_cipher import ModelCredentialCipher
from openbot_server.model_settings import ModelSettingsService
from openbot_server.product_model import ProductModelError
from openbot_server.task_inputs import CreateMessageInput
from openbot_server.task_store import PostgresTaskStore
from openbot_server.work_corrections import CorrectionStore
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_engine_binding import EngineActivityFacts
from openbot_server.work_handoff import HandoffStore
from openbot_server.work_model_receipts import ModelReceipts
from openbot_server.work_product_model import ProductWorkModel
from openbot_server.work_sources import WorkSourceAdmission
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_temporal_start import WorkRuntimeContext
from openbot_server.work_values import InvalidWork, WorkConflict

KEY='synthetic-product-key-never-real'
SCOPE=dict(expected_namespace='default',expected_queue='fixture-queue',expected_workflow_type='fixture-workflow')
CONFIG=dict(provider='openai',model='fixture-model',apiKey=KEY,revision=None,agentEnabled=True)

@pytest.fixture
def setup(fixture,tmp_path):
    bot,channel=str(uuid4()),str(uuid4())
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("INSERT INTO bots(id,name,role,computer_profile) VALUES(%s,%s,'assistant','none')",(bot,'Product model '+bot))
        db.execute("INSERT INTO channels(id,name,description) VALUES(%s,%s,'Synthetic only')",(channel,'Product model '+channel))
        db.execute('INSERT INTO channel_bots(channel_id,bot_id) VALUES(%s,%s)',(channel,bot))
    base=tmp_path.resolve();base.chmod(0o700);(base/'blobs').mkdir(mode=0o700)
    store=PostgresWorkStore(fixture['dsn'])
    receipts=ModelReceipts(store,LocalWorkFiles(base/'blobs'))
    settings=ModelSettingsService(base/'settings',lambda r:httpx2.Response(200,json={'id':'fixture-model'}))
    connections=ModelConnectionsService(fixture['dsn'],ModelCredentialCipher(bytes(range(32))))
    f=SimpleNamespace(**fixture,bot=bot,channel=channel,store=store,receipts=receipts,settings=settings,connections=connections,ids=[],calls=[])
    f.sources=WorkSourceAdmission(store,token_limit=1_000_000)
    yield f
    with psycopg.connect(f.dsn) as db:
        db.execute('DELETE FROM work_model_receipts WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(bot,))
        db.execute('DELETE FROM work_sources WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(bot,))
        for table in ('work_actions','work_artifacts','work_correction_contexts','work_corrections','work_events'):
            db.execute(f'DELETE FROM {table} WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(bot,))
        for table in ('work_claims','work_admissions'):
            db.execute(f'DELETE FROM {table} WHERE run_id IN (SELECT r.id FROM work_runs r JOIN work_tasks t ON t.id=r.task_id WHERE t.bot_id=%s)',(bot,))
        db.execute('DELETE FROM work_runs WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(bot,))
        db.execute('DELETE FROM work_tasks WHERE bot_id=%s',(bot,))
        db.execute('DELETE FROM runs WHERE bot_id=%s',(bot,))
        db.execute('DELETE FROM run_events WHERE channel_id=%s OR bot_id=%s',(channel,bot))
        db.execute('DELETE FROM channels WHERE id=%s',(channel,))
        db.execute('DELETE FROM bots WHERE id=%s',(bot,))
        db.execute('DELETE FROM model_connections WHERE id=ANY(%s)',(f.ids,))

async def selected(f):
    item=await f.connections.create(f.token,dict(name='Synthetic '+uuid4().hex,presetId='openai',baseUrl='https://api.openai.com/v1',apiKey=KEY))
    f.ids.append(item['id'])
    return item

async def bound(f,profile='none',connection=None):
    with psycopg.connect(f.dsn) as db:
        db.execute('UPDATE bots SET computer_profile=%s,configuration=%s WHERE id=%s',(profile,Jsonb({'model':{'connectionId':connection['id'],'modelId':'queued-model'}} if connection else {}),f.bot))
    result=await PostgresTaskStore(f.dsn,model_connections=f.connections,work_sources=f.sources).submit(f.token,f.channel,
        CreateMessageInput(content='Synthetic model task',botId=f.bot))
    async with f.store._transaction(trusted=True) as db:
        row=await (await db.execute('SELECT task_id FROM work_sources WHERE legacy_run_id=%s',(result.run.id,))).fetchone()
    task=await f.store.snapshot(f.token,row['task_id'])
    rid=task['runs'][0]['id']
    correction=await CorrectionStore(f.store).freeze(task['id'],rid,'initial')
    context=WorkRuntimeContext(task['id'],rid,f.bot,task['objective'],task['usage']['tokenLimit'],correction['id'])
    accepted=SimpleNamespace(task_id=task['id'],run_id=rid,namespace='default',workflow_id='openbot-work-v1-'+rid,
        engine_run_id='synthetic-engine',first_run_id='synthetic-engine')
    handoff=HandoffStore(f.store);reference='temporal:default:'+accepted.workflow_id
    reservation=await handoff.reserve_submission(task['id'],rid,reference)
    await handoff.acknowledge(task['id'],rid,reference,reservation.attempt_id,'synthetic-engine')
    facts=EngineActivityFacts(namespace='default',queue=SCOPE['expected_queue'],start_queue=SCOPE['expected_queue'],
        workflow_id=accepted.workflow_id,workflow_type=SCOPE['expected_workflow_type'],engine_run_id='synthetic-engine',
        first_run_id='synthetic-engine',start_input=dict(taskId=task['id'],runId=rid,attemptId=reservation.attempt_id))
    return SimpleNamespace(context=context,accepted=accepted,facts=facts,source=result.run,activity='model-1')

@contextmanager
def binding(b):
    async def inspect(*args,**kwargs): return b.facts
    with patch('openbot_server.work_temporal_activity.activity_info',lambda:SimpleNamespace(activity_id=b.activity)), \
            patch('openbot_server.work_temporal_activity.inspect_activity_start',inspect):
        yield

def request(text='Synthetic prompt',step=1):
    return ModelStepRequest(step=step,messages=[ModelRequest(parts=[UserPromptPart(
        text,timestamp=datetime(2026,9,25,tzinfo=timezone.utc))])],tools=())

def response(req):
    body=json.loads(req.content);model=body['model']
    if req.url.path.endswith('/responses'):
        return {'id':'response-fixture','object':'response','created_at':1,'model':model,'status':'completed',
            'output':[{'id':'message-fixture','type':'message','role':'assistant','status':'completed',
                'content':[{'type':'output_text','text':'Checked answer','annotations':[]}]}],
            'usage':{'input_tokens':10,'output_tokens':4,'total_tokens':14}}
    return {'id':'chat-fixture','object':'chat.completion','created':1,'model':model,
        'choices':[{'index':0,'finish_reason':'stop','message':{'role':'assistant','content':'Checked answer'}}],
        'usage':{'prompt_tokens':10,'completion_tokens':4,'total_tokens':14}}

def product(f,handler=None,**options):
    def send(req):
        f.calls.append(req)
        return handler(req) if handler else httpx2.Response(200,json=response(req))
    return ProductWorkModel(f.store,object(),SCOPE,f.settings,f.connections,f.receipts,
        transport_factory=lambda:httpx2.MockTransport(send),**options)

@pytest.mark.parametrize('profile',['none','model'])
def test_real_product_sdk_protocol_and_private_provenance(setup,profile):
    async def check():
        f=setup;connection=await selected(f) if profile=='model' else None
        if profile=='none': await f.settings.save(CONFIG)
        b=await bound(f,profile,connection)
        calls=[]
        async def admission(db,task,action):
            assert task['id']==b.context.task_id and action['status']=='proposed'
            calls.append('admission');return True
        async def before(): calls.append('send')
        with binding(b):
            result=await product(f).call(b.context,request(),admission_check=admission,before_send=before)
        assert result.text=='Checked answer' and result.usage.input_tokens==10
        assert calls==['admission','send'] and len(f.calls)==1
        assert f.calls[0].url.path.endswith('/responses' if profile=='none' else '/chat/completions')
        snap=await f.store.snapshot(f.token,b.context.task_id)
        config=snap['actions'][0]['intent']['configuration']
        assert config['source']==('singleton' if profile=='none' else 'connection')
        assert set(config)==({'source','revision','provider','model','baseUrl','protocol'} | ({'connectionId'} if profile=='model' else set()))
        assert KEY not in json.dumps(snap) and 'apiKey' not in json.dumps(snap)
        assert snap['usage']['spentTokens']==14 and snap['actions'][0]['status']=='applied'
    asyncio.run(check())

def test_queued_model_selection_ignores_later_bot_change(setup):
    async def check():
        f=setup;first=await selected(f);second=await selected(f);b=await bound(f,'model',first)
        await f.connections.update_employee_model(f.token,f.bot,dict(expectedRevision=1,model={'connectionId':second['id'],'modelId':'later-model'}))
        with binding(b): await product(f).call(b.context,request())
        assert json.loads(f.calls[0].content)['model']=='queued-model'
        snapshot=await f.store.snapshot(f.token,b.context.task_id)
        assert snapshot['actions'][0]['intent']['configuration']['connectionId']==first['id']
    asyncio.run(check())

@pytest.mark.parametrize('profile',['none','model'])
def test_missing_or_disabled_refuses_without_fallback_or_action(setup,profile,monkeypatch):
    async def check():
        f=setup
        monkeypatch.setenv('OPENAI_API_KEY','synthetic-ambient-must-not-use')
        b=await bound(f,profile)
        with binding(b),pytest.raises(ProductModelError): await product(f).call(b.context,request())
        assert not f.calls and (await f.store.snapshot(f.token,b.context.task_id))['actions']==[]
        if profile=='model':
            conn=await selected(f);b=await bound(f,profile,conn)
            await f.connections.update(f.token,conn['id'],dict(expectedRevision=1,enabled=False))
            with binding(b),pytest.raises(ControlError): await product(f).call(b.context,request())
        else:
            await f.settings.save({**CONFIG,'agentEnabled':False})
            with binding(b),pytest.raises(ProductModelError): await product(f).call(b.context,request())
        assert not f.calls
    asyncio.run(check())

@pytest.mark.parametrize('profile',['none','model'])
@pytest.mark.parametrize('change',['disable','rotate'])
def test_actual_send_rechecks_configuration_after_awaited_root_callback(setup,profile,change):
    async def check():
        f=setup;conn=await selected(f) if profile=='model' else None
        saved=await f.settings.save(CONFIG) if profile=='none' else None
        b=await bound(f,profile,conn)
        async def before():
            if profile=='none': await f.settings.save({**CONFIG,'revision':saved['revision'],**({'agentEnabled':False} if change=='disable' else {'apiKey':'synthetic-rotated-key'})})
            else: await f.connections.update(f.token,conn['id'],dict(expectedRevision=1,**({'enabled':False} if change=='disable' else {'apiKey':'synthetic-rotated-key'})))
        with binding(b),pytest.raises(WorkConflict,match='model_observation_unknown'):
            await product(f).call(b.context,request(),before_send=before)
        assert not f.calls
        assert (await f.store.snapshot(f.token,b.context.task_id))['actions'][0]['status']=='unknown'
    asyncio.run(check())

@pytest.mark.parametrize('profile',['none','model'])
@pytest.mark.parametrize('change',['disable','rotate'])
def test_receipt_retry_after_config_change_uses_original_without_new_send(setup,profile,change):
    async def check():
        f=setup;conn=await selected(f) if profile=='model' else None
        saved=await f.settings.save(CONFIG) if profile=='none' else None
        b=await bound(f,profile,conn)
        with binding(b): first=await product(f).call(b.context,request())
        if profile=='none': await f.settings.save({**CONFIG,'revision':saved['revision'],**({'agentEnabled':False} if change=='disable' else {'apiKey':'synthetic-rotated-key'})})
        else: await f.connections.update(f.token,conn['id'],dict(expectedRevision=1,**({'enabled':False} if change=='disable' else {'apiKey':'synthetic-rotated-key'})))
        def forbidden_transport(): raise AssertionError('Recovery must not construct transport or decrypt current config')
        service=ProductWorkModel(f.store,object(),SCOPE,f.settings,f.connections,f.receipts,
            max_output_tokens=8192,transport_factory=forbidden_transport)
        with binding(b),patch.object(f.settings,'active',AsyncMock(side_effect=AssertionError('No current singleton read'))), \
                patch.object(f.connections,'resolve_in_transaction',AsyncMock(side_effect=AssertionError('No current key decryption'))):
            second=await service.call(b.context,request(step=99))
        assert first==second and len(f.calls)==1
        b.activity='next-model'
        with binding(b):
            if change=='disable':
                with pytest.raises((ControlError,ProductModelError)): await product(f).call(b.context,request())
            else:
                await product(f).call(b.context,request())
                assert len(f.calls)==2 and f.calls[-1].headers['authorization']=='Bearer synthetic-rotated-key'
    asyncio.run(check())

def test_committed_receipt_lost_ack_recovered_and_unknown_never_resent(setup):
    async def check():
        f=setup;await f.settings.save(CONFIG);b=await bound(f)
        original=f.receipts.save
        async def interrupted(*args,**kwargs):
            await original(*args,**kwargs);raise asyncio.CancelledError()
        with binding(b),patch.object(f.receipts,'save',interrupted),pytest.raises(asyncio.CancelledError):
            await product(f).call(b.context,request())
        with binding(b): await product(f).call(b.context,request())
        assert len(f.calls)==1
        b.activity='missing-response'
        def unavailable(req): raise httpx2.ReadTimeout('synthetic loss')
        for _ in range(2):
            with binding(b),pytest.raises(WorkConflict,match='model_observation_unknown'):
                await product(f,unavailable).call(b.context,request())
        assert len(f.calls)==2
        snapshot=await f.store.snapshot(f.token,b.context.task_id)
        assert len(snapshot['actions'])==2 and snapshot['actions'][-1]['status']=='unknown'
    asyncio.run(check())

def test_binding_and_admission_callback_cannot_be_bypassed(setup):
    async def check():
        f=setup;await f.settings.save(CONFIG);b=await bound(f)
        with binding(b),pytest.raises(WorkConflict,match='scope_changed'):
            await product(f).call(replace(b.context,task_id=str(uuid4())),request())
        async def refuse(db,task,action): return False
        with binding(b),pytest.raises(WorkConflict,match='product_admission_refused'):
            await product(f).call(b.context,request(),admission_check=refuse)
        assert not f.calls
        async def revoke(): await f.store.revoke(f.token,b.context.task_id)
        with binding(b),pytest.raises(WorkConflict): await product(f).call(b.context,request(),before_send=revoke)
        assert not f.calls
    asyncio.run(check())

def test_changed_request_or_pending_configuration_never_replans(setup):
    async def check():
        f=setup;saved=await f.settings.save(CONFIG);b=await bound(f)
        async def refuse(db,task,action): return False
        with binding(b),pytest.raises(WorkConflict): await product(f).call(b.context,request(),admission_check=refuse)
        await f.settings.save({**CONFIG,'revision':saved['revision'],'apiKey':'synthetic-new-key'})
        with binding(b),pytest.raises(WorkConflict,match='model_operation_changed'): await product(f).call(b.context,request())
        assert not f.calls and len((await f.store.snapshot(f.token,b.context.task_id))['actions'])==1
        b.activity='second'
        with binding(b): await product(f).call(b.context,request())
        with binding(b),pytest.raises(WorkConflict,match='model_operation_changed'):
            await product(f).call(b.context,request('Changed prompt'))
        assert len(f.calls)==1
    asyncio.run(check())

def test_reservation_policy_bound_and_no_configuration_cache(setup):
    async def check():
        f=setup;await f.settings.save(CONFIG);b=await bound(f)
        for value in (True,-1,1,1_000_000_001):
            with binding(b),pytest.raises(InvalidWork):
                await product(f,reserve_policy=lambda req,out:value).call(b.context,request())
        assert not f.calls
        with binding(b): await product(f,reserve_policy=lambda req,out:out+100).call(b.context,request())
        assert len(f.calls)==1
    asyncio.run(check())


@pytest.mark.parametrize('profile',['none','model'])
def test_same_service_resolves_fresh_configuration_for_next_activity(setup,profile):
    async def check():
        f=setup;conn=await selected(f) if profile=='model' else None
        saved=await f.settings.save(CONFIG) if profile=='none' else None
        b=await bound(f,profile,conn);service=product(f)
        with binding(b): await service.call(b.context,request())
        if profile=='none':
            await f.settings.save({**CONFIG,'revision':saved['revision'],'apiKey':'synthetic-rotated-key'})
        else:
            await f.connections.update(f.token,conn['id'],dict(expectedRevision=1,apiKey='synthetic-rotated-key'))
        b.activity='next-model'
        with binding(b): await service.call(b.context,request())
        snapshot=await f.store.snapshot(f.token,b.context.task_id)
        assert len(f.calls)==2 and f.calls[-1].headers['authorization']=='Bearer synthetic-rotated-key'
        assert snapshot['actions'][0]['intent']['configuration']['revision']!=snapshot['actions'][1]['intent']['configuration']['revision']
    asyncio.run(check())


@pytest.mark.parametrize('change',['activity','claim','membership'])
def test_final_send_gate_rejects_changed_binding_or_fence_or_membership(setup,change):
    async def check():
        f=setup;await f.settings.save(CONFIG);b=await bound(f)
        async def before():
            if change=='activity': b.activity='another-activity'
            elif change=='claim': await f.store.claim(b.context.task_id,b.context.run_id,'replacement-claim')
            else:
                with psycopg.connect(f.dsn) as db:
                    db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(f.channel,f.bot))
        with binding(b),pytest.raises(WorkConflict):
            await product(f).call(b.context,request(),before_send=before)
        assert not f.calls
    asyncio.run(check())


def test_admission_rechecks_singleton_changed_during_callback(setup):
    async def check():
        f=setup;saved=await f.settings.save(CONFIG);b=await bound(f)
        async def admission(db,task,action):
            await f.settings.save({**CONFIG,'revision':saved['revision'],'apiKey':'synthetic-rotated-key'})
            return True
        with binding(b),pytest.raises(WorkConflict,match='configuration_changed'):
            await product(f).call(b.context,request(),admission_check=admission)
        snapshot=await f.store.snapshot(f.token,b.context.task_id)
        assert not f.calls and snapshot['actions'][0]['status']=='proposed'
        assert snapshot['usage']['reservedTokens']==0
    asyncio.run(check())


def test_missing_work_source_never_uses_singleton(setup):
    async def check():
        f=setup;await f.settings.save(CONFIG);b=await bound(f)
        with psycopg.connect(f.dsn) as db:
            db.execute('DELETE FROM work_sources WHERE task_id=%s',(b.context.task_id,))
        with binding(b),pytest.raises(WorkConflict,match='source_changed'):
            await product(f).call(b.context,request())
        assert not f.calls and (await f.store.snapshot(f.token,b.context.task_id))['actions']==[]
    asyncio.run(check())


def test_admission_rechecks_actual_sdk_acceptance_in_the_same_transaction(setup):
    async def check():
        f=setup;await f.settings.save(CONFIG);b=await bound(f)
        async def changed(db,task,action):
            await db.execute('UPDATE work_admissions SET submission_attempt_id=%s WHERE run_id=%s',
                (uuid4().hex,b.context.run_id))
            return True
        with binding(b),pytest.raises(WorkConflict,match='handoff_attempt_changed'):
            await asyncio.wait_for(product(f).call(b.context,request(),admission_check=changed),10)
        assert not f.calls
        snapshot=await f.store.snapshot(f.token,b.context.task_id)
        assert snapshot['actions'][0]['status']=='proposed' and snapshot['usage']['reservedTokens']==0
        with psycopg.connect(f.dsn) as db:
            persisted=db.execute('SELECT submission_attempt_id FROM work_admissions WHERE run_id=%s',
                (b.context.run_id,)).fetchone()[0]
        assert persisted==b.facts.start_input['attemptId']
    asyncio.run(check())
