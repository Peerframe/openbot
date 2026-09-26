"""Focused unit tests for the real OpenAI Responses ``ModelStepPort`` adapter.

Every test drives the released Pydantic AI ``OpenAIResponsesModel`` and the
official ``openai.AsyncOpenAI`` client through an in-memory ``httpx2`` transport.
No network, credential, database, Temporal service or billing path is touched:
the only seam is the trusted ``transport=`` injection, which the port normally
owns and closes.

The tests pin the reviewed boundaries: one explicit ``POST /v1/responses`` with
``store=false`` and an output cap, no SDK retry despite retry hints, refusal of
redirects, foreign endpoints, oversized bodies, wrong terminal status, missing or
inconsistent usage, hosted-tool output, undeclared or ambiguously identified tool
calls, the overall deadline, cancellation propagation, hostile ambient SDK
environment variables, explicit credentials/options, redacted provider errors and
close ownership.
"""
import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_ROOT = Path(__file__).resolve().parents[2]
# Prepend the two existing source trees; the tests perform no install and no network.
for _relative in ('apps/server-python/src', 'apps/agent-runtime-python/src'):
    _source = str(_ROOT / _relative)
    if _source not in sys.path:
        sys.path.insert(0, _source)

import httpx2  # noqa: E402
from pydantic_ai.messages import ModelRequest, ToolCallPart, UserPromptPart, ImageUrl, ToolReturnPart, ModelResponse, NativeToolCallPart, NativeToolReturnPart, UploadedFile  # noqa: E402

from openbot_agent_runtime.contracts import ModelStepRequest, ToolDescriptor  # noqa: E402

from openbot_server.work_openai_model import (  # noqa: E402
    ModelTransportError,
    OpenAIResponsesPort,
)

MODEL = 'gpt-4o-mini'
API_KEY = 'sk-unit-test-key'
CAP = 512
DEADLINE = 5.0

READ = ToolDescriptor(
    name='read_row',
    description='Read the permitted row.',
    input_schema={'type': 'object', 'properties': {'row': {'type': 'integer'}},
                  'required': ['row'], 'additionalProperties': False},
)

_MISSING = object()


def step_request(*, tools=(READ,)):
    return ModelStepRequest(
        step=1,
        messages=(ModelRequest(parts=[UserPromptPart('Do the work')]),),
        tools=tools,
    )


