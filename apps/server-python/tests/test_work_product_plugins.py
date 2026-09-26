"""Real PG + official MCP HTTP/SDK; SDK Activity context and synthetic immutable engine history."""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import psycopg
import pytest
from temporalio.testing import ActivityEnvironment

from openbot_agent_runtime.catalog import ToolCatalog
from openbot_agent_runtime.errors import RuntimeFailure
from openbot_server.plugin_inputs import PluginError
from openbot_server.database import StoreUnavailable
from openbot_server.plugin_service import PluginService
from openbot_server.plugin_transport import MCPConnection
from openbot_server.task_inputs import CreateMessageInput
from openbot_server.task_store import PostgresTaskStore
from openbot_server.work_corrections import CorrectionStore
from openbot_server.work_deferred import DeferredActivities
from openbot_server.work_effects import recover_action
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_handoff import HandoffStore
from openbot_server.work_product_plugins import WorkPluginAdapter, plugin_tool_descriptors
from openbot_server.work_sources import WorkSourceAdmission
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_temporal_activity import claim_current_activity
from openbot_server.work_temporal_start import WorkRuntimeContext
from openbot_server.work_tool_results import ToolResults
from openbot_server.work_values import InvalidWork, WorkConflict
from test_plugin_service import remote, anyio_backend, installed

SCOPE=dict(expected_namespace='default',expected_queue='plugin-fixture',expected_workflow_type='plugin-workflow')


@pytest.fixture
def seed(fixture):
    bot,channel=str(uuid4()),str(uuid4())
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("INSERT INTO bots(id,name,role,computer_profile) VALUES(%s,'Work plugin fixture','assistant','none')",(bot,))
        db.execute("INSERT INTO channels(id,name,description) VALUES(%s,%s,'Synthetic only')",(channel,'Plugin '+channel))
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


async def harness(seed,tmp_path,remote,mode='confirm',tool='call_plugin'):
    base=tmp_path.resolve();base.chmod(0o700);(base/'blobs').mkdir(mode=0o700)
    plugins=PluginService(seed['dsn'],base/'plugins.json',local_endpoints=(remote['endpoint'],))
    plugin=await installed(plugins,seed,remote,mode)
    store=PostgresWorkStore(seed['dsn'])
    source=await PostgresTaskStore(seed['dsn'],work_sources=WorkSourceAdmission(store,token_limit=1000)).submit(
        seed['token'],seed['channelId'],CreateMessageInput(content='Synthetic plugin task',botId=seed['botId']))
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
    adapter=WorkPluginAdapter(store,client,SCOPE,plugins,results)
    declaration=await env.run(adapter.catalog,context)
    catalog=ToolCatalog(plugin_tool_descriptors(declaration),max_tools=4,max_bytes=4096)
    host=SimpleNamespace(store=store,client=client,scope=SCOPE,load_tool_result=adapter.load_result,
                         ports=SimpleNamespace(deferred_catalog=AsyncMock(return_value=catalog)))
    activities=DeferredActivities(host,adapter.prepare,adapter.load)
    arguments=dict(pluginId=plugin['id'],revision=plugin['revision'],toolName='write_note',arguments={'note':'synthetic private note'})
    if tool=='read_plugin_resource':arguments=dict(pluginId=plugin['id'],revision=plugin['revision'],name='notes://public/info')
    proposal=dict(call_id='untrusted-model-correlation',tool=tool,arguments=arguments)
    identity=await env.run(activities.prepare_request,proposal,correction['id'])
    async def row():
        async with store._transaction(trusted=True) as db:return (await store._action(db,identity))[1]
    async def approve(yes=True):
        action=await row()
        return await store.decide(seed['token'],identity,intent_digest=action['intent_digest'],approved=yes)
    async def execute():
        env.info=replace(env.info,activity_id='execute')
        return await env.run(activities.execute,identity)
    return SimpleNamespace(**locals())


