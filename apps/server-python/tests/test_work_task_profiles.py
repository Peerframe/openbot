"""Real Task API/SQL/profile transactions, with the existing synthetic provider/SDK seam."""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import replace
import json
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx2
import psycopg
from psycopg.types.json import Jsonb
import pytest

pytest.importorskip('pydantic_ai',reason='The locked Worker profile is required')

from openbot_server.app import create_app
from openbot_server.database import PostgresReadStore, StoreUnavailable
from openbot_server.model_connections import ModelConnectionsService
from openbot_server.model_connections_cipher import ModelCredentialCipher
from openbot_server.model_settings import ModelSettingsService
from openbot_server.task_inputs import CreateMessageInput
from openbot_server.task_store import PostgresTaskStore
from openbot_server.work_corrections import CorrectionStore
from openbot_server.work_engine_binding import EngineActivityFacts
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_handoff import HandoffStore
from openbot_server.work_model_receipts import ModelReceipts
from openbot_server.work_product_artifacts import ProductWorkArtifacts
from openbot_server.work_product_binding import ProductWorkBinding
from openbot_server.work_product_reads import ProductWorkReads
from openbot_server.work_product_result import ProductWorkResultVerifier, EvidenceBundle, ToolEvidence, _public
from openbot_server.work_sources import WorkSourceAdmission
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_task_profiles import (WorkTaskProfiles, resolve_product_source,
    product_capabilities, task_profile_prompt, _profile)
from openbot_server.work_temporal_effect import ToolRequest
from openbot_server.work_temporal_start import WorkRuntimeContext
from openbot_server.work_tool_results import ToolResults
from openbot_server.work_values import WorkConflict, canonical

# Existing synthetic SDK/protocol fixture helpers; no provider/network framework is added.
from test_work_product_model import binding, request, product, response, selected, KEY, SCOPE, CONFIG
from test_work_product_result import tool, producer, ACCEPT


class Fixture(SimpleNamespace):
    def __repr__(self): return '<owned native Task fixture>'


@pytest.fixture
def setup(fixture,tmp_path):
    bot,channel=str(uuid4()),str(uuid4())
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("INSERT INTO bots(id,name,role,computer_profile,description) VALUES(%s,%s,'Analyst','none','Synthetic profile')",
            (bot,'Task profile '+bot))
        db.execute('INSERT INTO channels(id,name) VALUES(%s,%s)',(channel,'Task profile '+channel))
        db.execute('INSERT INTO channel_bots(channel_id,bot_id) VALUES(%s,%s)',(channel,bot))
    base=tmp_path.resolve();base.chmod(0o700);(base/'blobs').mkdir(mode=0o700)
    files=LocalWorkFiles(base/'blobs')
    store=PostgresWorkStore(fixture['dsn'],files=files,task_profiles=WorkTaskProfiles())
    f=Fixture(**fixture,bot=bot,channel=channel,store=store,receipts=ModelReceipts(store,files),
        results=ToolResults(store,files),settings=ModelSettingsService(base/'settings',
            lambda request:httpx2.Response(200,json={'id':'fixture-model'})),
        connections=ModelConnectionsService(fixture['dsn'],ModelCredentialCipher(bytes(range(32)))),ids=[],calls=[])
    yield f
    with psycopg.connect(f.dsn) as db:
        query='(SELECT id FROM work_tasks WHERE bot_id=%s)'
        for table in ('work_tool_results','work_model_receipts','work_sources','work_task_profiles','work_actions',
                      'work_artifacts','work_correction_contexts','work_corrections','work_events'):
            db.execute(f'DELETE FROM {table} WHERE task_id IN '+query,(bot,))
        for table in ('work_claims','work_admissions'):
            db.execute(f'DELETE FROM {table} WHERE run_id IN (SELECT id FROM work_runs WHERE task_id IN '+query+')',(bot,))
        db.execute('DELETE FROM work_runs WHERE task_id IN '+query,(bot,))
        db.execute('DELETE FROM work_tasks WHERE bot_id=%s',(bot,))
        db.execute('DELETE FROM runs WHERE bot_id=%s',(bot,))
        db.execute('DELETE FROM run_events WHERE bot_id=%s OR channel_id=%s',(bot,channel))
        db.execute('DELETE FROM channels WHERE id=%s',(channel,))
        db.execute('DELETE FROM bots WHERE id=%s',(bot,))
        db.execute('DELETE FROM model_connections WHERE id=ANY(%s)',(f.ids,))


