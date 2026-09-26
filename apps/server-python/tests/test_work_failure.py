"""Owned PostgreSQL and real SDK ActivityEnvironment; history is synthetic, no live engine."""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import psycopg
from psycopg import sql
import pytest
pytest.importorskip('temporalio')
from temporalio.testing import ActivityEnvironment
from temporalio.converter import DataConverter
from temporalio.exceptions import ApplicationError
from temporalio.service import RPCError, RPCStatusCode

from openbot_server import work_failure as failure
from openbot_server.work_engine_binding import assert_historical_workflow_in_transaction
from openbot_server.work_handoff import HandoffStore
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_values import WorkConflict
from test_work_collaboration import seed

REQUEST = dict(version=1, code='execution_failed')
SCOPE = dict(expected_namespace='default', expected_queue='failure-test', expected_workflow_type='OpenBotWorkV1')


async def harness(seed, *, task=None, store=None):
    store = store or PostgresWorkStore(seed['dsn'])
    task = task or await store.create(seed['token'], bot_id=seed['botId'], objective='Synthetic failure',
                                     token_limit=100, request_key=str(uuid4()))
    run = task['runs'][0]['id']; workflow = 'openbot-work-v1-'+run
    handoffs = HandoffStore(store); ref = 'temporal:default:'+workflow
    reserved = await handoffs.reserve_submission(task['id'], run, ref)
    if reserved.should_start:
        await handoffs.acknowledge(task['id'], run, ref, reserved.attempt_id, 'failure-first')
    async with store._transaction(trusted=True) as db:
        admission = await (await db.execute('SELECT * FROM work_admissions WHERE run_id=%s',(run,))).fetchone()
    start_input = dict(taskId=task['id'], runId=run, attemptId=admission['submission_attempt_id'])
    converter=DataConverter.default; payloads=await converter.encode([start_input])
    start=SimpleNamespace(workflow_id=workflow,first_execution_run_id=admission['engine_first_run_id'],
        workflow_type=SimpleNamespace(name='OpenBotWorkV1'),task_queue=SimpleNamespace(name='failure-test'),
        input=SimpleNamespace(payloads=payloads))
    event=SimpleNamespace(HasField=lambda name:name=='workflow_execution_started_event_attributes',
                          workflow_execution_started_event_attributes=start)
    state=dict(error=None, event=event); handles=[]
    async def history(*,page_size):
        assert page_size == 1
        if state['error']: raise state['error']
        if state['event'] is not None: yield state['event']
    def handle(workflow_id, *, run_id):
        handles.append((workflow_id,run_id))
        return SimpleNamespace(fetch_history_events=history)
    client=SimpleNamespace(namespace='default',data_converter=converter,get_workflow_handle=handle)
    completion=AsyncMock(side_effect=AssertionError('No completed result expected'))
    service=failure.FailureActivities(store,client,namespace='default',queue='failure-test',completed_result=completion)
    env=ActivityEnvironment(); env.info=replace(env.info,namespace='default',task_queue='failure-test',
        workflow_id=workflow,workflow_run_id='failure-current',workflow_type='OpenBotWorkV1',
        activity_id='failure-activity',activity_type=failure.ACTIVITY_NAME)
    async def invoke(request=None):return await env.run(service.finalize,REQUEST if request is None else request)
    async def snapshot():return await store.snapshot(seed['token'],task['id'])
    async def action(status='admitted',key=None):
        fence=await store.claim(task['id'],run,'fixture-claim')
        from openbot_server.work_corrections import CorrectionStore
        async with store._transaction(trusted=True) as db:
            enabled=(await (await db.execute('SELECT corrections_enabled FROM work_runs WHERE id=%s',(run,))).fetchone())['corrections_enabled']
        context=(await CorrectionStore(store).freeze(task['id'],run,'failure-fixture'))['id'] if enabled else None
        identity=await store.propose(task['id'],run,fence=fence,action_key=key or str(uuid4()),
            intent=dict(effect='synthetic-only'),reserved_tokens=3,requires_approval=False,correction_context=context)
        if status!='proposed': await store.admit(identity,fence=fence)
        if status=='unknown':await store.uncertain(identity)
        if status in ('applied','not_applied'):
            await store.resolve(identity,applied=status=='applied',actual_tokens=2,
                                evidence=dict(source='synthetic',reference=identity,sha256='a'*64))
        return identity
    return SimpleNamespace(**locals())


