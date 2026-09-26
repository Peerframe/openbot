"""Real PostgreSQL/files/receipt tests with the existing synthetic SDK/history seam."""
import asyncio
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import hashlib
import json
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
import pytest

from openbot_server.owner_files import OwnerFiles
from openbot_server.task_inputs import CreateMessageInput
from openbot_server.task_store import PostgresTaskStore
from openbot_server.work_corrections import CorrectionStore
from openbot_server.work_effects import execute_action, recover_action
from openbot_server.work_engine_binding import EngineActivityFacts
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_handoff import HandoffStore
from openbot_server.work_product_reads import ProductWorkReads, _arguments, _page, TOOLS, tool_descriptors
from openbot_server.work_sources import WorkSourceAdmission
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_temporal_activity import derive_claim_id
from openbot_server.work_temporal_effect import ToolRequest
from openbot_server.work_temporal_start import WorkRuntimeContext
from openbot_server.work_tool_results import ToolResults
from openbot_server.work_values import InvalidWork, WorkConflict, canonical

SCOPE = dict(expected_namespace='default', expected_queue='read-fixture', expected_workflow_type='read-fixture')


@pytest.fixture
def setup(fixture, tmp_path):
    bot, peer, channel = str(uuid4()), str(uuid4()), str(uuid4())
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("INSERT INTO bots(id,name,role,computer_profile,description) VALUES "
            "(%s,%s,'Researcher','none','Profile only'),(%s,%s,'Reviewer','none','Colleague')",
            (bot,'Read '+bot,peer,'Peer '+peer))
        db.execute('INSERT INTO channels(id,name) VALUES(%s,%s)', (channel,'Read '+channel))
        db.execute('INSERT INTO channel_bots(channel_id,bot_id) VALUES(%s,%s),(%s,%s)', (channel,bot,channel,peer))
    tmp_path = tmp_path.resolve(); tmp_path.chmod(0o700)
    (tmp_path/'attachments').mkdir(mode=0o700); (tmp_path/'blobs').mkdir(mode=0o700)
    store = PostgresWorkStore(fixture['dsn'])
    files = OwnerFiles(tmp_path/'attachments')
    results = ToolResults(store,LocalWorkFiles(tmp_path/'blobs'))
    reads = ProductWorkReads(store,object(),SCOPE,files,results)
    f = SimpleNamespace(**fixture,bot=bot,peer=peer,channel=channel,store=store,files=files,results=results,reads=reads)
    yield f
    with psycopg.connect(f.dsn) as db:
        query = '(SELECT id FROM work_tasks WHERE bot_id=%s)'
        db.execute('DELETE FROM work_sources WHERE task_id IN '+query,(bot,))
        for table in ('work_tool_results','work_actions','work_artifacts','work_correction_contexts','work_corrections','work_events'):
            db.execute(f'DELETE FROM {table} WHERE task_id IN '+query,(bot,))
        for table in ('work_claims','work_admissions'):
            db.execute(f'DELETE FROM {table} WHERE run_id IN (SELECT id FROM work_runs WHERE task_id IN '+query+')',(bot,))
        db.execute('DELETE FROM work_runs WHERE task_id IN '+query,(bot,))
        db.execute('DELETE FROM work_tasks WHERE bot_id=%s',(bot,))
        db.execute('DELETE FROM runs WHERE channel_id=%s',(channel,))
        db.execute('DELETE FROM messages WHERE channel_id=%s',(channel,))
        db.execute('DELETE FROM run_events WHERE channel_id=%s',(channel,))
        db.execute('DELETE FROM channels WHERE id=%s',(channel,))
        db.execute('DELETE FROM bots WHERE id=ANY(%s)',([bot,peer],))


