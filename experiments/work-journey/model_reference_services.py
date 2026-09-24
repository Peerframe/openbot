"""Actual SDK transport with synthetic responses; counts every request outside the Worker.

Only fault barriers and the HTTP responder are fixtures. Receipt, Action authority and recovery
are product code. No account, key, live model quality or billing is exercised.
"""
import asyncio
import json
from pathlib import Path
import secrets

import httpx2
from pydantic_ai.messages import ToolCallPart, ToolReturnPart

import control
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_model_activity import execute_model_activity
from openbot_server.work_model_receipts import ModelReceipts
from openbot_server.work_openai_model import OpenAIResponsesPort

MODEL = 'gpt-4o-mini'


class PausedReceipts(ModelReceipts):
    async def save(self, action_id, **kwargs):
        metadata = await super().save(action_id, **kwargs)
        if any(isinstance(p, ToolCallPart) for p in kwargs['response'].parts):
            directory = Path(control.settings()['directory'])
            (directory / ('model-receipt-' + kwargs['task_id'])).touch()
            async with asyncio.timeout(45):
                while not (directory / 'release-model').exists():
                    await asyncio.sleep(.05)
        return metadata


def model_port(context, store, client, scope):
    cfg = control.settings()
    receipts = PausedReceipts(store, LocalWorkFiles(cfg['model_receipt_root']))

    async def provider(request):
        final = any(isinstance(p, ToolReturnPart) for m in request.messages for p in m.parts)
        async def respond(http_request):
            body = json.loads(http_request.content)
            assert body['model'] == MODEL and body['store'] is False and body['max_output_tokens'] == 4
            # Random measurement identity deliberately prevents fixture deduplication from hiding
            # a repeated model request. Persistent service counts survive the owned Worker crash.
            await asyncio.to_thread(control.http, '/operations', {'actionId': secrets.token_hex(16),
                'taskId': context.task_id, 'intent': {'kind': 'model', 'stage': 'final' if final else 'plan'}})
            output = [{'id': 'msg-final', 'type': 'message', 'role': 'assistant', 'status': 'completed',
                'content': [{'type': 'output_text', 'text': context.objective + ': verified', 'annotations': []}]}] if final else [
                {'type': 'function_call', 'id': 'fc-read', 'call_id': 'read-fixture', 'name': 'read_observation',
                 'arguments': json.dumps({'objective': context.objective}), 'status': 'completed'}]
            return httpx2.Response(200, json={'id': 'resp-final' if final else 'resp-plan',
                'object': 'response', 'created_at': 1.0, 'model': MODEL, 'status': 'completed',
                'output': output, 'error': None, 'incomplete_details': None,
                'usage': {'input_tokens': 2, 'output_tokens': 1, 'total_tokens': 3,
                          'input_tokens_details': {'cached_tokens': 0},
                          'output_tokens_details': {'reasoning_tokens': 0}}})
        port = OpenAIResponsesPort(model=MODEL, api_key='synthetic-fixture-only', max_output_tokens=4,
                                   transport=httpx2.MockTransport(respond))
        try:
            return await port(request)
        finally:
            await port.aclose()

    async def model(request):
        return await execute_model_activity(store, client, **scope, receipts=receipts, provider=provider,
            request=request, provider_id='openai-responses', model_id=MODEL,
            max_output_tokens=4, reserved_tokens=6)
    return model
