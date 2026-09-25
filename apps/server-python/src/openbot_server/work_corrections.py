"""Owner commands and immutable context boundaries; neither is execution authority."""
import hashlib
import json
from uuid import uuid4

from psycopg.types.json import Jsonb

from .models import iso_timestamp
from .work_values import InvalidWork, WorkConflict, WorkNotFound, text


class CorrectionsChanged(WorkConflict):
    """An intact, correctly scoped historical context needs a new model turn."""


def projection(row):
    return dict(id=row['id'], taskId=row['task_id'], runId=row['run_id'],
                sequence=row['sequence'], requestedBy=row['requested_by'],
                instruction=row['instruction'], generation=row['generation'],
                createdAt=iso_timestamp(row['created_at']))


async def _run(db, task_id, run_id):
    text(run_id, 128)
    cursor = await db.execute('SELECT * FROM work_runs WHERE task_id=%s AND id=%s',
                              (task_id, run_id))
    run = await cursor.fetchone()
    if run is None:
        raise WorkNotFound()
    return run


async def _current(db, task_id, run_id):
    cursor = await db.execute('SELECT id,instruction FROM work_corrections '
                              'WHERE task_id=%s AND run_id=%s ORDER BY sequence',
                              (task_id, run_id))
    return [dict(id=row['id'], instruction=row['instruction']) for row in await cursor.fetchall()]


def _digest(task_id, run_id, generation, corrections):
    # Eight 4-KiB commands exceed the generic intent cap. This separate closed shape has
    # a bounded size and no arbitrary objects, recursion or caller-selected hash fields.
    if type(generation) is not int or generation < 1 or type(corrections) is not list or len(corrections) > 8:
        raise WorkConflict('correction_context_corrupt')
    seen = set()
    try:
        for item in corrections:
            if type(item) is not dict or set(item) != {'id', 'instruction'}:
                raise WorkConflict('correction_context_corrupt')
            text(item['id'], 128); text(item['instruction'], 16384)
            if item['id'] in seen:
                raise WorkConflict('correction_context_corrupt')
            seen.add(item['id'])
        encoded = json.dumps(dict(taskId=task_id, runId=run_id, generation=generation,
                                  corrections=corrections), ensure_ascii=False,
                             sort_keys=True, separators=(',', ':')).encode('utf-8')
    except (InvalidWork, TypeError, ValueError, UnicodeError):
        raise WorkConflict('correction_context_corrupt') from None
    return hashlib.sha256(encoded).hexdigest()


def _context(row):
    if row['content_digest'] != _digest(row['task_id'], row['run_id'], row['generation'], row['corrections']):
        raise WorkConflict('correction_context_corrupt')
    return dict(id=row['id'], corrections=row['corrections'], generation=row['generation'])


async def check_context(db, task, run_id, context_id, *, current=True):
    """Caller holds the Task lock. Historical reads validate identity/integrity, not permission."""
    run = await _run(db, task['id'], run_id)
    if context_id is None:
        if run['corrections_enabled']:
            raise WorkConflict('correction_context_required')
        return None
    try:
        text(context_id, 128)
    except InvalidWork:
        raise WorkConflict('correction_context_invalid') from None
    if not run['corrections_enabled']:
        raise WorkConflict('corrections_unsupported')
    cursor = await db.execute('SELECT * FROM work_correction_contexts '
                              'WHERE id=%s AND task_id=%s AND run_id=%s',
                              (context_id, task['id'], run_id))
    row = await cursor.fetchone()
    if row is None:
        raise WorkConflict('correction_context_invalid')
    result = _context(row)
    if current and (result['generation'] != task['authority_generation'] or
                    result['corrections'] != await _current(db, task['id'], run_id)):
        raise CorrectionsChanged('corrections_changed')
    return result


