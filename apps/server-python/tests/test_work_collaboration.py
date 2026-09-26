"""Owned PG, actual Temporal ActivityEnvironment, immutable synthetic start. No model/network."""
import asyncio
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock,patch
from uuid import uuid4

import psycopg
import pytest
from temporalio.testing import ActivityEnvironment
from openbot_agent_runtime.catalog import ToolCatalog
from openbot_agent_runtime.errors import RuntimeFailure
from openbot_server.task_inputs import CreateMessageInput
from openbot_server.task_store import PostgresTaskStore
from openbot_server.work_corrections import CorrectionStore
from openbot_server.work_deferred import DeferredActivities
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_handoff import HandoffStore
from openbot_server.work_sources import WorkSourceAdmission
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_temporal_start import WorkRuntimeContext
from openbot_server.work_tool_results import ToolResults
from openbot_server.work_values import InvalidWork,WorkConflict
from openbot_server.work_product_collaboration import WorkCollaborationAdapter,collaboration_tool_descriptors
from openbot_server import work_collaboration as tree

SCOPE=dict(expected_namespace='default',expected_queue='collaboration-fixture',expected_workflow_type='collaboration-workflow')

@pytest.fixture
def anyio_backend():return 'asyncio'

@pytest.fixture
def seed(fixture):
    bots=[str(uuid4()) for _ in range(7)];channel=str(uuid4())
    with psycopg.connect(fixture['dsn']) as db:
        for bot in bots:db.execute("INSERT INTO bots(id,name,role,computer_profile) VALUES(%s,%s,'assistant','none')",(bot,'Collaboration '+bot))
        db.execute("INSERT INTO channels(id,name,description) VALUES(%s,%s,'Synthetic only')",(channel,'Collaboration '+channel))
        for bot in bots:db.execute('INSERT INTO channel_bots(channel_id,bot_id) VALUES(%s,%s)',(channel,bot))
    yield {**fixture,'botId':bots[0],'bots':bots,'channelId':channel}
    with psycopg.connect(fixture['dsn']) as db:
        db.execute('DELETE FROM work_collaborations WHERE root_task_id IN (SELECT id FROM work_tasks WHERE bot_id=ANY(%s))',(bots,))
        for table in ('work_tool_results','work_sources','work_actions','work_artifacts','work_correction_contexts','work_corrections','work_events'):
            db.execute(f'DELETE FROM {table} WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=ANY(%s))',(bots,))
        for table in ('work_claims','work_admissions'):
            db.execute(f'DELETE FROM {table} WHERE run_id IN (SELECT r.id FROM work_runs r JOIN work_tasks t ON t.id=r.task_id WHERE t.bot_id=ANY(%s))',(bots,))
        db.execute('DELETE FROM work_runs WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=ANY(%s))',(bots,))
        db.execute('DELETE FROM work_tasks WHERE bot_id=ANY(%s)',(bots,))
        db.execute('DELETE FROM runs WHERE bot_id=ANY(%s)',(bots,))
        db.execute('DELETE FROM run_events WHERE channel_id=%s OR bot_id=ANY(%s)',(channel,bots))
        db.execute('DELETE FROM channels WHERE id=%s',(channel,))
        db.execute('DELETE FROM bots WHERE id=ANY(%s)',(bots,))