@pytest.mark.anyio
async def test_confirm_uses_one_durable_approval_and_original_snapshot(seed,tmp_path,remote):
    h=await harness(seed,tmp_path,remote)
    first=await h.row();assert first['requires_approval'] and first['decision']=='pending'
    catalog=await h.env.run(h.adapter.catalog,h.context)
    assert {entry['toolName'] for entry in catalog['tools']}=={'read_value','write_note'}
    assert [entry['name'] for entry in catalog['resources']]==['notes://public/info']
    assert h.plugins._pending=={} and remote['effects']==[]
    with pytest.raises(WorkConflict,match='not_authorized'):await h.execute()
    await h.approve()
    assert (await h.execute())['status']=='applied'
    assert (await h.execute())['status']=='applied'
    assert remote['effects']==['synthetic private note'] and h.plugins._pending=={}
    result=await h.env.run(h.activities.result,h.identity)
    assert result['result']['result']['isError'] is False
    events=(await h.store.snapshot(seed['token'],h.task['id']))['events']
    assert len([e for e in events if e['kind']=='tool.plugin_dispatch_started'])==1
    assert 'synthetic private note' not in str((await h.plugins.store.read())['audit'])
    assert 'synthetic-plugin-token' not in str(first['intent'])


@pytest.mark.anyio
@pytest.mark.parametrize('tool',['call_plugin','read_plugin_resource'])
async def test_read_grant_uses_action_without_second_approval(seed,tmp_path,remote,tool):
    h=await harness(seed,tmp_path,remote,mode='read',tool=tool)
    assert not (await h.row())['requires_approval']
    assert (await h.execute())['status']=='applied'
    value=await h.env.run(h.activities.result,h.identity)
    assert value['result']['untrusted'] is True


@pytest.mark.anyio
async def test_publication_revalidation_holds_plugin_lease_before_task_and_never_reinvokes(seed,tmp_path,remote):
    h=await harness(seed,tmp_path,remote,mode='read')
    assert (await h.execute())['status']=='applied'
    original_calls=list(remote['effects'])
    async def check():
        async with h.plugins.locked_work_validation() as checker:
            async with h.store._transaction(trusted=True) as db:
                await h.store._task(db,h.context.task_id)
                assert await h.adapter.revalidate_in_transaction(db,h.context,checker) is True
        with pytest.raises(PluginError):
            checker(seed['botId'],'call_plugin',h.proposal['arguments'],(await h.row())['intent']['effect']['selection'])
    await asyncio.wait_for(h.env.run(check),3)
    assert remote['effects']==original_calls
    await h.plugins.set_enabled(seed['token'],h.plugin['id'],dict(revision=h.plugin['revision'],enabled=False))
    with pytest.raises(PluginError):await h.env.run(check)
    assert remote['effects']==original_calls


@pytest.mark.anyio
@pytest.mark.parametrize('change',['deny','disable','grant','manifest','cancel','revoke','membership','source','correction','intent','approval-flag'])
async def test_refuses_changed_authority_without_tool_send(seed,tmp_path,remote,change):
    h=await harness(seed,tmp_path,remote)
    if change=='deny':await h.approve(False)
    else:await h.approve()
    if change=='disable':await h.plugins.set_enabled(seed['token'],h.plugin['id'],dict(revision=h.plugin['revision'],enabled=False))
    elif change=='grant':await h.plugins.grant(seed['token'],h.plugin['id'],seed['botId'],dict(revision=h.plugin['revision'],tools=[]))
    elif change=='manifest':
        @remote['app'].tool()
        def added_later()->str:return 'changed'
    elif change=='cancel':await h.store.cancel(seed['token'],h.task['id'])
    elif change=='revoke':await h.store.revoke(seed['token'],h.task['id'])
    elif change=='membership':
        with psycopg.connect(seed['dsn']) as db:db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(seed['channelId'],seed['botId']))
    elif change=='source':
        with psycopg.connect(seed['dsn']) as db:db.execute("UPDATE runs SET execution_profile='docker-linux' WHERE id=%s",(h.source.run.id,))
    elif change=='correction':
        await CorrectionStore(h.store).request(seed['token'],h.task['id'],run_id=h.run,instruction='Changed scope',request_key='edit',expected_sequence=0)
    elif change=='intent':
        with psycopg.connect(seed['dsn']) as db:db.execute("UPDATE work_actions SET intent_digest=%s WHERE id=%s",('0'*64,h.identity))
    elif change=='approval-flag':
        with psycopg.connect(seed['dsn']) as db:db.execute("UPDATE work_actions SET requires_approval=false,decision='not_required' WHERE id=%s",(h.identity,))
    try:outcome=await h.execute()
    except (WorkConflict,InvalidWork):pass
    else:assert outcome['status'] in ('unknown','superseded')
    assert not remote['effects'] and h.plugins._pending=={}


