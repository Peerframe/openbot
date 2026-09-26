"""Real PG + real SDK ActivityEnvironment + synthetic immutable start and public HTTP transport."""
import asyncio
from dataclasses import replace
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock,patch
from uuid import uuid4

import psycopg
import pytest
from temporalio.testing import ActivityEnvironment
from openbot_agent_runtime.catalog import ToolCatalog
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
from openbot_server.work_product_web import WorkWebAdapter,web_tool_descriptors,web_prompt
from openbot_server.public_source import SearchConfiguration,PublicWebError
from test_public_source import anyio_backend,converter,web_remote,kimi

SCOPE=dict(expected_namespace='default',expected_queue='web-fixture',expected_workflow_type='web-workflow')


@pytest.fixture
def seed(fixture):
    bot,channel=str(uuid4()),str(uuid4())
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("INSERT INTO bots(id,name,role,computer_profile) VALUES(%s,'Work web fixture','assistant','none')",(bot,))
        db.execute("INSERT INTO channels(id,name,description) VALUES(%s,%s,'Synthetic only')",(channel,'Web '+channel))
        db.execute('INSERT INTO channel_bots(channel_id,bot_id) VALUES(%s,%s)',(channel,bot))
    yield {**fixture,'botId':bot,'channelId':channel}
    with psycopg.connect(fixture['dsn']) as db:
        for table in ('work_tool_results','work_sources','work_actions','work_artifacts','work_correction_contexts','work_corrections','work_events'):
            db.execute(f'DELETE FROM {table} WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(bot,))
        for table in ('work_claims','work_admissions'):
            db.execute(f'DELETE FROM {table} WHERE run_id IN (SELECT r.id FROM work_runs r JOIN work_tasks t ON t.id=r.task_id WHERE t.bot_id=%s)',(bot,))
        db.execute('DELETE FROM work_runs WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(bot,))
        db.execute('DELETE FROM work_tasks WHERE bot_id=%s',(bot,))
        db.execute('DELETE FROM runs WHERE bot_id=%s',(bot,))
        db.execute('DELETE FROM run_events WHERE bot_id=%s OR channel_id=%s',(bot,channel))
        db.execute('DELETE FROM channels WHERE id=%s',(channel,))
        db.execute('DELETE FROM bots WHERE id=%s',(bot,))


async def harness(seed,tmp_path,web_remote,*,tool='fetch',search=None):
    base=tmp_path.resolve();base.chmod(0o700);(base/'blobs').mkdir(mode=0o700)
    store=PostgresWorkStore(seed['dsn'])
    source=await PostgresTaskStore(seed['dsn'],work_sources=WorkSourceAdmission(store,token_limit=1000)).submit(
        seed['token'],seed['channelId'],CreateMessageInput(content='Read https://example.com/source and report synthetic evidence',botId=seed['botId']))
    async with store._transaction(trusted=True) as db:
        row=await (await db.execute('SELECT task_id FROM work_sources WHERE legacy_run_id=%s',(source.run.id,))).fetchone()
    task=await store.snapshot(seed['token'],row['task_id']);run=task['runs'][0]['id']
    correction=await CorrectionStore(store).freeze(task['id'],run,'initial')
    context=WorkRuntimeContext(task['id'],run,seed['botId'],task['objective'],1000,correction['id'])
    workflow='openbot-work-v1-'+run;reference='temporal:default:'+workflow
    handoff=HandoffStore(store);reservation=await handoff.reserve_submission(task['id'],run,reference)
    await handoff.acknowledge(task['id'],run,reference,reservation.attempt_id,'fixture-engine')
    start_input=dict(taskId=task['id'],runId=run,attemptId=reservation.attempt_id)
    start=SimpleNamespace(workflow_id=workflow,first_execution_run_id='fixture-engine',
        task_queue=SimpleNamespace(name=SCOPE['expected_queue']),workflow_type=SimpleNamespace(name=SCOPE['expected_workflow_type']),
        input=SimpleNamespace(payloads=['fixture-payload']))
    event=SimpleNamespace(HasField=lambda value:value=='workflow_execution_started_event_attributes',
                          workflow_execution_started_event_attributes=start)
    async def history(*,page_size):
        assert page_size==1
        yield event
    def handle(workflow_id,*,run_id):
        assert workflow_id==workflow and run_id=='fixture-engine'
        return SimpleNamespace(fetch_history_events=history)
    client=SimpleNamespace(namespace='default',get_workflow_handle=handle,
        data_converter=SimpleNamespace(decode=AsyncMock(return_value=[start_input])))
    env=ActivityEnvironment();env.info=replace(env.info,namespace='default',task_queue=SCOPE['expected_queue'],
        workflow_id=workflow,workflow_run_id='fixture-engine',workflow_type=SCOPE['expected_workflow_type'],activity_id='prepare')
    results=ToolResults(store,LocalWorkFiles(base/'blobs'))
    config={'value':search}
    async def configuration(db,ctx):
        assert ctx.task_id==context.task_id
        return config['value']
    adapter=WorkWebAdapter(store,client,SCOPE,results,web=web_remote['client'],search_configuration=configuration,
                           history_reset_on_correction=True)
    async def catalog(_):return ToolCatalog(web_tool_descriptors(await adapter.catalog(context)),max_tools=4,max_bytes=4096)
    host=SimpleNamespace(store=store,client=client,scope=SCOPE,load_tool_result=adapter.load_result,
                         ports=SimpleNamespace(deferred_catalog=catalog))
    activities=DeferredActivities(host,adapter.prepare,adapter.load)
    arguments={'url':'https://example.com/evidence'} if tool=='fetch' else {'sourceIndex':0} if tool=='read_public_page' else {'query':' public evidence '}
    async def prepare(number,chosen_tool=tool,args=arguments):
        env.info=replace(env.info,activity_id='prepare-'+str(number))
        return await env.run(activities.prepare_request,dict(call_id='untrusted-correlation',tool=chosen_tool,arguments=args),correction['id'])
    identity=await prepare(0)
    async def row(identity=identity):
        async with store._transaction(trusted=True) as db:return (await store._action(db,identity))[1]
    async def execute(identity=identity):
        env.info=replace(env.info,activity_id='execute-'+identity)
        return await env.run(activities.execute,identity)
    return SimpleNamespace(**locals())


@pytest.mark.anyio
@pytest.mark.parametrize('tool',['fetch','read_public_page'])
async def test_public_page_action_observation_and_no_resend(seed,tmp_path,web_remote,tool):
    h=await harness(seed,tmp_path,web_remote,tool=tool)
    assert not (await h.row())['requires_approval']
    assert (await h.execute())['status']=='applied'
    assert (await h.execute())['status']=='applied'
    result=await h.env.run(h.activities.result,h.identity)
    assert result['result']['text']=='Synthetic public evidence'
    assert len(web_remote['requests'])==1
    collected=await h.env.run(h.adapter.collect_results,h.context)
    assert collected==({'actionId':h.identity,'payload':result['result']},)
    await h.env.run(h.adapter.revalidate,h.context)
    async with h.store._transaction(trusted=True) as db:
        with patch.object(h.store,'_transaction',side_effect=AssertionError('No nested transaction')):
            assert await h.adapter.revalidate_in_transaction(db,h.context) is True
    catalog=await h.env.run(h.adapter.catalog,h.context)
    assert catalog['sourceUrls']==['https://example.com/source'] and catalog['searchProvider'] is None
    assert [x.name for x in web_tool_descriptors(catalog)]==['fetch','read_public_page']
    assert 'untrusted' in web_prompt(catalog)


@pytest.mark.anyio
async def test_four_attempts_durable_across_adapter_instances(seed,tmp_path,web_remote):
    h=await harness(seed,tmp_path,web_remote)
    assert (await h.execute())['status']=='applied'
    for i in range(1,5):
        identity=await h.prepare(i)
        # A new instance must not reset the quota or cache permissions.
        fresh=WorkWebAdapter(h.store,h.client,SCOPE,h.results,web=web_remote['client'])
        h.activities.plan_effect=fresh.prepare;h.activities.load_effect=fresh.load
        result=await h.execute(identity)
        assert result['status']==('applied' if i<4 else 'unknown')
    assert len(web_remote['requests'])==4
    events=(await h.store.snapshot(seed['token'],h.task['id']))['events']
    assert sum(x['kind']=='tool.web_attempt_started' for x in events)==4
    assert sum(x['kind']=='tool.web_dispatch_started' for x in events)==4


@pytest.mark.anyio
async def test_failed_dns_consumes_quota_and_unknown_only_looks_up(seed,tmp_path,web_remote):
    h=await harness(seed,tmp_path,web_remote)
    web_remote['addresses']=[]
    assert (await h.execute())['status']=='unknown'
    count=len(web_remote['resolves'])
    assert (await h.execute())['status']=='unknown' and len(web_remote['resolves'])==count
    events=(await h.store.snapshot(seed['token'],h.task['id']))['events']
    assert sum(x['kind']=='tool.web_attempt_started' for x in events)==1 and not web_remote['requests']


@pytest.mark.anyio
@pytest.mark.parametrize('change',['cancel','revoke','membership','source','correction','fence','expiry'])
async def test_rechecks_after_dns_and_before_send(seed,tmp_path,web_remote,change):
    h=await harness(seed,tmp_path,web_remote)
    async def changed():
        if change=='cancel':await h.store.cancel(seed['token'],h.task['id'])
        elif change=='revoke':await h.store.revoke(seed['token'],h.task['id'])
        elif change=='correction':await CorrectionStore(h.store).request(seed['token'],h.task['id'],run_id=h.run,instruction='Changed',request_key='change',expected_sequence=0)
        else:
            with psycopg.connect(seed['dsn']) as db:
                if change=='membership':db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(seed['channelId'],seed['botId']))
                elif change=='source':db.execute("UPDATE runs SET execution_profile='docker-linux' WHERE id=%s",(h.source.run.id,))
                elif change=='fence':db.execute("UPDATE work_claims SET expires_at=clock_timestamp()-interval '1 second' WHERE run_id=%s",(h.run,))
                elif change=='expiry':db.execute("UPDATE work_actions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=%s",(h.identity,))
    web_remote['on_resolve']=changed
    try:outcome=await h.execute()
    except WorkConflict:pass
    else:assert outcome['status'] in ('unknown','superseded')
    assert not web_remote['requests']


@pytest.mark.anyio
async def test_missing_sdk_and_forged_intent_fail_closed(seed,tmp_path,web_remote):
    h=await harness(seed,tmp_path,web_remote)
    with pytest.raises(RuntimeError):await h.adapter.invoke(h.context,h.identity,(await h.row())['intent'])
    changed=(await h.row())['intent'];changed['arguments']['headers']={'Cookie':'fake'}
    with pytest.raises((WorkConflict,InvalidWork)):await h.env.run(h.adapter.invoke,h.context,h.identity,changed)
    assert not web_remote['requests']


@pytest.mark.anyio
async def test_lost_http_response_no_resend(seed,tmp_path,web_remote):
    h=await harness(seed,tmp_path,web_remote);web_remote['lose']=True
    assert (await h.execute())['status']=='unknown'
    assert len(web_remote['requests'])==1
    assert (await h.execute())['status']=='unknown' and len(web_remote['requests'])==1


@pytest.mark.anyio
async def test_receipt_ack_loss_recovers_without_resend(seed,tmp_path,web_remote):
    h=await harness(seed,tmp_path,web_remote);original=h.results.save
    async def lost(*args,**kwargs):
        await original(*args,**kwargs);raise asyncio.CancelledError()
    with patch.object(h.results,'save',lost),pytest.raises(asyncio.CancelledError):await h.execute()
    assert (await h.execute())['status']=='applied' and len(web_remote['requests'])==1


@pytest.mark.anyio
@pytest.mark.parametrize('change',['disable','revision','model','credential'])
async def test_current_search_config_is_required_at_dispatch(seed,tmp_path,web_remote,change):
    initial=kimi();h=await harness(seed,tmp_path,web_remote,tool='web_search',search=initial)
    async def changed():
        if change=='disable':h.config['value']=None
        elif change=='revision':h.config['value']=kimi(revision='r2')
        elif change=='model':h.config['value']=kimi(model='another')
        else:h.config['value']=SearchConfiguration('kimi','r1','different-secret',initial.model)
    web_remote['on_resolve']=changed
    assert (await h.execute())['status']=='unknown' and not web_remote['requests']
    assert 'synthetic-kimi-secret' not in str((await h.row())['intent'])


@pytest.mark.anyio
async def test_search_result_cannot_cross_current_model_or_permission(seed,tmp_path,web_remote):
    h=await harness(seed,tmp_path,web_remote,tool='web_search',search=kimi())
    web_remote.update(headers={'content-type':'application/json'},body=json.dumps(dict(status='succeeded',context=dict(encrypted_output='synthetic opaque'))).encode())
    assert (await h.execute())['status']=='applied'
    assert (await h.env.run(h.activities.result,h.identity))['result']=='synthetic opaque'
    h.config['value']=kimi(model='other-model')
    with pytest.raises(WorkConflict):await h.env.run(h.activities.result,h.identity)
    with pytest.raises(WorkConflict):await h.env.run(h.adapter.revalidate,h.context)
    assert len(web_remote['requests'])==1


@pytest.mark.anyio
async def test_observation_must_still_have_source_membership(seed,tmp_path,web_remote):
    h=await harness(seed,tmp_path,web_remote);assert (await h.execute())['status']=='applied'
    with psycopg.connect(seed['dsn']) as db:db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(seed['channelId'],seed['botId']))
    with pytest.raises(WorkConflict):await h.env.run(h.adapter.collect_results,h.context)
    assert len(web_remote['requests'])==1