async def harness(seed,tmp_path,*,existing=None,connections=None,files=None,instruction='Collaborate on synthetic evidence'):
    base=tmp_path.resolve();base.mkdir(exist_ok=True);base.chmod(0o700);(base/'blobs').mkdir(mode=0o700)
    store=PostgresWorkStore(seed['dsn']);sources=WorkSourceAdmission(store,token_limit=1000)
    if existing is None:
        source=await PostgresTaskStore(seed['dsn'],files=files,work_sources=sources).submit(seed['token'],seed['channelId'],CreateMessageInput(content=instruction,botId=seed['botId']))
        async with store._transaction(trusted=True) as db:
            row=await (await db.execute('SELECT task_id FROM work_sources WHERE legacy_run_id=%s',(source.run.id,))).fetchone()
        task_id=row['task_id']
    else:task_id=existing
    task=await store.snapshot(seed['token'],task_id);run=task['runs'][0]['id']
    correction=await CorrectionStore(store).freeze(task['id'],run,'initial')
    context=WorkRuntimeContext(task['id'],run,task['botId'],task['objective'],1000,correction['id'])
    workflow='openbot-work-v1-'+run;reference='temporal:default:'+workflow
    handoff=HandoffStore(store);reservation=await handoff.reserve_submission(task['id'],run,reference)
    await handoff.acknowledge(task['id'],run,reference,reservation.attempt_id,'fixture-engine')
    start_input=dict(taskId=task['id'],runId=run,attemptId=reservation.attempt_id)
    start=SimpleNamespace(workflow_id=workflow,first_execution_run_id='fixture-engine',task_queue=SimpleNamespace(name=SCOPE['expected_queue']),
        workflow_type=SimpleNamespace(name=SCOPE['expected_workflow_type']),input=SimpleNamespace(payloads=['fixture-payload']))
    event=SimpleNamespace(HasField=lambda value:value=='workflow_execution_started_event_attributes',workflow_execution_started_event_attributes=start)
    async def history(*,page_size):assert page_size==1;yield event
    def handle(workflow_id,*,run_id):
        assert workflow_id==workflow and run_id=='fixture-engine'
        return SimpleNamespace(fetch_history_events=history)
    client=SimpleNamespace(namespace='default',get_workflow_handle=handle,data_converter=SimpleNamespace(decode=AsyncMock(return_value=[start_input])))
    env=ActivityEnvironment();env.info=replace(env.info,namespace='default',task_queue=SCOPE['expected_queue'],workflow_id=workflow,
        workflow_run_id='fixture-engine',workflow_type=SCOPE['expected_workflow_type'],activity_id='prepare')
    results=ToolResults(store,LocalWorkFiles(base/'blobs'))
    adapter=WorkCollaborationAdapter(store,client,SCOPE,sources,results,files,connections,history_reset_on_correction=True)
    async def catalog(_):return ToolCatalog(collaboration_tool_descriptors(),max_tools=4,max_bytes=8192)
    host=SimpleNamespace(store=store,client=client,scope=SCOPE,load_tool_result=adapter.load_result,ports=SimpleNamespace(deferred_catalog=catalog))
    activities=DeferredActivities(host,adapter.prepare,adapter.load)
    # Actual production has a prior model Activity claim. Explicit synthetic root origin here.
    await store.claim(task['id'],run,'initial-model-'+run)
    async def prepare(number,tool='start_task',args=None):
        env.info=replace(env.info,activity_id='prepare-'+str(number))
        return await env.run(activities.prepare_request,dict(call_id='untrusted-correlation',tool=tool,
            arguments=args or dict(botId=seed['bots'][1],task='Review synthetic evidence')),correction['id'])
    async def row(identity):
        async with store._transaction(trusted=True) as db:return (await store._action(db,identity))[1]
    async def execute(identity):
        env.info=replace(env.info,activity_id='execute-'+identity)
        return await env.run(activities.execute,identity)
    async def relations():
        async with store._transaction(trusted=True) as db:
            return await (await db.execute('SELECT * FROM work_collaborations WHERE parent_task_id=%s ORDER BY created_at',(task['id'],))).fetchall()
    return SimpleNamespace(**locals())

@pytest.mark.anyio
async def test_create_once_and_original_receipt(seed,tmp_path):
    h=await harness(seed,tmp_path);identity=await h.prepare(0)
    assert (await h.execute(identity))['status']=='applied'
    assert (await h.execute(identity))['status']=='applied'
    relations=await h.relations();assert len(relations)==1
    result=await h.env.run(h.activities.result,identity)
    assert result['result']==dict(runId=relations[0]['child_source_run_id'],botId=seed['bots'][1],status='queued')
    with psycopg.connect(seed['dsn']) as db:
        row=db.execute('SELECT author_type,author_id,content FROM messages WHERE id=%s',(relations[0]['assignment_message_id'],)).fetchone()
        assert row==('bot',seed['botId'],'Review synthetic evidence')
        assert db.execute('SELECT state FROM work_admissions WHERE run_id=%s',(relations[0]['child_work_run_id'],)).fetchone()==('pending',)
    assert await h.env.run(h.adapter.unconsumed_children,h.context)==(identity,)

