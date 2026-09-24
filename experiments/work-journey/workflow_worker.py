"""A trusted strategy with control-side activities; effect execution remains outside the SDK."""
import asyncio
from datetime import timedelta
from dataclasses import dataclass
import sys
from pathlib import Path
from temporalio import activity,workflow
from engine_client import connect as connect_engine
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError, TimeoutError as ActivityTimeout
from temporalio.worker import Worker
from pydantic_ai import DeferredToolRequests,DeferredToolResults
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from pydantic_ai.messages import ModelResponse,TextPart,ToolCallPart,ToolReturnPart
from pydantic_ai.usage import RequestUsage,UsageLimits
with workflow.unsafe.imports_passed_through():
    import control
    # Pure path assembly; resolving paths during Workflow module replay is forbidden.
    sys.path.insert(0,str(Path(__file__).parents[2]/'apps/agent-runtime-python/src'))
    from openbot_agent_runtime.catalog import ToolCatalog
    from openbot_agent_runtime.contracts import RuntimeLimits, ToolDescriptor
    from openbot_agent_runtime.guard import RunGuard
    from openbot_agent_runtime.sdk_ports import PortModel, PortToolset
    from openbot_agent_runtime.temporal_agent import build_temporal_agent
    from openbot_server.work_temporal_activity import bind_current_activity
    from openbot_server.work_temporal_start import load_current_activity_task

CONFIG={'start_to_close_timeout':timedelta(seconds=10),'retry_policy':RetryPolicy(maximum_attempts=4,
    initial_interval=timedelta(seconds=1),non_retryable_error_types=['ReceiptMismatch','WorkConflict','InvalidWork'])}
# A running Worker can consume before the dispatcher records acknowledgement. Only this
# read-only startup activity has a longer bounded wait; effects keep their existing policy.
START_CONFIG={'start_to_close_timeout':timedelta(seconds=10),
    'schedule_to_close_timeout':timedelta(seconds=120),
    'retry_policy':RetryPolicy(initial_interval=timedelta(seconds=1),
        maximum_interval=timedelta(seconds=5),
        non_retryable_error_types=['ReceiptMismatch','WorkConflict','InvalidWork','WorkNotFound'])}
# Set once in ``main``; the registered activity reads it at call time so the product seam binds
# the real connected engine client.
_ENGINE=None


@dataclass(frozen=True)
class WorkDeps:
    task_id: str
    run_id: str


READ=ToolDescriptor(name='read_row',description='Read the permitted reference CSV.',
    input_schema={'type':'object','properties':{},'additionalProperties':False})
WRITE=ToolDescriptor(name='write_row',description='Propose the reviewed CSV correction.',
    input_schema={'type':'object','properties':{'row':{'type':'integer'},'value':{'type':'string'}},
                  'required':['row','value'],'additionalProperties':False})


async def assert_runtime_scope(deps):
    # Typed deps are a routing hint, not authority. Check the SDK's actual engine
    # Run and immutable start against the control admission on every guard await.
    cfg=control.settings()
    accepted=await bind_current_activity(control.store(),_ENGINE,
        expected_namespace='default',expected_queue=cfg['queue'],expected_workflow_type='WorkJourney')
    if (accepted.task_id,accepted.run_id)!=(deps.task_id,deps.run_id):
        raise control.WorkConflict('runtime_deps_scope_mismatch')


def runtime_parts(deps,descriptors):
    limits=RuntimeLimits()
    guard=RunGuard(authority=lambda:assert_runtime_scope(deps),progress=None,
        steps_limit=limits.steps,tool_calls_limit=limits.tool_calls,
        progress_events_limit=limits.progress_events,deadline_seconds=10)
    catalog=ToolCatalog(descriptors,max_tools=limits.catalog_tools,max_bytes=limits.catalog_bytes)
    return limits,guard,catalog


