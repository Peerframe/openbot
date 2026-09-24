"""Control-private immutable model observations; historical facts confer no authority.

The Action is admitted before the provider call. An observation is stored after receiving and
validating that call, before Action settlement and engine acknowledgement. A crash before the
receipt commits leaves unknown billing; no missing receipt authorizes another provider request.
This optional Worker module is not imported by ordinary HTTP startup.
"""
import asyncio
import hashlib
from dataclasses import dataclass

from pydantic_ai.messages import ModelMessagesTypeAdapter, ModelResponse

from .work_values import InvalidWork, WorkConflict, canonical, tokens

CODEC = 'pydantic-ai2-model-response-v1'
MAX_RESULT_BYTES = 2 * 1024 * 1024


def encode_response(response):
    if type(response) is not ModelResponse:
        raise InvalidWork('invalid_model_observation')
    usage = response.usage
    actual = tokens(usage.input_tokens) + tokens(usage.output_tokens)
    tokens(actual)
    data = ModelMessagesTypeAdapter.dump_json([response])
    if not 0 < len(data) <= MAX_RESULT_BYTES:
        raise InvalidWork('model_observation_size_limit')
    return data, actual


def decode_response(data, actual):
    try:
        messages = ModelMessagesTypeAdapter.validate_json(data)
        if len(messages) != 1 or type(messages[0]) is not ModelResponse:
            raise ValueError()
        _, observed = encode_response(messages[0])
        if observed != actual:
            raise ValueError()
    except Exception:
        raise WorkConflict('model_receipt_invalid') from None
    return messages[0]


@dataclass(frozen=True)
class ModelObservation:
    response: ModelResponse
    metadata: dict


class ModelReceipts:
    def __init__(self, store, files):
        self.store = store
        self.files = files

    @staticmethod
    def _scope(action, task_id, run_id, digest):
        if (action['task_id'], action['run_id'], action['intent_digest']) != (task_id, run_id, digest):
            raise WorkConflict('model_receipt_scope_mismatch')
        if action['status'] not in ('admitted', 'unknown', 'applied'):
            raise WorkConflict('model_receipt_not_admitted')
        if canonical(action['intent'])[1] != digest or action['intent'].get('kind') != 'model':
            raise WorkConflict('model_receipt_intent_mismatch')

    @staticmethod
    def _metadata(row):
        return {name: row[name] for name in ('action_id', 'task_id', 'run_id', 'intent_digest',
                                            'codec', 'sha256', 'size_bytes', 'actual_tokens')}

    @staticmethod
    def _settled(action, metadata):
        if action['status'] == 'applied':
            expected = {'source': 'control-model-observation', 'reference': action['id'],
                        'sha256': metadata['sha256']}
            if (action['actual_tokens'] != metadata['actual_tokens']
                    or action['evidence'] != expected):
                raise WorkConflict('model_receipt_settlement_conflict')

    async def save(self, action_id, *, task_id, run_id, intent_digest, response):
        # Refuse even a blob write for an unadmitted or wrongly scoped Action. Recheck under
        # the same Task/Action locking order after blob I/O; cancellation is a historical fact.
        data, actual = encode_response(response)
        async with self.store._transaction(trusted=True) as db:
            _, action = await self.store._action(db, action_id)
            self._scope(action, task_id, run_id, intent_digest)
            self._settled(action, {'sha256': hashlib.sha256(data).hexdigest(), 'actual_tokens': actual})
        descriptor = await asyncio.to_thread(self.files.put, data)
        metadata = dict(action_id=action_id, task_id=task_id, run_id=run_id,
                        intent_digest=intent_digest, codec=CODEC, sha256=descriptor['sha256'],
                        size_bytes=descriptor['sizeBytes'], actual_tokens=actual)
        async with self.store._transaction(trusted=True) as db:
            _, action = await self.store._action(db, action_id)
            self._scope(action, task_id, run_id, intent_digest)
            self._settled(action, metadata)
            existing = await (await db.execute('SELECT * FROM work_model_receipts WHERE action_id=%s',
                                               (action_id,))).fetchone()
            if existing is not None:
                if self._metadata(existing) != metadata:
                    raise WorkConflict('model_receipt_changed')
                return metadata
            await db.execute('INSERT INTO work_model_receipts '
                '(action_id,task_id,run_id,intent_digest,codec,sha256,size_bytes,actual_tokens) '
                'VALUES (%s,%s,%s,%s,%s,%s,%s,%s)', tuple(metadata.values()))
        return metadata

    async def load(self, action_id, *, task_id, run_id, intent_digest):
        async with self.store._transaction(trusted=True) as db:
            _, action = await self.store._action(db, action_id)
            self._scope(action, task_id, run_id, intent_digest)
            row = await (await db.execute('SELECT * FROM work_model_receipts WHERE action_id=%s',
                                          (action_id,))).fetchone()
            if row is None:
                return None
            metadata = self._metadata(row)
            self._settled(action, metadata)
        if ((row['task_id'], row['run_id'], row['intent_digest']) != (task_id, run_id, intent_digest)
                or row['codec'] != CODEC or not 0 < row['size_bytes'] <= MAX_RESULT_BYTES):
            raise WorkConflict('model_receipt_invalid')
        data = await asyncio.to_thread(self.files.read, row['sha256'], row['size_bytes'])
        response = decode_response(data, row['actual_tokens'])
        return ModelObservation(response, metadata)