@pytest.mark.anyio
async def test_sql_commit_with_lost_tool_ack_recovers_original_without_create(seed,tmp_path):
    h=await harness(seed,tmp_path);identity=await h.prepare(0)
    with patch.object(h.results,'save',side_effect=asyncio.CancelledError()),pytest.raises(asyncio.CancelledError):await h.execute(identity)
    assert len(await h.relations())==1
    with patch.object(h.adapter,'invoke',side_effect=AssertionError('Never resend')):
        assert (await h.execute(identity))['status']=='applied'
    assert len(await h.relations())==1

@pytest.mark.anyio
async def test_missing_commit_is_unknown_never_creates_on_recovery(seed,tmp_path):
    h=await harness(seed,tmp_path);identity=await h.prepare(0)
    with patch.object(h.adapter,'invoke',side_effect=ConnectionError('synthetic lost before SQL')):
        assert (await h.execute(identity))['status']=='unknown'
    assert (await h.execute(identity))['status']=='unknown'
    assert not await h.relations()

@pytest.mark.anyio
async def test_wait_readiness_has_no_effect_and_terminal_observation(seed,tmp_path):
    h=await harness(seed,tmp_path);identity=await h.prepare(0);await h.execute(identity)
    child=(await h.relations())[0]
    join=await h.env.run(h.adapter.join_request,h.context,identity)
    wait=await h.prepare(1,'wait_for_task',join.arguments);row=await h.row(wait)
    for _ in range(2):assert await h.env.run(h.adapter.readiness,h.context,row)=='pending'
    assert (await h.row(wait))['status']=='proposed'
    with psycopg.connect(seed['dsn']) as db:
        db.execute("UPDATE work_tasks SET status='completed',result_summary='Committed synthetic answer' WHERE id=%s",(child['child_task_id'],))
        db.execute("UPDATE work_runs SET status='completed' WHERE id=%s",(child['child_work_run_id'],))
    assert await h.env.run(h.adapter.readiness,h.context,row)=='ready'
    assert (await h.execute(wait))['status']=='applied'
    assert (await h.env.run(h.activities.result,wait))['result']['result']=='Committed synthetic answer'
    assert await h.env.run(h.adapter.unconsumed_children,h.context)==()

@pytest.mark.anyio
async def test_concurrent_same_action_cannot_create_twice(seed,tmp_path):
    h=await harness(seed,tmp_path);identity=await h.prepare(0)
    # Distinct concurrent SDK invocations of one Action: admission owns the at-most-once send.
    outcomes=await asyncio.gather(h.execute(identity),h.execute(identity),return_exceptions=True)
    assert any(isinstance(x,dict) and x['status']=='applied' for x in outcomes)
    assert len(await h.relations())==1

@pytest.mark.anyio
async def test_tree_descendant_limit_serializes_different_actions(seed,tmp_path):
    h=await harness(seed,tmp_path)
    identities=[await h.prepare(i,args=dict(botId=seed['bots'][i+1],task='bounded '+str(i))) for i in range(5)]
    # Each real execute holds its own live claim, so run sequentially; tree cap is durable.
    results=[await h.execute(identity) for identity in identities]
    assert [r['status'] for r in results]==['applied']*4+['unknown']
    assert len(await h.relations())==4

