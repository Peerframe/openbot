"""Read-only correlation gate for a future multi-Run Temporal activity.

The gate compares an activity's engine chain with the start the trusted dispatcher already
acknowledged for an exact Task/Run. It is deliberately a *correlation*
check: the returned record identifies the activity, its engine run and the accepted handoff,
but it is never an authority token, claim, fence or permission to call model/tool ports. A
later effect still has to acquire its own control-owned authority and fence under the existing
work-store transactions.

Nothing here writes, claims, schedules, retries or audits, and the module never imports
``temporalio``. The trusted caller decodes :class:`EngineActivityFacts` from
``temporalio.activity.info()`` and that exact Run's immutable start event (see
:mod:`openbot_server.work_temporal_activity`); facts are never accepted from model, HTTP or
Worker input.
"""
from dataclasses import dataclass

from .work_dispatcher import REFERENCE_PREFIX, WORKFLOW_ID_PREFIX
from .work_handoff import valid_attempt_id
from .work_store import PostgresWorkStore
from .work_values import InvalidWork, WorkConflict, WorkNotFound, text

MAX_NAMESPACE = 64
MAX_QUEUE = 256
MAX_WORKFLOW_TYPE = 256
MAX_WORKFLOW_ID = 256
MAX_ENGINE_RUN_ID = 256
MAX_IDENTITY = 128


@dataclass(frozen=True)
class EngineActivityFacts:
    """Actual activity facts decoded by trusted control code, never by a model.

    A trusted caller reads namespace, queue, Workflow ID/type and the current Run ID from
    ``temporalio.activity.info()``, then inspects that exact Run's first immutable
    ``WorkflowExecutionStarted`` event for ``first_run_id``, workflow type, start queue and the
    exact ``{taskId, runId, attemptId}`` start input. ``first_run_id`` identifies the accepted
    chain across Continue-As-New; a new same-ID chain after retention has a different first Run
    ID. Nothing here is accepted from HTTP, model or workflow input.

    ``queue`` is the actual activity task queue and ``start_queue`` the workflow's start task
    queue. They are represented separately because they are different engine facts; under this
    control deployment both must equal the trusted expected queue, and a mismatch is refused
    rather than mistaken for proof of the accepted workflow.
    """
    namespace: str
    queue: str
    start_queue: str
    workflow_id: str
    workflow_type: str
    engine_run_id: str
    first_run_id: str
    start_input: dict


@dataclass(frozen=True)
class AcceptedWorkflow:
    """Bounded identity/fact record returned by :func:`assert_accepted_workflow`.

    This is correlation evidence for logging and for keying a *separate* authority request. It
    carries no budget, generation, fence or grant, and must not be forwarded to model/tool ports
    as if it authorized an effect.
    """
    task_id: str
    run_id: str
    namespace: str
    queue: str
    workflow_id: str
    workflow_type: str
    engine_run_id: str
    first_run_id: str


def _identity(value):
    # Exact shape, never a superset: an unexpected key could smuggle separate intent.
    if type(value) is not dict or set(value) != {'taskId', 'runId'}:
        raise InvalidWork('invalid_identity')
    return text(value['taskId'], MAX_IDENTITY), text(value['runId'], MAX_IDENTITY)


def engine_start_input(value):
    """Validate the exact bounded ``{taskId,runId,attemptId}`` start input.

    This is the immutable start intent decoded from the engine's start event. It is compared
    with the durable submission attempt so same-ID history from another submission is never
    mistaken for the accepted one. The 128-bit attempt identifier keeps that comparison exact;
    ``work_handoff`` owns its canonical shape.
    """
    if type(value) is not dict or set(value) != {'taskId', 'runId', 'attemptId'}:
        raise InvalidWork('invalid_engine_start_input')
    task_id = text(value['taskId'], MAX_IDENTITY)
    run_id = text(value['runId'], MAX_IDENTITY)
    attempt_id = text(value['attemptId'], 32)
    if not valid_attempt_id(attempt_id):
        raise InvalidWork('invalid_engine_start_input')
    return {'taskId': task_id, 'runId': run_id, 'attemptId': attempt_id}