def arguments(f,**changes):
    return dict(bot_id=f.bot,objective='Prepare a report about the three supplied open items.',
                token_limit=1_000_000,request_key=str(uuid4()),**changes)


def profile(f,kind='none',selection=None):
    with psycopg.connect(f.dsn) as db:
        db.execute('UPDATE bots SET computer_profile=%s,configuration=%s WHERE id=%s',
            (kind,Jsonb({'model':selection} if selection is not None else {}),f.bot))


async def bound(f,task=None):
    task=task or await f.store.create(f.token,**arguments(f))
    rid=task['runs'][0]['id']
    correction=await CorrectionStore(f.store).freeze(task['id'],rid,'initial')
    context=WorkRuntimeContext(task['id'],rid,f.bot,task['objective'],task['usage']['tokenLimit'],correction['id'])
    workflow='openbot-work-v1-'+rid
    accepted=SimpleNamespace(task_id=task['id'],run_id=rid,namespace='default',workflow_id=workflow,
        engine_run_id='synthetic-engine',first_run_id='synthetic-engine')
    handoff=HandoffStore(f.store); reference='temporal:default:'+workflow
    reservation=await handoff.reserve_submission(task['id'],rid,reference)
    await handoff.acknowledge(task['id'],rid,reference,reservation.attempt_id,'synthetic-engine')
    facts=EngineActivityFacts(namespace='default',queue=SCOPE['expected_queue'],start_queue=SCOPE['expected_queue'],
        workflow_id=workflow,workflow_type=SCOPE['expected_workflow_type'],engine_run_id='synthetic-engine',
        first_run_id='synthetic-engine',start_input=dict(taskId=task['id'],runId=rid,attemptId=reservation.attempt_id))
    return SimpleNamespace(context=context,accepted=accepted,facts=facts,activity='native-model-1')


def application(f):
    return create_app(PostgresReadStore(f.dsn),owner_name=f.ownerName,secure_cookies=False,
        allowed_origins=('http://control.test',),work=f.store)


def test_actual_owner_task_api_creates_profile_without_chat_and_allows_queued_correction(setup):
    f=setup
    with TestClient(application(f),base_url='http://control.test') as client:
        body=dict(botId=f.bot,objective='A native Task with no channel',tokenLimit=50000,requestKey=str(uuid4()))
        assert client.post('/api/v1/tasks',json=body,headers={'Origin':'http://control.test'}).status_code==401
        client.cookies.set('openbot_session',f.token); client.headers['Origin']='http://control.test'
        assert client.post('/api/v1/tasks',json={**body,'executionProfile':'model'}).status_code==422
        assert client.post('/api/v1/tasks',json=body,headers={'Origin':'https://other.test'}).status_code==403
        first=client.post('/api/v1/tasks',json=body)
        assert first.status_code==202,first.text
        task=first.json()
        assert client.post('/api/v1/tasks',json=body).json()==task
        assert client.post('/api/v1/tasks',json={**body,'objective':'Changed'}).status_code==409
        correction=client.post('/api/v1/tasks/'+task['id']+'/corrections',json=dict(
            runId=task['runs'][0]['id'],instruction='Include a concise explanation.',requestKey='queued',expectedSequence=0))
        assert correction.status_code==202,correction.text
        with psycopg.connect(f.dsn) as db:
            assert db.execute('SELECT execution_profile,model_selection FROM work_task_profiles WHERE task_id=%s',(task['id'],)).fetchone()==('none',None)
            assert db.execute('SELECT corrections_enabled FROM work_runs WHERE task_id=%s',(task['id'],)).fetchone()==(True,)
            assert db.execute('SELECT count(*) FROM work_sources WHERE task_id=%s',(task['id'],)).fetchone()[0]==0
            assert db.execute('SELECT count(*) FROM runs WHERE bot_id=%s',(f.bot,)).fetchone()[0]==0
            assert db.execute('SELECT count(*) FROM messages WHERE channel_id=%s',(f.channel,)).fetchone()[0]==0