@pytest.mark.anyio
async def test_cascade_and_historical_lookup_after_cancel(seed,tmp_path):
    h=await harness(seed,tmp_path);identity=await h.prepare(0)
    with patch.object(h.results,'save',side_effect=asyncio.CancelledError()),pytest.raises(asyncio.CancelledError):await h.execute(identity)
    child=(await h.relations())[0]
    await h.store.cancel(seed['token'],h.task['id'])
    async with h.store._transaction(trusted=True) as db:
        task=await h.store._task(db,child['child_task_id'])
        assert task['cancel_requested'] and not task['authority_active']
        with pytest.raises(WorkConflict):h.store._active(task)
    services=await h.adapter.load(h.context,(await h.row(identity))['intent'])
    assert await services.adapter.lookup(identity) is not None
    assert len(await h.relations())==1

@pytest.mark.anyio
@pytest.mark.parametrize('change',['membership','profile','correction','expiry','source','missing_claim','expired_tree'])
async def test_current_creation_guard(seed,tmp_path,change):
    h=await harness(seed,tmp_path);identity=await h.prepare(0)
    if change=='correction':await CorrectionStore(h.store).request(seed['token'],h.task['id'],run_id=h.run,instruction='Changed',request_key='changed',expected_sequence=0)
    else:
        with psycopg.connect(seed['dsn']) as db:
            if change=='membership':db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(seed['channelId'],seed['bots'][1]))
            elif change=='profile':db.execute("UPDATE bots SET computer_profile='docker-linux' WHERE id=%s",(seed['bots'][1],))
            elif change=='expiry':db.execute("UPDATE work_actions SET expires_at=clock_timestamp()-interval '1s' WHERE id=%s",(identity,))
            elif change=='source':db.execute("UPDATE runs SET instruction='tampered' WHERE id=%s",(h.source.run.id,))
            elif change=='missing_claim':db.execute("DELETE FROM work_events WHERE task_id=%s AND kind='run.claimed'",(h.task['id'],))
            else:db.execute("UPDATE work_events SET created_at=clock_timestamp()-interval '301s' WHERE task_id=%s AND kind='run.claimed'",(h.task['id'],))
    try:outcome=await h.execute(identity)
    except WorkConflict:pass
    else:assert outcome['status'] in ('unknown','superseded','expired')
    assert not await h.relations()

@pytest.mark.anyio
async def test_plain_task_lifetime_unchanged_and_exact_claim_origin(seed,tmp_path):
    h=await harness(seed,tmp_path)
    with psycopg.connect(seed['dsn']) as db:
        db.execute("UPDATE work_events SET created_at=clock_timestamp()-interval '301s' WHERE task_id=%s AND kind='run.claimed'",(h.task['id'],))
    async with h.store._transaction(trusted=True) as db:
        task=await h.store._task(db,h.task['id']);h.store._active(task)
    with pytest.raises(WorkConflict,match='deadline'):await h.prepare(0)

@pytest.mark.anyio
async def test_direct_children_only_and_no_ancestor_delegate(seed,tmp_path):
    h=await harness(seed,tmp_path);identity=await h.prepare(0);await h.execute(identity);child=(await h.relations())[0]
    c=await harness(seed,tmp_path/'child',existing=child['child_task_id'])
    with pytest.raises(WorkConflict):await c.prepare(0,args=dict(botId=seed['botId'],task='No back delegation'))
    other=await c.prepare(1,args=dict(botId=seed['bots'][2],task='Second level'));await c.execute(other)
    grand=(await c.relations())[0]
    with pytest.raises(WorkConflict):await h.prepare(2,'wait_for_task',dict(runId=grand['child_source_run_id']))
    g=await harness(seed,tmp_path/'grand',existing=grand['child_task_id'])
    with pytest.raises(WorkConflict):await g.prepare(0,args=dict(botId=seed['bots'][3],task='Third level refused'))
    await h.store.revoke(seed['token'],h.task['id'])
    async with g.store._transaction(trusted=True) as db:
        task=await g.store._task(db,g.task['id'])
        with pytest.raises(WorkConflict):g.store._active(task)

