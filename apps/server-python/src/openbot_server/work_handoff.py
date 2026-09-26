"""Control-only engine acceptance facts; this adapter neither dispatches nor grants authority."""
import re
import secrets
from dataclasses import dataclass

from .work_store import PostgresWorkStore
from .work_values import InvalidWork, WorkConflict, WorkNotFound, text

# One fresh 128-bit random value, stored as 32 lowercase hex characters. It identifies the
# exact reserved start input; it is correlation evidence, never an authority token.
ATTEMPT_ID_BYTES = 16
ATTEMPT_ID_PATTERN = re.compile('[0-9a-f]{32}')


def valid_attempt_id(value):
    """Return whether ``value`` is one bounded 128-bit lowercase-hex attempt identifier."""
    return type(value) is str and ATTEMPT_ID_PATTERN.fullmatch(value) is not None


@dataclass(frozen=True)
class SubmissionReservation:
    """Typed reservation outcome with explicit start authority and persisted provenance.

    ``should_start`` is true only for the single caller that created the reservation and owns
    the one permitted high-level start. ``attempt_id`` is the persisted identifier to inspect;
    it is ``None`` for a legacy reservation that predates attempt provenance. A legacy
    reservation never gains an identifier, is never resent and never authorizes a start.
    """
    should_start: bool
    attempt_id: str | None