async def bound(f, *, instruction='Synthetic read task', reply=None):
    task_store = PostgresTaskStore(f.dsn,files=f.files,work_sources=WorkSourceAdmission(f.store,token_limit=10000))
    source = await task_store.submit(f.token,f.channel,CreateMessageInput(content=instruction,botId=f.bot,
        **({'replyToMessageId':reply} if reply else {})))
    with psycopg.connect(f.dsn) as db:
        task_id = db.execute('SELECT task_id FROM work_sources WHERE legacy_run_id=%s',(source.run.id,)).fetchone()[0]
    task = await f.store.snapshot(f.token,task_id)
    run_id = task['runs'][0]['id']
    correction = await CorrectionStore(f.store).freeze(task_id,run_id,'initial')
    context = WorkRuntimeContext(task_id,run_id,f.bot,task['objective'],task['usage']['tokenLimit'],correction['id'])
    workflow = 'openbot-work-v1-'+run_id
    handoff = HandoffStore(f.store); reference = 'temporal:default:'+workflow
    reservation = await handoff.reserve_submission(task_id,run_id,reference)
    await handoff.acknowledge(task_id,run_id,reference,reservation.attempt_id,'synthetic-engine')
    facts = EngineActivityFacts(namespace='default',queue='read-fixture',start_queue='read-fixture',
        workflow_id=workflow,workflow_type='read-fixture',engine_run_id='synthetic-engine',first_run_id='synthetic-engine',
        start_input=dict(taskId=task_id,runId=run_id,attemptId=reservation.attempt_id))
    return SimpleNamespace(context=context,facts=facts,activity='read-1',source=source.run)


@contextmanager
def activity(b):
    async def history(*args,**kwargs): return b.facts
    with patch('openbot_server.work_temporal_activity.activity_info',lambda:SimpleNamespace(activity_id=b.activity)), \
         patch('openbot_server.work_temporal_activity.inspect_activity_start',history):
        yield


async def planned(f,b,tool,args=None):
    args = {} if args is None else args
    plan = await f.reads.prepare(b.context,ToolRequest(tool,args,canonical(args)[1]))
    assert plan.reserved_tokens == 0 and plan.requires_approval is False
    return dict(kind='deferred_tool',tool=tool,arguments=args,effect=plan.intent)


async def run_read(f,b,tool,args=None, *, intent=None):
    intent = intent or await planned(f,b,tool,args)
    services = await f.reads.load(b.context,intent)
    claim = derive_claim_id('default',b.facts.workflow_id,b.facts.engine_run_id,b.activity)
    fence = await f.store.claim(b.context.task_id,b.context.run_id,claim)
    outcome = await execute_action(f.store,task_id=b.context.task_id,run_id=b.context.run_id,
        fence=fence,action_key='read-test-'+b.activity,intent=intent,reserved_tokens=0,requires_approval=False,
        adapter=services.adapter,verifier=services.verifier,correction_context=b.context.correction_token)
    async with f.store._transaction(trusted=True) as db:
        _,row = await f.store._action(db,outcome.action_id)
    return outcome,row,services


def message(f,content, *, at, author='human', run=None, reply=None):
    identity = str(uuid4())
    with psycopg.connect(f.dsn) as db:
        db.execute('INSERT INTO messages(id,channel_id,author_type,author_id,content,created_at,run_id,reply_to_message_id) '
            'VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',(identity,f.channel,author,f.bot if author=='bot' else 'owner',content,at,run,reply))
    return identity


@pytest.mark.parametrize('tool',sorted(TOOLS-{'read_attachment'}))
@pytest.mark.parametrize('value',[{'channelId':'other'},[],None,{'extra':1}])
def test_empty_argument_contract(tool,value):
    with pytest.raises(InvalidWork): _arguments(tool,value)


def test_catalog_is_complete_and_returns_detached_schemas():
    first=tool_descriptors()
    assert {value.name for value in first}==TOOLS
    assert all(value.input_schema['additionalProperties'] is False for value in first)
    first[0].input_schema['properties']['forged']={}
    assert tool_descriptors()[0].input_schema['properties']=={}


@pytest.mark.parametrize('changes',[{'offset':True},{'offset':-1},{'offset':262145},{'limit':False},
    {'limit':0},{'limit':16001},{'offset':1.5},{'offset':None},{'extra':1},{'attachmentId':'not-uuid'}])
def test_attachment_input_bounds(changes):
    with pytest.raises(InvalidWork): _arguments('read_attachment',{'attachmentId':str(uuid4()),**changes})


