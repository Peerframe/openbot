"""Control-owned deferred proposals. Approval never enables an SDK executor or replanning."""
import asyncio
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import inspect

from temporalio import activity
from .work_deferred_values import parse_proposal
from .work_effects import execute_action, recover_action
from .work_reconciliation import ReconciliationStore
from .work_runtime_ports import WorkRuntimeDeps
from .work_temporal_activity import _bind_activity_identity, _claim_bound_activity, bind_failed_activity
from .work_temporal_effect import ToolRequest
from .work_temporal_start import load_current_activity_task
from .work_values import InvalidWork, WorkConflict, canonical, text, tokens


@dataclass(frozen=True)
class DeferredPlan:
    intent: dict
    reserved_tokens: int
    requires_approval: bool = True
    expires_seconds: int = 300


@dataclass(frozen=True)
class EffectServices:
    adapter: object
    verifier: object


def operation_key(accepted, activity_id):
    if accepted.engine_run_id != accepted.first_run_id:
        raise WorkConflict('tool_continuation_identity_required')
    data, _ = canonical([accepted.task_id, accepted.run_id, accepted.namespace,
                        accepted.workflow_id, accepted.engine_run_id, text(activity_id, 256)])
    return 'tool-activity-v1-' + hashlib.sha256(b'openbot.tool.activity.v1\0' + data).hexdigest()


async def call(callback, *args):
    async with asyncio.timeout(30):
        value = callback(*args)
        return await value if inspect.isawaitable(value) else value


