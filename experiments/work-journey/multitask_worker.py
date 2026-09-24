"""One shared Worker/Agent with accepted per-Run ports; scripted fixture services only.

Process configuration has no Task/Run ID. Durable Action keys below describe this fixed
three-operation fixture, not a general operation-identity policy or live provider.
"""
import asyncio
from datetime import timedelta
import hashlib
from pathlib import Path
import sys

from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from temporalio.worker import Worker
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.usage import RequestUsage, UsageLimits
from engine_client import connect as connect_engine

with workflow.unsafe.imports_passed_through():
    import control
    sys.path.insert(0, str(Path(__file__).parents[2] / 'apps/agent-runtime-python/src'))
    from openbot_agent_runtime.contracts import ToolDescriptor
    from openbot_agent_runtime.temporal_agent import build_temporal_agent
    from openbot_server.work_runtime_ports import WorkRuntimeDeps, WorkRuntimeServices, WorkRuntimePortFactory
    from openbot_server.work_temporal_start import load_current_activity_task
    from openbot_server.work_temporal_activity import claim_current_activity
    from openbot_server.work_temporal_effect import ActionPlan, execute_activity_action
    from openbot_server.work_effects import VerifiedOutcome

TYPE = 'OpenBotMultitaskReference'
CONFIG = {'start_to_close_timeout': timedelta(seconds=75),
          'schedule_to_close_timeout': timedelta(seconds=120),
          'retry_policy': RetryPolicy(initial_interval=timedelta(seconds=1), maximum_attempts=3,
              non_retryable_error_types=['WorkConflict', 'InvalidWork', 'ReceiptMismatch', 'RuntimeFailure'])}
START_CONFIG = {**CONFIG, 'retry_policy': RetryPolicy(initial_interval=timedelta(seconds=1),
    maximum_interval=timedelta(seconds=5), non_retryable_error_types=[
        'WorkConflict', 'InvalidWork', 'ReceiptMismatch', 'WorkNotFound'])}
READ = ToolDescriptor(name='read_observation', description='Read this Task fixture observation.',
    input_schema={'type': 'object', 'properties': {'objective': {'type': 'string'}},
                  'required': ['objective'], 'additionalProperties': False})
# Process composition only. No per-Run state, guard, credentials or routing registry.
_STORE = _CLIENT = _FACTORY = None
_SCOPE = None


class ReferencePolicy:
    async def plan(self, request):
        if request.arguments != {} or request.tool not in ('plan', 'read', 'final'):
            raise control.ReceiptMismatch('Unknown fixture operation')
        intent = {'kind': 'read'} if request.tool == 'read' else {'kind': 'model', 'stage': request.tool}
        return ActionPlan('reference:' + request.tool, intent, 0 if request.tool == 'read' else 3, False, 120)


class ReferenceAdapter:
    def __init__(self, context):
        self.context = context

    async def apply(self, action_id, intent):
        await asyncio.to_thread(control.http, '/operations',
            {'actionId': action_id, 'taskId': self.context.task_id, 'intent': intent})

    async def lookup(self, action_id):
        return await asyncio.to_thread(control.http, '/operations/' + action_id)


class ReferenceVerifier:
    def __init__(self, context):
        self.context = context

    async def verify(self, *, action_id, task_id, run_id, intent_digest, intent, lookup):
        if (task_id, run_id) != (self.context.task_id, self.context.run_id):
            return None
        try:
            evidence = control.verify({'id': action_id, 'task_id': task_id,
                'intent_digest': intent_digest, 'intent': intent}, lookup)
        except (control.ReceiptMismatch, control.InvalidWork, KeyError, TypeError):
            return None
        return VerifiedOutcome(action_id, task_id, run_id, intent_digest, True,
                               lookup['actualTokens'], evidence)


async def perform(context, operation):
    outcome = await execute_activity_action(_STORE, _CLIENT, **_SCOPE,
        request={'call_id': 'fixture-call-' + operation, 'tool': operation, 'arguments': {}},
        policy=ReferencePolicy(), adapter=ReferenceAdapter(context), verifier=ReferenceVerifier(context))
    if outcome.status != 'applied':
        raise control.ReceiptMismatch('Unverified fixture Action')