def test_utf16_pages_preserve_offsets_bytes_and_json_bounds():
    item=dict(id=str(uuid4()),name='Sample.txt',sha256='a'*64)
    request=_arguments('read_attachment',{'attachmentId':item['id'],'offset':3.0,'limit':1.0})
    value=_page(item,'A😀B',False,request)
    assert value['text']=='B' and value['totalCharacters']==4 and value['nextOffset'] is None
    page=_page(item,'中文'*10000,True,{'offset':0,'limit':16000})
    assert len(page['text'].encode())<=8192 and page['truncated'] is True
    escaped=_page(item,'\x01'*16000,False,{'offset':0,'limit':16000})
    assert len(json.dumps(escaped['text'],ensure_ascii=False).encode())-2<=10240
    with pytest.raises(InvalidWork): _page(item,'A😀B',False,{'offset':2,'limit':1})
    with pytest.raises(InvalidWork): _page(item,'A😀B',False,{'offset':8,'limit':1})


def test_real_context_cutoff_reference_and_prompt(setup):
    f=setup
    async def check():
        past=datetime.now(timezone.utc)-timedelta(days=1)
        ref=message(f,'Explicit prior reference',at=past)
        for n in range(18): message(f,'Past '+str(n)+' 中文'*700,at=past+timedelta(seconds=n+1))
        b=await bound(f,reply=ref)
        later=message(f,'MUST NOT LEAK future input',at=datetime.now(timezone.utc)+timedelta(seconds=1))
        with activity(b):
            prompt=await f.reads.read_prompt(b.context)
            assert prompt['bot']['id']==f.bot and prompt['bot']['role']=='Researcher'
            assert set(prompt)=={'bot','source','attachments'} and prompt['attachments']==[]
            outcome,row,_=await run_read(f,b,'read_channel_context')
            assert outcome.status=='applied'
            data=await f.reads.load_result(b.context,row)
            assert len(data)==13 and later not in {r['id'] for r in data}
            assert data[-1]['id']==ref and data[-1]['referenced'] is True
            assert sum(len(r['content'].encode()) for r in data)<=10000
            assert all(len(r['content'].encode())<=1600 for r in data)
    asyncio.run(check())


def test_status_is_work_projection_and_receipt_is_historical(setup):
    f=setup
    async def check():
        b=await bound(f)
        with activity(b):
            outcome,row,_=await run_read(f,b,'read_task_status')
            assert outcome.status=='applied'
            original=await f.reads.load_result(b.context,row)
            assert original[0]['status']=='running'
            with psycopg.connect(f.dsn) as db:
                assert db.execute('SELECT status FROM runs WHERE id=%s',(b.source.id,)).fetchone()[0]=='queued'
                db.execute("UPDATE runs SET title='Changed title' WHERE id=%s",(b.source.id,))
            assert await f.reads.load_result(b.context,row)==original
    asyncio.run(check())


def test_colleagues_keep_channel_identity_and_catalog_limits(setup):
    f=setup
    async def check():
        b=await bound(f)
        with activity(b):
            outcome,row,_=await run_read(f,b,'list_channel_bots')
            assert outcome.status=='applied'
            data=await f.reads.load_result(b.context,row)
            assert data=={'bots':[{'id':f.peer,'name':'Peer '+f.peer,'role':'Reviewer','description':'Colleague'}],'truncated':False}
    asyncio.run(check())


def test_attachment_pages_survive_restart_and_recovery_never_rereads(setup):
    f=setup
    async def check():
        async with f.files.lock(): item=f.files.persist(f.channel,'Evidence.txt','A😀B 中文'.encode())
        b=await bound(f,instruction='Read [OpenBot attachment: '+item['id']+']')
        with activity(b):
            outcome,row,services=await run_read(f,b,'read_attachment',{'attachmentId':item['id'],'offset':3,'limit':4})
            assert outcome.status=='applied'
            expected=await f.reads.load_result(b.context,row)
            assert expected['text']=='B 中文' and expected['offset']==3 and expected['untrusted'] is True
            restarted=ProductWorkReads(f.store,object(),SCOPE,OwnerFiles(f.files.root),f.results)
            assert await restarted.load_result(b.context,row)==expected
            with patch.object(f.reads,'_invoke',side_effect=AssertionError('must not read again')):
                recovered=await recover_action(f.store,task_id=b.context.task_id,run_id=b.context.run_id,
                    action_id=outcome.action_id,adapter=services.adapter,verifier=services.verifier)
            assert recovered.status=='applied' and recovered.invoked_apply is False
    asyncio.run(check())


