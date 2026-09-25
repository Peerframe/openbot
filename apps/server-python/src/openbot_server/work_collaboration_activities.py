"""Trusted derived joins; the original child creation remains a separate immutable Action."""
from dataclasses import replace

from temporalio import activity

from . import work_temporal_activity as temporal
from .work_corrections import CorrectionStore
from .work_deferred import call
from .work_engine_binding import assert_historical_workflow_in_transaction
from .work_temporal_effect import ToolRequest
from .work_temporal_start import load_current_activity_task
from .work_values import InvalidWork, WorkConflict, canonical, text


class CollaborationActivities:
    def __init__(self, host, join_request, unconsumed_children):
        if (host.deferred is None or host.load_tool_result is None
                or not callable(join_request) or not callable(unconsumed_children)):
            raise InvalidWork('invalid_collaboration_composition')
        self.host,self.join_request,self.unconsumed_children=host,join_request,unconsumed_children

    async def observed_deadline(self):
        """Historical read only: a fixed tree fact remains readable after its deadline.

        Actual SDK identity is mandatory. The existing root-to-leaf Task lock verifies the
        stored tree against the exact root Work Run's first claim; it does not mint authority.
        This is also called inside load_task so ordinary Tasks need no extra Activity command.
        """
        if not activity.in_activity():raise WorkConflict('activity_context_required')
        info=temporal.activity_info()
        temporal.current_activity_id(info)
        facts=await temporal.inspect_activity_start(self.host.client,info,**self.host.scope)
        identity=dict(taskId=facts.start_input['taskId'],runId=facts.start_input['runId'])
        async with self.host.store._transaction(trusted=True) as db:
            task=await self.host.store._task(db,identity['taskId'],read=True)
            accepted=await assert_historical_workflow_in_transaction(self.host.store,db,identity,facts,**self.host.scope)
            tree=task['_collaboration']
            if tree['deadline'] is None:return None
            exact_run=(tree['links'][-1]['child_work_run_id'] if tree['links'] else tree['rootWorkRunId'])
            if exact_run!=accepted.run_id:
                raise WorkConflict('collaboration_deadline_run_changed')
            return dict(version=1,rootTaskId=tree['rootTaskId'],rootRunId=tree['rootWorkRunId'],
                        deadline=tree['deadline'].isoformat())

    @activity.defn(name='openbot.collaboration_deadline.v1')
    async def deadline(self, value: dict) -> dict | None:
        if type(value) is not dict or value:
            raise InvalidWork('invalid_collaboration_deadline_request')
        return await self.observed_deadline()

    async def _context(self, token):
        context=await load_current_activity_task(self.host.store,self.host.client,**self.host.scope)
        if token is not None:
            text(token,128)
            await CorrectionStore(self.host.store).read(context.task_id,context.run_id,token)
            context=replace(context,correction_token=token)
        return context

    @activity.defn(name='openbot.children_to_join.v1')
    async def pending(self, value: dict) -> list[str]:
        if type(value) is not dict or set(value)!={'contextToken'}:
            raise InvalidWork('invalid_child_join_request')
        context=await self._context(value['contextToken'])
        children=await call(self.unconsumed_children,context)
        if type(children) is not tuple or len(children)>4:
            raise WorkConflict('invalid_child_join_set')
        identities=[text(child,128) for child in children]
        if len(set(identities))!=len(identities):raise WorkConflict('invalid_child_join_set')
        return sorted(identities)

    @activity.defn(name='openbot.prepare_child_join.v1')
    async def prepare(self, value: dict) -> str:
        if type(value) is not dict or set(value)!={'creationActionId','contextToken'}:
            raise InvalidWork('invalid_child_join_request')
        context=await self._context(value['contextToken'])
        creation=text(value['creationActionId'],128)
        request=await call(self.join_request,context,creation)
        if (type(request) is not ToolRequest or request.tool!='wait_for_task'
                or type(request.arguments) is not dict or set(request.arguments)!={'runId'}
                or request.digest!=canonical(request.arguments)[1]):
            raise WorkConflict('invalid_derived_child_join')
        text(request.arguments['runId'],128)
        # This Activity's SDK ID, not the creation/model call ID, keys the join Action.
        return await self.host.deferred.prepare_request(dict(call_id='control-child-join',
            tool=request.tool,arguments=request.arguments),context.correction_token)