def load_services(context):
    # Configuration/closure assembly only: effects must stay inside the guarded callbacks.
    async def model(request):
        observations = [p.content for m in request.messages for p in m.parts
                        if isinstance(p, ToolReturnPart) and p.tool_name == READ.name]
        if not observations:
            await perform(context, 'plan')
            parts = [ToolCallPart(READ.name, {'objective': context.objective}, tool_call_id='read-fixture')]
        else:
            if observations != [context.objective + ': observed']:
                raise control.ReceiptMismatch('Cross-Task observation')
            await perform(context, 'final')
            parts = [TextPart(context.objective + ': verified')]
        return ModelResponse(parts, usage=RequestUsage(input_tokens=2, output_tokens=1), model_name='openbot-port')

    async def tool(request):
        if request.name != READ.name or request.arguments != {'objective': context.objective}:
            raise control.ReceiptMismatch('Cross-Task request')
        directory = Path(control.settings()['directory'])
        # Measurement barrier only; it neither selects services nor grants authority.
        (directory / ('read-' + context.task_id)).touch()
        async with asyncio.timeout(45):
            while not (directory / ('release-' + context.task_id)).exists():
                await asyncio.sleep(.05)
        await perform(context, 'read')
        return context.objective + ': observed'

    return WorkRuntimeServices(model_step=model, tool_call=tool, model_tools=(READ,), inline_tools=(READ,))


async def model_factory(deps):
    return await _FACTORY.model_factory(deps)


async def toolset_factory(deps):
    return await _FACTORY.toolset_factory(deps)


agent = build_temporal_agent(name='openbot-shared-reference', deps_type=WorkRuntimeDeps,
    model_factory=model_factory, toolset_factory=toolset_factory,
    instructions='', activity_config=CONFIG,
    model_activity_config={'heartbeat_timeout': timedelta(seconds=4)})


@activity.defn
async def load_task(identity: dict) -> dict:
    context = await load_current_activity_task(_STORE, _CLIENT, **_SCOPE)
    if (context.task_id, context.run_id) != (identity['taskId'], identity['runId']):
        raise control.WorkConflict('runtime_deps_scope_mismatch')
    return {'taskId': context.task_id, 'runId': context.run_id, 'objective': context.objective}


@activity.defn
async def publish_task(summary: str) -> dict:
    context = await load_current_activity_task(_STORE, _CLIENT, **_SCOPE)
    if summary != context.objective + ': verified':
        raise control.ReceiptMismatch('Cross-Task publication')
    fence = await claim_current_activity(_STORE, _CLIENT, **_SCOPE)
    async with _STORE._transaction(trusted=True) as db:
        snap = await _STORE._view(db, context.task_id)
    data = (summary + '\n').encode()
    completed = await _STORE.complete(context.task_id, context.run_id, fence=fence,
        expected_revision=snap['revision'], summary=summary,
        artifacts=[{'key': 'observation', 'name': 'observation.txt', 'mediaType': 'text/plain', 'data': data}],
        verification={'source': 'scripted-task-observation', 'reference': context.task_id,
                      'sha256': hashlib.sha256(data).hexdigest()})
    return {'taskId': completed['id'], 'status': completed['status']}


@workflow.defn(name=TYPE)
class MultitaskWork:
    __pydantic_ai_agents__ = [agent]

    @workflow.run
    async def run(self, identity: dict) -> dict:
        context = await workflow.execute_activity(load_task, identity, **START_CONFIG)
        result = await agent.run(context['objective'],
            deps=WorkRuntimeDeps(context['taskId'], context['runId']),
            usage_limits=UsageLimits(request_limit=3))
        return await workflow.execute_activity(publish_task, result.output, **CONFIG)


async def main():
    global _STORE, _CLIENT, _FACTORY, _SCOPE
    cfg = control.settings()
    if 'task_id' in cfg or 'run_id' in cfg:
        raise ValueError('Shared Worker must not have a fixed Task/Run')
    _STORE = control.store()
    _CLIENT = await connect_engine(cfg['temporal_address'], cfg.get('engine_tls'), plugins=[PydanticAIPlugin()])
    _SCOPE = dict(expected_namespace='default', expected_queue=cfg['queue'], expected_workflow_type=TYPE)
    _FACTORY = WorkRuntimePortFactory(_STORE, _CLIENT, **_SCOPE, load_services=load_services, deadline_seconds=60)
    async with Worker(_CLIENT, task_queue=cfg['queue'], workflows=[MultitaskWork],
                      activities=[load_task, publish_task]):
        Path(cfg['directory'], 'ready').touch()
        await asyncio.Event().wait()


if __name__ == '__main__':
    asyncio.run(main())