@pytest.mark.parametrize('mutation',['deleted','binary','derived','missing'])
def test_attachment_versions_and_offlining_revoke_result(setup,mutation):
    f=setup
    async def check():
        async with f.files.lock():
            item=f.files.persist(f.channel,'Document.pdf',b'%PDF-1.4\nsynthetic\n%%EOF')
            derived=dict(text='Extracted readable text',truncated=False,sha256=item['sha256'],operation='extract',processedAt='2026-09-25T00:00:00.000Z')
            f.files._write(item['id']+'.text.json',json.dumps(derived).encode())
            item['processing']=dict(operation='extract',characters=len(derived['text']),truncated=False,processedAt=derived['processedAt'])
            f.files._write(item['id']+'.json',json.dumps(item).encode())
        b=await bound(f,instruction='Read [OpenBot attachment: '+item['id']+']')
        with activity(b):
            outcome,row,_=await run_read(f,b,'read_attachment',{'attachmentId':item['id']})
            assert outcome.status=='applied'
            async with f.files.lock():
                if mutation=='deleted': f.files.set_deleted(f.channel,item['id'],True)
                elif mutation=='binary': f.files._write(item['id']+'.bin',b'changed')
                elif mutation=='missing': f.files._remove(item['id']+'.text.json')
                else:
                    derived['text']='A different extracted text'
                    item['processing']['characters']=len(derived['text'])
                    f.files._write(item['id']+'.text.json',json.dumps(derived).encode())
                    f.files._write(item['id']+'.json',json.dumps(item).encode())
            with pytest.raises(WorkConflict): await f.reads.load_result(b.context,row)
    asyncio.run(check())


@pytest.mark.parametrize('mutation',['membership','cancel','source','correction','fence'])
def test_apply_rechecks_current_authority_after_prepare(setup,mutation):
    f=setup
    async def check():
        b=await bound(f)
        with activity(b):
            intent=await planned(f,b,'read_task_status')
            services=await f.reads.load(b.context,intent)
            claim=derive_claim_id('default',b.facts.workflow_id,b.facts.engine_run_id,b.activity)
            fence=await f.store.claim(b.context.task_id,b.context.run_id,claim)
            action=await f.store.propose(b.context.task_id,b.context.run_id,fence=fence,action_key='prepared',
                intent=intent,reserved_tokens=0,requires_approval=False,correction_context=b.context.correction_token)
            assert await f.store.admit(action,fence=fence)
            if mutation=='cancel': await f.store.cancel(f.token,b.context.task_id)
            elif mutation=='correction':
                await CorrectionStore(f.store).request(f.token,b.context.task_id,run_id=b.context.run_id,
                    instruction='Updated',request_key='change',expected_sequence=0)
            elif mutation=='fence': await f.store.claim(b.context.task_id,b.context.run_id,'newer-claim')
            else:
                with psycopg.connect(f.dsn) as db:
                    if mutation=='membership': db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(f.channel,f.bot))
                    else: db.execute("UPDATE runs SET instruction='Changed' WHERE id=%s",(b.source.id,))
            with pytest.raises(WorkConflict): await services.adapter.apply(action,intent)
            with psycopg.connect(f.dsn) as db:
                assert db.execute('SELECT count(*) FROM work_tool_results WHERE action_id=%s',(action,)).fetchone()[0]==0
    asyncio.run(check())


@pytest.mark.parametrize('mutation',['membership','cancel','source','wrong_task','digest'])
def test_load_result_rechecks_access_after_blob_io(setup,mutation):
    f=setup
    async def check():
        b=await bound(f)
        with activity(b):
            _,row,_=await run_read(f,b,'read_channel_context')
            original=f.results.load
            async def changed(*args,**kwargs):
                observed=await original(*args,**kwargs)
                if mutation=='cancel': await f.store.cancel(f.token,b.context.task_id)
                else:
                    with psycopg.connect(f.dsn) as db:
                        if mutation=='membership': db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(f.channel,f.bot))
                        elif mutation=='source': db.execute("UPDATE runs SET instruction='Changed' WHERE id=%s",(b.source.id,))
                return observed
            if mutation=='wrong_task': row={**row,'task_id':str(uuid4())}
            if mutation=='digest': row={**row,'intent_digest':'a'*64}
            with patch.object(f.results,'load',changed):
                with pytest.raises(WorkConflict): await f.reads.load_result(b.context,row)
    asyncio.run(check())


