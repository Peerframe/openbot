"""Official TemporalDurability using the plugin's deterministic workflow sandbox."""
import asyncio
from datetime import timedelta
from pathlib import Path
from temporalio import activity,workflow
from temporalio.client import Client
from temporalio.common import RetryPolicy
from temporalio.worker import Worker
from pydantic_ai.durable_exec.temporal import TemporalDurability,PydanticAIPlugin
from pydantic_ai.usage import UsageLimits
# Strategy definitions are trusted code; their I/O runs only in registered activities.
with workflow.unsafe.imports_passed_through():
    from strategy import settings,build_agent,mark_waiting,apply_external,resume

config={'start_to_close_timeout':timedelta(seconds=8),'retry_policy':RetryPolicy(maximum_attempts=3,initial_interval=timedelta(seconds=1))}
agent=build_agent(TemporalDurability(activity_config=config,model_activity_config={'heartbeat_timeout':timedelta(seconds=4)}))


@activity.defn
async def waiting_activity():await asyncio.to_thread(mark_waiting)


@activity.defn
async def apply_activity():return await asyncio.to_thread(apply_external)


@workflow.defn
class SDKWorkflow:
    __pydantic_ai_agents__=[agent]
    def __init__(self):self.approval=None;self.waiting=False

    @workflow.query
    def is_waiting(self)->bool:return self.waiting

    @workflow.signal
    async def approve(self,value:dict):
        if self.approval is None:self.approval=value

    @workflow.run
    async def run(self):
        first=await agent.run('Correct row 7',usage_limits=UsageLimits(request_limit=4))
        await workflow.execute_activity(waiting_activity,**config)
        self.waiting=True
        await workflow.wait_condition(lambda:self.approval is not None,timeout=timedelta(seconds=60))
        if self.approval!={'approved':True}:return {'outcome':'denied','requests':first.usage.requests}
        outcome=await workflow.execute_activity(apply_activity,**config)
        return await resume(agent,first,outcome)


async def main():
    cfg=settings()
    client=await Client.connect(cfg['temporal_address'],plugins=[PydanticAIPlugin()])
    async with Worker(client,task_queue=cfg['case'],workflows=[SDKWorkflow],
                      activities=[waiting_activity,apply_activity]):
        Path(cfg['directory'],'ready').touch()
        await asyncio.Event().wait()


if __name__=='__main__':asyncio.run(main())
