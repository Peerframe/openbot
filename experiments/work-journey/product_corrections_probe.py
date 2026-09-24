"""Public corrections, original receipts, partial batches and publication ACK recovery."""
import asyncio
import json
import secrets
from concurrent.futures import ThreadPoolExecutor
from temporalio.worker import Replayer
from temporalio.api.enums.v1 import PendingActivityState
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from openbot_server.work_worker import OpenBotWork

async def qualify_corrections(client,api,bot,dsn,artifact_root,server,launch,counts):
    root=artifact_root.parent/'correction-receipts';root.mkdir(mode=0o700)
    cfg=dict(dsn=dsn,artifact_root=str(artifact_root),model_receipt_root=str(root),temporal_address=server.address,
        queue='corrections-'+secrets.token_hex(8),pause_initial=True,pause_receipt=True,pause_prepare=True)
    worker=launch('product_corrections_worker.py',cfg)
    tasks={name:api.call('/api/v1/tasks',dict(botId=bot['id'],objective=name,tokenLimit=50,
        requestKey=secrets.token_hex(12)),expected=202) for name in ['receipt','prepare','execute']}
    delivery=launch('product_dispatch_entry.py',cfg);await asyncio.to_thread(delivery.done,65)
    assert len(json.loads(delivery.diagnostic())['deliveries'])==3
    handles={name:client.get_workflow_handle('openbot-work-v1-'+task['runs'][0]['id']) for name,task in tasks.items()}
    async def until(predicate,timeout=45):
        async with asyncio.timeout(timeout):
            while True:
                value=predicate()
                if value:return value
                await asyncio.sleep(.1)
    def correct(name,sequence,instruction):
        task=tasks[name];body=dict(runId=task['runs'][0]['id'],expectedSequence=sequence,
            instruction=instruction,requestKey=secrets.token_hex(12))
        path='/api/v1/tasks/'+task['id']+'/corrections'
        result=api.call(path,body,expected=202)
        assert api.call(path,body,expected=202)==result
        return result
    receipt=tasks['receipt']['id'];prepare=tasks['prepare']['id'];execute=tasks['execute']['id']
    await asyncio.to_thread(worker.wait,'before-model-'+receipt)
    assert counts(receipt)['attempts']==0
    correct('receipt',0,'c1');(worker.directory/('release-before-model-'+receipt)).touch()
    await asyncio.to_thread(worker.wait,'receipt-'+receipt)
    assert counts(receipt)['attempts']==1,'Stale model request reached provider'
    correct('receipt',1,'c2')
    await asyncio.to_thread(worker.wait,'prepared-'+prepare)
    correct('prepare',0,'keep existing facts')
    def unknown_snapshot():
        snap=api.snapshot(execute)
        return snap if any(a['status']=='unknown' for a in snap['actions']) else None
    snap=await until(unknown_snapshot)
    pending=next(a for a in snap['actions'] if a['decision']=='pending')
    api.call('/api/v1/actions/'+pending['id']+'/decision',dict(intentDigest=pending['intentDigest'],approved=True))
    correct('execute',0,'keep existing facts')
    snap=api.snapshot(execute);unknown=next(a for a in snap['actions'] if a['status']=='unknown')
    assert next(a for a in snap['actions'] if a['id']==pending['id'])['status']=='superseded'
    api.call('/api/v1/actions/'+pending['id']+'/decision',dict(intentDigest=pending['intentDigest'],approved=True),expected=409)
    assert snap['usage']==dict(tokenLimit=50,spentTokens=5,reservedTokens=2) and counts(execute)['writes']==1
    # Distinguish Owner-command reconciliation from an unacknowledged execute retry.
    async with asyncio.timeout(30):
        while True:
            history=await handles['execute'].fetch_history()
            completed={e.activity_task_completed_event_attributes.scheduled_event_id for e in history.events if e.HasField('activity_task_completed_event_attributes')}
            execution=[e.event_id for e in history.events if e.HasField('activity_task_scheduled_event_attributes') and e.activity_task_scheduled_event_attributes.activity_type.name=='openbot.execute_tool.v1']
            if len(execution)==2 and all(event in completed for event in execution):break
            await asyncio.sleep(.1)
    for name in ['receipt','prepare']:
        pending_activity=(await handles[name].describe()).raw_description.pending_activities
        assert len(pending_activity)==1 and pending_activity[0].attempt==1
        assert pending_activity[0].state==PendingActivityState.PENDING_ACTIVITY_STATE_STARTED and not pending_activity[0].HasField('last_failure')
        if name=='prepare':assert pending_activity[0].activity_type.name=='openbot.prepare_corrected_tool.v1'
    before={name:counts(task['id']) for name,task in tasks.items()}
    runs={name:(await handle.describe()).run_id for name,handle in handles.items()}
    worker.kill()  # Owned fixture crash: originals remain in PostgreSQL/Temporal.
    repair_path='/api/v1/actions/'+unknown['id']+'/reconcile'
    repair_request=dict(intentDigest=unknown['intentDigest'],requestKey=secrets.token_hex(12),expectedSequence=0,reason='Inspect original write after correction')
    command=api.call(repair_path,repair_request,expected=202)
    assert not command['delivered'] and command['outcome'] is None
    cfg=cfg|dict(pause_initial=False,pause_receipt=False,pause_prepare=False,allow_lookup=True,pause_verify=True,pause_publication=True)
    worker=launch('product_corrections_worker.py',cfg)
    await asyncio.to_thread(worker.wait,'verify-'+receipt)
    assert counts(receipt)['attempts']==2,'Original receipt was billed again'
    correct('receipt',2,'c3');(worker.directory/('release-verify-'+receipt)).touch()
    await asyncio.to_thread(worker.wait,'published-'+receipt)
    published=(await handles['receipt'].describe()).raw_description.pending_activities
    assert len(published)==1 and published[0].activity_type.name=='openbot.publish_corrected_task.v1'
    assert published[0].state==PendingActivityState.PENDING_ACTIVITY_STATE_STARTED and published[0].attempt==1
    assert not published[0].HasField('last_failure')
    publication_id=published[0].activity_id
    complete=api.snapshot(receipt);assert complete['status']=='completed' and complete['usage']==dict(tokenLimit=50,spentTokens=9,reservedTokens=0)
    assert counts(receipt)['attempts']==3
    worker.kill()  # Kill immediately while publication ACK is demonstrably absent.
    worker=launch('product_corrections_worker.py',cfg|dict(fail_callbacks=True,pause_publication=False))
    await asyncio.gather(*(asyncio.wait_for(handle.result(),110) for handle in handles.values()))
    assert api.snapshot(receipt)==complete and counts(receipt)['attempts']==3
    for name in ['prepare','execute']:
        snap=api.snapshot(tasks[name]['id']);assert snap['status']=='completed' and len(snap['artifacts'])==1
    assert counts(prepare)['writes']==0 and counts(prepare)['attempts']==before['prepare']['attempts']+1
    assert counts(execute)['writes']==1 and counts(execute)['attempts']==before['execute']['attempts']+1
    assert api.call(complete['artifacts'][0]['downloadUrl'],raw=True)==b'receipt:c3\n'
    assert api.call(api.snapshot(execute)['artifacts'][0]['downloadUrl'],raw=True)==b'row,value\n7,fixed\n'
    histories={name:await handle.fetch_history() for name,handle in handles.items()}
    assert all([(await handles[name].describe()).run_id==runs[name] for name in handles])
    scheduled=next(e.event_id for e in histories['receipt'].events if e.HasField('activity_task_scheduled_event_attributes') and e.activity_task_scheduled_event_attributes.activity_id==publication_id)
    assert any(e.HasField('activity_task_started_event_attributes') and e.activity_task_started_event_attributes.scheduled_event_id==scheduled and e.activity_task_started_event_attributes.attempt>1 for e in histories['receipt'].events)
    repaired=api.call(repair_path,repair_request,expected=202)
    assert repaired['delivered'] and repaired['outcome']=='resolved'
    assert any(e.HasField('activity_task_scheduled_event_attributes') and e.activity_task_scheduled_event_attributes.activity_type.name=='openbot.reconcile_tool.v1' for e in histories['execute'].events)
    model_failures=[e.activity_task_failed_event_attributes.failure for e in histories['receipt'].events if e.HasField('activity_task_failed_event_attributes')]
    assert any('CorrectionsChanged' in str(f) and 'RuntimeFailure' in str(f) for f in model_failures)
    worker.kill();before={name:(api.snapshot(task['id']),counts(task['id'])) for name,task in tasks.items()}
    with ThreadPoolExecutor(max_workers=2) as executor:
        replay=Replayer(workflows=[OpenBotWork],plugins=[PydanticAIPlugin()],workflow_task_executor=executor)
        for history in histories.values():await replay.replay_workflow(history)
    assert before=={name:(api.snapshot(task['id']),counts(task['id'])) for name,task in tasks.items()}
    record=dict(case='product-owner-corrections',publicCommands=True,typedModelStaleContinuation=True,
        originalModelReceiptAfterCorrection=True,partialPreparePaired=True,unknownLookupOnly=True,
        oldApprovalSuperseded=True,lateVerificationCorrection=True,publicationAckRecovery=True,offlineReplay='passed',
        scope='actual HTTP/PG/mTLS/SDK; synthetic bounded provider/effects')
    print(json.dumps(record),flush=True);return [record]
