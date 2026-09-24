"""Read-only product loader for a continuously running Temporal Worker.

A Worker process that stays up across many activities needs the *product* facts of the Task it is
allowed to work on (bot, objective, token budget) without trusting any Task/Run identity supplied
by workflow, HTTP or model input. This module is that loader. It takes one thing on trust: the
pinned SDK activity context, read inside the existing
:func:`openbot_server.work_temporal_activity.bind_current_activity` gate. The caller never passes a
Task ID, a Run ID or an activity-info override.

The result is deliberately *correlation evidence*, not authority. Binding proves that this exact
activity belongs to an acknowledged engine start; loading the persisted Task/Run then proves the
product context is still open. The returned :class:`WorkRuntimeContext` grants no claim, fence,
budget reservation or tool permission, and a later effect still has to acquire control-owned
authority. Nothing here writes, claims, acknowledges, schedules, retries or authorizes, and there
is no model, tool or credential access.

Temporal owns retry and scheduling. An unacknowledged handoff is reported as
:class:`WorkStartPending` and the loader stops; it never sleeps, re-binds or acknowledges, because
a retry decision belongs to the engine, not to this control-plane read. Re-running the loader on
the next activity attempt is safe and stateless.
"""
from dataclasses import dataclass

from .work_engine_binding import AcceptedWorkflow
from .work_store import PostgresWorkStore
from .work_temporal_activity import bind_current_activity
from .work_values import WorkConflict, WorkNotFound, text, tokens

MAX_TASK_ID = 128
MAX_RUN_ID = 128
MAX_BOT_ID = 128
MAX_OBJECTIVE = 16384

# Exact conflict text emitted by the existing binding gate when the durable handoff has not been
# acknowledged. Only this exact value is translated; every other conflict is a real refusal.
HANDOFF_NOT_ACKNOWLEDGED = 'handoff_not_acknowledged'


@dataclass(frozen=True)
class WorkRuntimeContext:
    """Detached scalar product context for one accepted, still-open Task/Run.

    Plain scalars only: no connection, cursor, Task row mapping or store reference escapes the
    loading transaction, so later product code cannot accidentally hold a lock or re-read a
    mutable row through this value. The fields describe *what* the Task is, never *what the
    Worker may do*.
    """
    task_id: str
    run_id: str
    bot_id: str
    objective: str
    token_limit: int


class WorkStartPending(Exception):
    """The acknowledged handoff for this activity is not there yet; do not load context.

    Fixed message ``handoff_not_acknowledged`` so callers and logs see one stable signal. This is
    an unproven state, not proof that a valid reservation exists: the binding gate checks
    acknowledgement before its reservation provenance. It returns no Task data or grant.
    Temporal, not this module, owns any bounded retry and scheduling.
    """

    def __init__(self):
        super().__init__(HANDOFF_NOT_ACKNOWLEDGED)


async def load_current_activity_task(store: PostgresWorkStore, client, *, expected_namespace,
                                     expected_queue, expected_workflow_type) -> WorkRuntimeContext:
    """Load the persisted product context for this exact, still-open accepted activity.

    First the existing :func:`bind_current_activity` gate derives namespace, queue, Workflow
    type/ID, current engine Run ID and the immutable start input from the pinned SDK context and
    matches them against the durable acknowledgment. The caller supplies only trusted routing
    settings: no Task/Run identity and no SDK context override exist in this API. If and only if
    that gate raises :class:`openbot_server.work_values.WorkConflict` with the exact text
    ``handoff_not_acknowledged``, :class:`WorkStartPending` is raised ``from None``; every other
    exception (including every other conflict and any transport failure) propagates untouched.

    After binding succeeds, the loader reopens the existing trusted transaction and re-establishes
    the Task SHARE lock via ``store._task(..., read=True)`` before repeating ``store._active``.
    That second authority check is what makes a cancel or revoke *between* binding and load
    refuse: the closing writer needs the Task row exclusively, so it either commits before this
    lock (and ``_active`` refuses) or waits until this read-only transaction ends. Only then is
    the exact Run loaded by ``task_id`` and ``id``: missing is :class:`WorkNotFound`, and any
    status other than ``queued``/``running`` is ``run_closed``. Persisted ``bot_id``,
    ``objective`` and ``token_limit`` are bounded by the existing ``text``/``tokens`` validators
    and returned as a detached dataclass. This function never retries, sleeps, acknowledges,
    starts, claims or authorizes, and performs no write.
    """
    try:
        accepted: AcceptedWorkflow = await bind_current_activity(
            store, client, expected_namespace=expected_namespace, expected_queue=expected_queue,
            expected_workflow_type=expected_workflow_type)
    except WorkConflict as conflict:
        if str(conflict) != HANDOFF_NOT_ACKNOWLEDGED:
            # A real correlation refusal, never a "not yet". Propagate it unchanged.
            raise
        raise WorkStartPending() from None

    async with store._transaction(trusted=True) as connection:
        # Re-take the Task SHARE lock and repeat the authority check inside this transaction. The
        # binding gate's earlier read-only lock is already released, so cancellation/revocation
        # may have committed in between; re-checking is what refuses that race.
        task = await store._task(connection, accepted.task_id, read=True)
        store._active(task)

        cursor = await connection.execute(
            'SELECT * FROM work_runs WHERE task_id=%s AND id=%s',
            (accepted.task_id, accepted.run_id))
        run = await cursor.fetchone()
        if run is None:
            raise WorkNotFound()
        if run['status'] not in ('queued', 'running'):
            raise WorkConflict('run_closed')

        # Detach bounded scalars before leaving the transaction so no row mapping or cursor can
        # outlive the lock. IDs use the work-domain 128-byte bound; objective uses its 16384 one.
        return WorkRuntimeContext(
            task_id=text(accepted.task_id, MAX_TASK_ID),
            run_id=text(accepted.run_id, MAX_RUN_ID),
            bot_id=text(task['bot_id'], MAX_BOT_ID),
            objective=text(task['objective'], MAX_OBJECTIVE),
            token_limit=tokens(task['token_limit']))