class CorrectionStore:
    def __init__(self, store):
        self._store = store

    async def enable(self, task_id, run_id):
        """Only a trusted Activity already bound to its original engine start calls this."""
        async with self._store._transaction(trusted=True) as db:
            task = await self._store._task(db, task_id)
            run = await _run(db, task_id, run_id)
            if run['corrections_enabled']:
                return
            self._store._active(task)
            if run['status'] not in ('queued', 'running'):
                raise WorkConflict('run_closed')
            cursor = await db.execute('SELECT 1 FROM work_actions WHERE run_id=%s LIMIT 1', (run_id,))
            if await cursor.fetchone():
                raise WorkConflict('corrections_enable_too_late')
            await db.execute('UPDATE work_runs SET corrections_enabled=true WHERE id=%s', (run_id,))
            await self._store._event(db, task_id, 'corrections.enabled', {'runId': run_id})

    async def request(self, token, task_id, *, run_id, instruction, request_key, expected_sequence):
        async with self._store._transaction(token) as db:
            return await self.request_in_transaction(db, task_id, run_id=run_id,
                instruction=instruction, request_key=request_key, expected_sequence=expected_sequence)

    async def request_in_transaction(self, db, task_id, *, run_id, instruction, request_key, expected_sequence, source=False):
        """Called only inside the same Owner transaction as a retained steering command."""
        text(task_id, 128); text(run_id, 128); text(instruction, 16384 if source else 4096); text(request_key, 128)
        if type(expected_sequence) is not int or not 0 <= expected_sequence <= 8:
            raise InvalidWork('invalid_correction_sequence')
        # This closed, individually bounded shape can exceed the generic 16-KiB intent
        # cap when valid 4-KiB instructions need six-byte JSON escapes. Preserve all input
        # bytes and the original canonical hash format without narrowing the text contract.
        encoded = json.dumps(dict(taskId=task_id, runId=run_id, instruction=instruction,
                                   expectedSequence=expected_sequence), ensure_ascii=False,
                             sort_keys=True, separators=(',', ':')).encode('utf-8')
        digest = hashlib.sha256(encoded).hexdigest()
        task = await self._store._task(db, task_id)
        run = await _run(db, task_id, run_id)
        cursor = await db.execute('SELECT * FROM work_corrections WHERE task_id=%s AND request_key=%s',
                                  (task_id, request_key))
        existing = await cursor.fetchone()
        # Lost command ACKs remain readable after cancellation; no new instruction is accepted.
        if existing is not None:
            if existing['request_digest'] != digest:
                raise WorkConflict('correction_content_changed')
            return projection(existing)
        self._store._active(task)
        if not run['corrections_enabled']:
            raise WorkConflict('corrections_unsupported')
        if run['status'] not in ('queued', 'running'):
            raise WorkConflict('run_closed')
        cursor = await db.execute('SELECT coalesce(max(sequence),0) AS sequence FROM work_corrections '
                                  'WHERE task_id=%s AND run_id=%s', (task_id, run_id))
        sequence = (await cursor.fetchone())['sequence']
        if sequence != expected_sequence:
            raise WorkConflict('correction_sequence_changed')
        if sequence >= 8:
            raise WorkConflict('correction_limit')
        generation = task['authority_generation'] + 1
        cursor = await db.execute('INSERT INTO work_corrections '
            '(id,task_id,run_id,sequence,request_key,request_digest,requested_by,instruction,generation) '
            "VALUES (%s,%s,%s,%s,%s,%s,'owner',%s,%s) ON CONFLICT(task_id,request_key) DO NOTHING RETURNING *",
            (str(uuid4()), task_id, run_id, sequence + 1, request_key, digest, instruction, generation))
        command = await cursor.fetchone()
        if command is None:
            # All cooperating writers hold this Task lock; fail closed on a conflicting writer.
            raise WorkConflict('correction_content_changed')
        await db.execute('UPDATE work_tasks SET authority_generation=%s WHERE id=%s',
                         (generation, task_id))
        cursor = await db.execute("UPDATE work_actions a SET status='superseded',superseded_by=%s "
            "WHERE a.task_id=%s AND a.status='proposed' AND a.decision<>'denied' "
            "AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.task_id=a.task_id AND e.kind='action.admitted' "
            "AND e.payload->>'actionId'=a.id) RETURNING a.id",
            (command['id'], task_id))
        superseded = [row['id'] for row in await cursor.fetchall()]
        await self._store._event(db, task_id, 'correction.requested',
            {'correctionId': command['id'], 'runId': run_id, 'sequence': command['sequence'],
             'generation': generation, 'supersededActionIds': superseded})
        return projection(command)

    async def freeze(self, task_id, run_id, checkpoint_key):
        text(checkpoint_key, 128)
        async with self._store._transaction(trusted=True) as db:
            task = await self._store._task(db, task_id)
            run = await _run(db, task_id, run_id)
            if not run['corrections_enabled']:
                raise WorkConflict('corrections_unsupported')
            cursor = await db.execute('SELECT * FROM work_correction_contexts '
                'WHERE task_id=%s AND run_id=%s AND checkpoint_key=%s', (task_id, run_id, checkpoint_key))
            existing = await cursor.fetchone()
            if existing is not None:
                return _context(existing)
            self._store._active(task)
            if run['status'] not in ('queued', 'running'):
                raise WorkConflict('run_closed')
            corrections = await _current(db, task_id, run_id)
            generation = task['authority_generation']
            content_digest = _digest(task_id, run_id, generation, corrections)
            cursor = await db.execute('INSERT INTO work_correction_contexts '
                '(id,task_id,run_id,checkpoint_key,generation,corrections,content_digest) '
                'VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *',
                (str(uuid4()), task_id, run_id, checkpoint_key, generation, Jsonb(corrections), content_digest))
            return _context(await cursor.fetchone())

    async def read(self, task_id, run_id, context_id):
        async with self._store._transaction(trusted=True) as db:
            task = await self._store._task(db, task_id, read=True)
            return await check_context(db, task, run_id, context_id, current=False)