def test_sdk_binding_and_forged_context_never_supply_authority(setup):
    f=setup
    async def check():
        b=await bound(f)
        with pytest.raises(RuntimeError): await f.reads.prepare(b.context,ToolRequest('read_task_status',{},canonical({})[1]))
        with activity(b):
            with pytest.raises(WorkConflict): await planned(f,SimpleNamespace(context=replace(b.context,bot_id=str(uuid4()))),'read_task_status')
            b.facts=replace(b.facts,first_run_id='wrong-engine')
            with pytest.raises(WorkConflict): await planned(f,b,'read_task_status')
    asyncio.run(check())


def test_unreferenced_and_other_channel_attachments_are_refused(setup):
    f=setup
    async def check():
        async with f.files.lock():
            item=f.files.persist(f.channel,'Unreferenced.txt',b'Private')
            other=f.files.persist(str(uuid4()),'Other.txt',b'Other channel')
        b=await bound(f,instruction='Read [OpenBot attachment: '+item['id']+']')
        with activity(b):
            with pytest.raises(WorkConflict): await planned(f,b,'read_attachment',{'attachmentId':other['id']})
            f.files._write(item['id']+'.json',json.dumps({**item,'channelId':str(uuid4())}).encode())
            with pytest.raises(WorkConflict): await planned(f,b,'read_attachment',{'attachmentId':item['id']})
    asyncio.run(check())


def test_attachment_budget_is_durable_across_restart(setup):
    f=setup
    async def check():
        async with f.files.lock(): item=f.files.persist(f.channel,'Budget.txt',b'x'*10000)
        b=await bound(f,instruction='Read [OpenBot attachment: '+item['id']+']')
        with activity(b):
            for index in range(32):
                b.activity='page-'+str(index)
                outcome,row,_=await run_read(f,b,'read_attachment',{'attachmentId':item['id'],'limit':8192})
                assert outcome.status=='applied'
                f.reads=ProductWorkReads(f.store,object(),SCOPE,OwnerFiles(f.files.root),f.results)
            b.activity='page-33'
            outcome,_,_=await run_read(f,b,'read_attachment',{'attachmentId':item['id'],'limit':1})
            assert outcome.status=='unknown'
            with psycopg.connect(f.dsn) as db:
                assert db.execute('SELECT count(*) FROM work_tool_results WHERE task_id=%s',(b.context.task_id,)).fetchone()[0]==32
    asyncio.run(check())


def test_real_sdk_activity_context_drives_history_binding(setup):
    from temporalio.testing import ActivityEnvironment
    f=setup
    async def check():
        b=await bound(f)
        handles=[]
        class Converter:
            async def decode(self,payloads,types):
                assert payloads==['synthetic'] and types==[dict]
                return [b.facts.start_input]
        class History:
            async def fetch_history_events(self,*,page_size):
                assert page_size==1
                yield SimpleNamespace(HasField=lambda field:field=='workflow_execution_started_event_attributes',
                    workflow_execution_started_event_attributes=SimpleNamespace(
                        workflow_type=SimpleNamespace(name='read-fixture'),task_queue=SimpleNamespace(name='read-fixture'),
                        input=SimpleNamespace(payloads=['synthetic']),workflow_id=b.facts.workflow_id,
                        first_execution_run_id='synthetic-engine'))
        class Client:
            namespace='default'
            data_converter=Converter()
            def get_workflow_handle(self,workflow_id,run_id=None):
                handles.append((workflow_id,run_id)); return History()
        f.reads=ProductWorkReads(f.store,Client(),SCOPE,f.files,f.results)
        environment=ActivityEnvironment()
        environment.info=replace(environment.info,activity_id=b.activity,namespace='default',
            task_queue='read-fixture',workflow_id=b.facts.workflow_id,workflow_type='read-fixture',
            workflow_run_id='synthetic-engine')
        async def invoke():
            outcome,row,_=await run_read(f,b,'read_channel_context')
            assert outcome.status=='applied'
            return await f.reads.load_result(b.context,row)
        value=await environment.run(invoke)
        assert value[0]['content']==b.context.objective
        assert handles and set(handles)=={(b.facts.workflow_id,'synthetic-engine')}
        environment.info=replace(environment.info,task_queue='different-queue')
        with pytest.raises(WorkConflict): await environment.run(invoke)
    asyncio.run(check())