@pytest.mark.anyio
async def test_concurrent_creation_serializes_whole_tree_limit(seed,tmp_path):
    from openbot_server.work_temporal_activity import derive_claim_id
    h=await harness(seed,tmp_path)
    identities=[await h.prepare(i,args=dict(botId=seed['bots'][1+i%6],task='concurrent '+str(i))) for i in range(6)]
    h.env.info=replace(h.env.info,activity_id='concurrent-dispatch')
    claim=derive_claim_id('default',h.workflow,'fixture-engine','concurrent-dispatch')
    fence=await h.store.claim(h.task['id'],h.run,claim)
    rows=[]
    for identity in identities:
        await h.store.admit(identity,fence=fence);rows.append(await h.row(identity))
    outcomes=await asyncio.gather(*(h.env.run(h.adapter.invoke,h.context,row['id'],row['intent']) for row in rows),return_exceptions=True)
    assert sum(isinstance(x,dict) for x in outcomes)==4
    assert sum(isinstance(x,WorkConflict) and str(x)=='collaboration_task_limit' for x in outcomes)==2
    assert len(await h.relations())==4

@pytest.mark.anyio
async def test_wait_refuses_removed_child_membership(seed,tmp_path):
    h=await harness(seed,tmp_path);identity=await h.prepare(0);await h.execute(identity)
    child=(await h.relations())[0];wait=await h.prepare(1,'wait_for_task',dict(runId=child['child_source_run_id']))
    with psycopg.connect(seed['dsn']) as db:
        db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(seed['channelId'],seed['bots'][1]))
    with pytest.raises(WorkConflict):await h.env.run(h.adapter.readiness,h.context,await h.row(wait))

@pytest.mark.anyio
async def test_failure_cascade_descendants_only_preserves_unknown(seed,tmp_path):
    h=await harness(seed,tmp_path);identity=await h.prepare(0);await h.execute(identity);child=(await h.relations())[0]
    c=await harness(seed,tmp_path/'child',existing=child['child_task_id'])
    action=await c.prepare(0,args=dict(botId=seed['bots'][2],task='unknown only'))
    with patch.object(c.adapter,'invoke',side_effect=ConnectionError('lost')):assert (await c.execute(action))['status']=='unknown'
    async with h.store._transaction(trusted=True) as db:
        await h.store._task(db,h.task['id'])
        assert await tree.cascade(db,h.store,h.task['id'],reason='failed',include_self=False)==(child['child_task_id'],)
    parent=await h.store.snapshot(seed['token'],h.task['id']);descendant=await c.store.snapshot(seed['token'],c.task['id'])
    assert parent['authorityActive'] and not parent['cancelRequested']
    assert not descendant['authorityActive'] and descendant['cancelRequested'] and descendant['status']=='open'
    assert (await c.row(action))['status']=='unknown'

@pytest.mark.anyio
async def test_child_context_keeps_root_time_and_excludes_ancestors(seed,tmp_path):
    from openbot_server.work_product_reads import ProductWorkReads
    h=await harness(seed,tmp_path);identity=await h.prepare(0);await h.execute(identity);child=(await h.relations())[0]
    later=str(uuid4())
    with psycopg.connect(seed['dsn']) as db:
        db.execute("INSERT INTO messages(id,channel_id,author_type,content) VALUES(%s,%s,'human','Later unrelated Owner task')",(later,seed['channelId']))
        db.execute("UPDATE bots SET computer_profile='model' WHERE id=%s",(seed['bots'][2],))
    c=await harness(seed,tmp_path/'child',existing=child['child_task_id'])
    reads=ProductWorkReads(c.store,c.client,SCOPE,None,c.results)
    async def read():
        bound=await reads._bind(c.context)
        async with c.store._transaction(trusted=True) as db:
            _,_,source,_,_=await reads._source(db,c.context,bound)
            return source,await reads._context(db,source),await reads._colleagues(db,c.context,source)
    source,messages,catalog=await c.env.run(read)
    assert child['assignment_message_id'] in {x['id'] for x in messages}
    assert h.source.run.sourceMessageId in {x['id'] for x in messages}
    assert later not in {x['id'] for x in messages}
    assert source['messageId']==child['assignment_message_id']
    peers={x['id'] for x in catalog['bots']}
    assert seed['botId'] not in peers and seed['bots'][1] not in peers and seed['bots'][2] in peers