async def assert_accepted_workflow(store: PostgresWorkStore, identity, facts, *,
                                   expected_namespace, expected_queue, expected_workflow_type):
    return await _assert_workflow(store, identity, facts, expected_namespace=expected_namespace,
        expected_queue=expected_queue, expected_workflow_type=expected_workflow_type, completed=False)


async def assert_completed_workflow(store: PostgresWorkStore, identity, facts, *,
                                    expected_namespace, expected_queue, expected_workflow_type):
    """Correlate a completed result for readback only. Never supplies fresh authority or a fence."""
    return await _assert_workflow(store, identity, facts, expected_namespace=expected_namespace,
        expected_queue=expected_queue, expected_workflow_type=expected_workflow_type, completed=True)


async def assert_failed_workflow(store, identity, facts, *, expected_namespace, expected_queue, expected_workflow_type):
    """Readback of an already recorded terminal refusal; never authorizes execution."""
    return await _assert_workflow(store, identity, facts, expected_namespace=expected_namespace,
        expected_queue=expected_queue, expected_workflow_type=expected_workflow_type, completed=False, failed=True)


async def assert_historical_workflow(store, identity, facts, *, expected_namespace, expected_queue, expected_workflow_type):
    """Original admission provenance only, including after closure; never grants a claim."""
    return await _assert_workflow(store, identity, facts, expected_namespace=expected_namespace,
        expected_queue=expected_queue, expected_workflow_type=expected_workflow_type,
        completed=False, historical=True)


