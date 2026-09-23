"""A trusted strategy with control-side activities; effect execution remains outside the SDK."""
import asyncio
from datetime import timedelta
from pathlib import Path
from temporalio import activity,workflow
from temporalio.client import Client
from temporalio.common import RetryPolicy
from temporalio.worker import Worker
from pydantic_ai import Agent,DeferredToolRequests,DeferredToolResults
from pydantic_ai.durable_exec.temporal import TemporalDurability,PydanticAIPlugin
from pydantic_ai.messages import ModelResponse,TextPart,ToolCallPart,ToolReturnPart
from pydantic_ai.models import Model
from pydantic_ai.tools import ToolDefinition
from pydantic_ai.toolsets.external import ExternalToolset
from pydantic_ai.usage import RequestUsage,UsageLimits
with workflow.unsafe.imports_passed_through():
    import control

CONFIG={'start_to_close_timeout':timedelta(seconds=10),'retry_policy':RetryPolicy(maximum_attempts=4,
    initial_interval=timedelta(seconds=1),non_retryable_error_types=['ReceiptMismatch','WorkConflict','InvalidWork'])}


class ControlledScript(Model):
    @property
    def model_name(self):return 'control-owned-reference'
    @property
    def system(self):return 'openbot-reference'
    async def request(self,messages,model_settings,model_request_parameters):
        returned={p.tool_name:p.content for m in messages for p in m.parts if isinstance(p,ToolReturnPart)}
        stage='plan' if 'read_row' not in returned else 'final' if 'write_row' in returned else 'decide'
        output=await control.perform('model:'+stage,{'kind':'model','stage':stage})
        if stage=='plan':parts=[ToolCallPart('read_row',{},tool_call_id='read-reference')]
        elif stage=='decide':parts=[ToolCallPart('write_row',{'row':7,'value':'fixed'},tool_call_id='write-reference')]
        else:
            if returned['write_row']!='applied':raise control.ReceiptMismatch('Unverified effect provided to SDK')
            parts=[TextPart(output)]
        return ModelResponse(parts,usage=RequestUsage(input_tokens=2,output_tokens=1),model_name=self.model_name)


async def read_row():
    """Read the permitted reference CSV through control-owned admission."""
    return await control.perform('tool:read',{'kind':'read'})


agent=Agent(ControlledScript(),name='openbot-work-reference',output_type=[str,DeferredToolRequests],
    tools=[read_row],toolsets=[ExternalToolset([ToolDefinition(name='write_row',parameters_json_schema={
        'type':'object','properties':{'row':{'type':'integer'},'value':{'type':'string'}},'required':['row','value'],'additionalProperties':False})])],
    capabilities=[TemporalDurability(activity_config=CONFIG,model_activity_config={'heartbeat_timeout':timedelta(seconds=4)})],retries=0)


@activity.defn
async def bind_identity(identity:dict)->None:await control.bind_identity(identity)
@activity.defn
async def prepare(call:dict)->str:return await control.prepare_write(call)
@activity.defn
async def decision(identity:str)->str:return await control.decision(identity)
@activity.defn
async def execute_write()->str:return await control.perform('tool:write',{'kind':'write','row':7,'value':'fixed'})
@activity.defn
async def publish(summary:str)->dict:return await control.publish(summary)
@activity.defn
async def current()->dict:
    snap=await control.inspect();return {'status':snap['status'],'active':snap['authorityActive'],'cancelRequested':snap['cancelRequested']}


@workflow.defn
class WorkJourney:
    __pydantic_ai_agents__=[agent]
    def __init__(self):self.identity=None;self.waiting=False
    @workflow.query
    def identity_query(self)->dict:return self.identity
    @workflow.query
    def waiting_query(self)->bool:return self.waiting
    @workflow.run
    async def run(self,identity:dict)->dict:
        self.identity=identity
        await workflow.execute_activity(bind_identity,identity,**CONFIG)
        first=await agent.run('Correct row 7',usage_limits=UsageLimits(request_limit=4))
        if not isinstance(first.output,DeferredToolRequests) or len(first.output.calls)!=1:
            raise ValueError('Expected one external write proposal')
        call=first.output.calls[0]
        action_id=await workflow.execute_activity(prepare,{'name':call.tool_name,'args':call.args_as_dict()},**CONFIG)
        self.waiting=True
        # The engine owns this durable wait. The control DB owns the approval; no second scheduler
        # replays agent segments, and a cached boolean signal cannot stand in for current admission.
        while True:
            answer=await workflow.execute_activity(decision,action_id,**CONFIG)
            if answer!='pending':break
            await workflow.sleep(1)
        self.waiting=False
        if answer!='approved':return {'taskId':identity['taskId'],'outcome':answer}
        outcome=await workflow.execute_activity(execute_write,**CONFIG)
        state=await workflow.execute_activity(current,**CONFIG)
        if not state['active']:return {'taskId':identity['taskId'],'outcome':'stopped','status':state['status']}
        final=await agent.run(message_history=first.all_messages(),usage=first.usage,
            deferred_tool_results=DeferredToolResults(calls={call.tool_call_id:outcome}),usage_limits=UsageLimits(request_limit=4))
        return await workflow.execute_activity(publish,final.output,**CONFIG)


async def main():
    cfg=control.settings()
    client=await Client.connect(cfg['temporal_address'],plugins=[PydanticAIPlugin()])
    async with Worker(client,task_queue=cfg['queue'],workflows=[WorkJourney],activities=[bind_identity,prepare,decision,execute_write,publish,current]):
        Path(cfg['directory'],'ready').touch()
        await asyncio.Event().wait()


if __name__=='__main__':asyncio.run(main())