@pytest.mark.anyio
@pytest.mark.parametrize('change',[None,'selection','disable','revision'])
async def test_target_own_model_snapshot_and_grant(seed,tmp_path,change):
    from openbot_server.model_connections import ModelConnectionsService
    from openbot_server.model_connections_cipher import ModelCredentialCipher
    svc=ModelConnectionsService(seed['dsn'],ModelCredentialCipher(b'c'*32))
    connection=await svc.create(seed['token'],dict(name='Collaboration '+str(uuid4()),presetId='kimi',baseUrl='https://api.moonshot.cn/v1',apiKey='synthetic-only'))
    try:
        with psycopg.connect(seed['dsn']) as db:db.execute("UPDATE bots SET computer_profile='model' WHERE id=%s",(seed['bots'][1],))
        selection=dict(connectionId=connection['id'],modelId='target-own-model')
        await svc.update_employee_model(seed['token'],seed['bots'][1],dict(expectedRevision=1,model=selection))
        h=await harness(seed,tmp_path,connections=svc);identity=await h.prepare(0)
        intent=(await h.row(identity))['intent'];assert intent['effect']['target']['modelSelection']==selection
        assert 'synthetic-only' not in str(intent)
        if change=='selection':await svc.update_employee_model(seed['token'],seed['bots'][1],dict(expectedRevision=2,model=dict(connectionId=connection['id'],modelId='changed')))
        elif change=='disable':await svc.update(seed['token'],connection['id'],dict(expectedRevision=1,enabled=False))
        elif change=='revision':await svc.update(seed['token'],connection['id'],dict(expectedRevision=1,apiKey='synthetic-new'))
        result=await h.execute(identity)
        if change is None:
            assert result['status']=='applied'
            child=(await h.relations())[0]
            with psycopg.connect(seed['dsn']) as db:
                assert db.execute('SELECT model_selection FROM runs WHERE id=%s',(child['child_source_run_id'],)).fetchone()[0]==selection
        else:assert result['status']=='unknown' and not await h.relations()
    finally:
        with psycopg.connect(seed['dsn']) as db:db.execute('DELETE FROM model_connections WHERE id=%s',(connection['id'],))

@pytest.mark.anyio
@pytest.mark.parametrize('change',[None,'ungranted','delete','tamper'])
async def test_only_original_attachment_refs_survive_current_validation(seed,tmp_path,change):
    from openbot_server.owner_files import OwnerFiles
    directory=tmp_path/'attachments';directory.mkdir(mode=0o700)
    files=OwnerFiles(directory.resolve());item=files.persist(seed['channelId'],'evidence.txt',b'Synthetic original')
    marker='[OpenBot attachment: '+item['id']+']'
    h=await harness(seed,tmp_path,files=files,instruction='Original evidence '+marker)
    args=dict(botId=seed['bots'][1],task='Use original '+marker)
    if change=='ungranted':
        other=files.persist(seed['channelId'],'other.txt',b'Not granted')
        args['task']='[OpenBot attachment: '+other['id']+']'
        with pytest.raises(WorkConflict):await h.prepare(0,args=args)
        return
    identity=await h.prepare(0,args=args)
    if change=='delete':files.set_deleted(seed['channelId'],item['id'],True)
    elif change=='tamper':(directory/(item['id']+'.bin')).write_bytes(b'Tampered original')
    result=await h.execute(identity)
    assert result['status']==('applied' if change is None else 'unknown')
    assert len(await h.relations())==(1 if change is None else 0)

@pytest.mark.anyio
async def test_forged_context_and_extra_authority_fields_fail_closed(seed,tmp_path):
    h=await harness(seed,tmp_path)
    for extra in ('skipApproval','parentRunId','channelId','tokenLimit','rootTaskId'):
        with pytest.raises((InvalidWork,ValueError,RuntimeFailure)):
            await h.prepare(extra,args=dict(botId=seed['bots'][1],task='safe',**{extra:True}))
    identity=await h.prepare(0);intent=(await h.row(identity))['intent']
    with pytest.raises(RuntimeError):await h.adapter.invoke(h.context,identity,intent)
    with pytest.raises(WorkConflict):await h.env.run(h.adapter.invoke,replace(h.context,bot_id=seed['bots'][1]),identity,intent)
    assert not await h.relations()