@pytest.mark.anyio
@pytest.mark.parametrize('code', sorted(failure.FAILURE_CODES))
async def test_queued_task_closes_and_ack_replay_is_immutable(seed,code):
    h=await harness(seed); before=await h.snapshot()
    value=dict(version=1,code=code); first=await h.invoke(value)
    assert first['disposition']=='failed' and first['publicCode']==code
    after=await h.snapshot()
    assert after['status']=='failed' and not after['authorityActive']
    async with h.store._transaction(trusted=True) as db:
        row=await h.store._task(db,h.task['id'])
        assert row['authority_generation']==2
    assert after['runs'][0]['status']=='failed'
    h.env.info=replace(h.env.info,attempt=2)
    assert await h.invoke(value)==first and await h.snapshot()==after
    assert h.handles==[(h.workflow,'failure-current')]*2
    assert len([e for e in after['events'] if e['kind']=='task.failed'])==1
    assert h.completion.await_count==0


@pytest.mark.anyio
async def test_unknown_reservations_and_verified_late_receipt_survive(seed):
    h=await harness(seed)
    ids={state:await h.action(state) for state in ('admitted','unknown','applied','not_applied','proposed')}
    before=await h.snapshot(); first=await h.invoke(); after=await h.snapshot()
    assert after['usage']==before['usage']==dict(tokenLimit=100,reservedTokens=6,spentTokens=4)
    assert after['attention']=='reconciliation' and first['unresolvedActions']==2
    assert {a['id']:a['status'] for a in after['actions']}=={v:('unknown' if k=='admitted' else k) for k,v in ids.items()}
    await h.store.resolve(ids['admitted'],applied=True,actual_tokens=2,
                          evidence=dict(source='synthetic',reference=ids['admitted'],sha256='b'*64))
    settled=await h.snapshot(); assert settled['status']=='failed'
    assert settled['usage']==dict(tokenLimit=100,reservedTokens=3,spentTokens=6)
    assert await h.invoke()==first and await h.snapshot()==settled
    with pytest.raises(WorkConflict):await h.store.claim(h.task['id'],h.run,'new-effect')


@pytest.mark.anyio
@pytest.mark.parametrize('with_action',[False,True])
async def test_owner_cancel_has_priority_and_late_truth_can_finish_it(seed,with_action):
    h=await harness(seed); identity=await h.action() if with_action else None
    await h.store.cancel(seed['token'],h.task['id'])
    result=await h.invoke(); after=await h.snapshot()
    assert result['disposition']=='cancellation_preserved' and result['cancelRequested']
    assert after['status']==('open' if with_action else 'cancelled')
    assert not [e for e in after['events'] if e['kind']=='task.failed']
    assert await h.invoke()==result and await h.snapshot()==after
    if identity:
        assert after['actions'][0]['status']=='unknown' and after['usage']['reservedTokens']==3
        await h.store.resolve(identity,applied=False,actual_tokens=0,
                             evidence=dict(source='synthetic',reference=identity,sha256='c'*64))
        assert (await h.invoke())['taskStatus']=='cancelled'


@pytest.mark.anyio
async def test_revoke_cannot_prevent_monotonic_closure(seed):
    h=await harness(seed); await h.store.revoke(seed['token'],h.task['id'])
    assert (await h.invoke())['disposition']=='failed'


@pytest.mark.anyio
async def test_changed_request_on_same_actual_activity_is_not_ack_replay(seed):
    h=await harness(seed); await h.invoke(); before=await h.snapshot()
    with pytest.raises(ApplicationError) as e:await h.invoke(dict(version=1,code='startup_failed'))
    assert e.value.non_retryable and await h.snapshot()==before
    h.env.info=replace(h.env.info,activity_id='different-finalizer')
    result=await h.invoke(dict(version=1,code='startup_failed'))
    assert result['disposition']=='already_failed' and result['publicCode']=='execution_failed'
    assert await h.snapshot()==before


@pytest.mark.anyio
@pytest.mark.parametrize('change',['queue','namespace','type','activity_type','activity_id','current_run','first_run','attempt','missing_history','unacknowledged'])
async def test_actual_sdk_and_acknowledged_start_are_mandatory(seed,change):
    h=await harness(seed); before=await h.snapshot()
    if change=='queue':h.env.info=replace(h.env.info,task_queue='wrong')
    if change=='namespace':h.env.info=replace(h.env.info,namespace='wrong')
    if change=='type':h.env.info=replace(h.env.info,workflow_type='wrong')
    if change=='activity_type':h.env.info=replace(h.env.info,activity_type='wrong')
    if change=='activity_id':h.env.info=replace(h.env.info,activity_id='')
    if change=='current_run':h.env.info=replace(h.env.info,workflow_run_id='')
    if change=='first_run':h.start.first_execution_run_id='replacement-chain'
    if change=='attempt':h.start.input.payloads=await h.converter.encode([h.start_input|dict(attemptId='f'*32)])
    if change=='missing_history':h.state['event']=None
    if change=='unacknowledged':
        with psycopg.connect(seed['dsn']) as db:db.execute("UPDATE work_admissions SET state='pending',engine_reference=NULL,engine_first_run_id=NULL WHERE run_id=%s",(h.run,))
        before=await h.snapshot()
    with pytest.raises(ApplicationError) as e:await h.invoke()
    assert e.value.non_retryable and await h.snapshot()==before