async def model_port(request):
    # Scripted response only. Billing/admission still use durable control Actions;
    # fresh per-activity Runtime guards never stand in for that shared budget.
    returned={p.tool_name:p.content for m in request.messages for p in m.parts if isinstance(p,ToolReturnPart)}
    stage='plan' if 'read_row' not in returned else 'final' if 'write_row' in returned else 'decide'
    output=await control.perform('model:'+stage,{'kind':'model','stage':stage})
    if stage=='plan':parts=[ToolCallPart('read_row',{},tool_call_id='read-reference')]
    elif stage=='decide':parts=[ToolCallPart('write_row',{'row':7,'value':'fixed'},tool_call_id='write-reference')]
    else:
        if returned['write_row']!='applied':raise control.ReceiptMismatch('Unverified effect provided to SDK')
        parts=[TextPart(output)]
    return ModelResponse(parts,usage=RequestUsage(input_tokens=2,output_tokens=1),model_name='openbot-port')


async def inline_tool_port(request):
    if request.name!='read_row' or request.arguments!={}:
        raise control.ReceiptMismatch('Only the admitted read is an inline Runtime tool')
    return await control.perform('tool:read',{'kind':'read'})


async def model_factory(deps):
    await assert_runtime_scope(deps)
    limits,guard,catalog=runtime_parts(deps,(READ,WRITE))
    return PortModel(step_port=model_port,catalog=catalog,guard=guard,limits=limits)


async def toolset_factory(deps):
    await assert_runtime_scope(deps)
    limits,guard,catalog=runtime_parts(deps,(READ,))
    return PortToolset(catalog=catalog,tool_port=inline_tool_port,guard=guard,limits=limits)


agent=build_temporal_agent(name='openbot-work-reference',deps_type=WorkDeps,
    model_factory=model_factory,toolset_factory=toolset_factory,instructions='',
    activity_config=CONFIG,model_activity_config={'heartbeat_timeout':timedelta(seconds=4)},
    deferred_tools=(WRITE,))


@activity.defn
async def bind_identity(identity:dict)->None:
    # Preserve the activity name/input/None result for recorded histories. The original
    # attempt check also rejects a collision before waiting for acknowledgement.
    await control.bind_identity(identity)
    cfg=control.settings()
    context=await load_current_activity_task(control.store(),_ENGINE,
        expected_namespace='default',expected_queue=cfg['queue'],expected_workflow_type='WorkJourney')
    if (context.task_id,context.run_id)!=(identity['taskId'],identity['runId']):
        raise control.WorkConflict('runtime_deps_scope_mismatch')
@activity.defn
async def prepare(call:dict)->str:return await control.prepare_write(call)
@activity.defn
async def decision(identity:str)->str:return await control.decision(identity)
@activity.defn
async def execute_write()->str:
    # The reference fault barrier stays outside the product seam so a retry can be held before
    # any inspection or POST, exactly as the existing probe requires.
    await control.fault_barrier('before-write-inspection')
    outcome=await control.execute_activity_write(_ENGINE)
    if outcome.status!='applied':
        raise control.UnresolvedEffect('Query the committed receipt on retry')
    return outcome.status
@activity.defn
async def publish(summary:str)->dict:return await control.publish(summary)
@activity.defn
async def current()->dict:
    snap=await control.inspect();return {'status':snap['status'],'active':snap['authorityActive'],'cancelRequested':snap['cancelRequested']}


@activity.defn
async def repair_state()->dict:return await control.repair_state()
@activity.defn
async def reconcile_write(command_id:str)->str:return await control.reconcile_write(command_id)
@activity.defn
async def finish_failed_repair(command_id:str)->None:await control.finish_failed_repair(command_id)
@activity.defn
async def reconcile_closed(identity:dict)->str:return await control.reconcile_closed(identity)
@activity.defn
async def finish_closed_repair(identity:dict)->None:await control.finish_closed_repair(identity)


def repairable(error):
    cause = error.cause
    return isinstance(cause, ActivityTimeout) or isinstance(cause, ApplicationError) and cause.type in (
        'ReceiptMismatch', 'UnresolvedEffect', 'HTTPError', 'URLError', 'TimeoutError', 'ConnectionError')