@pytest.mark.anyio
async def test_source_uuid_case_and_ecmascript_trim(seed,tmp_path):
    h=await harness(seed,tmp_path);identity=await h.prepare(0,args=dict(botId=seed['bots'][1].upper(),task='\ufeff  Exact synthetic assignment \n'))
    assert (await h.execute(identity))['status']=='applied'
    child=(await h.relations())[0]
    wait=await h.prepare(1,'wait_for_task',dict(runId=child['child_source_run_id'].upper()))
    assert await h.env.run(h.adapter.readiness,h.context,await h.row(wait))=='pending'
    with psycopg.connect(seed['dsn']) as db:
        assert db.execute('SELECT instruction FROM runs WHERE id=%s',(child['child_source_run_id'],)).fetchone()[0]=='Exact synthetic assignment'

@pytest.mark.anyio
async def test_before_commit_expiry_rolls_back_all_child_rows(seed,tmp_path):
    h=await harness(seed,tmp_path);identity=await h.prepare(0);original=h.sources.admit
    async def expire(db,run):
        value=await original(db,run)
        await db.execute("UPDATE work_actions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=%s",(identity,))
        return value
    with patch.object(h.sources,'admit',expire):assert (await h.execute(identity))['status']=='unknown'
    assert not await h.relations()
    with psycopg.connect(seed['dsn']) as db:
        assert db.execute('SELECT count(*) FROM messages WHERE channel_id=%s AND author_type=\'bot\'',(seed['channelId'],)).fetchone()[0]==0
        assert db.execute('SELECT count(*) FROM work_tasks WHERE bot_id=%s',(seed['bots'][1],)).fetchone()[0]==0

@pytest.mark.anyio
async def test_concurrent_cancel_and_creation_leave_no_live_child(seed,tmp_path):
    h=await harness(seed,tmp_path);identity=await h.prepare(0)
    outcomes=await asyncio.gather(h.execute(identity),h.store.cancel(seed['token'],h.task['id']),return_exceptions=True)
    assert any(isinstance(x,dict) and x.get('cancelRequested') for x in outcomes)
    with psycopg.connect(seed['dsn']) as db:
        assert db.execute('SELECT count(*) FROM work_collaborations c JOIN work_tasks t ON t.id=c.child_task_id '
            'WHERE c.root_task_id=%s AND t.authority_active',(h.task['id'],)).fetchone()[0]==0

@pytest.mark.anyio
@pytest.mark.parametrize('state',['failed','cancelled'])
async def test_committed_child_failures_are_honest_observations(seed,tmp_path,state):
    h=await harness(seed,tmp_path);identity=await h.prepare(0);await h.execute(identity);child=(await h.relations())[0]
    wait=await h.prepare(1,'wait_for_task',dict(runId=child['child_source_run_id']))
    with psycopg.connect(seed['dsn']) as db:db.execute('UPDATE work_tasks SET status=%s WHERE id=%s',(state,child['child_task_id']))
    assert await h.env.run(h.adapter.readiness,h.context,await h.row(wait))=='ready'
    assert (await h.execute(wait))['status']=='applied'
    result=(await h.env.run(h.activities.result,wait))['result']
    assert result['status']==state and result['error']=='child_'+state and 'result' not in result

@pytest.mark.parametrize('task,accepted',[('x'*4000,True),('😀'*2000,True),('😀'*2001,False),('\ufeff \n',False)])
def test_retained_utf16_and_trim_bound(task,accepted):
    from openbot_server.work_product_collaboration import _input
    value=dict(botId=str(uuid4()),task=task)
    if accepted:assert _input('start_task',value)==value['botId']
    else:
        with pytest.raises(InvalidWork):_input('start_task',value)