@pytest.mark.parametrize('kind,selection',[
    ('docker-linux',None),('macos-cua',None),('lume-vm',None),('coder',None),
    ('model',None),('model',{}),('model',{'connectionId':'test','modelId':'bad model'}),
    ('model',{'connectionId':'test','modelId':'good','extra':True}),
])
def test_invalid_native_profile_refuses_api_without_partial_task(setup,kind,selection):
    f=setup;profile(f,kind,selection)
    key=str(uuid4())
    with TestClient(application(f),base_url='http://control.test') as client:
        client.cookies.set('openbot_session',f.token); client.headers['Origin']='http://control.test'
        reply=client.post('/api/v1/tasks',json=dict(botId=f.bot,objective='Refuse invalid profile',tokenLimit=100,requestKey=key))
        assert reply.status_code==409,reply.text
    with psycopg.connect(f.dsn) as db:
        assert db.execute('SELECT count(*) FROM work_tasks WHERE request_key=%s',(key,)).fetchone()[0]==0
        assert db.execute('SELECT count(*) FROM work_task_profiles WHERE bot_id=%s',(f.bot,)).fetchone()[0]==0


def test_concurrent_idempotency_has_one_profile_run_event_and_stable_selection(setup):
    f=setup
    async def check():
        first=await selected(f); second=await selected(f)
        original=dict(connectionId=first['id'],modelId='queued-model')
        profile(f,'model',original); args=arguments(f)
        one,two=await asyncio.gather(f.store.create(f.token,**args),f.store.create(f.token,**args))
        assert one==two
        profile(f,'model',dict(connectionId=second['id'],modelId='later-model'))
        assert await f.store.create(f.token,**args)==one
        profile(f,'docker-linux')
        assert await f.store.create(f.token,**args)==one
        with psycopg.connect(f.dsn) as db:
            assert db.execute('SELECT model_selection FROM work_task_profiles WHERE task_id=%s',(one['id'],)).fetchone()[0]==original
            assert db.execute('SELECT count(*) FROM work_runs WHERE task_id=%s',(one['id'],)).fetchone()[0]==1
            assert db.execute('SELECT count(*) FROM work_events WHERE task_id=%s',(one['id'],)).fetchone()[0]==1
    asyncio.run(check())


def test_failed_admission_rolls_back_profile_and_replay_key(setup):
    f=setup;args=arguments(f)
    with psycopg.connect(f.dsn) as db:
        db.execute("CREATE FUNCTION task_profile_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$")
        db.execute('CREATE TRIGGER task_profile_reject BEFORE INSERT ON work_admissions FOR EACH ROW EXECUTE FUNCTION task_profile_reject()')
    try:
        with pytest.raises(StoreUnavailable): asyncio.run(f.store.create(f.token,**args))
        with psycopg.connect(f.dsn) as db:
            assert db.execute('SELECT count(*) FROM work_tasks WHERE request_key=%s',(args['request_key'],)).fetchone()[0]==0
            assert db.execute('SELECT count(*) FROM work_task_profiles WHERE bot_id=%s',(f.bot,)).fetchone()[0]==0
    finally:
        with psycopg.connect(f.dsn) as db:
            db.execute('DROP TRIGGER task_profile_reject ON work_admissions'); db.execute('DROP FUNCTION task_profile_reject()')
    assert asyncio.run(f.store.create(f.token,**args))['status']=='queued'


def test_default_store_history_is_not_backfilled_or_promoted_by_replay(setup):
    f=setup
    async def check():
        args=arguments(f); reference=PostgresWorkStore(f.dsn)
        old=await reference.create(f.token,**args)
        assert await f.store.create(f.token,**args)==old
        with psycopg.connect(f.dsn) as db:
            assert db.execute('SELECT corrections_enabled FROM work_runs WHERE task_id=%s',(old['id'],)).fetchone()==(False,)
            assert db.execute('SELECT count(*) FROM work_task_profiles WHERE task_id=%s',(old['id'],)).fetchone()[0]==0
        async with f.store._transaction(trusted=True) as db:
            task=await f.store._task(db,old['id'],read=True)
            with pytest.raises(WorkConflict): await resolve_product_source(db,task,f.bot)
    asyncio.run(check())


