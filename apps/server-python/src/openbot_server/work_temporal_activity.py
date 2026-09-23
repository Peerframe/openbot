"""Trusted activity-side binding of an activity to its exact current engine Workflow Run.

This is the Worker boundary that derives engine identity from the pinned Temporal Python SDK
1.33.0 instead of trusting a Run ID supplied as workflow, HTTP or model input.
``temporalio.activity.info()`` supplies the actual namespace, task queue, Workflow ID/type and
current Workflow Run ID. Only that exact Run's first immutable ``WorkflowExecutionStarted``
event may supply ``first_execution_run_id`` and the exact ``{taskId, runId, attemptId}`` start
input. A missing current Run ID never falls back to a latest-Run handle.

The derived facts are then handed to
:func:`openbot_server.work_engine_binding.assert_accepted_workflow`, the read-only correlation
gate. :func:`bind_current_activity` never starts a workflow, claims work, publishes a Task,
retries an effect or authorizes an operation; its returned record is correlation evidence only.

:func:`claim_current_activity` is the single trusted boundary that may turn an accepted binding
into a control-owned :class:`openbot_server.work_claims.WorkFence`. It runs only after that gate
and derives the claim identifier from the accepted namespace, Workflow ID and actual current
engine Run ID; the existing :func:`openbot_server.work_claims.claim` transaction remains the only
thing that grants the fence. Identity, claim ID, authority and Run ID are never accepted from
workflow, model or HTTP input, and no Workflow or external effect is started or retried. Missing,
unavailable or malformed history and every disagreement with trusted settings fail closed.

The activity task queue and the workflow start task queue are different engine facts and are
represented separately. Under this control deployment both must equal the trusted expected
queue, and a mismatch is refused rather than mistaken for proof of the accepted workflow.
"""
import hashlib

from .work_claims import WorkFence, claim as claim_work
from .work_dispatcher import WORKFLOW_ID_PREFIX
from .work_engine_binding import (MAX_ENGINE_RUN_ID, MAX_NAMESPACE, MAX_QUEUE, MAX_WORKFLOW_ID,
                                  MAX_WORKFLOW_TYPE, EngineActivityFacts,
                                  assert_accepted_workflow, engine_start_input)
from .work_values import InvalidWork, WorkConflict, text

# Domain separation keeps this digest from ever colliding with another control digest computed
# over similar facts. The claim identifier is a control-owned derivation, never caller input.
CLAIM_ID_DOMAIN = b'openbot.work.claim.current-activity.v1'
CLAIM_ID_PREFIX = 'work-claim-v1-'
MAX_CLAIM_ID = 128


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


def derive_claim_id(namespace, workflow_id, engine_run_id):
    """Derive the stable bounded claim ID for one accepted engine Run.

    The identifier is a domain-separated SHA-256 digest over exactly the trusted namespace,
    deterministic Workflow ID and the actual current engine Run ID. It is deterministic so a
    redelivery of the same live Run addresses the same claim row, and Run-specific so a later
    Run in the same accepted first-Run chain addresses a new row. Callers never supply it.
    """
    text(namespace, MAX_NAMESPACE)
    text(workflow_id, MAX_WORKFLOW_ID)
    text(engine_run_id, MAX_ENGINE_RUN_ID)
    # NUL separators are unambiguous because ``text`` already refused NUL in every component.
    material = (CLAIM_ID_DOMAIN + b'\0' + namespace.encode('utf-8') + b'\0'
                + workflow_id.encode('utf-8') + b'\0' + engine_run_id.encode('utf-8'))
    claim_id = CLAIM_ID_PREFIX + hashlib.sha256(material).hexdigest()
    return text(claim_id, MAX_CLAIM_ID)


async def claim_current_activity(store, client, *, expected_namespace, expected_queue,
                                 expected_workflow_type, expires_seconds=60) -> WorkFence:
    """Claim the accepted current engine Run and return its control-owned fence.

    The real-SDK :func:`bind_current_activity` gate runs first and is the sole source of the
    Task/Run identity, Workflow ID and actual current engine Run ID. Only after acceptance is the
    claim ID derived from those accepted facts and handed to the existing control-owned
    :func:`openbot_server.work_claims.claim` transaction, which alone grants the
    :class:`openbot_server.work_claims.WorkFence`. A live redelivery of the same Run returns its
    original fence without advancing the epoch; a different current Run in the same accepted
    chain gets a new fence that stales the old one; wrong attempt/chain, absent acknowledgment,
    cancellation, revocation, closed Run and an expired same-Run claim fail closed without
    minting a claim. Nothing here starts or retries a Workflow or an external effect.
    """
    accepted = await bind_current_activity(
        store, client, expected_namespace=expected_namespace, expected_queue=expected_queue,
        expected_workflow_type=expected_workflow_type)
    claim_id = derive_claim_id(
        accepted.namespace, accepted.workflow_id, accepted.engine_run_id)
    return await claim_work(
        store, accepted.task_id, accepted.run_id, claim_id, expires_seconds=expires_seconds)