class HandoffStore:
    def __init__(self, store: PostgresWorkStore):
        self._store = store

    async def pending(self, limit=32):
        """Return a bounded observation, not a claim or permission to execute work."""
        if type(limit) is not int or not 1 <= limit <= 128:
            raise InvalidWork('invalid_handoff_limit')
        async with self._store._transaction(trusted=True) as connection:
            cursor = await connection.execute(
                'SELECT t.id AS task_id,r.id AS run_id FROM work_tasks t '
                'JOIN work_runs r ON r.task_id=t.id '
                'JOIN work_admissions a ON a.run_id=r.id '
                "WHERE t.authority_active AND NOT t.cancel_requested AND t.status IN ('queued','open') "
                "AND r.status IN ('queued','running') AND a.state='pending' "
                'AND a.submission_attempted_at IS NULL '
                'ORDER BY t.created_at,t.id,r.ordinal,r.id LIMIT %s', (limit,))
            return [{'taskId': row['task_id'], 'runId': row['run_id']} for row in await cursor.fetchall()]

    async def unconfirmed(self, limit=32):
        """Observe prior submissions for exact engine-history lookup, including after cancellation.

        This is not permission to call ``start_workflow`` again or to resume execution.
        """
        if type(limit) is not int or not 1 <= limit <= 128:
            raise InvalidWork('invalid_handoff_limit')
        async with self._store._transaction(trusted=True) as connection:
            cursor = await connection.execute(
                'SELECT r.task_id,r.id AS run_id,a.submission_reference,a.submission_attempt_id '
                'FROM work_admissions a '
                'JOIN work_runs r ON r.id=a.run_id '
                "WHERE a.state='pending' AND a.submission_attempted_at IS NOT NULL "
                'ORDER BY a.submission_attempted_at,r.id LIMIT %s', (limit,))
            return [{'taskId': row['task_id'], 'runId': row['run_id'],
                     'engineReference': row['submission_reference'],
                     'attemptId': row['submission_attempt_id']} for row in await cursor.fetchall()]

    async def unconfirmed_for(self, task_id, run_id):
        """Look up one prior submission without losing it behind a bounded scan."""
        text(task_id, 128); text(run_id, 128)
        async with self._store._transaction(trusted=True) as connection:
            cursor = await connection.execute(
                'SELECT r.task_id,r.id AS run_id,a.submission_reference,a.submission_attempt_id '
                'FROM work_admissions a '
                'JOIN work_runs r ON r.id=a.run_id '
                "WHERE r.task_id=%s AND r.id=%s AND a.state='pending' "
                'AND a.submission_attempted_at IS NOT NULL', (task_id, run_id))
            row = await cursor.fetchone()
            if row is None:
                return None
            return {'taskId': row['task_id'], 'runId': row['run_id'],
                    'engineReference': row['submission_reference'],
                    'attemptId': row['submission_attempt_id']}

    async def reserve_submission(self, task_id, run_id, engine_reference):
        """Record the one external submission attempt before contacting the engine.

        The fresh 128-bit attempt identifier is persisted in the same trusted transaction as the
        submission reference, so the caller owns the only permitted start and never needs a
        second lookup before that start. A repeated identical reservation returns the original
        persisted identifier with ``should_start`` false; a legacy reservation without that
        identifier stays unresolved and cannot authorize a start.
        """
        text(run_id, 128); text(engine_reference, 256)
        async with self._store._transaction(trusted=True) as connection:
            task = await self._store._task(connection, task_id)
            cursor = await connection.execute(
                'SELECT r.status AS run_status,a.state,a.engine_reference,a.submission_reference,'
                'a.submission_attempt_id '
                'FROM work_runs r JOIN work_admissions a ON a.run_id=r.id '
                'WHERE r.task_id=%s AND r.id=%s FOR UPDATE OF r,a', (task_id, run_id))
            handoff = await cursor.fetchone()
            if handoff is None:
                raise WorkNotFound()
            existing = handoff['submission_reference'] or handoff['engine_reference']
            if existing is not None:
                if existing != engine_reference:
                    raise WorkConflict('handoff_reference_changed')
                # The original identifier is returned for inspection; never replaced or backfilled.
                return SubmissionReservation(False, handoff['submission_attempt_id'])
            self._store._active(task)
            if handoff['state'] != 'pending' or handoff['run_status'] not in ('queued', 'running'):
                raise WorkConflict('handoff_closed')
            attempt_id = secrets.token_hex(ATTEMPT_ID_BYTES)
            await connection.execute(
                'UPDATE work_admissions SET submission_reference=%s,submission_attempt_id=%s,'
                'submission_attempted_at=clock_timestamp() WHERE run_id=%s',
                (engine_reference, attempt_id, run_id))
            # Public audit records the submission reference only; the attempt identifier is
            # correlation evidence and must not be exposed as a public event field.
            await self._store._event(connection, task_id, 'handoff.submission_attempted',
                                     {'runId': run_id, 'engineReference': engine_reference})
            return SubmissionReservation(True, attempt_id)

    async def acknowledge(self, task_id, run_id, engine_reference, attempt_id, engine_first_run_id):
        """Record verified acceptance: True once, False for an identical replay.

        The inspected attempt identifier is compared under the same row lock as the submission
        reference and first engine Run ID, so an acceptance can never attach a different start
        input. Only trusted control code may supply this receipt. Acceptance may precede
        cancellation; recording that past fact must never reopen a Task/Run or grant new
        execution authority.
        """
        text(run_id, 128); text(engine_reference, 256); text(engine_first_run_id, 128)
        if not valid_attempt_id(attempt_id):
            raise InvalidWork('invalid_attempt_id')
        async with self._store._transaction(trusted=True) as connection:
            # All work writers take the Task lock first, including cancellation and audit writes.
            await self._store._task(connection, task_id)
            cursor = await connection.execute(
                'SELECT a.state,a.engine_reference,a.submission_reference,a.submission_attempt_id,'
                'a.engine_first_run_id '
                'FROM work_runs r '
                'JOIN work_admissions a ON a.run_id=r.id '
                'WHERE r.task_id=%s AND r.id=%s FOR UPDATE OF r,a', (task_id, run_id))
            handoff = await cursor.fetchone()
            if handoff is None:
                raise WorkNotFound()
            if handoff['state'] == 'acknowledged':
                if handoff['engine_reference'] != engine_reference:
                    raise WorkConflict('handoff_reference_changed')
                if handoff['submission_reference'] != engine_reference:
                    # A legacy acceptance with no recorded submission cannot become a
                    # worker grant simply by attaching a current same-ID engine run.
                    raise WorkConflict('handoff_not_reserved')
                if handoff['submission_attempt_id'] is None:
                    # A pre-provenance acceptance cannot prove which start it accepted.
                    raise WorkConflict('handoff_attempt_unbound')
                if handoff['submission_attempt_id'] != attempt_id:
                    raise WorkConflict('handoff_attempt_changed')
                if handoff['engine_first_run_id'] is None:
                    # The old chain identity was never recorded. Current same-ID
                    # history could be a new chain after retention; no auto-backfill.
                    raise WorkConflict('handoff_engine_run_unbound')
                if handoff['engine_first_run_id'] != engine_first_run_id:
                    raise WorkConflict('handoff_engine_run_changed')
                return False
            if handoff['state'] != 'pending' or handoff['submission_reference'] is None:
                raise WorkConflict('handoff_not_reserved')
            if handoff['submission_reference'] != engine_reference:
                raise WorkConflict('handoff_reference_changed')
            if handoff['submission_attempt_id'] is None:
                raise WorkConflict('handoff_attempt_unbound')
            if handoff['submission_attempt_id'] != attempt_id:
                raise WorkConflict('handoff_attempt_changed')
            await connection.execute(
                "UPDATE work_admissions SET state='acknowledged',engine_reference=%s,"
                'engine_first_run_id=%s WHERE run_id=%s',
                (engine_reference, engine_first_run_id, run_id))
            await self._store._event(connection, task_id, 'handoff.acknowledged',
                                     {'runId': run_id, 'engineReference': engine_reference,
                                      'engineFirstRunId': engine_first_run_id})
            return True
