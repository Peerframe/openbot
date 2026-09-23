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
                'ORDER BY t.created_at,t.id,r.ordinal,r.id LIMIT %s', (limit,))
            return [{'taskId': row['task_id'], 'runId': row['run_id']} for row in await cursor.fetchall()]

    async def acknowledge(self, task_id, run_id, engine_reference):
        """Record verified acceptance: True once, False for an identical replay.

        Only trusted control code may supply this receipt. Acceptance may precede cancellation;
        recording that past fact must never reopen a Task/Run or grant new execution authority.
        """
        text(run_id, 128); text(engine_reference, 256)
        async with self._store._transaction(trusted=True) as connection:
            # All work writers take the Task lock first, including cancellation and audit writes.
            await self._store._task(connection, task_id)
            cursor = await connection.execute(
                'SELECT a.state,a.engine_reference FROM work_runs r '
                'JOIN work_admissions a ON a.run_id=r.id '
                'WHERE r.task_id=%s AND r.id=%s FOR UPDATE OF r,a', (task_id, run_id))
            handoff = await cursor.fetchone()
            if handoff is None:
                raise WorkNotFound()
            if handoff['state'] == 'acknowledged':
                if handoff['engine_reference'] != engine_reference:
                    raise WorkConflict('handoff_reference_changed')
                return False
            await connection.execute(
                "UPDATE work_admissions SET state='acknowledged',engine_reference=%s WHERE run_id=%s",
                (engine_reference, run_id))
            await self._store._event(connection, task_id, 'handoff.acknowledged',
                                     {'runId': run_id, 'engineReference': engine_reference})
            return True