@pytest.mark.anyio
async def test_same_action_concurrent_apply_only_one_attempt(seed,tmp_path,web_remote):
    from openbot_server.work_temporal_activity import claim_current_activity
    h=await harness(seed,tmp_path,web_remote)
    h.env.info=replace(h.env.info,activity_id='execute-concurrent')
    fence=await h.env.run(claim_current_activity,h.store,h.client,**SCOPE)
    row=await h.row()
    await h.store.admit(row['id'],fence=fence)
    async def both():
        return await asyncio.gather(h.adapter.invoke(h.context,h.identity,row['intent']),
                                    h.adapter.invoke(h.context,h.identity,row['intent']),return_exceptions=True)
    values=await h.env.run(both)
    assert sum(type(x) is dict for x in values)==1
    assert sum(isinstance(x,WorkConflict) for x in values)==1
    assert len(web_remote['requests'])==1


@pytest.mark.anyio
async def test_parallel_actions_cannot_exceed_four_calls(seed,tmp_path,web_remote):
    from openbot_server.work_temporal_activity import claim_current_activity
    h=await harness(seed,tmp_path,web_remote)
    identities=[h.identity]+[await h.prepare(i) for i in range(1,5)]
    h.env.info=replace(h.env.info,activity_id='shared-live-activity')
    fence=await h.env.run(claim_current_activity,h.store,h.client,**SCOPE)
    rows=[await h.row(identity) for identity in identities]
    for row in rows:
        await h.store.admit(row['id'],fence=fence)
    async def all_calls():
        return await asyncio.gather(*(h.adapter.invoke(h.context,row['id'],row['intent']) for row in rows),return_exceptions=True)
    values=await h.env.run(all_calls)
    assert sum(type(x) is dict for x in values)==4
    assert sum(isinstance(x,WorkConflict) and str(x)=='work_web_call_limit' for x in values)==1
    assert len(web_remote['requests'])==4