@pytest.mark.parametrize('kind',['none','model'])
def test_native_model_dispatch_uses_recorded_profile_and_recovery_ignores_later_config(setup,kind):
    f=setup
    async def check():
        connection=await selected(f) if kind=='model' else None
        if kind=='none': await f.settings.save(CONFIG)
        profile(f,kind,dict(connectionId=connection['id'],modelId='queued-model') if connection else None)
        b=await bound(f)
        profile(f,'docker-linux')
        with binding(b):
            answer=await product(f).call(b.context,request())
            assert answer.text=='Checked answer' and len(f.calls)==1
            assert json.loads(f.calls[0].content)['model']==('queued-model' if kind=='model' else 'fixture-model')
            if connection: await f.connections.update(f.token,connection['id'],dict(expectedRevision=1,enabled=False))
            else:
                current=await f.settings.active()
                await f.settings.save({**CONFIG,'revision':current['revision'],'agentEnabled':False})
            assert (await product(f).call(b.context,request())).text=='Checked answer'
            assert len(f.calls)==1
        snap=await f.store.snapshot(f.token,b.context.task_id)
        assert snap['actions'][0]['status']=='applied' and KEY not in json.dumps(snap)
    asyncio.run(check())


def test_native_prompt_capabilities_and_read_tools_do_not_invent_channel_scope(setup):
    f=setup
    async def check():
        with psycopg.connect(f.dsn) as db:
            db.execute('UPDATE bots SET role=%s,description=%s WHERE id=%s',('😀'*160,'😀'*2000,f.bot))
        b=await bound(f); gate=ProductWorkBinding(f.store,object(),SCOPE)
        with binding(b):
            async with f.store._transaction(trusted=True) as db:
                value=await task_profile_prompt(db,b.context,binding=gate)
                source=await gate.check(db,b.context,require_fence=False)
            assert product_capabilities(source)==frozenset(('model','report','result_review'))
            assert value['bot']['role']=='😀'*160 and value['attachments']==[]
            assert not {'channelId','messageId','runId'}.intersection(value['source'])
            with psycopg.connect(f.dsn) as db:
                created=db.execute('SELECT created_at FROM work_tasks WHERE id=%s',(b.context.task_id,)).fetchone()[0]
            assert value['source']['createdAt']==created.isoformat()
            reads=ProductWorkReads(f.store,object(),SCOPE,None,f.results)
            for name in ('read_channel_context','read_task_status','list_channel_bots'):
                with pytest.raises(WorkConflict): await reads.prepare(b.context,ToolRequest(name,{},canonical({})[1]))
            with pytest.raises(WorkConflict):
                async with f.store._transaction(trusted=True) as db:
                    await task_profile_prompt(db,replace(b.context,bot_id=str(uuid4())),binding=gate)
    asyncio.run(check())


@pytest.mark.parametrize('change',['digest','cancel','context'])
def test_native_binding_and_model_source_fail_closed_after_change(setup,change):
    f=setup
    async def check():
        b=await bound(f);gate=ProductWorkBinding(f.store,object(),SCOPE)
        if change=='digest':
            with psycopg.connect(f.dsn) as db:
                db.execute('UPDATE work_task_profiles SET profile_digest=%s WHERE task_id=%s',('0'*64,b.context.task_id))
        elif change=='cancel': await f.store.cancel(f.token,b.context.task_id)
        else: b.context=replace(b.context,objective='Forged objective')
        with binding(b):
            with pytest.raises(WorkConflict):
                async with f.store._transaction(trusted=True) as db: await gate.check(db,b.context,require_fence=False)
            with pytest.raises(WorkConflict): await product(f).call(b.context,request())
        assert not f.calls
    asyncio.run(check())


