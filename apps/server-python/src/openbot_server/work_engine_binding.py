"""Read-only correlation gate for a future multi-Run Temporal activity.

The gate compares an activity's engine chain with the start the trusted dispatcher already
acknowledged for an exact Task/Run. It is deliberately a *correlation*
check: the returned record identifies the activity, its engine run and the accepted handoff,
but it is never an authority token, claim, fence or permission to call model/tool ports. A
later effect still has to acquire its own control-owned authority and fence under the existing
work-store transactions.

Nothing here writes, claims, schedules, retries or audits, and the module never imports
``temporalio``. The trusted caller decodes :class:`EngineActivityFacts` from
``temporalio.activity.info()``; facts are never accepted from model, HTTP or Worker input.
"""
from dataclasses import dataclass

from .work_dispatcher import REFERENCE_PREFIX, WORKFLOW_ID_PREFIX
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
    ``temporalio.activity.info()``. Trusted workflow code supplies ``first_run_id`` from
    ``workflow.info().first_execution_run_id``. It identifies the accepted chain across
    Continue-As-New; a new same-ID chain after retention has a different first Run ID.
    """
    namespace: str
    queue: str
    workflow_id: str
    workflow_type: str
    engine_run_id: str
    first_run_id: str


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


async def assert_accepted_workflow(store: PostgresWorkStore, identity, facts, *,
                                   expected_namespace, expected_queue, expected_workflow_type):
    """Fail closed unless this activity matches one acknowledged Task/Run engine start.

    ``expected_*`` are trusted settings from control composition; ``identity`` must be exactly
    ``{'taskId', 'runId'}``; ``facts`` must be an :class:`EngineActivityFacts` decoded by trusted
    control code. The actual namespace/queue/type/workflow ID must match those settings and the
    deterministic ``openbot-work-v1-<runId>`` ID.

    Inside the existing trusted transaction, under the Task read lock, the exact Task/Run
    admission must be active and authorized, the Run must be queued/running, and
    ``work_admissions.state`` must be ``acknowledged`` with both submission and engine references
    equal to ``temporal:<namespace>:<workflowId>`` and the same first engine Run ID. An older
    acknowledgement without that verified chain identity is refused. A reserved-but-unacknowledged attempt,
    mismatched scope/type/ID, wrong Task/Run, cancellation/revocation and closed Runs are refused.

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
    text(facts.workflow_id, MAX_WORKFLOW_ID)
    text(facts.workflow_type, MAX_WORKFLOW_TYPE)
    text(facts.engine_run_id, MAX_ENGINE_RUN_ID)
    text(facts.first_run_id, MAX_ENGINE_RUN_ID)

    workflow_id = WORKFLOW_ID_PREFIX + run_id
    reference = REFERENCE_PREFIX + expected_namespace + ':' + workflow_id

    # Actual engine facts must agree with trusted settings before any durable state is trusted.
    # A well-formed fact that disagrees is a conflict with trusted composition, not malformed
    # input, so it is refused fail-closed as WorkConflict rather than InvalidWork.
    if facts.namespace != expected_namespace:
        raise WorkConflict('engine_namespace_mismatch')
    if facts.queue != expected_queue:
        raise WorkConflict('engine_queue_mismatch')
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
            'a.engine_first_run_id '
            'FROM work_runs r JOIN work_admissions a ON a.run_id=r.id '
            'WHERE r.task_id=%s AND r.id=%s', (task_id, run_id))
        admission = await cursor.fetchone()
        if admission is None:
            raise WorkNotFound()
        store._active(task)
        if admission['run_status'] not in ('queued', 'running'):
            raise WorkConflict('run_closed')
        if admission['state'] != 'acknowledged':
            raise WorkConflict('handoff_not_acknowledged')
        if (admission['submission_reference'] != reference
                or admission['engine_reference'] != reference):
            raise WorkConflict('handoff_reference_changed')
        if admission['engine_first_run_id'] is None:
            raise WorkConflict('handoff_engine_run_unbound')
        if admission['engine_first_run_id'] != facts.first_run_id:
            raise WorkConflict('handoff_engine_run_changed')
        return AcceptedWorkflow(
            task_id=task_id, run_id=run_id, namespace=facts.namespace, queue=facts.queue,
            workflow_id=workflow_id, workflow_type=facts.workflow_type,
            engine_run_id=facts.engine_run_id, first_run_id=facts.first_run_id)