@pytest.mark.anyio
@pytest.mark.parametrize('value',[None,{},dict(version=True,code='execution_failed'),dict(version=1,code='secret-token'),
                                  dict(version=1,code='execution_failed',taskId='other')])
async def test_untrusted_request_has_no_authority_and_no_error_echo(seed,value):
    h=await harness(seed); before=await h.snapshot()
    with pytest.raises(ApplicationError) as e:await h.env.run(h.service.finalize,value)
    assert e.value.non_retryable and 'secret-token' not in str(e.value)
    assert not h.handles and await h.snapshot()==before


@pytest.mark.anyio
async def test_outside_sdk_cannot_close_task(seed):
    h=await harness(seed); before=await h.snapshot()
    with pytest.raises(ApplicationError) as e:await h.service.finalize(REQUEST)
    assert e.value.non_retryable and not h.handles and await h.snapshot()==before


@pytest.mark.anyio
async def test_same_transaction_historical_proof_after_closure_has_no_nested_lock(seed):
    h=await harness(seed); await h.invoke()
    facts=await failure.inspect_activity_start(h.client,h.env.info,**SCOPE)
    async with asyncio.timeout(2),h.store._transaction(trusted=True) as db:
        await h.store._task(db,h.task['id'])
        accepted=await assert_historical_workflow_in_transaction(h.store,db,
            dict(taskId=h.task['id'],runId=h.run),facts,**SCOPE)
        assert accepted.run_id==h.run


@pytest.mark.anyio
async def test_sql_failure_rolls_back_unknown_and_terminal_state_then_retries(seed):
    h=await harness(seed);await h.action();before=await h.snapshot()
    name='failure_'+uuid4().hex
    with psycopg.connect(seed['dsn']) as db:
        db.execute(sql.SQL("CREATE FUNCTION {}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='task.failed' THEN RAISE EXCEPTION 'synthetic-private-detail'; END IF; RETURN NEW; END $$").format(sql.Identifier(name)))
        db.execute(sql.SQL('CREATE TRIGGER {} BEFORE INSERT ON work_events FOR EACH ROW EXECUTE FUNCTION {}()').format(sql.Identifier(name),sql.Identifier(name)))
    try:
        with pytest.raises(ApplicationError) as e:await h.invoke()
        assert not e.value.non_retryable and e.value.type=='WorkFinalizationUnavailable'
        assert 'synthetic-private-detail' not in str(e.value) and await h.snapshot()==before
    finally:
        with psycopg.connect(seed['dsn']) as db:
            db.execute(sql.SQL('DROP TRIGGER {} ON work_events').format(sql.Identifier(name)))
            db.execute(sql.SQL('DROP FUNCTION {}()').format(sql.Identifier(name)))
    assert (await h.invoke())['disposition']=='failed'


@pytest.mark.anyio
async def test_transient_history_rpc_retries_without_sql_but_arbitrary_errors_do_not(seed):
    h=await harness(seed);before=await h.snapshot()
    for error,retry in [(RPCError('private',RPCStatusCode.UNAVAILABLE,b''),True),
                        (RPCError('private',RPCStatusCode.PERMISSION_DENIED,b''),False),
                        (RuntimeError('private'),False)]:
        h.state['error']=error
        with pytest.raises(ApplicationError) as e:await h.invoke()
        assert e.value.non_retryable != retry and 'private' not in str(e.value)
        assert await h.snapshot()==before


@pytest.mark.anyio
async def test_concurrent_retry_and_cancel_preserve_single_first_outcome(seed):
    h=await harness(seed);await h.action()
    async def cancel():
        try:return await h.store.cancel(seed['token'],h.task['id'])
        except WorkConflict:return None
    values=await asyncio.gather(h.invoke(),h.invoke(),cancel())
    after=await h.snapshot()
    assert after['actions'][0]['status']=='unknown' and after['usage']['reservedTokens']==3
    assert len([e for e in after['events'] if e['kind']=='action.unknown'])==1
    failures=[e for e in after['events'] if e['kind']=='task.failed']
    assert (len(failures),after['status'],after['cancelRequested']) in ((1,'failed',False),(0,'open',True))
    assert values[0]==values[1]


