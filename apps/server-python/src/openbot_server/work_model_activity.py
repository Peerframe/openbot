"""Durable model-call port for one accepted engine activity, using existing Action authority.

Each SDK model request is a separate activity. A generated engine activity identity is not a
model-provided call ID or Runtime step counter. This profile supports activity retries within
one engine Run, not a new Workflow retry/Continue-As-New without an explicit continuation token.
"""
import hashlib
from copy import deepcopy
import json

from pydantic_ai.messages import ModelMessagesTypeAdapter
from openbot_agent_runtime.catalog import ToolCatalog
from openbot_agent_runtime.contracts import ModelStepRequest

from .work_effects import VerifiedOutcome, execute_action, recover_action
from .work_temporal_activity import _bind_activity_identity, _claim_bound_activity
from .work_values import InvalidWork, WorkConflict, canonical, text, tokens

DOMAIN = b'openbot.model.activity.v1\0'


def operation_key(accepted, activity_id):
    # A new engine Run has a fresh Activity sequence. Refuse implicit replay of old billed
    # operations until continuation explicitly carries the original operation identity.
    if accepted.engine_run_id != accepted.first_run_id:
        raise WorkConflict('model_continuation_identity_required')
    values = [accepted.task_id, accepted.run_id, accepted.namespace, accepted.workflow_id,
              accepted.engine_run_id, text(activity_id, 256)]
    data, _ = canonical(values)
    return 'model-activity-v1-' + hashlib.sha256(DOMAIN + data).hexdigest()


def model_request(request, *, provider_id, model_id, max_output_tokens):
    if type(request) is not ModelStepRequest:
        raise InvalidWork('invalid_model_request')
    text(provider_id, 64); text(model_id, 128)
    if type(max_output_tokens) is not int or not 1 <= max_output_tokens <= 65536:
        raise InvalidWork('invalid_model_output_limit')
    if not 1 <= len(request.messages) <= 256:
        raise InvalidWork('invalid_model_messages')
    messages = ModelMessagesTypeAdapter.dump_json(request.messages)
    if len(messages) > 256 * 1024:
        raise InvalidWork('model_input_size_limit')
    catalog = ToolCatalog(request.tools, max_tools=64, max_bytes=64 * 1024)
    # SDK serialization provides the canonical message shape; JSON key sorting detaches it from
    # incidental object key order. The step counter is deliberately excluded from the intent.
    payload = {'messages': json.loads(messages), 'tools': [dict(name=t.name,
        description=t.description, input_schema=t.input_schema) for t in catalog.descriptors]}
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    intent = dict(kind='model', provider=provider_id, model=model_id,
                  requestSha256=hashlib.sha256(encoded).hexdigest(), maxOutputTokens=max_output_tokens,
                  store=False, protocol='responses-v1')
    # Provider callback receives detached data; mutation cannot change the stored intent.
    detached = ModelStepRequest(step=request.step,
        messages=ModelMessagesTypeAdapter.validate_json(messages), tools=tuple(deepcopy(catalog.descriptors)))
    return detached, intent


class ModelReceiptAdapter:
    def __init__(self, receipts, provider, request, *, task_id, run_id, intent_digest):
        self.receipts, self.provider, self.request = receipts, provider, request
        self.scope = dict(task_id=task_id, run_id=run_id, intent_digest=intent_digest)

    async def apply(self, action_id, intent):
        if canonical(intent)[1] != self.scope['intent_digest']:
            raise WorkConflict('model_intent_changed')
        response = await self.provider(self.request)
        await self.receipts.save(action_id, **self.scope, response=response)

    async def lookup(self, action_id):
        observed = await self.receipts.load(action_id, **self.scope)
        return None if observed is None else observed.metadata


class ModelReceiptVerifier:
    def __init__(self, receipts):
        self.receipts = receipts

    async def verify(self, *, action_id, task_id, run_id, intent_digest, intent, lookup):
        observed = await self.receipts.load(action_id, task_id=task_id, run_id=run_id,
                                            intent_digest=intent_digest)
        if observed is None or lookup != observed.metadata:
            return None
        return VerifiedOutcome(action_id, task_id, run_id, intent_digest, True,
            observed.metadata['actual_tokens'], {'source': 'control-model-observation',
                'reference': action_id, 'sha256': observed.metadata['sha256']})


async def execute_model_activity(store, client, *, expected_namespace, expected_queue,
                                  expected_workflow_type, receipts, provider, request,
                                  provider_id, model_id, max_output_tokens, reserved_tokens, correction_context=None):
    """Call a model once after admission, or recover a previously admitted observation.

    The provider and its configuration are trusted composition, never Workflow/model input.
    The reservation is an explicit control policy; actual reported usage settles truth even if
    it exceeds that estimate. Unknown output/usage remains reserved, with no provider retry.
    """
    tokens(reserved_tokens)
    detached, intent = model_request(request, provider_id=provider_id, model_id=model_id,
                                     max_output_tokens=max_output_tokens)
    accepted, activity_id = await _bind_activity_identity(store, client,
        expected_namespace=expected_namespace, expected_queue=expected_queue,
        expected_workflow_type=expected_workflow_type)
    if correction_context is not None:
        from .work_corrections import CorrectionStore
        await CorrectionStore(store).read(accepted.task_id, accepted.run_id, correction_context)
        intent['correctionContext'] = correction_context
    key = operation_key(accepted, activity_id)
    digest = canonical(intent)[1]
    adapter = ModelReceiptAdapter(receipts, provider, detached, task_id=accepted.task_id,
                                  run_id=accepted.run_id, intent_digest=digest)
    verifier = ModelReceiptVerifier(receipts)
    async with store._transaction(trusted=True) as db:
        row = await (await db.execute('SELECT * FROM work_actions WHERE run_id=%s AND action_key=%s',
                                      (accepted.run_id, key))).fetchone()
    if row is not None and (row['task_id'] != accepted.task_id or row['intent_digest'] != digest
                           or row['reserved_tokens'] != reserved_tokens):
        raise WorkConflict('model_operation_changed')
    if row is not None and row['status'] in ('admitted', 'unknown', 'applied', 'not_applied'):
        # Receipt readback must remain possible after the old execution claim expires.
        outcome = await recover_action(store, task_id=accepted.task_id, run_id=accepted.run_id,
            action_id=row['id'], adapter=adapter, verifier=verifier)
    else:
        fence = await _claim_bound_activity(store, accepted, activity_id)
        outcome = await execute_action(store, task_id=accepted.task_id, run_id=accepted.run_id,
            fence=fence, action_key=key, intent=intent, reserved_tokens=reserved_tokens,
            requires_approval=False, expires_seconds=300, adapter=adapter, verifier=verifier,
            correction_context=correction_context)
    if outcome.status != 'applied':
        raise WorkConflict('model_observation_unknown')
    # Applied Actions skip adapter lookup in the common seam. Always read back the immutable
    # original response explicitly; a newly constructed callback has no in-memory response.
    observed = await receipts.load(outcome.action_id, task_id=accepted.task_id,
        run_id=accepted.run_id, intent_digest=digest)
    if observed is None:
        raise WorkConflict('model_observation_unknown')
    return observed.response
