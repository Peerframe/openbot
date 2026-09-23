"""Control-only engine acceptance facts; this adapter neither dispatches nor grants authority."""
from .work_store import PostgresWorkStore
from .work_values import InvalidWork, WorkConflict, WorkNotFound, text


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
                'SELECT r.task_id,r.id AS run_id,a.submission_reference FROM work_admissions a '
                'JOIN work_runs r ON r.id=a.run_id '
                "WHERE a.state='pending' AND a.submission_attempted_at IS NOT NULL "
                'ORDER BY a.submission_attempted_at,r.id LIMIT %s', (limit,))
            return [{'taskId': row['task_id'], 'runId': row['run_id'],
                     'engineReference': row['submission_reference']} for row in await cursor.fetchall()]

    async def unconfirmed_for(self, task_id, run_id):
        """Look up one prior submission without losing it behind a bounded scan."""
        text(task_id, 128); text(run_id, 128)
        async with self._store._transaction(trusted=True) as connection:
            cursor = await connection.execute(
                'SELECT r.task_id,r.id AS run_id,a.submission_reference FROM work_admissions a '
                'JOIN work_runs r ON r.id=a.run_id '
                "WHERE r.task_id=%s AND r.id=%s AND a.state='pending' "
                'AND a.submission_attempted_at IS NOT NULL', (task_id, run_id))
            row = await cursor.fetchone()
            if row is None:
                return None
            return {'taskId': row['task_id'], 'runId': row['run_id'],
                    'engineReference': row['submission_reference']}

    async def reserve_submission(self, task_id, run_id, engine_reference):
        """Record the one external submission attempt before contacting the engine.

        Only ``True`` authorizes this caller to send the first start request. A repeated identical
        reservation returns ``False`` and must inspect the original engine history instead.
        """
        text(run_id, 128); text(engine_reference, 256)
        async with self._store._transaction(trusted=True) as connection:
            task = await self._store._task(connection, task_id)
            cursor = await connection.execute(
                'SELECT r.status AS run_status,a.state,a.engine_reference,a.submission_reference '
                'FROM work_runs r JOIN work_admissions a ON a.run_id=r.id '
                'WHERE r.task_id=%s AND r.id=%s FOR UPDATE OF r,a', (task_id, run_id))
            handoff = await cursor.fetchone()
            if handoff is None:
                raise WorkNotFound()
            existing = handoff['submission_reference'] or handoff['engine_reference']
            if existing is not None:
                if existing != engine_reference:
                    raise WorkConflict('handoff_reference_changed')
                return False
            self._store._active(task)
            if handoff['state'] != 'pending' or handoff['run_status'] not in ('queued', 'running'):
                raise WorkConflict('handoff_closed')
            await connection.execute(
                'UPDATE work_admissions SET submission_reference=%s,'
                'submission_attempted_at=clock_timestamp() WHERE run_id=%s',
                (engine_reference, run_id))
            await self._store._event(connection, task_id, 'handoff.submission_attempted',
                                     {'runId': run_id, 'engineReference': engine_reference})
            return True

    async def acknowledge(self, task_id, run_id, engine_reference, engine_first_run_id):
        """Record verified acceptance: True once, False for an identical replay.

        Only trusted control code may supply this receipt. Acceptance may precede cancellation;
        recording that past fact must never reopen a Task/Run or grant new execution authority.
        """
        text(run_id, 128); text(engine_reference, 256); text(engine_first_run_id, 128)
        async with self._store._transaction(trusted=True) as connection:
            # All work writers take the Task lock first, including cancellation and audit writes.
            await self._store._task(connection, task_id)
            cursor = await connection.execute(
                'SELECT a.state,a.engine_reference,a.submission_reference,a.engine_first_run_id '
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
            await connection.execute(
                "UPDATE work_admissions SET state='acknowledged',engine_reference=%s,"
                'engine_first_run_id=%s WHERE run_id=%s',
                (engine_reference, engine_first_run_id, run_id))
            await self._store._event(connection, task_id, 'handoff.acknowledged',
                                     {'runId': run_id, 'engineReference': engine_reference,
                                      'engineFirstRunId': engine_first_run_id})
            return True