@pytest.mark.anyio
async def test_descendant_cascade_is_atomic_and_child_cannot_fail_parent(seed,tmp_path):
    from test_work_collaboration import harness as collaboration_harness
    ch=await collaboration_harness(seed,tmp_path)
    identity=await ch.prepare(0);assert (await ch.execute(identity))['status']=='applied'
    link=(await ch.relations())[0]
    child=await ch.store.snapshot(seed['token'],link['child_task_id'])
    h=await harness(seed,task=child,store=ch.store);await h.action()
    parent_before=await ch.store.snapshot(seed['token'],ch.task['id'])
    assert (await h.invoke())['disposition']=='failed'
    assert await ch.store.snapshot(seed['token'],ch.task['id'])==parent_before
    assert (await h.snapshot())['usage']['reservedTokens']==3


@pytest.mark.anyio
@pytest.mark.parametrize('child_unknown',[False,True])
async def test_parent_failure_cancels_descendant_without_guessing_its_effect(seed,tmp_path,child_unknown):
    from test_work_collaboration import harness as collaboration_harness
    ch=await collaboration_harness(seed,tmp_path)
    identity=await ch.prepare(0);assert (await ch.execute(identity))['status']=='applied'
    link=(await ch.relations())[0]
    child=await ch.store.snapshot(seed['token'],link['child_task_id'])
    c=await harness(seed,task=child,store=ch.store)
    if child_unknown:await c.action('unknown')
    h=await harness(seed,task=ch.task,store=ch.store)
    assert (await h.invoke())['disposition']=='failed'
    after=await c.snapshot()
    assert after['status']==('open' if child_unknown else 'cancelled')
    assert after['cancelRequested'] and not after['authorityActive']
    assert after['usage']['reservedTokens']==(3 if child_unknown else 0)
    if child_unknown:assert after['actions'][0]['status']=='unknown'


async def publication(h,tmp_path):
    from openbot_server.work_worker import WorkActivities,VerifiedTaskResult
    from openbot_server.work_files import LocalWorkFiles
    from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
    import hashlib
    root=tmp_path/'blobs';root.mkdir(mode=0o700)
    h.store.files=LocalWorkFiles(root)
    h.client.config=lambda:dict(plugins=[PydanticAIPlugin()])
    data=b'Synthetic checked report\n'
    verify=AsyncMock(return_value=VerifiedTaskResult((dict(key='report',name='report.txt',mediaType='text/plain',data=data),),
        dict(source='synthetic',reference=h.task['id'],sha256=hashlib.sha256(data).hexdigest())))
    host=WorkActivities(h.store,h.client,namespace='default',queue='failure-test',load_services=lambda _:None,verify_result=verify)
    h.service.completed_result=host.completed_result
    env=ActivityEnvironment();env.info=replace(h.env.info,activity_id='publish',activity_type='openbot.publish_task.v1')
    return host,env,verify


@pytest.mark.anyio
async def test_completed_lost_ack_recovers_original_with_digest_and_blob_checks(seed,tmp_path):
    h=await harness(seed);host,env,verify=await publication(h,tmp_path)
    first=await env.run(host.publish_task,'Checked synthetic answer')
    before=await h.snapshot();verify.side_effect=AssertionError('No new review')
    result=await h.invoke(dict(version=1,code='publication_failed'))
    assert result['disposition']=='completed' and result['completion']==first
    assert await h.snapshot()==before and verify.await_count==1
    artifact=before['artifacts'][0]
    (h.store.files.directory/artifact['sha256']).write_bytes(b'corrupt')
    with pytest.raises(ApplicationError) as e:await h.invoke(dict(version=1,code='publication_failed'))
    assert e.value.non_retryable and await h.snapshot()==before


@pytest.mark.anyio
async def test_completion_callback_cannot_leak_engine_error_payload(seed,tmp_path):
    h=await harness(seed);host,env,_=await publication(h,tmp_path)
    await env.run(host.publish_task,'Checked synthetic answer');before=await h.snapshot()
    h.service.completed_result=AsyncMock(side_effect=ApplicationError('secret-provider-body',type='private-provider-type'))
    with pytest.raises(ApplicationError) as e:await h.invoke()
    assert e.value.non_retryable and 'secret' not in str(e.value) and e.value.type=='InvalidWork'
    assert await h.snapshot()==before


