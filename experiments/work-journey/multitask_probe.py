"""Public-entry proof for the shared Worker with actual PostgreSQL/Temporal state."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import secrets
import sys
from pathlib import Path

from temporalio.client import WorkflowFailureError, WorkflowExecutionStatus
from temporalio.exceptions import ApplicationError
from temporalio.api.enums.v1 import PendingActivityState
from temporalio.worker import Replayer
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin

sys.path.insert(0, str(Path(__file__).parents[2] / 'apps/server-python/src'))
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_handoff import HandoffStore
from openbot_server.work_dispatcher import dispatch_one
from openbot_server.temporal_engine import TemporalEnginePort


async def qualify_shared(client, api, bot, dsn, artifact_root, server, launch, counts, *, product=False):
    if product:
        from openbot_server.work_worker import OpenBotWork as MultitaskWork, TYPE
    else:
        from multitask_worker import MultitaskWork, TYPE
    queue = 'shared-' + secrets.token_hex(8)
    cfg = {'dsn': dsn, 'artifact_root': str(artifact_root),
           'temporal_address': server.address, 'queue': queue}
    worker = launch('product_worker_fixture.py' if product else 'multitask_worker.py', cfg)
    tasks = [api.call('/api/v1/tasks', {'botId': bot['id'], 'objective': objective,
        'tokenLimit': limit, 'requestKey': secrets.token_hex(12)}, expected=202)
        for objective, limit in [('Cancelled alpha observation', 3), ('Independent beta observation', 6)]]
    handoff = HandoffStore(PostgresWorkStore(dsn, files=LocalWorkFiles(artifact_root)))
    engine = TemporalEnginePort(client)
    for task in tasks:
        result = await dispatch_one(task['id'], task['runs'][0]['id'], 'default', queue,
                                    TYPE, 240, handoff, engine)
        assert result.acknowledged, result.reason
    # Both tool invocations are held simultaneously, in one process and on one queue.
    for task in tasks:
        await asyncio.to_thread(worker.wait, 'read-' + task['id'])
        assert api.snapshot(task['id'])['usage']['spentTokens'] == 3
    handles = [client.get_workflow_handle('openbot-work-v1-' + t['runs'][0]['id']) for t in tasks]
    for handle in handles:
        description = await handle.describe()
        assert description.status == WorkflowExecutionStatus.RUNNING
        pending = description.raw_description.pending_activities
        assert len(pending) == 1, pending
        assert pending[0].state == PendingActivityState.PENDING_ACTIVITY_STATE_STARTED
        assert pending[0].attempt == 1 and not pending[0].HasField('last_failure')
    api.cancel(tasks[0]['id'])
    for task in tasks:
        (worker.directory / ('release-' + task['id'])).touch()
    try:
        await asyncio.wait_for(handles[0].result(), 30)
    except WorkflowFailureError as error:
        if product:
            # Product work_worker.py finalizes, then re-raises OpenBotTaskFailed from None:
            # its deliberate sanitation boundary stops the cause chain at this ApplicationError.
            failure = error.cause
            assert isinstance(failure, ApplicationError), failure
            assert failure.type == 'OpenBotTaskFailed', failure.type
            assert failure.message == 'execution_failed', failure.message
            assert failure.non_retryable is True, failure.non_retryable
            assert failure.cause is None, failure.cause
        else:
            causes = []
            cause = error
            while cause is not None:
                causes.append(str(cause))
                cause = getattr(cause, 'cause', None)
            assert any('admission_closed' in c for c in causes), causes
    else:
        raise AssertionError('Cancelled Task continued to publication')
    await asyncio.wait_for(handles[1].result(), 30)
    stopped, completed = [api.snapshot(t['id']) for t in tasks]
    assert stopped['status'] == 'cancelled' and not stopped['artifacts']
    assert stopped['usage'] == {'tokenLimit': 3, 'reservedTokens': 0, 'spentTokens': 3}, stopped['usage']
    assert completed['status'] == 'completed'
    assert completed['usage'] == {'tokenLimit': 6, 'reservedTokens': 0, 'spentTokens': 6}, completed['usage']
    assert len(stopped['actions']) == 1 and len(completed['actions']) == 3
    assert counts(tasks[0]['id']) == {'attempts': 1, 'writes': 0, 'lookups': 1}
    assert counts(tasks[1]['id']) == {'attempts': 3, 'writes': 0, 'lookups': 3}
    assert len(completed['artifacts']) == 1
    assert api.call(completed['artifacts'][0]['downloadUrl'], raw=True) == b'Independent beta observation: verified\n'
    worker.kill()
    before = [(api.snapshot(t['id']), counts(t['id'])) for t in tasks]
    # Offline replay must not invoke service loaders, ports, control stores or effects.
    with ThreadPoolExecutor(max_workers=2) as executor:
        replayer = Replayer(workflows=[MultitaskWork], plugins=[PydanticAIPlugin()], workflow_task_executor=executor)
        for handle in handles:
            await replayer.replay_workflow(await handle.fetch_history())
    assert before == [(api.snapshot(t['id']), counts(t['id'])) for t in tasks]
    record = {'case': 'product-concurrent-runs' if product else 'concurrent-runs', 'oneWorkerQueueAgent': True,
              'overlappingToolActivities': True, 'isolatedCancellationAccountingArtifacts': True,
              'cancelledSpent': 3, 'completedSpent': 6, 'offlineReplay': 'passed',
              'scope': ('product Worker; ' if product else '') + 'public HTTP + PostgreSQL + Temporal; scripted ports, no live provider'}
    print(json.dumps(record), flush=True)
    return [record]
