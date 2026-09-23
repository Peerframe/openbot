"""One bounded handoff drain; Temporal alone owns execution retries and durable waits."""
import asyncio
from pathlib import Path
import json

from engine_client import connect as connect_engine
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin

import control
from openbot_server.work_handoff import HandoffStore
from openbot_server.work_dispatcher import dispatch_one
from openbot_server.temporal_engine import TemporalEnginePort


class BarrierHandoff:
    """Reference-only crash barriers around the real product handoff facts."""

    def __init__(self, handoff):
        self.handoff = handoff

    async def unconfirmed_for(self, task_id, run_id):
        return await self.handoff.unconfirmed_for(task_id, run_id)

    async def reserve_submission(self, task_id, run_id, reference):
        await control.fault_barrier('before-enqueue')
        reserved = await self.handoff.reserve_submission(task_id, run_id, reference)
        if reserved:
            await control.fault_barrier('after-reservation')
        return reserved

    async def acknowledge(self, task_id, run_id, reference):
        await control.fault_barrier('after-enqueue')
        return await self.handoff.acknowledge(task_id, run_id, reference)


async def main():
    cfg = control.settings()
    timeout_seconds = cfg.get('execution_timeout_seconds', 240)
    if type(timeout_seconds) is not int or timeout_seconds not in (240, 1200):
        raise ValueError('Unsupported bounded fixture execution timeout')
    identity = {'taskId': cfg['task_id'], 'runId': cfg['run_id']}
    handoff = HandoffStore(control.store())
    pending = identity in await handoff.pending()
    unconfirmed = await handoff.unconfirmed_for(identity['taskId'], identity['runId'])
    if not pending and unconfirmed is None:
        return
    client = await connect_engine(cfg['temporal_address'], cfg.get('engine_tls'), plugins=[PydanticAIPlugin()])
    result = await dispatch_one(identity['taskId'], identity['runId'], 'default', cfg['queue'],
        'WorkJourney', timeout_seconds, BarrierHandoff(handoff), TemporalEnginePort(client))
    if not result.acknowledged:
        raise ValueError('Engine acceptance remains ' + result.reason)
    Path(cfg['directory'], 'dispatched.json').write_text(json.dumps({
        'acknowledged': result.reason == 'acknowledged'}))


if __name__ == '__main__':
    asyncio.run(main())
