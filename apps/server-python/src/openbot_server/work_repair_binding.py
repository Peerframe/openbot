"""Bind a finite historical lookup to its command and exact acknowledged original engine Run."""
from dataclasses import dataclass

from temporalio.client import WorkflowExecutionStatus
from temporalio import activity

from .temporal_engine import TemporalEnginePort
from .work_engine_binding import EngineActivityFacts, assert_historical_workflow
from .work_reconciliation import ReconciliationStore
from .work_temporal_activity import current_activity_id
from .work_values import InvalidWork, WorkConflict, canonical, text

TYPE = 'OpenBotClosedRepairV1'
PREFIX = 'openbot-closed-repair-v1-'
CLOSED = {WorkflowExecutionStatus.COMPLETED, WorkflowExecutionStatus.FAILED,
          WorkflowExecutionStatus.CANCELED, WorkflowExecutionStatus.TERMINATED,
          WorkflowExecutionStatus.TIMED_OUT}


@dataclass(frozen=True)
class HistoricalEffectContext:
    task_id: str
    run_id: str
    bot_id: str
    correction_token: str | None = None


def identity(value):
    keys = {'taskId', 'runId', 'actionId', 'commandId'}
    if type(value) is not dict or set(value) != keys:
        raise InvalidWork('invalid_repair_identity')
    return {key: text(value[key], 128) for key in sorted(keys)}


def scope(value):
    return dict(task_id=value['taskId'], run_id=value['runId'], action_id=value['actionId'])


async def original_run(store, client, value, *, namespace, queue, workflow_type):
    """Inspect the SQL-recorded first Run, never a latest-Run lookup or a Task-status guess."""
    value = identity(value)
    if client.namespace != namespace:
        raise WorkConflict('engine_namespace_mismatch')
    async with store._transaction(trusted=True) as db:
        await store._task(db, value['taskId'], read=True)
        row = await (await db.execute(
            'SELECT a.engine_first_run_id FROM work_runs r JOIN work_admissions a ON a.run_id=r.id '
            'WHERE r.task_id=%s AND r.id=%s', (value['taskId'], value['runId']))).fetchone()
    if row is None or not row['engine_first_run_id']:
        raise WorkConflict('handoff_engine_run_unbound')
    first = text(row['engine_first_run_id'], 256)
    workflow_id = 'openbot-work-v1-' + value['runId']
    handle = client.get_workflow_handle(workflow_id, run_id=first)
    description = await handle.describe()
    if description.run_id != first:
        raise WorkConflict('repair_original_run_changed')
    start = await TemporalEnginePort(client).inspect_start(workflow_id, run_id=first)
    if start is None:
        raise WorkConflict('engine_start_history_unavailable')
    facts = EngineActivityFacts(namespace=client.namespace, queue=description.task_queue,
        start_queue=start.task_queue, workflow_id=workflow_id, workflow_type=start.workflow_type,
        engine_run_id=first, first_run_id=start.first_run_id, start_input=start.input)
    await assert_historical_workflow(store, {'taskId': value['taskId'], 'runId': value['runId']}, facts,
        expected_namespace=namespace, expected_queue=queue, expected_workflow_type=workflow_type)
    if description.status not in CLOSED | {WorkflowExecutionStatus.RUNNING}:
        raise WorkConflict('repair_original_state_unproven')
    return description.status


async def bind_repair_activity(store, client, value, *, namespace, queue, workflow_type):
    value = identity(value)
    info = activity.info()
    current_activity_id(info)
    engine_run = text(info.workflow_run_id, 256)
    if (info.workflow_id != PREFIX + value['commandId'] or info.workflow_type != TYPE
            or info.task_queue != queue or info.namespace != namespace or client.namespace != namespace):
        raise WorkConflict('repair_activity_scope_changed')
    start = await TemporalEnginePort(client).inspect_start(info.workflow_id, run_id=engine_run)
    if (start is None or start.workflow_type != TYPE or start.task_queue != queue
            or start.first_run_id != engine_run or start.input != value):
        raise WorkConflict('repair_start_changed')
    if await original_run(store, client, value, namespace=namespace, queue=queue,
                          workflow_type=workflow_type) not in CLOSED:
        raise WorkConflict('repair_original_still_running')
    await ReconciliationStore(store).read(value['commandId'], **scope(value))
    async with store._transaction(trusted=True) as db:
        task, row = await store._action(db, value['actionId'])
        if (row['task_id'], row['run_id']) != (value['taskId'], value['runId']):
            raise WorkConflict('reconciliation_scope_changed')
        intent = row['intent']
        if (not row['action_key'].startswith('tool-activity-v1-') or type(intent) is not dict
                or set(intent) != {'kind', 'tool', 'arguments', 'effect'}
                or intent['kind'] != 'deferred_tool' or canonical(intent)[1] != row['intent_digest']):
            raise WorkConflict('deferred_record_invalid')
        return HistoricalEffectContext(value['taskId'], value['runId'], text(task['bot_id'], 128), row.get('correction_context_id')), row
