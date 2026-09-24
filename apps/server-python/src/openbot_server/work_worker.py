"""Optional product Temporal Worker: trusted service composition, never a Task-specific process.

Host callbacks are deployment code. They must admit effects through existing Action contracts;
result verification must independently inspect work and artifacts. No model-supplied configuration,
experiment import, credentials in Workflow inputs, per-Run cache or alternate retry owner exists.
"""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, asdict, replace
from datetime import timedelta
from copy import deepcopy
import inspect

from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from temporalio.worker import Worker
from pydantic_ai import DeferredToolRequests, DeferredToolResults
from pydantic_ai.toolsets import ExternalToolset
from pydantic_ai.usage import UsageLimits, RunUsage
from temporalio.exceptions import ApplicationError
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin

with workflow.unsafe.imports_passed_through():
    from openbot_agent_runtime.temporal_agent import build_temporal_agent
    from openbot_agent_runtime.catalog import ToolCatalog
    from openbot_agent_runtime.contracts import ToolDescriptor
    from .work_corrected_workflow import run_corrected
    from .work_correction_activities import CorrectionActivities
    from .work_corrections import CorrectionStore, check_context
    from .work_deferred import DeferredActivities
    from .work_closed_repair import ClosedRepair, ClosedRepairActivities
    from .work_deferred_values import parse_proposal
    from .work_runtime_ports import WorkRuntimeDeps, WorkRuntimePortFactory
    from .work_temporal_start import load_current_activity_task
    from .work_temporal_activity import bind_completed_activity, claim_current_activity
    from .work_values import InvalidWork, WorkConflict, canonical, receipt, text
    from .work_completion import normalize

TYPE = 'OpenBotWorkV1'
CONFIG = {'start_to_close_timeout': timedelta(seconds=75),
          'schedule_to_close_timeout': timedelta(seconds=180),
          'retry_policy': RetryPolicy(initial_interval=timedelta(seconds=1), maximum_attempts=3,
            non_retryable_error_types=['WorkConflict', 'CorrectionsChanged', 'InvalidWork', 'RuntimeFailure'])}
START_CONFIG = {**CONFIG, 'retry_policy': RetryPolicy(initial_interval=timedelta(seconds=1),
    maximum_interval=timedelta(seconds=5), non_retryable_error_types=['WorkConflict', 'InvalidWork', 'WorkNotFound', 'RuntimeFailure'])}
# One deployment composition per process, no identity map. Never used during Workflow replay.
_HOST = None


def _host():
    if not activity.in_activity() or _HOST is None:
        raise WorkConflict('worker_services_unconfigured')
    return _HOST


async def _model_factory(deps):
    return await _host().ports.model_factory(deps)


async def _toolset_factory(deps):
    return await _host().ports.toolset_factory(deps)


agent = build_temporal_agent(name='openbot-work-v1', deps_type=WorkRuntimeDeps,
    model_factory=_model_factory, toolset_factory=_toolset_factory, instructions='',
    activity_config=CONFIG, model_activity_config={'heartbeat_timeout': timedelta(seconds=4)})


@dataclass(frozen=True)
class VerifiedTaskResult:
    """Trusted verifier's checked artifact bytes/evidence; Runtime final text cannot construct it."""
    artifacts: tuple[dict, ...]
    verification: dict


