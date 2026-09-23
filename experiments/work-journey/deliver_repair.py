"""One durable command delivery; never starts/restarts a workflow or executes an effect."""
import asyncio
import json
from pathlib import Path

from temporalio.client import WorkflowExecutionStatus
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from engine_client import connect as connect_engine
import control
from openbot_server.work_reconciliation import ReconciliationStore


async def main():
    cfg = control.settings()
    task_id, run_id, action_id, command_id = (
        cfg['task_id'], cfg['run_id'], cfg['action_id'], cfg['command_id'])
    repairs = ReconciliationStore(control.store())
    command = await repairs.read(command_id, task_id=task_id, run_id=run_id, action_id=action_id)
    if command['finished_at'] is not None:
        return
    client = await connect_engine(cfg['temporal_address'], cfg.get('engine_tls'), plugins=[PydanticAIPlugin()])
    workflow_id = control.reference(run_id)
    description = await client.get_workflow_handle(workflow_id).describe()
    if description.status != WorkflowExecutionStatus.RUNNING:
        raise ValueError('Repair delivery requires an open engine execution; explicit recovery is needed')
    # Bind the run we verified. An unbound handle would signal a possibly different latest run.
    handle = client.get_workflow_handle(workflow_id, run_id=description.run_id)
    event = None
    async for event in handle.fetch_history_events(page_size=1):
        break
    if event is None or not event.HasField('workflow_execution_started_event_attributes'):
        raise ValueError('Repair engine start event missing')
    start = event.workflow_execution_started_event_attributes
    if start.workflow_type.name != 'WorkJourney' or start.task_queue.name != cfg['queue']:
        raise ValueError('Repair engine type/queue mismatch')
    if await client.data_converter.decode(start.input.payloads, [dict]) != [{'taskId': task_id, 'runId': run_id}]:
        raise ValueError('Repair engine scope mismatch')
    await control.fault_barrier('before-repair-delivery')
    await handle.signal('repair_requested', command_id)
    await control.fault_barrier('after-repair-delivery')
    changed = await repairs.acknowledge(command_id, 'temporal:default:' + workflow_id + ':' + description.run_id)
    Path(cfg['directory'], 'repair-delivered.json').write_text(json.dumps({'acknowledged': changed}))


if __name__ == '__main__':
    asyncio.run(main())
