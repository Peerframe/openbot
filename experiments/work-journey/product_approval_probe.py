"""Public approve while Worker absent, cancellation, unknown repair and original Action replay."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import secrets
from temporalio.client import WorkflowFailureError
from temporalio.worker import Replayer
from temporalio.api.enums.v1 import PendingActivityState
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from multitask_probe import HandoffStore,PostgresWorkStore,LocalWorkFiles,TemporalEnginePort,dispatch_one
from openbot_server.work_worker import OpenBotWork,TYPE


async def qualify_approval(client,api,bot,dsn,artifact_root,server,launch,counts,effects):
    queue='approval-'+secrets.token_hex(8)
    cfg=dict(dsn=dsn,artifact_root=str(artifact_root),temporal_address=server.address,queue=queue,pause_prepare=True)
    worker=launch('product_approval_worker.py',cfg)
    tasks=[api.call('/api/v1/tasks',dict(botId=bot['id'],objective='Correct approved CSV '+label,
        tokenLimit=10,requestKey=secrets.token_hex(12)),expected=202) for label in ['normal','unknown','cancel','deny']]
    handoff=HandoffStore(PostgresWorkStore(dsn,files=LocalWorkFiles(artifact_root)))
    for task in tasks:
        result=await dispatch_one(task['id'],task['runs'][0]['id'],'default',queue,TYPE,360,handoff,TemporalEnginePort(client))
        assert result.acknowledged,result.reason
    async def until(predicate):
        async with asyncio.timeout(45):
            while True:
                result=predicate()
                if result:return result
                await asyncio.sleep(.1)
    pending=[]
    for task in tasks:
        snap=await until(lambda: (s if (s:=api.snapshot(task['id']))['attention']=='approval' else None))
        action=next(a for a in snap['actions'] if a['decision']=='pending')
        assert action['intent']==dict(kind='deferred_tool',tool='write_row',arguments={'row':7,'value':'fixed'},
                                     effect={'kind':'write','row':7,'value':'fixed'})
        assert counts(task['id'])['writes']==0 and snap['usage']['spentTokens']==3
        pending.append(action)
    handles=[client.get_workflow_handle('openbot-work-v1-'+t['runs'][0]['id']) for t in tasks]
    runs=[(await h.describe()).run_id for h in handles]
    preparation=[]
    for task,handle in zip(tasks,handles):
        await asyncio.to_thread(worker.wait,'prepared-'+task['id'])
        pending_activities=(await handle.describe()).raw_description.pending_activities
        assert len(pending_activities)==1
        activity=pending_activities[0]
        assert activity.activity_type.name=='openbot.prepare_tool.v1' and activity.attempt==1
        assert activity.state==PendingActivityState.PENDING_ACTIVITY_STATE_STARTED and not activity.HasField('last_failure')
        preparation.append(activity.activity_id)
    worker.kill()
    for index,(task,action) in enumerate(zip(tasks,pending)):
        api.call('/api/v1/actions/'+action['id']+'/decision',dict(intentDigest=action['intentDigest'],approved=index!=3))
    api.cancel(tasks[2]['id']);effects.corrupt_receipt(tasks[1]['id'],malformed_json=True)
    worker=launch('product_approval_worker.py',cfg|dict(fail_planner=True,pause_prepare=False,pause_stop=True))
    await asyncio.wait_for(handles[0].result(),110)
    try:await asyncio.wait_for(handles[2].result(),110)
    except WorkflowFailureError:pass
    else:raise AssertionError('Cancellation allowed approved execution')
    unknown=await until(lambda:(s if (s:=api.snapshot(tasks[1]['id']))['attention']=='reconciliation' else None))
    original=next(a for a in unknown['actions'] if a['id']==pending[1]['id'])
    assert original['status']=='unknown' and unknown['usage']==dict(tokenLimit=10,spentTokens=3,reservedTokens=2)
    assert counts(tasks[1]['id'])['writes']==1 and counts(tasks[1]['id'])['attempts']==2
    # Require the intended command path, not an execute retry racing Owner delivery.
    async with asyncio.timeout(30):
        while True:
            history=await handles[1].fetch_history()
            completed={e.activity_task_completed_event_attributes.scheduled_event_id for e in history.events
                       if e.HasField('activity_task_completed_event_attributes')}
            execution=[e.event_id for e in history.events if e.HasField('activity_task_scheduled_event_attributes')
                       and e.activity_task_scheduled_event_attributes.activity_type.name=='openbot.execute_tool.v1']
            if len(execution)==1 and execution[0] in completed:break
            await asyncio.sleep(.1)
    await asyncio.to_thread(worker.wait,'stopped-'+tasks[3]['id'])
    stopped_pending=(await handles[3].describe()).raw_description.pending_activities
    assert len(stopped_pending)==1 and stopped_pending[0].activity_type.name=='openbot.stop_tool.v1'
    assert stopped_pending[0].attempt==1 and stopped_pending[0].state==PendingActivityState.PENDING_ACTIVITY_STATE_STARTED
    stop_id=stopped_pending[0].activity_id
    worker.kill()
    request=dict(intentDigest=original['intentDigest'],requestKey=secrets.token_hex(12),
                 expectedSequence=0,reason='Inspect the original unknown CSV effect')
    path='/api/v1/actions/'+original['id']+'/reconcile'
    command=api.call(path,request,expected=202)
    assert not command['delivered'] and command['outcome'] is None
    assert api.call(path,request,expected=202)['id']==command['id']
    effects.repair_receipt(tasks[1]['id'])
    worker=launch('product_approval_worker.py',cfg|dict(fail_planner=True,pause_prepare=False))
    await asyncio.wait_for(handles[1].result(),110)
    for index in [0,1]:
        snap=api.snapshot(tasks[index]['id'])
        assert snap['status']=='completed' and snap['usage']==dict(tokenLimit=10,spentTokens=8,reservedTokens=0)
        assert counts(tasks[index]['id'])['writes']==1 and counts(tasks[index]['id'])['attempts']==3
        assert len(snap['actions'])==3 and sum(a['id']==pending[index]['id'] for a in snap['actions'])==1
        assert api.call(snap['artifacts'][0]['downloadUrl'],raw=True)==b'row,value\n7,fixed\n'
        assert (await handles[index].describe()).run_id==runs[index]
        history=await handles[index].fetch_history()
        scheduled=next(e.event_id for e in history.events if e.HasField('activity_task_scheduled_event_attributes')
            and e.activity_task_scheduled_event_attributes.activity_id==preparation[index])
        assert any(e.HasField('activity_task_started_event_attributes')
            and e.activity_task_started_event_attributes.scheduled_event_id==scheduled
            and e.activity_task_started_event_attributes.attempt>1 for e in history.events)
    repaired=api.call(path,request,expected=202)
    assert repaired['delivered'] and repaired['outcome']=='resolved'
    repair_history=await handles[1].fetch_history()
    assert any(e.HasField('activity_task_scheduled_event_attributes') and
        e.activity_task_scheduled_event_attributes.activity_type.name=='openbot.reconcile_tool.v1' for e in repair_history.events)
    refused=await asyncio.wait_for(handles[3].result(),110)
    assert refused==dict(taskId=tasks[3]['id'],status='failed',reason='denied')
    stop_history=await handles[3].fetch_history()
    stop_scheduled=next(e.event_id for e in stop_history.events if e.HasField('activity_task_scheduled_event_attributes')
        and e.activity_task_scheduled_event_attributes.activity_id==stop_id)
    assert any(e.HasField('activity_task_started_event_attributes') and
        e.activity_task_started_event_attributes.scheduled_event_id==stop_scheduled and
        e.activity_task_started_event_attributes.attempt>1 for e in stop_history.events)
    denied=api.snapshot(tasks[3]['id'])
    assert denied['status']=='failed' and not denied['authorityActive'] and not denied['artifacts']
    assert counts(tasks[3]['id'])['attempts']==1 and counts(tasks[3]['id'])['writes']==0
    cancelled=api.snapshot(tasks[2]['id'])
    assert cancelled['status']=='cancelled' and not cancelled['artifacts'] and counts(tasks[2]['id'])['writes']==0
    worker.kill();before=[(api.snapshot(t['id']),counts(t['id'])) for t in tasks]
    with ThreadPoolExecutor(max_workers=2) as executor:
        replayer=Replayer(workflows=[OpenBotWork],plugins=[PydanticAIPlugin()],workflow_task_executor=executor)
        for handle in handles:await replayer.replay_workflow(await handle.fetch_history())
    assert before==[(api.snapshot(t['id']),counts(t['id'])) for t in tasks]
    record=dict(case='product-deferred-approval',approveWhileWorkerAbsent=True,plannerDisabledAfterRestart=True,
        unknownWaitRetainsReservation=True,repairCommandDistinguishesDeliveryAndVerification=True,
        sameActionSingleWrite=True,cancelStopsApprovedWrite=True,deniedStopAcknowledgementRecovery=True,offlineReplay='passed',scope='scripted model + actual HTTP/PG/Temporal')
    print(json.dumps(record),flush=True);return [record]
