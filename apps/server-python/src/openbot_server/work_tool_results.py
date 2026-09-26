"""Private received tool responses. Observations are data, never authority or business proof."""
import asyncio
import hashlib
import json
from dataclasses import dataclass

from .work_effects import VerifiedOutcome
from .work_values import InvalidWork, WorkConflict, WorkNotFound, canonical
from .runtime_host import json_copy
from .runtime_ports import RuntimeDenied

CODEC = 'openbot-tool-json-v1'
MAX_RESULT_BYTES = 128 * 1024


def encode_result(value):
    # Retain the reviewed tool JSON contract, including long/empty keys and 64-level depth.
    # The stricter Action-intent codec must not discard a valid already-received response.
    try:
        detached = json_copy(value, MAX_RESULT_BYTES, 'invalid_tool_result')
        data = json.dumps(detached, ensure_ascii=False, sort_keys=True,
                          separators=(',', ':'), allow_nan=False).encode('utf-8')
    except (RuntimeDenied, ValueError, TypeError, UnicodeError, RecursionError):
        raise InvalidWork('invalid_tool_result') from None
    return data, hashlib.sha256(data).hexdigest()


def decode_result(data):
    try:
        value = json.loads(data)
        encoded, _ = encode_result(value)
        if data != encoded:
            raise ValueError()
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise WorkConflict('tool_result_invalid') from None
    return value


@dataclass(frozen=True)
class ToolObservation:
    value: object
    metadata: dict


def evidence(action_id, digest):
    return dict(source='control-tool-observation', reference=action_id, sha256=digest)


class ToolResults:
    def __init__(self, store, files):
        self.store, self.files = store, files

    @staticmethod
    def _scope(action, task_id, run_id, intent_digest):
        if (action['task_id'], action['run_id'], action['intent_digest']) != (task_id, run_id, intent_digest):
            raise WorkConflict('tool_result_scope_mismatch')
        if action['status'] not in ('admitted', 'unknown', 'applied'):
            raise WorkConflict('tool_result_not_admitted')
        if (canonical(action['intent'])[1] != intent_digest
                or action['intent'].get('kind') != 'deferred_tool'):
            raise WorkConflict('tool_result_intent_mismatch')

    @staticmethod
    def _metadata(row):
        return {key: row[key] for key in ('action_id', 'task_id', 'run_id', 'intent_digest',
                                         'codec', 'sha256', 'size_bytes')}

    @staticmethod
    def _settled(action, metadata):
        if action['status'] == 'applied' and (action['actual_tokens'] != 0
                or action['evidence'] != evidence(action['id'], metadata['sha256'])):
            raise WorkConflict('tool_result_settlement_conflict')

    async def save(self, action_id, *, task_id, run_id, intent_digest, value):
        data, digest = encode_result(value)
        metadata = dict(action_id=action_id, task_id=task_id, run_id=run_id,
                        intent_digest=intent_digest, codec=CODEC, sha256=digest, size_bytes=len(data))
        async def check(db):
            _, action = await self.store._action(db, action_id)
            self._scope(action, task_id, run_id, intent_digest)
            self._settled(action, metadata)
            existing = await (await db.execute('SELECT * FROM work_tool_results WHERE action_id=%s',
                                               (action_id,))).fetchone()
            if existing is not None and self._metadata(existing) != metadata:
                raise WorkConflict('tool_result_changed')
            if existing is None and action['status'] == 'applied':
                raise WorkConflict('tool_result_missing')
            return existing
        # Permission to record past truth does not revive cancelled work. Refuse unadmitted
        # or mismatched writes before blob I/O, then recheck the immutable Action under its lock.
        async with self.store._transaction(trusted=True) as db:
            await check(db)
        stored = await asyncio.to_thread(self.files.put, data)
        if stored != dict(sha256=digest, sizeBytes=len(data)):
            raise WorkConflict('tool_result_integrity')
        async with self.store._transaction(trusted=True) as db:
            if await check(db) is None:
                await db.execute('INSERT INTO work_tool_results '
                    '(action_id,task_id,run_id,intent_digest,codec,sha256,size_bytes) '
                    'VALUES (%s,%s,%s,%s,%s,%s,%s)', tuple(metadata.values()))
        return metadata

    async def load(self, action_id, *, task_id, run_id, intent_digest):
        async with self.store._transaction(trusted=True) as db:
            return await self.load_in_transaction(db,action_id,task_id=task_id,run_id=run_id,
                                                  intent_digest=intent_digest)

    async def load_in_transaction(self, db, action_id, *, task_id, run_id, intent_digest):
        """Read original bytes under caller-owned locks; never open a second Task transaction."""
        mapped = await (await db.execute('SELECT task_id FROM work_actions WHERE id=%s',(action_id,))).fetchone()
        if mapped is None:
            raise WorkNotFound()
        if mapped['task_id'] != task_id:
            raise WorkConflict('tool_result_scope_mismatch')
        await self.store._task(db,task_id,read=True)
        action = await (await db.execute('SELECT * FROM work_actions WHERE id=%s FOR SHARE',
                                         (action_id,))).fetchone()
        if action is None:
            raise WorkNotFound()
        self._scope(action, task_id, run_id, intent_digest)
        row = await (await db.execute('SELECT * FROM work_tool_results WHERE action_id=%s FOR SHARE',
                                      (action_id,))).fetchone()
        if row is None:
            if action['status'] == 'applied':
                raise WorkConflict('tool_result_missing')
            return None
        metadata = self._metadata(row)
        self._settled(action, metadata)
        if ((row['task_id'], row['run_id'], row['intent_digest']) != (task_id, run_id, intent_digest)
                or row['codec'] != CODEC or not 0 < row['size_bytes'] <= MAX_RESULT_BYTES):
            raise WorkConflict('tool_result_invalid')
        data = await asyncio.to_thread(self.files.read, row['sha256'], row['size_bytes'])
        return ToolObservation(decode_result(data), metadata)


class ToolResponseAdapter:
    """Record one received response; lookup never invokes the tool or its transport again.

    The callback is trusted control composition and must recheck the tool-specific authority.
    Do not use this adapter to assert that an external business mutation was independently
    verified: a response (including an error result) proves only the invocation was observed.
    """
    def __init__(self, results, invoke, *, task_id, run_id, intent_digest):
        if not callable(invoke):
            raise InvalidWork('tool_invoker_required')
        self.results, self.invoke = results, invoke
        self.scope = dict(task_id=task_id, run_id=run_id, intent_digest=intent_digest)

    async def apply(self, action_id, intent):
        if canonical(intent)[1] != self.scope['intent_digest']:
            raise WorkConflict('tool_result_intent_mismatch')
        # Detect a wrongly assembled adapter before any callback, not only when saving its
        # response. Admission is still exclusively owned by execute_action, never this read.
        if await self.results.load(action_id, **self.scope) is not None:
            return
        value = await self.invoke(action_id, intent)
        await self.results.save(action_id, **self.scope, value=value)

    async def lookup(self, action_id):
        observed = await self.results.load(action_id, **self.scope)
        return None if observed is None else observed.metadata


class ToolResponseVerifier:
    def __init__(self, results):
        self.results = results

    async def verify(self, *, action_id, task_id, run_id, intent_digest, intent, lookup):
        observed = await self.results.load(action_id, task_id=task_id, run_id=run_id,
                                           intent_digest=intent_digest)
        if observed is None or observed.metadata != lookup:
            return None
        return VerifiedOutcome(action_id, task_id, run_id, intent_digest, True, 0,
                               evidence(action_id, observed.metadata['sha256']))
