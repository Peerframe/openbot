"""Actual product CLI, cancelled original, bounded lookup cycles and commit-before-ACK retry."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import secrets

from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.client import WorkflowFailureError
from temporalio.api.enums.v1 import PendingActivityState
from temporalio.worker import Replayer
from openbot_server.work_worker import OpenBotWork
from openbot_server.work_closed_repair import ClosedRepair
from openbot_server.work_repair_binding import PREFIX


async def qualify_closed(client,api,bot,dsn,artifact_root,server,launch,counts,effects):
    queue='closed-product-'+secrets.token_hex(8)
    cfg=dict(dsn=dsn,artifact_root=str(artifact_root),temporal_address=server.address,queue=queue,
             enable_repair=True,pause_repair=True)
    worker=launch('product_approval_worker.py',cfg)
    task=api.call('/api/v1/tasks',dict(botId=bot['id'],objective='Verify cancelled historical CSV effect',
        tokenLimit=10,requestKey=secrets.token_hex(12)),expected=202)
    task_id,run_id=task['id'],task['runs'][0]['id']
    async def cli(repair=False):
        process=launch('product_dispatch_entry.py',cfg|dict(repair_closed=repair))
        await asyncio.to_thread(process.done,65)
        return json.loads(process.diagnostic())['deliveries']
    assert (await cli())[0]['status']=='acknowledged'
    async def until(predicate):
        async with asyncio.timeout(45):
            while True:
                value=predicate()
                if value:return value
                await asyncio.sleep(.1)
    pending=await until(lambda:(s if (s:=api.snapshot(task_id))['attention']=='approval' else None))
    action=next(a for a in pending['actions'] if a['decision']=='pending')
    effects.corrupt_receipt(task_id,malformed_json=True)
    api.call('/api/v1/actions/'+action['id']+'/decision',dict(intentDigest=action['intentDigest'],approved=True))
    await until(lambda:api.snapshot(task_id)['attention']=='reconciliation')
    api.cancel(task_id)
    original=client.get_workflow_handle('openbot-work-v1-'+run_id)
    original_run=(await original.describe()).run_id
    try:await asyncio.wait_for(original.result(),45)
    except WorkflowFailureError:pass
    else:raise AssertionError('Cancelled original continued execution')
    before=api.snapshot(task_id)
    assert before['cancelRequested'] and not before['authorityActive']
    assert before['usage']==dict(tokenLimit=10,spentTokens=3,reservedTokens=2)
    assert counts(task_id)['writes']==1 and counts(task_id)['attempts']==2
    path='/api/v1/actions/'+action['id']+'/reconcile'
    def request(sequence):
        data=dict(intentDigest=action['intentDigest'],requestKey=secrets.token_hex(12),
                  expectedSequence=sequence,reason='Inspect the original cancelled write')
        command=api.call(path,data,expected=202)
        assert not command['delivered'] and command['outcome'] is None
        return command,data
    first,data1=request(0)
    assert (await cli(True))[0]['status'] in ('delivered','finished')
    first_handle=client.get_workflow_handle(PREFIX+first['id'])
    assert await asyncio.wait_for(first_handle.result(),45)==dict(commandId=first['id'],outcome='unresolved')
    assert api.snapshot(task_id)['usage']==before['usage']
    assert api.call(path,data1,expected=202)['outcome']=='unresolved'
    effects.repair_receipt(task_id)
    second,data2=request(1)
    assert (await cli(True))[0]['status'] in ('delivered','finished')
    await asyncio.to_thread(worker.wait,'reconciled-'+task_id)
    second_handle=client.get_workflow_handle(PREFIX+second['id'])
    description=await second_handle.describe()
    pending=description.raw_description.pending_activities
    assert len(pending)==1 and pending[0].activity_type.name=='openbot.closed_repair.v1'
    assert pending[0].attempt==1 and pending[0].state==PendingActivityState.PENDING_ACTIVITY_STATE_STARTED
    assert not pending[0].HasField('last_failure')
    activity_id=pending[0].activity_id
    verified=api.snapshot(task_id);observed=counts(task_id)
    assert verified['status']=='cancelled' and not verified['authorityActive'] and not verified['artifacts']
    assert verified['usage']==dict(tokenLimit=10,spentTokens=5,reservedTokens=0)
    assert len(verified['actions'])==2 and observed['attempts']==2 and observed['writes']==1
    worker.kill()
    assert await cli(True)==[]
    assert api.call(path,data1,expected=202)['outcome']=='unresolved'
    assert api.call(path,data2,expected=202)['outcome']=='resolved'
    worker=launch('product_approval_worker.py',cfg|dict(pause_repair=False,fail_lookup=True,fail_planner=True))
    assert await asyncio.wait_for(second_handle.result(),75)==dict(commandId=second['id'],outcome='resolved')
    assert not (worker.directory/('lookup-invoked-'+task_id)).exists()
    assert api.snapshot(task_id)==verified and counts(task_id)==observed
    assert (await original.describe()).run_id==original_run
    history=await second_handle.fetch_history()
    scheduled=next(e.event_id for e in history.events if e.HasField('activity_task_scheduled_event_attributes')
        and e.activity_task_scheduled_event_attributes.activity_id==activity_id)
    assert any(e.HasField('activity_task_started_event_attributes') and
        e.activity_task_started_event_attributes.scheduled_event_id==scheduled and
        e.activity_task_started_event_attributes.attempt>1 for e in history.events)
    assert any(e.HasField('activity_task_completed_event_attributes') and
        e.activity_task_completed_event_attributes.scheduled_event_id==scheduled for e in history.events)
    assert not any(e.HasField('activity_task_scheduled_event_attributes') and
        e.activity_task_scheduled_event_attributes.activity_type.name=='openbot.closed_repair_finish.v1'
        for e in history.events)
    worker.kill()
    with ThreadPoolExecutor(max_workers=2) as executor:
        replayer=Replayer(workflows=[OpenBotWork,ClosedRepair],plugins=[PydanticAIPlugin()],workflow_task_executor=executor)
        for handle in [original,first_handle,second_handle]:
            await replayer.replay_workflow(await handle.fetch_history())
    assert api.snapshot(task_id)==verified and counts(task_id)==observed
    record=dict(case='product-closed-repair',actualOperatorCLI=True,cancelledOriginalNeverRestarted=True,
        unresolvedReservationRetained=True,oldCycleImmutable=True,commitBeforeAckRecovery=True,
        noNewLookupAfterCommit=True,singleExternalWrite=True,offlineReplay='passed')
    print(json.dumps(record),flush=True)
    return [record]
