"""Optional product Temporal Worker: trusted service composition, never a Task-specific process.

Host callbacks are deployment code. They must admit effects through existing Action contracts;
result verification must independently inspect work and artifacts. No model-supplied configuration,
experiment import, credentials in Workflow inputs, per-Run cache or alternate retry owner exists.
"""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import timedelta
from copy import deepcopy
import inspect

from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from temporalio.worker import Worker
from pydantic_ai.usage import UsageLimits
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin

with workflow.unsafe.imports_passed_through():
    from openbot_agent_runtime.temporal_agent import build_temporal_agent
    from .work_runtime_ports import WorkRuntimeDeps, WorkRuntimePortFactory
    from .work_temporal_start import load_current_activity_task
    from .work_temporal_activity import bind_completed_activity, claim_current_activity
    from .work_values import InvalidWork, WorkConflict, canonical, receipt, text
    from .work_completion import normalize

TYPE = 'OpenBotWorkV1'
CONFIG = {'start_to_close_timeout': timedelta(seconds=75),
          'schedule_to_close_timeout': timedelta(seconds=180),
          'retry_policy': RetryPolicy(initial_interval=timedelta(seconds=1), maximum_attempts=3,
            non_retryable_error_types=['WorkConflict', 'InvalidWork', 'RuntimeFailure'])}
START_CONFIG = {**CONFIG, 'retry_policy': RetryPolicy(initial_interval=timedelta(seconds=1),
    maximum_interval=timedelta(seconds=5), non_retryable_error_types=['WorkConflict', 'InvalidWork', 'WorkNotFound'])}
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
    def __init__(self, store, client, *, namespace, queue, load_services, verify_result):
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

    @activity.defn(name='openbot.load_task.v1')
    async def load_task(self, identity: dict) -> dict:
        context = await load_current_activity_task(self.store, self.client, **self.scope)
        if (context.task_id, context.run_id) != (identity.get('taskId'), identity.get('runId')):
            raise WorkConflict('runtime_deps_scope_mismatch')
        return {'taskId': context.task_id, 'runId': context.run_id, 'objective': context.objective}

    async def completed_result(self, summary):
        try:
            accepted = await bind_completed_activity(self.store, self.client, **self.scope)
        except WorkConflict as error:
            if str(error) == 'completion_not_recorded':
                return None
            raise
        async with self.store._transaction(trusted=True) as db:
            task = await self.store._task(db, accepted.task_id, read=True)
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
            if (event.get('runId') != accepted.run_id or type(ids) is not list
                    or len(ids) != len(by_id) or set(ids) != set(by_id)):
                raise WorkConflict('completion_record_invalid')
            rows = [by_id[key] for key in ids]
            descriptors = [dict(key=r['artifact_key'], name=r['name'], mediaType=r['media_type'],
                                sha256=r['sha256'], sizeBytes=r['size_bytes']) for r in rows]
            _, digest = canonical(dict(taskId=accepted.task_id, runId=accepted.run_id, summary=summary,
                artifacts=descriptors, verification=event.get('verification')))
            if task['completion_digest'] != digest or event.get('completionDigest') != digest:
                raise WorkConflict('completion_record_invalid')
        if self.store.files is None:
            raise WorkConflict('work_files_unconfigured')
        for row in rows:
            await asyncio.to_thread(self.store.files.read, row['sha256'], row['size_bytes'])
        return {'taskId': accepted.task_id, 'status': 'completed', 'artifactIds': [r['id'] for r in rows]}

    @activity.defn(name='openbot.publish_task.v1')
    async def publish_task(self, summary: str) -> dict:
        text(summary, 16384)
        completed = await self.completed_result(summary)
        if completed is not None:
            return completed
        try:
            return await self._publish_active(summary)
        except WorkConflict:
            # Another admitted attempt may have completed while this one awaited verification.
            # Only the same independently recorded result can turn this conflict into readback.
            completed = await self.completed_result(summary)
            if completed is not None:
                return completed
            raise

    async def _publish_active(self, summary):
        context = await load_current_activity_task(self.store, self.client, **self.scope)
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
            expected_revision=revision, summary=summary, artifacts=artifacts, verification=verification)
        return {'taskId': completed['id'], 'status': completed['status'],
                'artifactIds': [a['id'] for a in completed['artifacts']]}


@workflow.defn(name=TYPE)
class OpenBotWork:
    __pydantic_ai_agents__ = [agent]

    @workflow.run
    async def run(self, identity: dict) -> dict:
        context = await workflow.execute_activity('openbot.load_task.v1', identity, **START_CONFIG)
        result = await agent.run(context['objective'],
            deps=WorkRuntimeDeps(context['taskId'], context['runId']),
            usage_limits=UsageLimits(request_limit=32))
        return await workflow.execute_activity('openbot.publish_task.v1', result.output, **CONFIG)


@asynccontextmanager
async def product_worker(client, store, *, namespace, queue, load_services, verify_result):
    """Serve one operator-selected queue. The connected client needs PydanticAIPlugin.

    Callbacks are required Python composition, not import paths or defaults. Shutdown drains the
    SDK Worker before releasing composition; a second Worker cannot replace an active host.
    """
    global _HOST
    if _HOST is not None:
        raise WorkConflict('worker_already_configured')
    host = WorkActivities(store, client, namespace=namespace, queue=queue,
                          load_services=load_services, verify_result=verify_result)
    _HOST = host
    try:
        async with Worker(client, task_queue=queue, workflows=[OpenBotWork],
                          activities=[host.load_task, host.publish_task],
                          graceful_shutdown_timeout=timedelta(seconds=8)) as worker:
            yield worker
    finally:
        _HOST = None
