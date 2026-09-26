"""One finite pass over existing commands; only a proved closed original can start a lookup."""
import asyncio
from datetime import timedelta

from temporalio.client import WorkflowExecutionStatus
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError

from .temporal_engine import TemporalEnginePort
from .work_closed_repair import finish_current
from .work_reconciliation import ReconciliationStore
from .work_repair_binding import TYPE, PREFIX, identity, original_run, scope
from .work_values import InvalidWork, WorkConflict, text


async def deliver_closed_repair(store, client, value, *, namespace, queue, workflow_type):
    value = identity(value)
    commands = ReconciliationStore(store)
    command = await commands.read(value['commandId'], **scope(value))
    if command['outcome'] is not None:
        return dict(status='finished', outcome=command['outcome'])
    status = await original_run(store, client, value, namespace=namespace, queue=queue,
                                workflow_type=workflow_type)
    if status == WorkflowExecutionStatus.RUNNING:
        return dict(status='waiting_original', outcome=None)
    repair_id = PREFIX + value['commandId']
    try:
        await client.start_workflow(TYPE, value, id=repair_id, task_queue=queue,
            execution_timeout=timedelta(seconds=180),
            id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE)
    except WorkflowAlreadyStartedError:
        pass
    description = await client.get_workflow_handle(repair_id).describe()
    current_run = text(description.run_id, 256)
    start = await TemporalEnginePort(client).inspect_start(repair_id, run_id=current_run)
    if (start is None or start.workflow_type != TYPE or start.task_queue != queue
            or start.first_run_id != current_run or start.input != value):
        raise WorkConflict('repair_start_changed')
    current = await commands.read(value['commandId'], **scope(value))
    if current['delivery_reference'] is None:
        await commands.acknowledge(value['commandId'], repair_id)
    if description.status == WorkflowExecutionStatus.RUNNING:
        return dict(status='delivered', outcome=current['outcome'])
    # Engine closure is not success. Only durable verified Action state can resolve a cycle;
    # otherwise keep the reservation and end this lookup cycle as unresolved.
    from .work_repair_binding import CLOSED
    if description.status not in CLOSED:
        raise WorkConflict('repair_engine_state_unproven')
    return dict(status='finished', outcome=await finish_current(store, value))


async def repair_batch(store, client, *, namespace, queue, workflow_type, limit=16, item_timeout_seconds=10):
    text(namespace, 64); text(queue, 256); text(workflow_type, 256)
    if (type(limit) is not int or not 1 <= limit <= 64 or type(item_timeout_seconds) is not int
            or not 1 <= item_timeout_seconds <= 30):
        raise InvalidWork('invalid_repair_batch')
    if client.namespace != namespace:
        raise WorkConflict('engine_namespace_mismatch')
    async with asyncio.timeout(item_timeout_seconds):
        rows = await ReconciliationStore(store).pending(limit)
    if type(rows) is not list or len(rows) > limit:
        raise InvalidWork('invalid_repair_batch')
    values = [identity(row) for row in rows]
    results = []
    for value in values:
        try:
            async with asyncio.timeout(item_timeout_seconds):
                result = await deliver_closed_repair(store, client, value, namespace=namespace,
                    queue=queue, workflow_type=workflow_type)
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            result = dict(status='unconfirmed', reason='observation_timeout', outcome=None)
        except Exception:
            result = dict(status='unconfirmed', reason='repair_delivery_unproven', outcome=None)
        results.append(value | result)
    return results