@pytest.mark.anyio
async def test_corrupted_record_is_never_replayed_to_runtime(seed):
    h=await harness(seed);await h.invoke()
    with psycopg.connect(seed['dsn']) as db:
        db.execute("UPDATE work_events SET payload=jsonb_set(payload,'{result,publicCode}','\"private-data\"'::jsonb) WHERE task_id=%s AND kind='task.failed'",(h.task['id'],))
    before=await h.snapshot()
    with pytest.raises(ApplicationError) as e:await h.invoke()
    assert e.value.non_retryable and 'private-data' not in str(e.value) and await h.snapshot()==before


@pytest.mark.anyio
async def test_stale_closed_run_cannot_terminate_open_task(seed):
    h=await harness(seed)
    with psycopg.connect(seed['dsn']) as db:db.execute("UPDATE work_runs SET status='failed' WHERE id=%s",(h.run,))
    before=await h.snapshot()
    with pytest.raises(ApplicationError) as e:await h.invoke()
    assert e.value.non_retryable and await h.snapshot()==before


@pytest.mark.anyio
async def test_resolution_and_failure_serialize_without_lost_spend(seed):
    h=await harness(seed);identity=await h.action()
    await asyncio.gather(h.invoke(),h.store.resolve(identity,applied=True,actual_tokens=2,
                        evidence=dict(source='synthetic',reference=identity,sha256='d'*64)))
    result=await h.snapshot()
    assert result['status']=='failed' and result['actions'][0]['status']=='applied'
    assert result['usage']==dict(tokenLimit=100,reservedTokens=0,spentTokens=2)


@pytest.mark.anyio
async def test_publication_waiting_for_review_cannot_overwrite_failure(seed,tmp_path):
    h=await harness(seed);host,env,verify=await publication(h,tmp_path)
    entered,released=asyncio.Event(),asyncio.Event();verdict=verify.return_value
    async def slow(*_):entered.set();await released.wait();return verdict
    verify.side_effect=slow
    running=asyncio.create_task(env.run(host.publish_task,'Checked synthetic answer'))
    await asyncio.wait_for(entered.wait(),2)
    try:assert (await h.invoke())['disposition']=='failed'
    finally:released.set()
    with pytest.raises(WorkConflict):await running
    result=await h.snapshot();assert result['status']=='failed' and not result['artifacts']


@pytest.mark.anyio
async def test_simultaneous_parent_and_child_close_do_not_reverse_lock_order(seed,tmp_path):
    from test_work_collaboration import harness as collaboration_harness
    ch=await collaboration_harness(seed,tmp_path)
    identity=await ch.prepare(0);await ch.execute(identity);link=(await ch.relations())[0]
    c=await harness(seed,task=await ch.store.snapshot(seed['token'],link['child_task_id']),store=ch.store)
    await c.action()
    h=await harness(seed,task=ch.task,store=ch.store)
    async with asyncio.timeout(5):await asyncio.gather(h.invoke(),c.invoke())
    parent,child=await h.snapshot(),await c.snapshot()
    assert parent['status']=='failed' and child['status'] in ('failed','open')
    assert not child['authorityActive'] and child['actions'][0]['status']=='unknown'
    assert child['usage']['reservedTokens']==3


@pytest.mark.anyio
async def test_origin_failure_event_rollback_also_restores_descendant_authority(seed,tmp_path):
    from test_work_collaboration import harness as collaboration_harness
    ch=await collaboration_harness(seed,tmp_path)
    identity=await ch.prepare(0);await ch.execute(identity);link=(await ch.relations())[0]
    h=await harness(seed,task=ch.task,store=ch.store)
    before=await h.snapshot();child_before=await h.store.snapshot(seed['token'],link['child_task_id'])
    name='failure_'+uuid4().hex
    with psycopg.connect(seed['dsn']) as db:
        db.execute(sql.SQL("CREATE FUNCTION {}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='task.failed' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END $$").format(sql.Identifier(name)))
        db.execute(sql.SQL('CREATE TRIGGER {} BEFORE INSERT ON work_events FOR EACH ROW EXECUTE FUNCTION {}()').format(sql.Identifier(name),sql.Identifier(name)))
    try:
        with pytest.raises(ApplicationError):await h.invoke()
        assert await h.snapshot()==before
        assert await h.store.snapshot(seed['token'],link['child_task_id'])==child_before
    finally:
        with psycopg.connect(seed['dsn']) as db:
            db.execute(sql.SQL('DROP TRIGGER {} ON work_events').format(sql.Identifier(name)))
            db.execute(sql.SQL('DROP FUNCTION {}()').format(sql.Identifier(name)))
