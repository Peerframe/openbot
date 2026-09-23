"""One bounded handoff drain; Temporal alone owns execution retries and durable waits."""
import asyncio
from datetime import timedelta
from pathlib import Path
import json

from engine_client import connect as connect_engine
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin

import control
from openbot_server.work_handoff import HandoffStore


async def main():
    cfg = control.settings()
    timeout_seconds = cfg.get('execution_timeout_seconds', 240)
    if type(timeout_seconds) is not int or timeout_seconds not in (240, 1200):
        raise ValueError('Unsupported bounded fixture execution timeout')
    identity = {'taskId': cfg['task_id'], 'runId': cfg['run_id']}
    handoff = HandoffStore(control.store())
    if identity not in await handoff.pending():
        return
    client = await connect_engine(cfg['temporal_address'], cfg.get('engine_tls'), plugins=[PydanticAIPlugin()])
    workflow_id = control.reference(identity['runId'])
    await control.fault_barrier('before-enqueue')
    try:
        handle = await client.start_workflow('WorkJourney', identity, id=workflow_id,
            task_queue=cfg['queue'], execution_timeout=timedelta(seconds=timeout_seconds),
            id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE)
    except WorkflowAlreadyStartedError:
        handle = client.get_workflow_handle(workflow_id)
    # Verify the immutable start event, even when the worker is absent. A colliding ID alone
    # does not establish that the engine accepted this Task/Run and reviewed workflow type.
    start = None
    async for event in handle.fetch_history_events(page_size=1):
        if event.HasField('workflow_execution_started_event_attributes'):
            start = event.workflow_execution_started_event_attributes
        break
    if start is None or start.workflow_type.name != 'WorkJourney':
        raise ValueError('Engine acceptance type mismatch')
    if await client.data_converter.decode(start.input.payloads, [dict]) != [identity]:
        raise ValueError('Engine acceptance scope mismatch')
    if start.task_queue.name != cfg['queue']:
        raise ValueError('Engine acceptance queue mismatch')
    await control.fault_barrier('after-enqueue')
    changed = await handoff.acknowledge(identity['taskId'], identity['runId'],
                                      'temporal:default:' + workflow_id)
    Path(cfg['directory'], 'dispatched.json').write_text(json.dumps({'acknowledged': changed}))


if __name__ == '__main__':
    asyncio.run(main())
