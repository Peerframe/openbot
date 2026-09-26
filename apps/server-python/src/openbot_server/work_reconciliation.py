"""Durable lookup commands. User requests and delivery receipts cannot settle Action outcomes."""
import re
from uuid import uuid4

from .models import iso_timestamp
from .work_values import InvalidWork, WorkConflict, WorkNotFound, canonical, text


def projection(row):
    return dict(id=row['id'], actionId=row['action_id'], sequence=row['sequence'],
                requestedBy=row['requested_by'], reason=row['reason'],
                createdAt=iso_timestamp(row['created_at']), delivered=row['delivered_at'] is not None,
                outcome=row['outcome'])


class ReconciliationStore:
    def __init__(self, store):
        self._store = store

    async def request(self, token, action_id, *, intent_digest, request_key, expected_sequence, reason):
        text(action_id, 128); text(request_key, 128); text(reason, 512)
        if type(intent_digest) is not str or re.fullmatch('[0-9a-f]{64}', intent_digest) is None:
            raise InvalidWork('invalid_intent_digest')
        if type(expected_sequence) is not int or not 0 <= expected_sequence <= 64:
            raise InvalidWork('invalid_reconciliation_sequence')
        _, digest = canonical({'actionId': action_id, 'intentDigest': intent_digest,
                               'expectedSequence': expected_sequence, 'reason': reason})
        async with self._store._transaction(token) as db:
            task, action = await self._store._action(db, action_id)
            cursor = await db.execute('SELECT c.*,r.request_digest AS replay_digest FROM work_reconciliation_requests r '
                                      'JOIN work_reconciliation_commands c ON c.id=r.command_id WHERE r.request_key=%s',
                                      (request_key,))
            existing = await cursor.fetchone()
            # A committed request remains retrievable after resolution; a lost HTTP response
            # must not turn the same user's idempotent retry into a new lookup cycle.
            if existing is not None:
                if existing['replay_digest'] != digest:
                    raise WorkConflict('reconciliation_content_changed')
                return projection(existing)
            if action['intent_digest'] != intent_digest:
                raise WorkConflict('reconciliation_intent_changed')
            if action['status'] != 'unknown':
                raise WorkConflict('reconciliation_unavailable')
            cursor = await db.execute('SELECT * FROM work_reconciliation_commands WHERE action_id=%s '
                                      'ORDER BY sequence DESC LIMIT 1', (action_id,))
            latest = await cursor.fetchone()
            sequence = latest['sequence'] if latest else 0
            if latest and latest['finished_at'] is None:
                if expected_sequence not in (sequence - 1, sequence):
                    raise WorkConflict('reconciliation_stale')
                await self._remember(db, latest, request_key, digest)
                return projection(latest)
            if expected_sequence != sequence:
                raise WorkConflict('reconciliation_stale')
            if sequence >= 64:
                raise WorkConflict('reconciliation_limit')
            cursor = await db.execute('INSERT INTO work_reconciliation_commands '
                '(id,action_id,intent_digest,sequence,requested_by,reason) '
                "VALUES (%s,%s,%s,%s,'owner',%s) RETURNING *",
                (str(uuid4()), action_id, intent_digest, sequence + 1, reason))
            command = await cursor.fetchone()
            await self._remember(db, command, request_key, digest)
            await self._store._event(db, task['id'], 'reconciliation.requested',
                {'commandId': command['id'], 'actionId': action_id, 'sequence': command['sequence'],
                 'intentDigest': intent_digest, 'requestedBy': 'owner', 'reason': reason})
            return projection(command)

    @staticmethod
    async def _remember(db, command, request_key, digest):
        cursor = await db.execute('INSERT INTO work_reconciliation_requests '
            '(request_key,request_digest,command_id) VALUES (%s,%s,%s) '
            'ON CONFLICT(request_key) DO NOTHING RETURNING request_key', (request_key, digest, command['id']))
        if await cursor.fetchone() is None:
            # Another Task may hold the global key. Never adopt its command or leave our
            # candidate/audit committed; raising rolls this entire Owner transaction back.
            cursor = await db.execute('SELECT request_digest,command_id FROM work_reconciliation_requests '
                                      'WHERE request_key=%s', (request_key,))
            old = await cursor.fetchone()
            if old is None or (old['request_digest'], old['command_id']) != (digest, command['id']):
                raise WorkConflict('reconciliation_content_changed')

    async def pending(self, limit=32):
        """Unfinished obligations remain resendable after an older engine restore."""
        if type(limit) is not int or not 1 <= limit <= 128:
            raise InvalidWork('invalid_reconciliation_limit')
        async with self._store._transaction(trusted=True) as db:
            cursor = await db.execute('SELECT c.id,a.id AS action_id,a.task_id,a.run_id '
                'FROM work_reconciliation_commands c JOIN work_actions a ON a.id=c.action_id '
                'WHERE c.finished_at IS NULL '
                'ORDER BY c.created_at,c.id LIMIT %s', (limit,))
            return [dict(commandId=r['id'], actionId=r['action_id'], taskId=r['task_id'], runId=r['run_id'])
                    for r in await cursor.fetchall()]

    async def _locked(self, db, command_id):
        text(command_id, 128)
        cursor = await db.execute('SELECT action_id FROM work_reconciliation_commands WHERE id=%s',
                                  (command_id,))
        found = await cursor.fetchone()
        if found is None:
            raise WorkNotFound()
        task, action = await self._store._action(db, found['action_id'])
        cursor = await db.execute('SELECT * FROM work_reconciliation_commands WHERE id=%s FOR UPDATE',
                                  (command_id,))
        return task, action, await cursor.fetchone()

    @staticmethod
    def _scope(task, action, command, task_id, run_id, action_id):
        if (task['id'], action['run_id'], action['id'], action['intent_digest']) != (
                task_id, run_id, action_id, command['intent_digest']):
            raise WorkConflict('reconciliation_scope_changed')

    async def read(self, command_id, *, task_id, run_id, action_id):
        async with self._store._transaction(trusted=True) as db:
            task, action, command = await self._locked(db, command_id)
            self._scope(task, action, command, task_id, run_id, action_id)
            return command

    async def acknowledge(self, command_id, engine_reference):
        text(engine_reference, 256)
        async with self._store._transaction(trusted=True) as db:
            task, action, command = await self._locked(db, command_id)
            if command['delivery_reference'] is not None:
                if command['delivery_reference'] != engine_reference:
                    raise WorkConflict('reconciliation_delivery_changed')
                return False
            # Even a late receipt only records delivery. It cannot clear finished_at/outcome.
            await db.execute('UPDATE work_reconciliation_commands SET delivery_reference=%s,'
                             'delivered_at=clock_timestamp() WHERE id=%s', (engine_reference, command_id))
            await self._store._event(db, task['id'], 'reconciliation.delivered',
                                    {'commandId': command_id, 'actionId': action['id']})
            return True

    async def finish(self, command_id, *, task_id, run_id, action_id, outcome):
        if outcome not in ('resolved', 'unresolved'):
            raise InvalidWork('invalid_reconciliation_outcome')
        async with self._store._transaction(trusted=True) as db:
            task, action, command = await self._locked(db, command_id)
            self._scope(task, action, command, task_id, run_id, action_id)
            if command['outcome'] is not None:
                if command['outcome'] != outcome:
                    raise WorkConflict('reconciliation_outcome_changed')
                return projection(command)
            allowed = ('applied', 'not_applied') if outcome == 'resolved' else ('unknown',)
            if action['status'] not in allowed:
                raise WorkConflict('reconciliation_outcome_unverified')
            cursor = await db.execute('UPDATE work_reconciliation_commands SET outcome=%s,'
                'finished_at=clock_timestamp() WHERE id=%s RETURNING *', (outcome, command_id))
            result = projection(await cursor.fetchone())
            await self._store._event(db, task['id'], 'reconciliation.finished',
                {'commandId': command_id, 'actionId': action_id, 'outcome': outcome})
            return result