@pytest.mark.anyio
async def test_current_generation_collect_omits_reset_history_but_quota_does_not_reset(seed,tmp_path,web_remote):
    h=await harness(seed,tmp_path,web_remote,tool='web_search',search=kimi())
    web_remote.update(headers={'content-type':'application/json'},body=json.dumps(dict(status='succeeded',context=dict(output='opaque old'))).encode())
    assert (await h.execute())['status']=='applied'
    await CorrectionStore(h.store).request(seed['token'],h.task['id'],run_id=h.run,instruction='New instructions',request_key='edit',expected_sequence=0)
    correction=await CorrectionStore(h.store).freeze(h.task['id'],h.run,'after-edit')
    context=replace(h.context,correction_token=correction['id'])
    h.config['value']=None
    assert await h.env.run(h.adapter.collect_results,context)==()
    h.adapter.history_reset_on_correction=False
    with pytest.raises(WorkConflict):await h.env.run(h.adapter.revalidate,context)
    events=(await h.store.snapshot(seed['token'],h.task['id']))['events']
    assert sum(x['kind']=='tool.web_attempt_started' for x in events)==1


@pytest.mark.anyio
async def test_mutated_receipt_refuses_revalidation(seed,tmp_path,web_remote):
    h=await harness(seed,tmp_path,web_remote);assert (await h.execute())['status']=='applied'
    with psycopg.connect(seed['dsn']) as db:db.execute('UPDATE work_tool_results SET sha256=%s WHERE action_id=%s',('a'*64,h.identity))
    with pytest.raises(WorkConflict):await h.env.run(h.adapter.revalidate,h.context)
    assert len(web_remote['requests'])==1
