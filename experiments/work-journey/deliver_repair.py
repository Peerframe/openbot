"""Deliver one command; a closed Agent gets a separate lookup-only workflow."""
import asyncio
import json
from datetime import timedelta
from pathlib import Path

from temporalio.client import WorkflowExecutionStatus
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from engine_client import connect as connect_engine
import control
from openbot_server.work_reconciliation import ReconciliationStore


async def verify_start(client, handle, *, workflow_type, queue, identity, first_run_id=None):
    event = None
    async for event in handle.fetch_history_events(page_size=1):
        break
    if event is None or not event.HasField('workflow_execution_started_event_attributes'):
        raise ValueError('Repair engine start event missing')
    start = event.workflow_execution_started_event_attributes
    if start.workflow_type.name != workflow_type or start.task_queue.name != queue:
        raise ValueError('Repair engine type/queue mismatch')
    if first_run_id is not None and start.first_execution_run_id != first_run_id:
        raise ValueError('Repair engine chain mismatch')
    if await client.data_converter.decode(start.input.payloads, [dict]) != [identity]:
        raise ValueError('Repair engine scope mismatch')


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
    # Bind the run we verified. An unbound handle would signal a possibly different latest run.
    handle = client.get_workflow_handle(workflow_id, run_id=description.run_id)
    original_input,first_run_id=await control.accepted_start_for_repair(task_id,run_id)
    await verify_start(client, handle, workflow_type='WorkJourney', queue=cfg['queue'],
                       identity=original_input,first_run_id=first_run_id)
    await control.fault_barrier('before-repair-delivery')
    if description.status == WorkflowExecutionStatus.RUNNING:
        await handle.signal('repair_requested', command_id)
        delivery_reference='temporal:default:' + workflow_id + ':' + description.run_id
    else:
        # A closed Agent history is never restarted. A separate one-command workflow can
        # only inspect the existing Action and original external receipt.
        identity={'taskId':task_id,'runId':run_id,'actionId':action_id,'commandId':command_id}
        repair_id=control.repair_reference(command_id)
        try:
            repair=await client.start_workflow('ClosedRepair',identity,id=repair_id,
                task_queue=cfg['queue'],execution_timeout=timedelta(seconds=120),
                id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE)
        except WorkflowAlreadyStartedError:
            repair=client.get_workflow_handle(repair_id)
        repair_description=await repair.describe()
        repair=client.get_workflow_handle(repair_id,run_id=repair_description.run_id)
        await verify_start(client,repair,workflow_type='ClosedRepair',queue=cfg['queue'],identity=identity)
        if repair_description.status != WorkflowExecutionStatus.RUNNING:
            current=await repairs.read(command_id,task_id=task_id,run_id=run_id,action_id=action_id)
            if current['finished_at'] is None:
                raise ValueError('Closed repair ended without a verified command outcome')
        delivery_reference='temporal:default:' + repair_id
    await control.fault_barrier('after-repair-delivery')
    # An earlier open-workflow receipt is historical; a new lookup cannot replace it.
    current=await repairs.read(command_id,task_id=task_id,run_id=run_id,action_id=action_id)
    changed=(False if description.status != WorkflowExecutionStatus.RUNNING and current['delivery_reference'] is not None
             else await repairs.acknowledge(command_id,delivery_reference))
    Path(cfg['directory'], 'repair-delivered.json').write_text(json.dumps({'acknowledged': changed}))


if __name__ == '__main__':
    asyncio.run(main())
