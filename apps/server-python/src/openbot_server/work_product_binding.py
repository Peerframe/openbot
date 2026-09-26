"""Fresh SDK-derived scope for product publication and local prepared artifacts."""
from . import work_temporal_activity as temporal
from .work_claims import WorkFence, check_fence
from .work_corrections import check_context
from .work_engine_binding import assert_accepted_workflow_in_transaction
from .work_temporal_start import WorkRuntimeContext
from .work_task_profiles import resolve_product_source
from .work_values import WorkConflict, canonical


class ProductWorkBinding:
    def __init__(self, store, client, scope):
        if set(scope) != {'expected_namespace','expected_queue','expected_workflow_type'}:
            raise WorkConflict('product_scope_required')
        self.store, self.client, self.scope = store, client, dict(scope)

    async def claim(self, context):
        accepted, identity = await temporal._bind_activity_identity(self.store, self.client, **self.scope)
        if (accepted.task_id,accepted.run_id) != (context.task_id,context.run_id):
            raise WorkConflict('product_scope_changed')
        return await temporal._claim_bound_activity(self.store, accepted, identity)

    async def check(self, db, context, *, require_fence=True, action_id=None, intent=None):
        if type(context) is not WorkRuntimeContext:
            raise WorkConflict('product_context_required')
        info = temporal.activity_info()
        activity_id = temporal.current_activity_id(info)
        facts = await temporal.inspect_activity_start(self.client, info, **self.scope)
        accepted = await assert_accepted_workflow_in_transaction(self.store, db,
            dict(taskId=context.task_id,runId=context.run_id), facts, **self.scope)
        task = await self.store._task(db, context.task_id, read=True)
        self.store._active(task)
        if (task['bot_id'] != context.bot_id or task['objective'] != context.objective
                or task['token_limit'] != context.token_limit):
            raise WorkConflict('product_scope_changed')
        await check_context(db, task, context.run_id, context.correction_token)
        source = await resolve_product_source(db, task, context.bot_id,
            command_profiles=self.store.command_profiles, browser_profiles=self.store.browser_profiles)
        if require_fence:
            key = temporal.derive_claim_id(accepted.namespace,accepted.workflow_id,accepted.engine_run_id,activity_id)
            claim = await (await db.execute('SELECT epoch FROM work_claims WHERE run_id=%s AND claim_id=%s',
                                            (context.run_id,key))).fetchone()
            if claim is None: raise WorkConflict('execution_claim_required')
            await check_fence(db,context.run_id,WorkFence(context.run_id,key,claim['epoch']))
        if action_id is not None:
            action = await (await db.execute('SELECT * FROM work_actions WHERE id=%s FOR SHARE', (action_id,))).fetchone()
            if (not action or (action['task_id'],action['run_id']) != (context.task_id,context.run_id)
                    or action['status'] != 'admitted' or action['intent'] != intent
                    or action['intent_digest'] != canonical(intent)[1]
                    or action['authority_generation'] != task['authority_generation']
                    or action['decision'] not in ('approved','not_required')):
                raise WorkConflict('product_action_not_admitted')
            await check_context(db,task,context.run_id,action['correction_context_id'])
        return source
