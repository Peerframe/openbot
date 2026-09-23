"""Trusted activity-side binding of an activity to its exact current engine Workflow Run.

This is the Worker boundary that derives engine identity from the pinned Temporal Python SDK
1.33.0 instead of trusting a Run ID supplied as workflow, HTTP or model input.
``temporalio.activity.info()`` supplies the actual namespace, task queue, Workflow ID/type and
current Workflow Run ID. Only that exact Run's first immutable ``WorkflowExecutionStarted``
event may supply ``first_execution_run_id`` and the exact ``{taskId, runId, attemptId}`` start
input. A missing current Run ID never falls back to a latest-Run handle.

The derived facts are then handed to
:func:`openbot_server.work_engine_binding.assert_accepted_workflow`, the read-only correlation
gate. This module never starts a workflow, claims work, publishes a Task, retries an effect or
authorizes an operation; the returned record is correlation evidence only and every later
model/tool action still needs its own current control-owned authority, budget, claim and
reconciliation policy. Missing, unavailable or malformed history and every disagreement with
trusted settings fail closed.

The activity task queue and the workflow start task queue are different engine facts and are
represented separately. Under this control deployment both must equal the trusted expected
queue, and a mismatch is refused rather than mistaken for proof of the accepted workflow.
"""
from .work_dispatcher import WORKFLOW_ID_PREFIX
from .work_engine_binding import (MAX_ENGINE_RUN_ID, MAX_NAMESPACE, MAX_QUEUE, MAX_WORKFLOW_ID,
                                  MAX_WORKFLOW_TYPE, EngineActivityFacts,
                                  assert_accepted_workflow, engine_start_input)
from .work_values import InvalidWork, WorkConflict, text


def activity_info():
    """Read the actual current activity context from the pinned SDK.

    Only trusted activity code may call this; the returned facts are never accepted from HTTP,
    model or workflow input. Tests replace this seam with a fake SDK context.
    """
    from temporalio import activity
    return activity.info()


async def inspect_activity_start(client, info, *, expected_namespace, expected_queue,
                                 expected_workflow_type):
    """Return bounded :class:`EngineActivityFacts` for the current exact engine Run.

    ``info`` is the actual ``temporalio.activity.info()`` record. The exact Run ID in it binds
    ``get_workflow_handle(workflow_id, run_id=current_run_id)``; a missing or malformed Run ID
    is refused before any handle is opened. The first immutable start event of that Run must
    exist and carry a bounded workflow type/queue plus the exact ``{taskId, runId, attemptId}``
    start input. Every disagreement raises fail-closed; no fact is taken from a caller-supplied
    identity.
    """
    from .temporal_engine import TemporalEnginePort

    text(expected_namespace, MAX_NAMESPACE)
    text(expected_queue, MAX_QUEUE)
    text(expected_workflow_type, MAX_WORKFLOW_TYPE)

    namespace = text(getattr(info, 'namespace', None), MAX_NAMESPACE)
    activity_queue = text(getattr(info, 'task_queue', None), MAX_QUEUE)
    workflow_id = text(getattr(info, 'workflow_id', None), MAX_WORKFLOW_ID)
    workflow_type = text(getattr(info, 'workflow_type', None), MAX_WORKFLOW_TYPE)
    current_run_id = text(getattr(info, 'workflow_run_id', None), MAX_ENGINE_RUN_ID)

    # The connected client must be the same namespace the activity reports; otherwise the
    # inspected history belongs to a different cluster and can never prove this activity.
    client_namespace = text(getattr(client, 'namespace', None), MAX_NAMESPACE)
    if namespace != expected_namespace or client_namespace != expected_namespace:
        raise WorkConflict('engine_namespace_mismatch')
    if activity_queue != expected_queue:
        raise WorkConflict('engine_queue_mismatch')
    if workflow_type != expected_workflow_type:
        raise WorkConflict('engine_workflow_type_mismatch')

    try:
        start = await TemporalEnginePort(client).inspect_start(
            workflow_id, run_id=current_run_id)
    except ValueError:
        # A malformed or wrong-identity start event is not acceptance and not missing history.
        raise WorkConflict('engine_start_event_invalid') from None
    if start is None:
        # Absent history is never acceptance and is never a reason to inspect another Run.
        raise WorkConflict('engine_start_history_unavailable')
    try:
        start_queue = text(start.task_queue, MAX_QUEUE)
        start_type = text(start.workflow_type, MAX_WORKFLOW_TYPE)
        first_run_id = text(start.first_run_id, MAX_ENGINE_RUN_ID)
        start_input = engine_start_input(start.input)
    except InvalidWork:
        raise WorkConflict('engine_start_event_invalid') from None
    if start_type != expected_workflow_type:
        raise WorkConflict('engine_workflow_type_mismatch')
    if start_queue != expected_queue:
        raise WorkConflict('engine_start_queue_mismatch')
    if workflow_id != WORKFLOW_ID_PREFIX + start_input['runId']:
        raise WorkConflict('engine_workflow_id_mismatch')

    return EngineActivityFacts(
        namespace=namespace, queue=activity_queue, start_queue=start_queue,
        workflow_id=workflow_id, workflow_type=workflow_type, engine_run_id=current_run_id,
        first_run_id=first_run_id, start_input=start_input)


async def bind_current_activity(store, client, *, expected_namespace, expected_queue,
                                expected_workflow_type):
    """Correlate the running activity with exactly one acknowledged Task/Run engine start.

    Reads the SDK activity context, derives the exact facts from the current Run's immutable
    start event, then applies the read-only
    :func:`openbot_server.work_engine_binding.assert_accepted_workflow` gate. The returned
    ``AcceptedWorkflow`` is correlation evidence only; it grants no claim, budget, fence or tool
    authority, and a later effect still has to acquire its own control-owned authority.
    """
    info = activity_info()
    facts = await inspect_activity_start(
        client, info, expected_namespace=expected_namespace, expected_queue=expected_queue,
        expected_workflow_type=expected_workflow_type)
    # The identity is derived from the immutable start input, never from caller/model input.
    identity = {'taskId': facts.start_input['taskId'], 'runId': facts.start_input['runId']}
    return await assert_accepted_workflow(
        store, identity, facts, expected_namespace=expected_namespace,
        expected_queue=expected_queue, expected_workflow_type=expected_workflow_type)
