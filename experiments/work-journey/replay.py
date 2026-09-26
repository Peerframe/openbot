"""Offline compatibility acceptance for an in-memory WorkJourney history."""
from concurrent.futures import ThreadPoolExecutor

from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio import workflow
from temporalio.client import WorkflowHistory
from temporalio.worker import Replayer


@workflow.defn(name='WorkJourney')
class _IncompatibleWorkJourney:
    @workflow.run
    async def run(self, identity: dict) -> dict:
        # The real workflow's first command schedules bind_identity, not a timer.
        await workflow.sleep(1)
        return identity


def _validate_history(history: WorkflowHistory) -> None:
    if not isinstance(history, WorkflowHistory):
        raise TypeError('Expected a fetched WorkflowHistory')
    if not history.events or not history.events[0].HasField('workflow_execution_started_event_attributes'):
        raise ValueError('Expected history beginning with workflow execution start')
    start = history.events[0].workflow_execution_started_event_attributes
    if start.workflow_type.name != 'WorkJourney':
        raise ValueError('Expected WorkJourney history')
    first_activity = next((event.activity_task_scheduled_event_attributes
                           for event in history.events
                           if event.HasField('activity_task_scheduled_event_attributes')), None)
    if first_activity is None or first_activity.activity_type.name != 'bind_identity':
        raise ValueError('History must include the initial bind_identity activity command')


async def verify_history_replay(history: WorkflowHistory) -> dict:
    """Require current-code success and command-mismatch detection for this history.

    Fetch the complete history separately with ``await handle.fetch_history()``.
    Waiting and completed histories are accepted after bind_identity was scheduled.
    No client is created, no activities run, and no history payloads are exported.
    Passing this check establishes compatibility only with the supplied history.
    """
    _validate_history(history)
    from workflow_worker import WorkJourney

    # Replayer otherwise creates an executor whose lifetime it does not manage.
    with ThreadPoolExecutor(max_workers=2) as executor:
        await Replayer(
            workflows=[WorkJourney], plugins=[PydanticAIPlugin()],
            workflow_task_executor=executor,
        ).replay_workflow(history)
        try:
            await Replayer(
                workflows=[_IncompatibleWorkJourney], plugins=[PydanticAIPlugin()],
                workflow_task_executor=executor,
            ).replay_workflow(history)
        except workflow.NondeterminismError:
            pass
        else:
            raise AssertionError('Replay accepted an incompatible first workflow command')

    return {'workflowId': history.workflow_id, 'runId': history.run_id,
            'eventCount': len(history.events), 'currentReplay': 'passed',
            'incompatibleReplay': 'rejected', 'incompatibleFailure': 'NondeterminismError'}