class WorkActivities:
    def __init__(self, store, client, *, namespace, queue, load_services, verify_result,
                 plan_effect=None, load_effect=None, enable_corrections=False):
        text(namespace, 64); text(queue, 256)
        if getattr(client, 'namespace', None) != namespace:
            raise WorkConflict('engine_namespace_mismatch')
        if not callable(load_services) or not callable(verify_result):
            raise InvalidWork('worker_callbacks_required')
        if not any(isinstance(p, PydanticAIPlugin) for p in client.config().get('plugins', ())):
            raise InvalidWork('worker_sdk_plugin_required')
        self.store, self.client, self.verify_result = store, client, verify_result
        self.scope = dict(expected_namespace=namespace, expected_queue=queue, expected_workflow_type=TYPE)
        self.ports = WorkRuntimePortFactory(store, client, **self.scope,
                                           load_services=load_services, deadline_seconds=60)
        if type(enable_corrections) is not bool: raise InvalidWork("invalid_correction_profile")
        self.enable_corrections = enable_corrections
        self.deferred = None
        if plan_effect is not None or load_effect is not None:
            self.deferred = DeferredActivities(self, plan_effect, load_effect)


    @activity.defn(name='openbot.load_task.v1')
    async def load_task(self, identity: dict) -> dict:
        context = await load_current_activity_task(self.store, self.client, **self.scope)
        if (context.task_id, context.run_id) != (identity.get('taskId'), identity.get('runId')):
            raise WorkConflict('runtime_deps_scope_mismatch')
        result = {'taskId': context.task_id, 'runId': context.run_id, 'objective': context.objective}
        if self.deferred is not None:
            catalog = await self.ports.deferred_catalog(WorkRuntimeDeps(context.task_id, context.run_id))
            result['deferredTools'] = [asdict(tool) for tool in catalog.descriptors]
        if self.enable_corrections:
            _, _, _, inline = await self.ports._prepare(WorkRuntimeDeps(context.task_id, context.run_id))
            if inline.descriptors: raise WorkConflict('correction_inline_tools_unsupported')
            await CorrectionStore(self.store).enable(context.task_id, context.run_id)
            result['correctionProtocol'] = 1
        return result

    async def completed_result(self, summary, correction_context=None):
        try:
            accepted = await bind_completed_activity(self.store, self.client, **self.scope)
        except WorkConflict as error:
            if str(error) == 'completion_not_recorded':
                return None
            raise
        async with self.store._transaction(trusted=True) as db:
            task = await self.store._task(db, accepted.task_id, read=True)
            await check_context(db, task, accepted.run_id, correction_context, current=False)
            if task['result_summary'] != summary:
                raise WorkConflict('completion_content_changed')
            rows = await (await db.execute('SELECT * FROM work_artifacts '
                'WHERE task_id=%s AND run_id=%s', (accepted.task_id, accepted.run_id))).fetchall()
            events = await (await db.execute("SELECT payload FROM work_events WHERE task_id=%s AND kind='task.completed'",
                                             (accepted.task_id,))).fetchall()
            if len(events) != 1:
                raise WorkConflict('completion_record_invalid')
            event = events[0]['payload']
            by_id = {row['id']: row for row in rows}
            ids = event.get('artifactIds')
            if (event.get('correctionContext') != correction_context
                    or event.get('runId') != accepted.run_id or type(ids) is not list
                    or len(ids) != len(by_id) or set(ids) != set(by_id)):
                raise WorkConflict('completion_record_invalid')
            rows = [by_id[key] for key in ids]
            descriptors = [dict(key=r['artifact_key'], name=r['name'], mediaType=r['media_type'],
                                sha256=r['sha256'], sizeBytes=r['size_bytes']) for r in rows]
            _, digest = canonical(dict(taskId=accepted.task_id, runId=accepted.run_id, summary=summary,
                artifacts=descriptors, verification=event.get('verification'),
                **({'correctionContext': correction_context} if correction_context is not None else {})))
            if task['completion_digest'] != digest or event.get('completionDigest') != digest:
                raise WorkConflict('completion_record_invalid')
        if self.store.files is None:
            raise WorkConflict('work_files_unconfigured')
        for row in rows:
            await asyncio.to_thread(self.store.files.read, row['sha256'], row['size_bytes'])
        return {'taskId': accepted.task_id, 'status': 'completed', 'artifactIds': [r['id'] for r in rows]}

    @activity.defn(name='openbot.publish_task.v1')
    async def publish_task(self, summary: str) -> dict:
        return await self.publish_result(summary)

    async def publish_result(self, summary, correction_context=None):
        text(summary, 16384)
        completed = await self.completed_result(summary, correction_context)
        if completed is not None:
            return completed
        try:
            return await self._publish_active(summary, **({"correction_context": correction_context}
                if correction_context is not None else {}))
        except WorkConflict:
            # Another admitted attempt may have completed while this one awaited verification.
            # Only the same independently recorded result can turn this conflict into readback.
            completed = await self.completed_result(summary, correction_context)
            if completed is not None:
                return completed
            raise

    async def _publish_active(self, summary, correction_context=None):
        context = await load_current_activity_task(self.store, self.client, **self.scope)
        if correction_context is not None:
            await CorrectionStore(self.store).read(context.task_id, context.run_id, correction_context)
            context = replace(context, correction_token=correction_context)
        fence = await claim_current_activity(self.store, self.client, **self.scope)
        async with self.store._transaction(trusted=True) as db:
            task = await self.store._task(db, context.task_id, read=True)
            revision = task['revision']
        # Capture the publication revision before verification. No intervening work can be silently
        # included in a verdict over older facts; the original fence/revision must still hold.
        async with asyncio.timeout(30):
            result = self.verify_result(context, summary)
            if inspect.isawaitable(result):
                result = await result
        if type(result) is not VerifiedTaskResult:
            raise WorkConflict('task_result_unverified')
        artifacts, verification = deepcopy(result.artifacts), deepcopy(result.verification)
        normalize(artifacts); receipt(verification)
        # store.complete rechecks authority, the captured revision and the original fence before
        # and after blob I/O. Verification is evidence, never permission to renew a stale claim.
        completed = await self.store.complete(context.task_id, context.run_id, fence=fence,
            expected_revision=revision, summary=summary, artifacts=artifacts, verification=verification,
            **({"correction_context": correction_context} if correction_context is not None else {}))
        return {'taskId': completed['id'], 'status': completed['status'],
                'artifactIds': [a['id'] for a in completed['artifacts']]}