@pytest.mark.anyio
async def test_lost_response_stays_unknown_and_recovery_never_reconnects(seed,tmp_path,remote):
    h=await harness(seed,tmp_path,remote);await h.approve()
    original=MCPConnection.call_observed
    async def lost(self,*args):
        await original(self,*args)
        raise TimeoutError('synthetic lost response')
    with patch.object(MCPConnection,'call_observed',lost):assert (await h.execute())['status']=='unknown'
    count=len(remote['requests'])
    h.plugins.connector=lambda *_args,**_kwargs:pytest.fail('Recovery must not reconnect')
    assert (await h.execute())['status']=='unknown'
    assert remote['effects']==['synthetic private note'] and len(remote['requests'])==count


@pytest.mark.anyio
async def test_receipt_commit_ack_loss_recovers_original_observation(seed,tmp_path,remote):
    h=await harness(seed,tmp_path,remote);await h.approve()
    original=h.results.save
    async def lost(*args,**kwargs):
        await original(*args,**kwargs)
        raise asyncio.CancelledError()
    with patch.object(h.results,'save',lost),pytest.raises(asyncio.CancelledError):await h.execute()
    h.plugins.connector=lambda *_args,**_kwargs:pytest.fail('Recovery must not reconnect')
    assert (await h.execute())['status']=='applied'
    assert remote['effects']==['synthetic private note']


@pytest.mark.anyio
async def test_exact_transport_rechecks_after_metadata_await_and_never_trusts_skip_bool(seed,tmp_path,remote):
    h=await harness(seed,tmp_path,remote);await h.approve()
    original=h.plugins._manifest
    async def revoked(*args):
        value=await original(*args)
        with psycopg.connect(seed['dsn']) as db:db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(seed['channelId'],seed['botId']))
        return value
    with patch.object(h.plugins,'_manifest',revoked):assert (await h.execute())['status']=='unknown'
    assert not remote['effects']
    bad={**h.arguments,'skipApproval':True}
    with pytest.raises(PluginError):h.plugins._work_input('call_plugin',bad)
    with pytest.raises(PluginError):await h.plugins.invoke_work(seed['botId'],h.run,h.identity,{},h.arguments,authority=True)


@pytest.mark.anyio
async def test_stale_fence_at_transport_and_missing_sdk_context_fail_closed(seed,tmp_path,remote):
    h=await harness(seed,tmp_path,remote);await h.approve()
    with pytest.raises(RuntimeError):await h.adapter.invoke(h.context,h.identity,(await h.row())['intent'])
    original=h.plugins._manifest
    async def expired(*args):
        value=await original(*args)
        with psycopg.connect(seed['dsn']) as db:db.execute("UPDATE work_claims SET expires_at=clock_timestamp()-interval '1 second' WHERE run_id=%s",(h.run,))
        return value
    with patch.object(h.plugins,'_manifest',expired):assert (await h.execute())['status']=='unknown'
    assert not remote['effects']


@pytest.mark.anyio
async def test_result_read_rechecks_current_plugin_grants(seed,tmp_path,remote):
    h=await harness(seed,tmp_path,remote);await h.approve();assert (await h.execute())['status']=='applied'
    await h.plugins.set_enabled(seed['token'],h.plugin['id'],dict(revision=h.plugin['revision'],enabled=False))
    with pytest.raises(PluginError):await h.env.run(h.activities.result,h.identity)
    services=await h.adapter.load(h.context,(await h.row())['intent'])
    outcome=await recover_action(h.store,task_id=h.task['id'],run_id=h.run,action_id=h.identity,
                                 adapter=services.adapter,verifier=services.verifier)
    assert outcome.status=='applied' and len(remote['effects'])==1


@pytest.mark.anyio
async def test_concurrent_apply_consumes_exactly_one_durable_dispatch(seed,tmp_path,remote):
    h=await harness(seed,tmp_path,remote);await h.approve()
    h.env.info=replace(h.env.info,activity_id='execute')
    fence=await h.env.run(claim_current_activity,h.store,h.client,**SCOPE)
    await h.store.admit(h.identity,fence=fence)
    row=await h.row();services=await h.adapter.load(h.context,row['intent'])
    async def race():
        return await asyncio.gather(services.adapter.apply(h.identity,row['intent']),
                                    services.adapter.apply(h.identity,row['intent']),return_exceptions=True)
    outcomes=await h.env.run(race)
    assert sum(isinstance(value,Exception) for value in outcomes)==1
    assert remote['effects']==['synthetic private note']
    recovered=await recover_action(h.store,task_id=h.task['id'],run_id=h.run,action_id=h.identity,
                                   adapter=services.adapter,verifier=services.verifier)
    assert recovered.status=='applied' and not recovered.invoked_apply


