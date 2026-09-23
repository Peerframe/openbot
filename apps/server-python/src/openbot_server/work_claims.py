"""Control-owned attempt fences. The durable engine, not this module, schedules recovery."""
from dataclasses import dataclass
from .work_values import InvalidWork, WorkConflict, WorkNotFound, text


@dataclass(frozen=True)
class WorkFence:
    run_id: str
    claim_id: str
    epoch: int


async def check_fence(connection, run_id, fence):
    if (not isinstance(fence, WorkFence) or fence.run_id != run_id or
            type(fence.epoch) is not int or not 1 <= fence.epoch <= 10000):
        raise WorkConflict('execution_claim_required')
    cursor = await connection.execute('SELECT r.execution_epoch,c.epoch,c.expires_at>clock_timestamp() AS live '
        'FROM work_runs r JOIN work_claims c ON c.run_id=r.id WHERE r.id=%s AND c.claim_id=%s',
        (run_id, fence.claim_id))
    row = await cursor.fetchone()
    if row is None or not row['live'] or row['epoch'] != fence.epoch or row['execution_epoch'] != fence.epoch:
        raise WorkConflict('execution_claim_stale')


async def claim(store, task_id, run_id, claim_id, *, expires_seconds=60):
    """A new trusted engine attempt supersedes old writers; replay never renews a claim."""
    text(run_id,128); text(claim_id,128)
    if type(expires_seconds) is not int or not 1 <= expires_seconds <= 300:
        raise InvalidWork('invalid_claim_lifetime')
    async with store._transaction(trusted=True) as connection:
        task = await store._task(connection, task_id)
        store._active(task)
        cursor = await connection.execute('SELECT * FROM work_runs WHERE task_id=%s AND id=%s FOR UPDATE', (task_id,run_id))
        run = await cursor.fetchone()
        if run is None:
            raise WorkNotFound()
        if run['status'] not in ('queued','running'):
            raise WorkConflict('run_closed')
        cursor = await connection.execute('SELECT epoch FROM work_claims WHERE run_id=%s AND claim_id=%s', (run_id,claim_id))
        existing = await cursor.fetchone()
        if existing:
            fence = WorkFence(run_id,claim_id,existing['epoch'])
            await check_fence(connection,run_id,fence)
            return fence
        if run['execution_epoch'] >= 10000:
            raise WorkConflict('attempt_limit')
        epoch = run['execution_epoch'] + 1
        await connection.execute("UPDATE work_runs SET execution_epoch=%s,status='running' WHERE id=%s", (epoch,run_id))
        await connection.execute("INSERT INTO work_claims VALUES (%s,%s,%s,clock_timestamp()+%s*interval '1 second')",
                                 (run_id,claim_id,epoch,expires_seconds))
        await connection.execute("UPDATE work_tasks SET status='open' WHERE id=%s", (task_id,))
        await store._event(connection,task_id,'run.claimed',{'runId':run_id,'epoch':epoch})
        fence = WorkFence(run_id,claim_id,epoch)
        await check_fence(connection,run_id,fence)
        return fence