def test_source_time_retains_microseconds_and_excludes_newer_tasks(setup):
    f=setup
    async def check():
        b=await bound(f)
        cut=datetime(2026,9,25,0,0,0,123456,tzinfo=timezone.utc)
        with psycopg.connect(f.dsn) as db:
            db.execute('UPDATE messages SET created_at=%s WHERE id=%s',(cut,b.source.sourceMessageId))
            db.execute('UPDATE runs SET created_at=%s WHERE id=%s',(cut+timedelta(microseconds=2),b.source.id))
        before=message(f,'earlier-microsecond',at=cut-timedelta(microseconds=1))
        after=message(f,'later-microsecond',at=cut+timedelta(microseconds=1))
        with activity(b):
            outcome,row,_=await run_read(f,b,'read_channel_context')
            assert outcome.status=='applied'
            data=await f.reads.load_result(b.context,row)
            assert before in {r['id'] for r in data} and after not in {r['id'] for r in data}
            assert row['intent']['effect']['source']['messageCutoff'].endswith('123456+00:00')
    asyncio.run(check())


def test_attachment_changed_between_plan_and_apply_and_symlink_refused(setup,tmp_path):
    f=setup
    async def check():
        async with f.files.lock(): item=f.files.persist(f.channel,'Version.txt',b'Original')
        b=await bound(f,instruction='Read [OpenBot attachment: '+item['id']+']')
        with activity(b):
            intent=await planned(f,b,'read_attachment',{'attachmentId':item['id']})
            async with f.files.lock():
                data=b'Changed version'
                metadata={**item,'sizeBytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
                f.files._write(item['id']+'.bin',data)
                f.files._write(item['id']+'.json',json.dumps(metadata).encode())
            outcome,_,_=await run_read(f,b,'read_attachment',intent=intent)
            assert outcome.status=='unknown'
            async with f.files.lock():
                f.files._remove(item['id']+'.bin')
                outside=tmp_path/'outside.txt'; outside.write_bytes(data)
                (f.files.root/(item['id']+'.bin')).symlink_to(outside)
            with pytest.raises(WorkConflict): await planned(f,b,'read_attachment',{'attachmentId':item['id']})
    asyncio.run(check())


def test_recorded_receipt_recovers_lost_ack_after_cancellation_without_exposing_result(setup):
    f=setup
    async def check():
        b=await bound(f)
        with activity(b):
            original=f.results.save
            saved=[]
            async def lose_ack(action_id,**kwargs):
                value=await original(action_id,**kwargs)
                saved.append(action_id)
                raise asyncio.CancelledError()
            with patch.object(f.results,'save',lose_ack):
                with pytest.raises(asyncio.CancelledError): await run_read(f,b,'read_channel_context')
            assert len(saved)==1
            async with f.store._transaction(trusted=True) as db: _,row=await f.store._action(db,saved[0])
            await f.store.cancel(f.token,b.context.task_id)
            f.reads=ProductWorkReads(f.store,object(),SCOPE,f.files,f.results)
            services=await f.reads.load(b.context,row['intent'])
            with patch.object(f.reads,'_invoke',side_effect=AssertionError('never invoke after cancel')):
                outcome=await recover_action(f.store,task_id=b.context.task_id,run_id=b.context.run_id,
                    action_id=row['id'],adapter=services.adapter,verifier=services.verifier)
            assert outcome.status=='applied' and outcome.invoked_apply is False
            async with f.store._transaction(trusted=True) as db: _,row=await f.store._action(db,saved[0])
            with pytest.raises(WorkConflict): await f.reads.load_result(b.context,row)
    asyncio.run(check())


@pytest.mark.parametrize('in_transaction',[False,True])
def test_consumed_attachment_is_revalidated_before_model_or_publication(setup,in_transaction):
    f=setup
    async def check():
        async with f.files.lock(): item=f.files.persist(f.channel,'Consumed.txt',b'Observed evidence')
        b=await bound(f,instruction='Read [OpenBot attachment: '+item['id']+']')
        async def validate():
            if in_transaction:
                async with f.files.lock():
                    async with f.store._transaction(trusted=True) as db:
                        await f.store._task(db,b.context.task_id)
                        return await f.reads.revalidate_in_transaction(db,b.context)
            return await f.reads.revalidate(b.context)
        with activity(b):
            outcome,_,_=await run_read(f,b,'read_attachment',{'attachmentId':item['id']})
            assert outcome.status=='applied'
            async with asyncio.timeout(3): assert await validate() is True
            with psycopg.connect(f.dsn) as db:
                before=db.execute('SELECT count(*) FROM work_actions WHERE task_id=%s',(b.context.task_id,)).fetchone()[0]
            async with asyncio.timeout(3): assert await validate() is True
            with psycopg.connect(f.dsn) as db:
                assert db.execute('SELECT count(*) FROM work_actions WHERE task_id=%s',(b.context.task_id,)).fetchone()[0]==before
            async with f.files.lock(): f.files.set_deleted(f.channel,item['id'],True)
            with pytest.raises(WorkConflict): await validate()
    asyncio.run(check())


def test_correction_history_reset_skips_old_generation_without_reusing_its_data(setup):
    f=setup
    async def check():
        async with f.files.lock(): item=f.files.persist(f.channel,'Prior.txt',b'Prior evidence')
        b=await bound(f,instruction='Read [OpenBot attachment: '+item['id']+']')
        with activity(b):
            outcome,row,_=await run_read(f,b,'read_attachment',{'attachmentId':item['id']})
            assert outcome.status=='applied'
            await CorrectionStore(f.store).request(f.token,b.context.task_id,run_id=b.context.run_id,
                instruction='Discard previous evidence',request_key='reset',expected_sequence=0)
            updated=await CorrectionStore(f.store).freeze(b.context.task_id,b.context.run_id,'updated')
            old=b.context; b.context=replace(b.context,correction_token=updated['id'])
            async with f.files.lock(): f.files.set_deleted(f.channel,item['id'],True)
            assert await f.reads.revalidate(b.context) is True
            with pytest.raises(WorkConflict): await f.reads.load_result(old,row)
            preserving=ProductWorkReads(f.store,object(),SCOPE,f.files,f.results,history_reset_on_correction=False)
            with pytest.raises(WorkConflict): await preserving.revalidate(b.context)
    asyncio.run(check())


def test_forged_applied_row_does_not_make_an_unsettled_observation_readable(setup):
    f=setup
    async def check():
        b=await bound(f)
        with activity(b):
            _,row,_=await run_read(f,b,'read_channel_context')
            with psycopg.connect(f.dsn) as db:
                db.execute("UPDATE work_actions SET status='unknown',actual_tokens=NULL,evidence=NULL WHERE id=%s",(row['id'],))
            with pytest.raises(WorkConflict): await f.reads.load_result(b.context,row)
    asyncio.run(check())


def test_prompt_requires_current_frozen_correction(setup):
    f=setup
    async def check():
        b=await bound(f)
        with activity(b):
            with pytest.raises(WorkConflict): await f.reads.read_prompt(replace(b.context,correction_token=None))
            assert (await f.reads.read_prompt(b.context))['bot']['id']==f.bot
    asyncio.run(check())


def test_prompt_preserves_profile_codepoint_contract(setup):
    f=setup
    async def check():
        b=await bound(f)
        with psycopg.connect(f.dsn) as db:
            db.execute('UPDATE bots SET role=%s,description=%s WHERE id=%s',('😀'*160,'😀'*2000,f.bot))
        with activity(b):
            prompt=await f.reads.read_prompt(b.context)
            assert prompt['bot']['role']=='😀'*160 and prompt['bot']['description']=='😀'*2000
    asyncio.run(check())


def test_prompt_descriptors_are_only_current_authorized_references_without_binary_parts(setup):
    f=setup
    async def check():
        async with f.files.lock():
            plain=f.files.persist(f.channel,'Listed.txt',b'Explicit text')
            pdf=f.files.persist(f.channel,'Listed.pdf',b'%PDF-1.7\nsynthetic\n%%EOF')
            f.files.persist(f.channel,'Unlisted.txt',b'Never disclose')
        b=await bound(f,instruction='Read '+''.join('[OpenBot attachment: '+v['id']+']' for v in (plain,pdf)))
        with activity(b):
            prompt=await f.reads.read_prompt(b.context)
            assert prompt['attachments']==[plain,pdf]
            assert set(prompt)=={'bot','source','attachments'}
            with pytest.raises(WorkConflict): await planned(f,b,'read_attachment',{'attachmentId':pdf['id']})
            async with f.files.lock(): f.files.set_deleted(f.channel,plain['id'],True)
            with pytest.raises(WorkConflict): await f.reads.read_prompt(b.context)
    asyncio.run(check())


def test_envelope_does_not_expose_extra_public_fields_or_malformed_pages(setup):
    from copy import deepcopy
    f=setup
    async def check():
        async with f.files.lock(): item=f.files.persist(f.channel,'Shape.txt',b'Evidence')
        b=await bound(f,instruction='Read [OpenBot attachment: '+item['id']+']')
        with activity(b):
            _,row,_=await run_read(f,b,'read_attachment',{'attachmentId':item['id'],'limit':3})
            saved=await f.results.load(row['id'],task_id=b.context.task_id,run_id=b.context.run_id,
                intent_digest=row['intent_digest'])
            assert f.reads._envelope(saved.value,row['intent'])['text']=='Evi'
            for mutation in ({'private':saved.value['receipt']},{'nextOffset':True},{'text':None},
                             {'untrusted':False},{'attachmentId':str(uuid4())}):
                forged=deepcopy(saved.value); forged['result'].update(mutation)
                with pytest.raises(WorkConflict): f.reads._envelope(forged,row['intent'])
            b.activity='status-shape'
            _,row,_=await run_read(f,b,'read_task_status')
            saved=await f.results.load(row['id'],task_id=b.context.task_id,run_id=b.context.run_id,
                intent_digest=row['intent_digest'])
            forged=deepcopy(saved.value); forged['result'][0]['instruction']='not a status field'
            with pytest.raises(WorkConflict): f.reads._envelope(forged,row['intent'])
    asyncio.run(check())


def test_late_bot_context_is_bounded_by_run_and_root_source_time(setup):
    f=setup
    async def check():
        b=await bound(f)
        cut=datetime(2026,9,25,0,0,0,tzinfo=timezone.utc)
        with psycopg.connect(f.dsn) as db:
            db.execute('UPDATE messages SET created_at=%s WHERE id=%s',(cut,b.source.sourceMessageId))
            db.execute('UPDATE runs SET created_at=%s WHERE id=%s',(cut+timedelta(seconds=2),b.source.id))
        allowed=message(f,'late eligible bot',at=cut+timedelta(seconds=1),author='bot',run=b.source.id)
        too_late=message(f,'after run cutoff',at=cut+timedelta(seconds=3),author='bot',run=b.source.id)
        future_source=message(f,'future task source',at=cut+timedelta(seconds=1))
        future_run=str(uuid4())
        with psycopg.connect(f.dsn) as db:
            db.execute('INSERT INTO runs(id,bot_id,channel_id,source_message_id,title,instruction,execution_profile) '
                "VALUES(%s,%s,%s,%s,'Future task','Later instruction','none')",
                (future_run,f.bot,f.channel,future_source))
        wrong_source=message(f,'later task reply',at=cut+timedelta(seconds=1),author='bot',run=future_run)
        with activity(b):
            _,row,_=await run_read(f,b,'read_channel_context')
            data=await f.reads.load_result(b.context,row)
            ids={r['id'] for r in data}
            assert allowed in ids and not ids.intersection({too_late,future_source,wrong_source})
    asyncio.run(check())