@pytest.mark.parametrize('change',['ambiguous','source_message','member'])
def test_channel_source_retains_exact_identity_membership_and_no_native_snapshot(setup,change):
    f=setup
    async def check():
        source=await PostgresTaskStore(f.dsn,work_sources=WorkSourceAdmission(f.store,token_limit=1_000_000)).submit(
            f.token,f.channel,CreateMessageInput(content='Channel source',botId=f.bot))
        with psycopg.connect(f.dsn) as db:
            tid=db.execute('SELECT task_id FROM work_sources WHERE legacy_run_id=%s',(source.run.id,)).fetchone()[0]
            assert db.execute('SELECT count(*) FROM work_task_profiles WHERE task_id=%s',(tid,)).fetchone()[0]==0
        b=await bound(f,await f.store.snapshot(f.token,tid)); gate=ProductWorkBinding(f.store,object(),SCOPE)
        with binding(b):
            async with f.store._transaction(trusted=True) as db:
                current=await gate.check(db,b.context,require_fence=False)
                assert current['source_kind']=='channel' and 'channel_reads' in product_capabilities(current)
            with psycopg.connect(f.dsn) as db:
                if change=='ambiguous':
                    _,digest=_profile(tid,f.bot,'none',None)
                    db.execute("INSERT INTO work_task_profiles(task_id,bot_id,execution_profile,profile_digest) VALUES(%s,%s,'none',%s)",(tid,f.bot,digest))
                elif change=='member': db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(f.channel,f.bot))
                else:
                    new=str(uuid4()); db.execute("INSERT INTO messages(id,channel_id,author_type,author_id,content) VALUES(%s,%s,'human','owner','Other')",(new,f.channel))
                    db.execute('UPDATE runs SET source_message_id=%s WHERE id=%s',(new,source.run.id))
            with pytest.raises(WorkConflict):
                async with f.store._transaction(trusted=True) as db: await gate.check(db,b.context,require_fence=False)
    asyncio.run(check())


def test_native_report_then_real_model_receipts_and_result_review_without_channel(setup):
    f=setup
    async def check():
        await f.settings.save(CONFIG); b=await bound(f)
        f.next_text='The supplied records contain three open items.'
        def send(req):
            value=response(req); value['output'][0]['content'][0]['text']=f.next_text
            return httpx2.Response(200,json=value)
        f.port=product(f,send);f.artifact=ProductWorkArtifacts(f.store,object(),SCOPE,f.results)
        gate=ProductWorkBinding(f.store,object(),SCOPE)
        async def validate(db,context):
            source=await gate.check(db,context)
            assert product_capabilities(source)==frozenset(('model','report','result_review'))
            return True
        async def collect(context,summary):
            async with f.store._transaction(trusted=True) as db:
                rows=await (await db.execute("SELECT * FROM work_actions WHERE task_id=%s AND status='applied' "
                    "AND intent->>'tool'='write_report'",(context.task_id,))).fetchall()
            evidence=[]
            for row in rows:
                item=await f.results.load(row['id'],task_id=context.task_id,run_id=context.run_id,intent_digest=row['intent_digest'])
                evidence.append(ToolEvidence(row['id'],_public(item.value,row['intent'])))
            return EvidenceBundle(tuple(evidence),await f.artifact.artifacts(context))
        verifier=ProductWorkResultVerifier(f.store,object(),SCOPE,f.port,f.receipts,f.results,
            collect_evidence=collect,validate_current=validate)
        with binding(b):
            await tool(f,b,report='# Synthetic report\n\nThe supplied records contain three open items.')
            await producer(f,b)
            b.activity='native-quality-review';f.next_text=ACCEPT
            fence=await gate.claim(b.context)
            checked=await verifier.verify(b.context,'The supplied records contain three open items.')
            assert len(checked.artifacts)==1 and checked.verification['source']=='control-content-review-v1'
            assert checked.artifacts[0]['data'].startswith(b'# Synthetic report')
            before=len(f.calls)
            again=await verifier.verify(b.context,'The supplied records contain three open items.')
            assert again==checked and len(f.calls)==before
            @asynccontextmanager
            async def publication(context,db):
                assert (await gate.check(db,context))['source_kind']=='task'
                yield
            final=await f.store.complete(b.context.task_id,b.context.run_id,fence=fence,
                expected_revision=checked.observed_revision,summary='The supplied records contain three open items.',
                artifacts=checked.artifacts,verification=checked.verification,
                correction_context=b.context.correction_token,publication=lambda db:publication(b.context,db))
            assert final['status']=='completed' and len(final['artifacts'])==1
        with psycopg.connect(f.dsn) as db:
            assert db.execute('SELECT count(*) FROM work_sources WHERE task_id=%s',(b.context.task_id,)).fetchone()[0]==0
            assert db.execute('SELECT count(*) FROM runs WHERE bot_id=%s',(f.bot,)).fetchone()[0]==0
    asyncio.run(check())