@workflow.defn
class WorkJourney:
    __pydantic_ai_agents__=[agent]
    def __init__(self):
        self.identity=None;self.waiting=False
        self.repair_waiting=False
        self.repair_generation=0
    @workflow.signal
    def repair_requested(self,command_id:str)->None:
        # A signal is only a hint. Durable control records decide whether a lookup is owed.
        if type(command_id) is str and 1 <= len(command_id) <= 128:
            self.repair_generation += 1
    @workflow.query
    def reconciliation_query(self)->bool:return self.repair_waiting

    async def wait_for_repair(self)->str:
        self.repair_waiting=True
        while True:
            observed=self.repair_generation
            state=await workflow.execute_activity(repair_state,**CONFIG)
            if state['status'] in ('applied','not_applied'):
                self.repair_waiting=False
                return state['status']
            if state['status']!='unknown':
                raise ApplicationError('Repair requires a previously unknown Action',non_retryable=True)
            if state['commandId'] is not None:
                try:
                    outcome=await workflow.execute_activity(reconcile_write,state['commandId'],**CONFIG)
                except ActivityError as error:
                    if not repairable(error):raise
                    await workflow.execute_activity(finish_failed_repair,state['commandId'],**CONFIG)
                    continue
                self.repair_waiting=False
                return outcome
            # Check the durable obligation before sleeping. A signal arriving during either
            # activity or before this wait changes the generation and cannot be cleared/lost.
            await workflow.wait_condition(lambda:self.repair_generation!=observed)

    @workflow.query
    def identity_query(self)->dict:return self.identity
    @workflow.query
    def waiting_query(self)->bool:return self.waiting
    @workflow.run
    async def run(self,identity:dict)->dict:
        # The first control activity checks the full immutable start input against the
        # durable reservation before this reference workflow calls model or tool ports.
        self.identity=identity
        await workflow.execute_activity(bind_identity,identity,**START_CONFIG)
        deps=WorkDeps(identity['taskId'],identity['runId'])
        first=await agent.run('Correct row 7',deps=deps,usage_limits=UsageLimits(request_limit=4))
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
        try:
            outcome=await workflow.execute_activity(execute_write,**CONFIG)
        except ActivityError as error:
            if not repairable(error) or not workflow.patched('owner-repair-wait-v1'):
                raise
            outcome=await self.wait_for_repair()
        if outcome!='applied':
            return {'taskId':identity['taskId'],'outcome':outcome}

        state=await workflow.execute_activity(current,**CONFIG)
        if not state['active']:return {'taskId':identity['taskId'],'outcome':'stopped','status':state['status']}
        final=await agent.run(message_history=first.all_messages(),usage=first.usage,deps=deps,
            deferred_tool_results=DeferredToolResults(calls={call.tool_call_id:outcome}),usage_limits=UsageLimits(request_limit=4))
        return await workflow.execute_activity(publish,final.output,**CONFIG)


@workflow.defn
class ClosedRepair:
    """One command-scoped historical lookup; never resumes the ended Agent workflow."""
    @workflow.run
    async def run(self,identity:dict)->dict:
        try:
            outcome=await workflow.execute_activity(reconcile_closed,identity,**CONFIG)
        except ActivityError as error:
            if not repairable(error):raise
            await workflow.execute_activity(finish_closed_repair,identity,**CONFIG)
            return {'commandId':identity['commandId'],'outcome':'unresolved'}
        return {'commandId':identity['commandId'],'outcome':outcome}


async def main():
    global _ENGINE
    cfg=control.settings()
    client=await connect_engine(cfg['temporal_address'],cfg.get('engine_tls'),plugins=[PydanticAIPlugin()])
    _ENGINE=client
    async with Worker(client,task_queue=cfg['queue'],workflows=[WorkJourney,ClosedRepair],activities=[bind_identity,prepare,decision,execute_write,publish,current,repair_state,reconcile_write,finish_failed_repair,reconcile_closed,finish_closed_repair]):
        Path(cfg['directory'],'ready').touch()
        await asyncio.Event().wait()


if __name__=='__main__':asyncio.run(main())