@workflow.defn(name=TYPE)
class OpenBotWork:
    __pydantic_ai_agents__ = [agent]

    @workflow.run
    async def run(self, identity: dict) -> dict:
        context = await workflow.execute_activity('openbot.load_task.v1', identity, **START_CONFIG)
        if context.get('correctionProtocol') == 1:
            return await run_corrected(context, identity, agent, CONFIG)
        deps = WorkRuntimeDeps(context['taskId'], context['runId'])
        options = {}
        if context.get('deferredTools'):
            catalog = ToolCatalog(tuple(ToolDescriptor(**tool) for tool in context['deferredTools']),
                                  max_tools=64, max_bytes=65536)
            options = dict(output_type=[str, DeferredToolRequests],
                toolsets=[ExternalToolset(list(catalog.sdk_definitions().values()), id='openbot-deferred')])
        usage = RunUsage()
        result = await agent.run(context['objective'], deps=deps, usage=usage,
                                 usage_limits=UsageLimits(request_limit=32), **options)
        pauses = 0
        while isinstance(result.output, DeferredToolRequests):
            calls = result.output.calls
            pauses += 1
            if pauses > 16 or result.output.approvals or not 1 <= len(calls) <= 8:
                raise ApplicationError('invalid_deferred_batch', non_retryable=True)
            try:
                proposals = [parse_proposal(dict(call_id=c.tool_call_id, tool=c.tool_name, arguments=c.args)) for c in calls]
                if len({p['call_id'] for p in proposals}) != len(proposals):
                    raise InvalidWork('duplicate_correlation')
            except InvalidWork:
                raise ApplicationError('invalid_deferred_proposal', non_retryable=True) from None
            prepared = []
            for proposal in proposals:
                action_id = await workflow.execute_activity('openbot.prepare_tool.v1', proposal, **CONFIG)
                prepared.append((proposal['call_id'], action_id))
            outcomes = {}
            for call_id, action_id in prepared:
                while True:
                    state = await workflow.execute_activity('openbot.tool_state.v1', action_id, **CONFIG)
                    if state['status'] in ('approved','not_required','admitted'):
                        state = await workflow.execute_activity('openbot.execute_tool.v1', action_id, **CONFIG)
                    if state['status'] == 'unknown' and state.get('commandId'):
                        state = await workflow.execute_activity('openbot.reconcile_tool.v1',
                            dict(actionId=action_id, commandId=state['commandId']), **CONFIG)
                    if state['status'] in ('not_applied','denied','expired'):
                        return await workflow.execute_activity('openbot.stop_tool.v1', action_id, **CONFIG)
                    if state['status'] == 'applied':
                        outcomes[call_id] = dict(actionId=action_id, status=state['status'])
                        break
                    if state['status'] not in ('pending','unknown'):
                        raise ApplicationError('invalid_deferred_state', non_retryable=True)
                    # The database owns the decision; this durable timer creates no grant or lookup.
                    await workflow.sleep(2)
            result = await agent.run(message_history=result.all_messages(), deps=deps, usage=usage,
                deferred_tool_results=DeferredToolResults(calls=outcomes),
                usage_limits=UsageLimits(request_limit=32), **options)
        return await workflow.execute_activity('openbot.publish_task.v1', result.output, **CONFIG)


@asynccontextmanager
async def product_worker(client, store, *, namespace, queue, load_services, verify_result,
                         plan_effect=None, load_effect=None, load_lookup=None, enable_corrections=False):
    """Serve one operator-selected queue. The connected client needs PydanticAIPlugin.

    Callbacks are required Python composition, not import paths or defaults. Shutdown drains the
    SDK Worker before releasing composition; a second Worker cannot replace an active host.
    """
    global _HOST
    if _HOST is not None:
        raise WorkConflict('worker_already_configured')
    host = WorkActivities(store, client, namespace=namespace, queue=queue,
                          load_services=load_services, verify_result=verify_result,
                          plan_effect=plan_effect, load_effect=load_effect, enable_corrections=enable_corrections)
    activities = [host.load_task, host.publish_task]
    if host.deferred is not None:
        activities += [host.deferred.prepare, host.deferred.state, host.deferred.execute, host.deferred.reconcile, host.deferred.stop]
    correction_activities = CorrectionActivities(host)
    activities += [correction_activities.freeze, correction_activities.prepare, correction_activities.publish]
    workflows = [OpenBotWork]
    if load_lookup is not None:
        repair = ClosedRepairActivities(store, client, namespace=namespace, queue=queue,
                                        workflow_type=TYPE, load_lookup=load_lookup)
        activities += [repair.reconcile, repair.finish]
        workflows.append(ClosedRepair)
    _HOST = host
    try:
        async with Worker(client, task_queue=queue, workflows=workflows,
                          activities=activities,
                          graceful_shutdown_timeout=timedelta(seconds=8)) as worker:
            yield worker
    finally:
        _HOST = None
