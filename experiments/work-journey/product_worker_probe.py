"""Product publish acknowledgement recovery; no service callback may execute on retry."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import secrets

from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.worker import Replayer
from temporalio.api.enums.v1 import PendingActivityState
from openbot_server.work_worker import OpenBotWork


async def qualify_publication(client, api, bot, dsn, artifact_root, server, launch, counts):
    root = artifact_root.parent / 'model-receipts'; root.mkdir(mode=0o700)
    queue = 'product-' + secrets.token_hex(8)
    cfg = dict(dsn=dsn, artifact_root=str(artifact_root), model_receipt_root=str(root),
        model_mode='sdk-fixture', temporal_address=server.address, queue=queue,
        pause_model=False, pause_publication=True)
    worker = launch('product_worker_fixture.py', cfg)
    task = api.call('/api/v1/tasks', {'botId': bot['id'], 'objective': 'Product Worker publication',
        'tokenLimit': 20, 'requestKey': secrets.token_hex(12)}, expected=202)
    task_id, run_id = task['id'], task['runs'][0]['id']
    delivery = launch('product_dispatch_entry.py', cfg)
    await asyncio.to_thread(delivery.done, 65)
    records = json.loads(delivery.diagnostic())['deliveries']
    assert len(records) == 1 and records[0]['status'] == 'acknowledged' and records[0]['startRequested'] is True
    repeat = launch('product_dispatch_entry.py', cfg)
    await asyncio.to_thread(repeat.done, 65)
    assert json.loads(repeat.diagnostic()) == {'deliveries': []}
    await asyncio.to_thread(worker.wait, 'read-' + task_id)
    (worker.directory / ('release-' + task_id)).touch()
    await asyncio.to_thread(worker.wait, 'published-' + task_id)
    handle = client.get_workflow_handle('openbot-work-v1-' + run_id)
    description = await handle.describe()
    pending = description.raw_description.pending_activities
    assert len(pending) == 1 and pending[0].activity_type.name == 'openbot.publish_task.v1'
    assert pending[0].state == PendingActivityState.PENDING_ACTIVITY_STATE_STARTED and pending[0].attempt == 1
    assert not pending[0].HasField('last_failure')
    activity_id = pending[0].activity_id
    before, effects = api.snapshot(task_id), counts(task_id)
    assert before['status'] == 'completed' and before['usage']['spentTokens'] == 6
    assert len(before['artifacts']) == 1 and effects == {'attempts': 3, 'writes': 0, 'lookups': 1}
    original = api.call(before['artifacts'][0]['downloadUrl'], raw=True)
    worker.kill()
    # Publication has a75-second start-to-close timeout and no heartbeat. Cover that actual
    # engine retry window rather than adding a competing short application timeout.
    worker = launch('product_worker_fixture.py', cfg | dict(fail_callbacks=True, pause_publication=False))
    result = await asyncio.wait_for(handle.result(), 110)
    assert result == {'taskId': task_id, 'status': 'completed', 'artifactIds': [before['artifacts'][0]['id']]}
    assert (await handle.describe()).run_id == description.run_id
    assert api.snapshot(task_id) == before and counts(task_id) == effects
    assert api.call(before['artifacts'][0]['downloadUrl'], raw=True) == original == b'Product Worker publication: verified\n'
    assert sum(e['kind'] == 'task.completed' for e in before['events']) == 1
    history = await handle.fetch_history()
    scheduled = next(e.event_id for e in history.events if e.HasField('activity_task_scheduled_event_attributes')
        and e.activity_task_scheduled_event_attributes.activity_id == activity_id)
    assert any(e.HasField('activity_task_started_event_attributes')
        and e.activity_task_started_event_attributes.scheduled_event_id == scheduled
        and e.activity_task_started_event_attributes.attempt > 1 for e in history.events)
    worker.kill()
    with ThreadPoolExecutor(max_workers=2) as executor:
        await Replayer(workflows=[OpenBotWork], plugins=[PydanticAIPlugin()],
                       workflow_task_executor=executor).replay_workflow(history)
    assert api.snapshot(task_id) == before and counts(task_id) == effects
    record = dict(case='product-publication-recovery', productDispatch=True, originalEngineRun=True,
        completedEventCount=1, noCallbacksAfterRestart=True, artifactsUnchanged=True, offlineReplay='passed')
    print(json.dumps(record), flush=True)
    return [record]