async def _assert_workflow(store, identity, facts, *, expected_namespace, expected_queue,
                           expected_workflow_type, completed, failed=False, historical=False):
    """Fail closed unless this activity matches one acknowledged Task/Run engine start.

    ``expected_*`` are trusted settings from control composition; ``identity`` must be exactly
    ``{'taskId', 'runId'}``; ``facts`` must be an :class:`EngineActivityFacts` decoded by trusted
    control code. The actual namespace/type/workflow ID must match those settings and the
    deterministic ``openbot-work-v1-<runId>`` ID. The activity task queue and the workflow start
    queue are separate facts and both must equal the trusted expected queue.

    Inside the existing trusted transaction, under the Task read lock, the exact Task/Run
    admission must be active and authorized, the Run must be queued/running, and
    ``work_admissions.state`` must be ``acknowledged`` with both submission and engine references
    equal to ``temporal:<namespace>:<workflowId>``, the persisted 128-bit submission attempt
    identifier and the same first engine Run ID. The immutable start input's exact
    ``{taskId, runId, attemptId}`` must equal the Task/Run and that persisted attempt: a
    same-ID/same-chain start from a different submission can never prove this one. An older
    acknowledgement without attempt provenance cannot prove which start it accepted. A
    reserved-but-unacknowledged attempt, mismatched scope/type/ID, wrong Task/Run,
    cancellation/revocation and closed Runs are refused.

    The return value is correlation only, never authority. The read lock keeps a concurrent
    cancellation/revocation from changing this decision mid-check, and accepting a past
    acknowledgement never reopens a closed Task/Run.
    """
    if type(facts) is not EngineActivityFacts:
        raise InvalidWork('invalid_engine_facts')
    task_id, run_id = _identity(identity)
    text(expected_namespace, MAX_NAMESPACE)
    text(expected_queue, MAX_QUEUE)
    text(expected_workflow_type, MAX_WORKFLOW_TYPE)
    text(facts.namespace, MAX_NAMESPACE)
    text(facts.queue, MAX_QUEUE)
    text(facts.start_queue, MAX_QUEUE)
    text(facts.workflow_id, MAX_WORKFLOW_ID)
    text(facts.workflow_type, MAX_WORKFLOW_TYPE)
    text(facts.engine_run_id, MAX_ENGINE_RUN_ID)
    text(facts.first_run_id, MAX_ENGINE_RUN_ID)
    start_input = engine_start_input(facts.start_input)

    workflow_id = WORKFLOW_ID_PREFIX + run_id
    reference = REFERENCE_PREFIX + expected_namespace + ':' + workflow_id

    # Actual engine facts must agree with trusted settings before any durable state is trusted.
    # A well-formed fact that disagrees is a conflict with trusted composition, not malformed
    # input, so it is refused fail-closed as WorkConflict rather than InvalidWork. The activity
    # task queue and the workflow start queue are different engine facts; this deployment
    # requires both to be the trusted queue, and a mismatch is never evidence of acceptance.
    if facts.namespace != expected_namespace:
        raise WorkConflict('engine_namespace_mismatch')
    if facts.queue != expected_queue:
        raise WorkConflict('engine_queue_mismatch')
    if facts.start_queue != expected_queue:
        raise WorkConflict('engine_start_queue_mismatch')
    if facts.workflow_type != expected_workflow_type:
        raise WorkConflict('engine_workflow_type_mismatch')
    if facts.workflow_id != workflow_id:
        raise WorkConflict('engine_workflow_id_mismatch')

    async with store._transaction(trusted=True) as connection:
        # All control writers take the Task lock first; this SHARE lock makes the following
        # reads consistent with cancellation/revocation while granting no write.
        task = await store._task(connection, task_id, read=True)
        cursor = await connection.execute(
            'SELECT r.status AS run_status,a.state,a.engine_reference,a.submission_reference,'
            'a.submission_attempt_id,a.engine_first_run_id '
            'FROM work_runs r JOIN work_admissions a ON a.run_id=r.id '
            'WHERE r.task_id=%s AND r.id=%s', (task_id, run_id))
        admission = await cursor.fetchone()
        if admission is None:
            raise WorkNotFound()
        if completed or failed:
            status = 'failed' if failed else 'completed'
            if task['status'] != status or admission['run_status'] != status:
                raise WorkConflict('failure_not_recorded' if failed else 'completion_not_recorded')
        elif not historical:
            store._active(task)
            if admission['run_status'] not in ('queued', 'running'):
                raise WorkConflict('run_closed')
        if admission['state'] != 'acknowledged':
            raise WorkConflict('handoff_not_acknowledged')
        if (admission['submission_reference'] != reference
                or admission['engine_reference'] != reference):
            raise WorkConflict('handoff_reference_changed')
        if admission['submission_attempt_id'] is None:
            # An acknowledgement without attempt provenance cannot prove which start it
            # accepted; a later same-ID chain could be mistaken for the original.
            raise WorkConflict('handoff_attempt_unbound')
        if start_input['attemptId'] != admission['submission_attempt_id']:
            # The immutable start input must carry the exact persisted attempt identifier. A
            # different one is a different submission that merely reused the Workflow ID.
            raise WorkConflict('handoff_attempt_changed')
        if start_input != {'taskId': task_id, 'runId': run_id,
                           'attemptId': admission['submission_attempt_id']}:
            # The Workflow ID is derived from the Task/Run, but the immutable start input is
            # the actual start intent; a mismatch means this history is not this submission.
            raise WorkConflict('handoff_start_input_changed')
        if admission['engine_first_run_id'] is None:
            raise WorkConflict('handoff_engine_run_unbound')
        if admission['engine_first_run_id'] != facts.first_run_id:
            raise WorkConflict('handoff_engine_run_changed')
        return AcceptedWorkflow(
            task_id=task_id, run_id=run_id, namespace=facts.namespace, queue=facts.queue,
            workflow_id=workflow_id, workflow_type=facts.workflow_type,
            engine_run_id=facts.engine_run_id, first_run_id=facts.first_run_id)