@pytest.mark.anyio
async def test_dispatch_commit_failure_rolls_back_file_audit_and_sends_nothing(seed,tmp_path,remote):
    h=await harness(seed,tmp_path,remote);await h.approve()
    original=h.store._transaction
    @asynccontextmanager
    async def rejected(*args,**kwargs):
        async with original(*args,**kwargs) as db:
            yield db
            mark=await (await db.execute("SELECT 1 FROM work_events WHERE task_id=%s AND kind='tool.plugin_dispatch_started'",
                                        (h.task['id'],))).fetchone()
            if mark:raise StoreUnavailable('synthetic commit refusal')
    with patch.object(h.store,'_transaction',rejected):assert (await h.execute())['status']=='unknown'
    assert not remote['effects']
    assert not any(item['phase']=='work_dispatching' for item in (await h.plugins.store.read())['audit'])
    assert not any(e['kind']=='tool.plugin_dispatch_started' for e in (await h.store.snapshot(seed['token'],h.task['id']))['events'])


@pytest.mark.anyio
@pytest.mark.parametrize('change',['plugin','accepted-history'])
async def test_actual_transport_checks_cross_instance_revocation_and_accepted_history(seed,tmp_path,remote,change):
    h=await harness(seed,tmp_path,remote);await h.approve()
    original=h.plugins._manifest
    async def changed(*args):
        value=await original(*args)
        if change=='plugin':
            other=PluginService(seed['dsn'],h.base/'plugins.json',local_endpoints=(remote['endpoint'],))
            await other.set_enabled(seed['token'],h.plugin['id'],dict(revision=h.plugin['revision'],enabled=False))
        else:h.start.first_execution_run_id='unaccepted-engine'
        return value
    with patch.object(h.plugins,'_manifest',changed):assert (await h.execute())['status']=='unknown'
    assert not remote['effects']


@pytest.mark.anyio
async def test_remote_error_response_is_observed_untrusted_data(seed,tmp_path,remote):
    @remote['app'].tool()
    def fails() -> str:
        raise ValueError('synthetic rejected operation')
    h=await harness(seed,tmp_path,remote,mode='read')
    h.plugin=await h.plugins.grant(seed['token'],h.plugin['id'],seed['botId'],dict(revision=h.plugin['revision'],tools=[{'name':'fails','mode':'read'}]))
    h.env.info=replace(h.env.info,activity_id='prepare-error')
    proposal=dict(call_id='unused',tool='call_plugin',arguments=dict(pluginId=h.plugin['id'],revision=h.plugin['revision'],toolName='fails',arguments={}))
    identity=await h.env.run(h.activities.prepare_request,proposal,h.correction['id'])
    h.env.info=replace(h.env.info,activity_id='execute-error')
    assert (await h.env.run(h.activities.execute,identity))['status']=='applied'
    result=await h.env.run(h.activities.result,identity)
    assert result['result']['result']['isError'] is True and result['result']['untrusted'] is True


def test_exact_json_comparison_does_not_alias_boolean_and_number():
    assert not PluginService._work_equal({'value':True},{'value':1})
    assert not PluginService._work_equal({'value':1.0},{'value':1})


@pytest.mark.anyio
@pytest.mark.parametrize('bad',['skip-approval','schema','app-html','prompt'])
async def test_model_cannot_expand_retained_tool_contract(seed,tmp_path,remote,bad):
    h=await harness(seed,tmp_path,remote)
    h.env.info=replace(h.env.info,activity_id='prepare-invalid')
    value=dict(h.proposal,arguments=dict(h.arguments))
    if bad=='skip-approval':value['arguments']['skipApproval']=True
    elif bad=='schema':value['arguments']['arguments']={'note':123}
    else:
        value['tool']='read_plugin_resource'
        value['arguments']=dict(pluginId=h.plugin['id'],revision=h.plugin['revision'],name='ui://fixture/card')
        if bad=='prompt':value['arguments'].update(kind='prompt',name='compose')
    count=len(remote['requests'])
    with pytest.raises((PluginError,RuntimeFailure)):await h.env.run(h.activities.prepare_request,value,h.correction['id'])
    assert len(remote['requests'])==count
    assert len((await h.store.snapshot(seed['token'],h.task['id']))['actions'])==1
