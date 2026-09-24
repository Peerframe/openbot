"""Public Task -> actual SDK -> durable receipt -> owned Worker crash -> original response."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import secrets

import psycopg
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.worker import Replayer
from temporalio.api.enums.v1 import PendingActivityState

from multitask_probe import HandoffStore, PostgresWorkStore, LocalWorkFiles, TemporalEnginePort, dispatch_one
from openbot_server.work_temporal_activity import derive_claim_id


async def qualify_model_recovery(client, api, bot, dsn, artifact_root, server, launch, counts):
    from multitask_worker import MultitaskWork, TYPE
    receipt_root = artifact_root.parent / 'model-receipts'
    receipt_root.mkdir(mode=0o700)
    queue = 'sdk-model-' + secrets.token_hex(8)
    cfg = {'dsn': dsn, 'artifact_root': str(artifact_root), 'model_receipt_root': str(receipt_root),
           'model_mode': 'sdk-fixture', 'temporal_address': server.address, 'queue': queue}
    worker = launch('multitask_worker.py', cfg)
    task = api.call('/api/v1/tasks', {'botId': bot['id'], 'objective': 'Recovered SDK observation',
        'tokenLimit': 20, 'requestKey': secrets.token_hex(12)}, expected=202)
    task_id, run_id = task['id'], task['runs'][0]['id']
    handoff = HandoffStore(PostgresWorkStore(dsn, files=LocalWorkFiles(artifact_root)))
    result = await dispatch_one(task_id, run_id, 'default', queue, TYPE, 240, handoff, TemporalEnginePort(client))
    assert result.acknowledged, result.reason
    await asyncio.to_thread(worker.wait, 'model-receipt-' + task_id)
    handle = client.get_workflow_handle('openbot-work-v1-' + run_id)
    description = await handle.describe()
    original_engine_run = description.run_id
    pending = description.raw_description.pending_activities
    assert len(pending) == 1 and pending[0].state == PendingActivityState.PENDING_ACTIVITY_STATE_STARTED
    assert pending[0].attempt == 1 and not pending[0].HasField('last_failure')
    model_activity_id = pending[0].activity_id
    claim_id = derive_claim_id('default', 'openbot-work-v1-' + run_id, original_engine_run, model_activity_id)
    snap = api.snapshot(task_id)
    assert len(snap['actions']) == 1 and snap['actions'][0]['status'] == 'admitted', snap
    action_id = snap['actions'][0]['id']
    assert snap['usage'] == {'tokenLimit': 20, 'spentTokens': 0, 'reservedTokens': 6}
    assert counts(task_id) == {'attempts': 1, 'writes': 0, 'lookups': 0}
    with psycopg.connect(dsn) as db:
        receipt = db.execute('SELECT sha256,actual_tokens FROM work_model_receipts WHERE action_id=%s',
                             (action_id,)).fetchone()
    assert receipt is not None and receipt[1] == 3
    # The crash is intentional test input, after metadata commit and before engine acknowledgement.
    worker.kill()
    with psycopg.connect(dsn) as db:
        updated = db.execute("UPDATE work_claims SET expires_at=clock_timestamp()-interval '1 second' "
                             "WHERE run_id=%s AND claim_id=%s", (run_id, claim_id))
        assert updated.rowcount == 1
        assert db.execute('SELECT expires_at < clock_timestamp() FROM work_claims WHERE run_id=%s AND claim_id=%s',
                          (run_id, claim_id)).fetchone() == (True,)
    worker = launch('multitask_worker.py', cfg)
    await asyncio.to_thread(worker.wait, 'read-' + task_id)
    recovered = api.snapshot(task_id)
    assert recovered['actions'][0]['id'] == action_id and recovered['actions'][0]['status'] == 'applied'
    assert recovered['usage'] == {'tokenLimit': 20, 'spentTokens': 3, 'reservedTokens': 0}
    assert counts(task_id)['attempts'] == 1, 'Activity recovery repeated the model HTTP request'
    (worker.directory / ('release-' + task_id)).touch()
    await asyncio.wait_for(handle.result(), 35)
    completed = api.snapshot(task_id)
    assert (await handle.describe()).run_id == original_engine_run
    assert completed['status'] == 'completed' and len(completed['actions']) == 3
    assert completed['usage'] == {'tokenLimit': 20, 'spentTokens': 6, 'reservedTokens': 0}
    assert len([e for e in completed['events'] if e['kind'] == 'action.resolved'
                and e['payload']['actionId'] == action_id]) == 1
    history = await handle.fetch_history()
    scheduled = next(e.event_id for e in history.events if e.HasField('activity_task_scheduled_event_attributes')
        and e.activity_task_scheduled_event_attributes.activity_id == model_activity_id)
    starts = [e for e in history.events if e.HasField('activity_task_started_event_attributes')
        and e.activity_task_started_event_attributes.scheduled_event_id == scheduled]
    assert starts and starts[-1].activity_task_started_event_attributes.attempt > 1
    assert any(e.HasField('activity_task_completed_event_attributes')
        and e.activity_task_completed_event_attributes.started_event_id == starts[-1].event_id for e in history.events)
    assert counts(task_id) == {'attempts': 3, 'writes': 0, 'lookups': 1}
    assert len(completed['artifacts']) == 1
    assert api.call(completed['artifacts'][0]['downloadUrl'], raw=True) == b'Recovered SDK observation: verified\n'
    worker.kill()
    before = (completed, counts(task_id))
    with ThreadPoolExecutor(max_workers=2) as executor:
        await Replayer(workflows=[MultitaskWork], plugins=[PydanticAIPlugin()],
                       workflow_task_executor=executor).replay_workflow(await handle.fetch_history())
    assert before == (api.snapshot(task_id), counts(task_id))
    record = {'case': 'model-receipt-recovery', 'modelRequests': 2, 'modelRequestsRepeatedAfterCrash': 0,
              'expiredClaimRecovered': True, 'spentTokens': 6, 'downloadVerified': True,
              'offlineReplay': 'passed', 'scope': 'public HTTP + PG + Temporal + real SDK, synthetic provider HTTP'}
    print(json.dumps(record), flush=True)
    return [record]