class DeferredActivities:
    def __init__(self, host, plan_effect, load_effect):
        if not callable(plan_effect) or not callable(load_effect):
            raise InvalidWork('effect_callbacks_required')
        self.host, self.plan_effect, self.load_effect = host, plan_effect, load_effect
        self.store, self.client, self.scope = host.store, host.client, host.scope

    async def _context(self):
        return await load_current_activity_task(self.store, self.client, **self.scope)

    async def _read(self, context, action_id):
        text(action_id, 128)
        async with self.store._transaction(trusted=True) as db:
            task, row = await self.store._action(db, action_id)
            self.store._active(task)
            if (row['task_id'], row['run_id']) != (context.task_id, context.run_id):
                raise WorkConflict('effect_scope_changed')
            intent = row['intent']
            if (not row['action_key'].startswith('tool-activity-v1-') or type(intent) is not dict
                    or set(intent) != {'kind','tool','arguments','effect'}
                    or intent['kind'] != 'deferred_tool' or canonical(intent)[1] != row['intent_digest']):
                raise WorkConflict('deferred_record_invalid')
            return deepcopy(row)

    async def _services(self, context, row):
        # Assembly only. The adapter receives the entire original immutable intent, not a new plan.
        services = await call(self.load_effect, context, deepcopy(row['intent']))
        if (type(services) is not EffectServices or not callable(getattr(services.adapter, 'apply', None))
                or not callable(getattr(services.adapter, 'lookup', None))
                or not callable(getattr(services.verifier, 'verify', None))):
            raise InvalidWork('invalid_effect_services')
        return services

    @activity.defn(name='openbot.prepare_tool.v1')
    async def prepare(self, proposal: dict) -> str:
        request = parse_proposal(proposal)
        accepted, activity_id = await _bind_activity_identity(self.store, self.client, **self.scope)
        key = operation_key(accepted, activity_id)
        context = await self._context()
        async with self.store._transaction(trusted=True) as db:
            row = await (await db.execute('SELECT id FROM work_actions WHERE run_id=%s AND action_key=%s',
                                         (context.run_id, key))).fetchone()
        if row is not None:
            original = await self._read(context, row['id'])
            if (original['intent']['tool'] != request['tool']
                    or canonical(original['intent']['arguments'])[1] != canonical(request['arguments'])[1]):
                raise WorkConflict('action_content_changed')
            return row['id']
        catalog = await self.host.ports.deferred_catalog(WorkRuntimeDeps(context.task_id, context.run_id))
        arguments = catalog.validate_arguments(request['tool'], request['arguments'])
        plan = await call(self.plan_effect, context, ToolRequest(request['tool'], deepcopy(arguments), canonical(arguments)[1]))
        if (type(plan) is not DeferredPlan or type(plan.intent) is not dict
                or type(plan.requires_approval) is not bool or type(plan.expires_seconds) is not int
                or not 1 <= plan.expires_seconds <= 3600):
            raise InvalidWork('invalid_deferred_plan')
        tokens(plan.reserved_tokens)
        intent = deepcopy(dict(kind='deferred_tool', tool=request['tool'], arguments=arguments, effect=plan.intent))
        canonical(intent)
        fence = await _claim_bound_activity(self.store, accepted, activity_id)
        return await self.store.propose(context.task_id, context.run_id, fence=fence, action_key=key,
            intent=intent, reserved_tokens=plan.reserved_tokens, requires_approval=plan.requires_approval,
            expires_seconds=plan.expires_seconds)

    @activity.defn(name='openbot.tool_state.v1')
    async def state(self, action_id: str) -> dict:
        context = await self._context()
        row = await self._read(context, action_id)
        state = row['status']
        if state == 'proposed':
            state = 'denied' if row['decision']=='denied' else 'expired' if not row['unexpired'] else row['decision']
        async with self.store._transaction(trusted=True) as db:
            command = await (await db.execute('SELECT id FROM work_reconciliation_commands '
                'WHERE action_id=%s AND finished_at IS NULL ORDER BY sequence LIMIT 1', (action_id,))).fetchone()
        return dict(actionId=action_id, status=state, commandId=command['id'] if command else None)

    @activity.defn(name='openbot.execute_tool.v1')
    async def execute(self, action_id: str) -> dict:
        context = await self._context()
        row = await self._read(context, action_id)
        if row['status'] in ('applied', 'not_applied'):
            return dict(actionId=action_id, status=row['status'])
        if row['status'] == 'proposed' and (not row['unexpired'] or row['decision'] not in ('approved','not_required')):
            raise WorkConflict('action_not_authorized')
        services = await self._services(context, row)
        if row['status'] in ('admitted','unknown'):
            outcome = await recover_action(self.store, task_id=context.task_id, run_id=context.run_id,
                action_id=action_id, adapter=services.adapter, verifier=services.verifier)
        else:
            accepted, activity_id = await _bind_activity_identity(self.store, self.client, **self.scope)
            fence = await _claim_bound_activity(self.store, accepted, activity_id)
            outcome = await execute_action(self.store, task_id=context.task_id, run_id=context.run_id,
                fence=fence, action_key=row['action_key'], intent=row['intent'],
                reserved_tokens=row['reserved_tokens'], requires_approval=row['requires_approval'],
                adapter=services.adapter, verifier=services.verifier)
        return dict(actionId=action_id, status=outcome.status)

    @activity.defn(name='openbot.reconcile_tool.v1')
    async def reconcile(self, identity: dict) -> dict:
        if type(identity) is not dict or set(identity) != {'actionId','commandId'}:
            raise InvalidWork('invalid_reconciliation_identity')
        context = await self._context()
        action_id, command_id = text(identity['actionId'],128), text(identity['commandId'],128)
        row = await self._read(context, action_id)
        commands = ReconciliationStore(self.store)
        scope = dict(task_id=context.task_id, run_id=context.run_id, action_id=action_id)
        command = await commands.read(command_id, **scope)
        if command['outcome'] is not None:
            return dict(actionId=action_id, status=row['status'])
        accepted, _ = await _bind_activity_identity(self.store, self.client, **self.scope)
        await commands.acknowledge(command_id, accepted.workflow_id)
        # Unknown repair is lookup only. Cancellation during this await can record historical truth,
        # but no claim/admission or adapter.apply exists anywhere on this path.
        services = await self._services(context, row)
        outcome = await recover_action(self.store, **scope, adapter=services.adapter, verifier=services.verifier)
        await commands.finish(command_id, **scope,
            outcome='resolved' if outcome.status in ('applied','not_applied') else 'unresolved')
        return dict(actionId=action_id, status=outcome.status)


    async def _stopped_result(self, action_id):
        try:
            accepted = await bind_failed_activity(self.store, self.client, **self.scope)
        except WorkConflict as error:
            if str(error) == 'failure_not_recorded': return None
            raise
        async with self.store._transaction(trusted=True) as db:
            await self.store._task(db, accepted.task_id, read=True)
            events = await (await db.execute("SELECT payload FROM work_events WHERE task_id=%s AND kind='task.failed'",
                                             (accepted.task_id,))).fetchall()
            if (len(events)!=1 or events[0]['payload'].get('runId')!=accepted.run_id
                    or events[0]['payload'].get('actionId')!=action_id
                    or events[0]['payload'].get('reason') not in ('denied','expired','not_applied')):
                raise WorkConflict('failure_record_invalid')
            return dict(taskId=accepted.task_id,status='failed',reason=events[0]['payload']['reason'])

    @activity.defn(name='openbot.stop_tool.v1')
    async def stop(self, action_id: str) -> dict:
        text(action_id,128)
        recorded = await self._stopped_result(action_id)
        if recorded is not None: return recorded
        try:
            context = await self._context()
            await self._read(context,action_id)
            async with self.store._transaction(trusted=True) as db:
                task,row = await self.store._action(db,action_id)
                self.store._active(task)
                reason = ('not_applied' if row['status']=='not_applied' else
                    'denied' if row['status']=='proposed' and row['decision']=='denied' else
                    'expired' if row['status']=='proposed' and not row['unexpired'] else None)
                if reason is None: raise WorkConflict('terminal_refusal_required')
                # A verified refusal closes execution; unresolved budgets/facts are retained.
                await db.execute("UPDATE work_tasks SET status='failed',authority_active=false,"
                    'authority_generation=authority_generation+1 WHERE id=%s',(context.task_id,))
                await db.execute("UPDATE work_runs SET status='failed' WHERE task_id=%s AND status IN ('queued','running')",
                                 (context.task_id,))
                await self.store._event(db,context.task_id,'task.failed',
                    dict(runId=context.run_id,actionId=action_id,reason=reason))
            return dict(taskId=context.task_id,status='failed',reason=reason)
        except WorkConflict:
            recorded = await self._stopped_result(action_id)
            if recorded is not None:return recorded
            raise