def text_item(text='hello'):
    return {'id': 'msg_1', 'type': 'message', 'role': 'assistant', 'status': 'completed',
            'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}


def call_item(*, name='read_row', arguments='{"row": 1}', call_id='call-1', item_id='fc_1'):
    return {'type': 'function_call', 'id': item_id, 'call_id': call_id, 'name': name,
            'arguments': arguments, 'status': 'completed'}


def usage_payload(input_tokens=3, output_tokens=2):
    return {'input_tokens': input_tokens, 'output_tokens': output_tokens,
            'total_tokens': input_tokens + output_tokens,
            'input_tokens_details': {'cached_tokens': 0},
            'output_tokens_details': {'reasoning_tokens': 0}}


def response_payload(*, output=None, usage=_MISSING, status='completed'):
    body = {
        'id': 'resp_1', 'object': 'response', 'created_at': 1.0, 'model': MODEL,
        'status': status,
        'output': [text_item()] if output is None else output,
        'error': None, 'incomplete_details': None, 'instructions': None, 'metadata': {},
        'parallel_tool_calls': False, 'temperature': None, 'tool_choice': 'auto',
        'tools': [], 'top_p': None, 'background': False,
    }
    if usage is _MISSING:
        body['usage'] = usage_payload()
    elif usage is not None:
        body['usage'] = usage
    return body


class _ChunkedStream(httpx2.AsyncByteStream):
    """A chunked body that a real HTTP transport could deliver."""

    def __init__(self, chunks):
        self._chunks = chunks

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk

    async def aclose(self):
        pass


class _ChunkedTransport(httpx2.AsyncBaseTransport):
    def __init__(self, chunks):
        self._chunks = chunks

    async def handle_async_request(self, request):
        return httpx2.Response(200, stream=_ChunkedStream(self._chunks), request=request)


class PortTestCase(unittest.IsolatedAsyncioTestCase):
    async def test_media_never_reaches_sdk_download_or_request(self):
        for content in ([ImageUrl('https://fixture.invalid/private', force_download=True)],
                        [ImageUrl('https://fixture.invalid/private')],
                        [UploadedFile('file-private', 'openai')]):
            port = self.make_port(httpx2.Response(200, json=response_payload()))
            for part in (UserPromptPart(content), ToolReturnPart('read_row', content, tool_call_id='read')):
                value = ModelStepRequest(step=1, messages=[ModelRequest([part])], tools=(READ,))
                with patch.object(port._model, 'request', side_effect=AssertionError('SDK must not be entered')) as sdk_request:
                    with self.assertRaises(ModelTransportError):
                        await port(value)
                sdk_request.assert_not_awaited()
            self.assertEqual(self.requests, [])

    async def test_native_tool_history_never_reaches_sdk(self):
        for part in (NativeToolCallPart('web_search', {}, tool_call_id='hosted', provider_name='openai'),
                     NativeToolReturnPart('web_search', 'result', tool_call_id='hosted', provider_name='openai')):
            port = self.make_port(httpx2.Response(200, json=response_payload()))
            value = ModelStepRequest(step=1, messages=[ModelResponse([part])], tools=(READ,))
            with patch.object(port._model, 'request', side_effect=AssertionError('SDK must not be entered')) as sdk_request:
                with self.assertRaises(ModelTransportError):
                    await port(value)
            sdk_request.assert_not_awaited()
            self.assertEqual(self.requests, [])

    async def test_default_transport_ignores_ambient_ca_paths(self):
        # A nonexistent CA path makes default httpx transport construction fail if it reads env.
        with patch.dict(os.environ, {'SSL_CERT_FILE': '/nonexistent-openbot-fixture-ca.pem',
                                     'SSL_CERT_DIR': '/nonexistent-openbot-fixture-ca-dir'}):
            port = OpenAIResponsesPort(model=MODEL, api_key=API_KEY)
            await port.aclose()

    async def test_incomplete_output_item_is_refused(self):
        for item in (text_item(), call_item()):
            item['status'] = 'in_progress'
            port = self.make_port(httpx2.Response(200, json=response_payload(output=[item])))
            with self.assertRaises(ModelTransportError):
                await port(step_request())

    async def test_compressed_body_is_refused_before_decoding(self):
        port = self.make_port(httpx2.Response(200, headers={'content-encoding': 'gzip'},
            stream=_ChunkedStream([b'unread compressed data'])))
        with self.assertRaises(ModelTransportError):
            await port(step_request())
        self.assertEqual(self.requests[0].headers['accept-encoding'], 'identity')

    def make_port(self, responder, **overrides):
        """Build a port over an injected transport; ``responder`` may be a response or callable."""
        self.requests = []

        def handler(request):
            self.requests.append(request)
            return responder(request) if callable(responder) else responder

        kwargs = dict(model=MODEL, api_key=API_KEY, max_output_tokens=CAP,
                      deadline_seconds=DEADLINE)
        kwargs.update(overrides)
        transport = kwargs.pop('transport', None)
        if transport is None:
            transport = httpx2.MockTransport(handler)
        port = OpenAIResponsesPort(transport=transport, **kwargs)
        self.addAsyncCleanup(port.aclose)
        return port

    # -- valid replies ---------------------------------------------------------

    async def test_text_reply_round_trips(self):
        port = self.make_port(httpx2.Response(200, json=response_payload(output=[text_item('done')])))
        result = await port(step_request())
        self.assertEqual(result.parts[0].content, 'done')
        self.assertEqual(result.usage.input_tokens, 3)
        self.assertEqual(result.usage.output_tokens, 2)
        self.assertEqual(result.provider_details['finish_reason'], 'completed')

    async def test_function_call_reply_is_preserved(self):
        port = self.make_port(httpx2.Response(200, json=response_payload(output=[call_item()])))
        result = await port(step_request())
        self.assertEqual(len(result.parts), 1)
        part = result.parts[0]
        self.assertIsInstance(part, ToolCallPart)
        self.assertEqual(part.tool_name, 'read_row')
        self.assertEqual(part.tool_call_id, 'call-1')
        self.assertEqual(part.args_as_dict(), {'row': 1})

    # -- exact request shape ---------------------------------------------------

    async def test_exact_model_tool_store_and_cap_request(self):
        port = self.make_port(httpx2.Response(200, json=response_payload()))
        await port(step_request())
        self.assertEqual(len(self.requests), 1)
        request = self.requests[0]
        self.assertEqual(str(request.url), 'https://api.openai.com/v1/responses')
        self.assertEqual(request.method, 'POST')
        self.assertEqual(request.headers['authorization'], f'Bearer {API_KEY}')
        body = json.loads(request.content)
        self.assertEqual(body['model'], MODEL)
        self.assertEqual(body['max_output_tokens'], CAP)
        self.assertIs(body['store'], False)
        self.assertIs(body['stream'], False)
        self.assertNotIn('previous_response_id', body)
        self.assertEqual(len(body['tools']), 1)
        tool = body['tools'][0]
        self.assertEqual(tool['type'], 'function')
        self.assertEqual(tool['name'], 'read_row')
        self.assertEqual(tool['parameters'], READ.input_schema)
        self.assertTrue(body['input'])

    # -- retries, redirects and terminal status --------------------------------

    async def test_429_and_500_are_one_attempt_despite_retry_hints(self):
        for status in (429, 500):
            with self.subTest(status=status):
                port = self.make_port(httpx2.Response(
                    status, json={'error': {'message': 'busy'}},
                    headers={'x-should-retry': 'true'}))
                with self.assertRaises(ModelTransportError):
                    await port(step_request())
                self.assertEqual(len(self.requests), 1)

    async def test_redirect_is_refused_without_following(self):
        port = self.make_port(httpx2.Response(
            302, headers={'location': 'https://evil.example/v1/responses'}))
        with self.assertRaises(ModelTransportError):
            await port(step_request())
        self.assertEqual(len(self.requests), 1)

    async def test_non_completed_or_failed_status_is_refused(self):
        for status in ('incomplete', 'failed', 'in_progress', 'queued'):
            with self.subTest(status=status):
                port = self.make_port(httpx2.Response(200, json=response_payload(status=status)))
                with self.assertRaises(ModelTransportError):
                    await port(step_request())

    async def test_completed_status_with_error_or_incomplete_details_is_refused(self):
        bodies = [
            response_payload() | {'error': {'code': 'server_error', 'message': 'boom'}},
            response_payload() | {'incomplete_details': {'reason': 'max_output_tokens'}},
        ]
        for body in bodies:
            with self.subTest(body=body):
                port = self.make_port(httpx2.Response(200, json=body))
                with self.assertRaises(ModelTransportError):
                    await port(step_request())

    # -- usage -----------------------------------------------------------------

    async def test_missing_or_invalid_usage_is_refused(self):
        cases = {
            'missing': response_payload(usage=None),
            'total mismatch': response_payload(
                usage={'input_tokens': 3, 'output_tokens': 2, 'total_tokens': 4}),
            'negative': response_payload(
                usage={'input_tokens': -1, 'output_tokens': 2, 'total_tokens': 1}),
            'boolean': response_payload(
                usage={'input_tokens': True, 'output_tokens': 2, 'total_tokens': 3}),
            'no total': response_payload(
                usage={'input_tokens': 3, 'output_tokens': 2}),
        }
        for label, body in cases.items():
            with self.subTest(case=label):
                port = self.make_port(httpx2.Response(200, json=body))
                with self.assertRaises(ModelTransportError):
                    await port(step_request())

    # -- body bounds, deadline and cancellation --------------------------------

    async def test_oversized_chunked_body_is_refused(self):
        transport = _ChunkedTransport([b'x' * 200, b'y' * 200])
        port = self.make_port(None, transport=transport, max_response_bytes=256)
        with self.assertRaises(ModelTransportError):
            await port(step_request())

    async def test_request_deadline_is_enforced(self):
        class SlowTransport(httpx2.AsyncBaseTransport):
            async def handle_async_request(self, request):
                await asyncio.sleep(5)
                return httpx2.Response(200, json=response_payload(), request=request)

        port = self.make_port(None, transport=SlowTransport(), deadline_seconds=0.05)
        with self.assertRaises(ModelTransportError):
            await port(step_request())

    async def test_cancellation_is_not_swallowed(self):
        started = asyncio.Event()

        class BlockingTransport(httpx2.AsyncBaseTransport):
            async def handle_async_request(self, request):
                started.set()
                await asyncio.Event().wait()

        port = self.make_port(None, transport=BlockingTransport(), deadline_seconds=30)
        task = asyncio.create_task(port(step_request()))
        await asyncio.wait_for(started.wait(), 5)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    # -- response tool safety --------------------------------------------------

    async def test_hosted_tool_output_is_refused(self):
        body = response_payload(output=[{'type': 'web_search_call', 'id': 'ws_1',
                                         'status': 'completed'}])
        port = self.make_port(httpx2.Response(200, json=body))
        with self.assertRaises(ModelTransportError):
            await port(step_request())

    async def test_undeclared_tool_name_is_refused(self):
        body = response_payload(output=[call_item(name='delete_everything')])
        port = self.make_port(httpx2.Response(200, json=body))
        with self.assertRaises(ModelTransportError):
            await port(step_request())

    async def test_blank_or_duplicate_call_ids_are_refused(self):
        cases = {
            'blank': [call_item(call_id='')],
            'duplicate': [call_item(call_id='call-1', item_id='fc_1'),
                          call_item(call_id='call-1', item_id='fc_2')],
        }
        for label, output in cases.items():
            with self.subTest(case=label):
                port = self.make_port(httpx2.Response(200, json=response_payload(output=output)))
                with self.assertRaises(ModelTransportError):
                    await port(step_request())

    async def test_message_count_limit_is_refused(self):
        port = self.make_port(httpx2.Response(200, json=response_payload()))
        messages = tuple(ModelRequest(parts=[UserPromptPart('x')]) for _ in range(257))
        with self.assertRaises(ModelTransportError):
            await port(ModelStepRequest(step=1, messages=messages, tools=(READ,)))

    async def test_message_byte_limit_is_refused(self):
        port = self.make_port(httpx2.Response(200, json=response_payload()))
        messages = (ModelRequest(parts=[UserPromptPart('x' * 300000)]),)
        with self.assertRaises(ModelTransportError):
            await port(ModelStepRequest(step=1, messages=messages, tools=(READ,)))

    # -- credentials, options and redaction ------------------------------------

    async def test_auth_endpoint_and_options_are_explicit(self):
        port = self.make_port(httpx2.Response(200, json=response_payload()))
        client = port._client
        self.assertEqual(client.api_key, API_KEY)
        self.assertEqual(str(client.base_url).rstrip('/'), 'https://api.openai.com/v1')
        self.assertEqual(client.max_retries, 0)
        self.assertEqual(client.organization, '')
        self.assertEqual(client.project, '')
        self.assertEqual(client.admin_api_key, '')
        self.assertEqual(client.webhook_secret, '')
        self.assertIs(port._http_client.follow_redirects, False)
        self.assertNotIn(API_KEY, repr(port))

    async def test_inherited_endpoint_and_credentials_are_ignored(self):
        with patch.dict(os.environ, {
            'OPENAI_BASE_URL': 'https://evil.example/v1',
            'OPENAI_API_KEY': 'sk-inherited-evil',
            'OPENAI_ORG_ID': 'evil-org',
            'OPENAI_PROJECT_ID': 'evil-project',
            'OPENAI_ADMIN_KEY': 'sk-admin-evil',
            'OPENAI_WEBHOOK_SECRET': 'whsec-evil',
        }):
            port = self.make_port(httpx2.Response(200, json=response_payload()))
            client = port._client
            self.assertEqual(client.api_key, API_KEY)
            self.assertEqual(str(client.base_url).rstrip('/'), 'https://api.openai.com/v1')
            self.assertEqual(client.organization, '')
            self.assertEqual(client.project, '')
            self.assertEqual(client.admin_api_key, '')
            self.assertEqual(client.webhook_secret, '')

    async def test_foreign_endpoint_and_method_are_refused(self):
        port = self.make_port(httpx2.Response(200, json=response_payload()))
        with self.assertRaises(ModelTransportError):
            await port._http_client.post('https://evil.example/v1/responses', json={})
        with self.assertRaises(ModelTransportError):
            await port._http_client.get('https://api.openai.com/v1/responses')
        with self.assertRaises(ModelTransportError):
            await port._http_client.post('https://api.openai.com/v1/chat/completions', json={})

    async def test_callback_errors_are_redacted(self):
        body = {'error': {'message': f'bad key {API_KEY}', 'type': 'invalid_request_error'}}
        port = self.make_port(httpx2.Response(401, json=body))
        with self.assertRaises(ModelTransportError) as raised:
            await port(step_request())
        text = str(raised.exception)
        self.assertNotIn(API_KEY, text)
        self.assertNotIn('bad key', text)
        self.assertIsNone(raised.exception.__cause__)

    async def test_close_ownership_closes_injected_transport(self):
        class ClosingTransport(httpx2.MockTransport):
            def __init__(self):
                super().__init__(lambda request: httpx2.Response(200, json=response_payload()))
                self.closed = False

            async def aclose(self):
                self.closed = True
                await super().aclose()

        transport = ClosingTransport()
        port = self.make_port(None, transport=transport)
        await port.aclose()
        self.assertTrue(transport.closed)
        # A second close is safe and still owned by the port.
        await port.aclose()
        self.assertTrue(transport.closed)


class ConstructorTests(unittest.TestCase):
    def build(self, **overrides):
        kwargs = dict(model=MODEL, api_key=API_KEY)
        kwargs.update(overrides)
        return OpenAIResponsesPort(**kwargs)

    def test_hostile_custom_headers_environment_is_refused(self):
        with patch.dict(os.environ, {'OPENAI_CUSTOM_HEADERS': 'X-Evil: topsecret'}):
            with self.assertRaises(ModelTransportError) as raised:
                self.build()
        self.assertNotIn('topsecret', str(raised.exception))
        self.assertNotIn('X-Evil', str(raised.exception))

    def test_openai_log_environment_is_refused(self):
        with patch.dict(os.environ, {'OPENAI_LOG': 'debug'}):
            with self.assertRaises(ModelTransportError):
                self.build()

    def test_invalid_configuration_is_refused(self):
        cases = [
            {'model': ''},
            {'model': 'x' * 200},
            {'model': 'bad\nmodel'},
            {'model': None},
            {'api_key': ''},
            {'api_key': 'line\rbreak'},
            {'api_key': 'line\nbreak'},
            {'api_key': 1},
            {'max_output_tokens': 0},
            {'max_output_tokens': True},
            {'max_output_tokens': 65537},
            {'max_output_tokens': 4096.0},
            {'max_response_bytes': 0},
            {'max_response_bytes': 2 * 1024 * 1024 + 1},
            {'deadline_seconds': 0},
            {'deadline_seconds': -1},
            {'deadline_seconds': float('inf')},
            {'deadline_seconds': float('nan')},
            {'deadline_seconds': True},
            {'deadline_seconds': 121},
            {'transport': object()},
        ]
        for overrides in cases:
            with self.subTest(overrides=overrides):
                with self.assertRaises(ModelTransportError):
                    self.build(**overrides)


if __name__ == '__main__':
    unittest.main()
