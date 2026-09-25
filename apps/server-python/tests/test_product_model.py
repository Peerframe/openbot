"""Actual released SDK requests against synthetic transports; no provider account or billing."""
import asyncio
from copy import deepcopy
import json
from pathlib import Path
import sys
from unittest.mock import AsyncMock

import httpx2
import pytest
pytest.importorskip('pydantic_ai', reason='Product Worker SDK profile is required')
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'agent-runtime-python/src'))
from pydantic_ai.messages import (
    BinaryContent, ModelRequest, ModelResponse, NativeToolCallPart, TextPart, ThinkingPart,
    ToolCallPart, ToolReturnPart, UserPromptPart,
)
from openbot_agent_runtime.contracts import ModelStepRequest, ToolDescriptor
from openbot_server.model_presets import model_provider_presets
from openbot_server.product_model import ProductModelPort, ProductModelError

KEY = "synthetic-never-real-model-key"
PRESETS = model_provider_presets()
TOOL = ToolDescriptor(name="fixture_tool", description="A scoped fixture.", input_schema={
    "type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"], "additionalProperties": False,
})


def config(provider, endpoint=None):
    preset = next(p for p in PRESETS if p["id"] == provider)
    model = (preset["suggestedModels"] or ["fixture/model" if provider == "openrouter" else "fixture-model"])[0]
    return {"provider": provider, "model": model, "apiKey": KEY,
            "baseUrl": endpoint or preset["endpoints"][0]["baseUrl"],
            "revision": "12345678-1234-4234-8234-123456789012", "agentEnabled": True,
            "agentEnabledAt": "2026-09-24T00:00:00.000Z"}


def request(messages=None, tools=()):
    return ModelStepRequest(step=1, messages=tuple(messages or [ModelRequest(parts=[UserPromptPart("Synthetic request")])]), tools=tools)


def reply(provider, *, tools=False, thinking=False):
    model = config(provider)["model"]
    if provider == "openai":
        output = []
        if thinking:
            output.append({"type": "reasoning", "id": "reason_fixture", "summary": [{"type": "summary_text", "text": "private-reasoning"}], "encrypted_content": "encrypted-private-reasoning"})
        output.append({"id": "message_fixture", "type": "message", "status": "completed", "role": "assistant",
                       "content": [{"type": "output_text", "text": "Visible answer", "annotations": []}]})
        if tools:
            output.append({"id": "function_fixture", "type": "function_call", "status": "completed", "call_id": "call_fixture", "name": TOOL.name, "arguments": '{"value":"fixture"}'})
        return {"id": "response_fixture", "object": "response", "created_at": 1, "model": model, "status": "completed", "output": output,
                "usage": {"input_tokens": 12, "output_tokens": 7, "total_tokens": 19,
                          "input_tokens_details": {"cached_tokens": 2}, "output_tokens_details": {"reasoning_tokens": 3}}}
    if provider == "anthropic":
        content = []
        if thinking:
            content.extend([{"type": "thinking", "thinking": "private-reasoning", "signature": "signature_fixture"},
                            {"type": "redacted_thinking", "data": "redacted_signature_fixture"}])
        content.append({"type": "text", "text": "Visible answer"})
        if tools:
            content.append({"type": "tool_use", "id": "call_fixture", "name": TOOL.name, "input": {"value": "fixture"}})
        return {"id": "message_fixture", "type": "message", "model": model, "role": "assistant", "content": content,
                "stop_reason": "tool_use" if tools else "end_turn", "stop_sequence": None,
                "usage": {"input_tokens": 9, "output_tokens": 7, "cache_read_input_tokens": 2, "cache_creation_input_tokens": 1}}
    message = {"role": "assistant", "content": "Visible answer"}
    if thinking:
        if provider in {"openrouter", "minimax"}:
            message["reasoning_details"] = [{"type": "reasoning.text", "text": "private-reasoning", "signature": "signature_fixture", "format": "unknown", "index": 0}]
        else:
            message["reasoning_content"] = "private-reasoning"
    if tools:
        message["tool_calls"] = [{"id": "call_fixture", "type": "function", "function": {"name": TOOL.name, "arguments": '{"value":"fixture"}'}}]
    value = {"id": "chat_fixture", "object": "chat.completion", "created": 1, "model": model,
             "choices": [{"index": 0, "finish_reason": "tool_calls" if tools else "stop", "message": message}],
             "usage": {"prompt_tokens": 12, "completion_tokens": 7, "total_tokens": 19,
                       "prompt_tokens_details": {"cached_tokens": 2}, "completion_tokens_details": {"reasoning_tokens": 3}}}
    if provider == "openrouter":
        value["provider"] = "synthetic-downstream"
    return value


@pytest.mark.parametrize("provider,endpoint", [(p["id"], e["baseUrl"]) for p in PRESETS for e in p["endpoints"]])
def test_all_eleven_providers_all_regions_execute_released_sdk(provider, endpoint):
    async def check():
        calls = []
        def handler(req):
            calls.append(req)
            return httpx2.Response(200, json=reply(provider))
        port = ProductModelPort(config(provider, endpoint), transport=httpx2.MockTransport(handler))
        try:
            result = await port(request())
            assert result.text == "Visible answer" and result.usage.input_tokens == 12 and result.usage.output_tokens == 7
            assert result.provider_name == provider and result.provider_url == endpoint
            assert port.provider_id == provider and port.model_name == config(provider)["model"]
            protocol = "responses-v1" if provider == "openai" else "anthropic-messages-v1" if provider == "anthropic" else "chat-completions-v1"
            assert port.protocol == protocol and port.max_output_tokens == 4096
            assert len(calls) == 1
            sent = calls[0]
            suffix = "/responses" if provider == "openai" else "/v1/messages" if provider == "anthropic" else "/chat/completions"
            assert sent.method == "POST" and str(sent.url) == endpoint + suffix
            body = json.loads(sent.content)
            assert body["model"] == port.model_name and body["stream"] is False
            assert body["max_output_tokens" if provider == "openai" else "max_tokens"] == 4096
            assert not any(key.lower().startswith("x-stainless") for key in sent.headers)
            assert sent.headers["accept-encoding"] == "identity"
            assert not any(key in body for key in ("previous_response_id", "background", "plugins", "mcp_servers", "models"))
            if provider == "anthropic":
                assert "authorization" not in sent.headers
                assert sent.headers["x-api-key"] == KEY and sent.headers["anthropic-version"] == "2023-06-01"
                assert result.usage.cache_read_tokens == 2 and result.usage.cache_write_tokens == 1
            else:
                assert "x-api-key" not in sent.headers and sent.headers["authorization"] == f"Bearer {KEY}"
                assert result.usage.details["reasoning_tokens"] == 3
            if provider == "openai":
                assert body["store"] is False
            elif provider == "openrouter":
                assert body["provider"] == {"allow_fallbacks": False, "require_parameters": True, "data_collection": "deny"}
                assert result.provider_details["downstream_provider"] == "synthetic-downstream"
            elif provider == "deepseek":
                assert body["thinking"] == {"type": "disabled"}
            elif provider == "minimax":
                assert body["reasoning_split"] is True and "downstream_provider" not in result.provider_details
            assert KEY not in repr(port)
        finally:
            await port.aclose()
        await port.aclose()
        with pytest.raises(ProductModelError):
            await port(request())
    asyncio.run(check())


@pytest.mark.parametrize("provider", [p["id"] for p in PRESETS])
def test_tools_reasoning_usage_and_continuation_use_sdk_conversion(provider):
    async def check():
        calls = []
        def handler(req):
            calls.append(json.loads(req.content))
            return httpx2.Response(200, json=reply(provider, tools=len(calls) == 1, thinking=len(calls) == 1))
        async with ProductModelPort(config(provider), transport=httpx2.MockTransport(handler)) as port:
            first = request(tools=(TOOL,))
            result = await port(first)
            assert result.usage.input_tokens == 12 and result.usage.output_tokens == 7
            assert result.text == "Visible answer" and "private-reasoning" not in result.text
            assert any(isinstance(p, ThinkingPart) for p in result.parts)
            assert [p.tool_name for p in result.parts if isinstance(p, ToolCallPart)] == [TOOL.name]
            assert [p.tool_call_id for p in result.parts if isinstance(p, ToolCallPart)] == ["call_fixture"]
            # The released Responses adapter maps completed -> stop even with function items;
            # tool parts, rather than an invented finish reason, retain the call semantics.
            assert result.finish_reason == ("stop" if provider == "openai" else "tool_call")
            second = request(messages=[*first.messages, result, ModelRequest(parts=[ToolReturnPart(TOOL.name, {"done": True}, tool_call_id="call_fixture")])], tools=(TOOL,))
            final = await port(second)
            assert final.text == "Visible answer" and len(calls) == 2
            sent = json.dumps(calls[1])
            assert "call_fixture" in sent and "done" in sent
            assert "private-reasoning" in sent
            if provider == "openai":
                assert "encrypted-private-reasoning" in sent
            if provider in {"anthropic", "openrouter", "minimax"}:
                assert "signature_fixture" in sent
    asyncio.run(check())


@pytest.mark.parametrize("provider", ["openrouter", "minimax"])
def test_plain_reasoning_survives_router_codec_roundtrip(provider):
    async def check():
        payload = reply(provider, tools=True)
        payload["choices"][0]["message"]["reasoning_content"] = "plain-private-reasoning"
        calls = []
        def handler(req):
            calls.append(json.loads(req.content))
            return httpx2.Response(200, json=payload if len(calls) == 1 else reply(provider))
        async with ProductModelPort(config(provider), transport=httpx2.MockTransport(handler)) as port:
            first = request(tools=(TOOL,))
            result = await port(first)
            await port(request(messages=[*first.messages, result, ModelRequest(parts=[ToolReturnPart(TOOL.name, "done", tool_call_id="call_fixture")])], tools=(TOOL,)))
            assert "plain-private-reasoning" in json.dumps(calls[1])
    asyncio.run(check())


@pytest.mark.parametrize("provider,status,code", [(p, s, c) for p in ("openai", "anthropic", "moonshot") for s, c in (
    (401, "model_credentials"), (403, "model_credentials"), (429, "model_rate_limit"),
    (302, "model_unavailable"), (400, "model_unavailable"), (500, "model_unavailable"),
)])
def test_no_retries_redirects_or_error_body_leaks(provider, status, code):
    async def check():
        calls = []
        def handler(req):
            calls.append(req)
            return httpx2.Response(status, text=f"private-upstream-body {KEY}", headers={"location": "https://untrusted.invalid"})
        async with ProductModelPort(config(provider), transport=httpx2.MockTransport(handler)) as port:
            with pytest.raises(ProductModelError) as error:
                await port(request())
            assert error.value.code == code and str(error.value) == code
            assert error.value.__cause__ is None
            assert (error.value.__suppress_context__ or error.value.__context__ is None) and len(calls) == 1
    asyncio.run(check())


@pytest.mark.parametrize("provider,fault", [(p, f) for p in ("openai", "anthropic", "moonshot") for f in (
    "missing_usage", "invalid_usage", "incomplete", "native_tool", "duplicate_tool", "undeclared_tool", "invalid_args", "empty",
)])
def test_unsettleable_responses_are_refused(provider, fault):
    async def check():
        payload = reply(provider, tools=True)
        if fault == "missing_usage":
            payload.pop("usage")
        elif fault == "invalid_usage":
            payload["usage"]["input_tokens" if provider in {"openai", "anthropic"} else "prompt_tokens"] = True
        elif provider == "openai":
            if fault == "incomplete":
                payload["status"] = "incomplete"
            elif fault == "native_tool":
                payload["output"].append({"type": "web_search_call", "status": "completed"})
            elif fault == "duplicate_tool":
                payload["output"].append(deepcopy(payload["output"][-1]))
            elif fault == "undeclared_tool":
                payload["output"][-1]["name"] = "unoffered_tool"
            elif fault == "invalid_args":
                payload["output"][-1]["arguments"] = "[]"
            else:
                payload["output"] = []
        elif provider == "anthropic":
            if fault == "incomplete":
                payload["stop_reason"] = "max_tokens"
            elif fault == "native_tool":
                payload["content"].append({"type": "server_tool_use", "id": "native", "name": "web_search", "input": {}})
            elif fault == "duplicate_tool":
                payload["content"].append(deepcopy(payload["content"][-1]))
            elif fault == "undeclared_tool":
                payload["content"][-1]["name"] = "unoffered_tool"
            elif fault == "invalid_args":
                payload["content"][-1]["input"] = []
            else:
                payload["content"] = []
        else:
            choice = payload["choices"][0]
            if fault == "incomplete":
                choice["finish_reason"] = None
            elif fault == "native_tool":
                choice["message"]["tool_calls"][0]["type"] = "web_search"
            elif fault == "duplicate_tool":
                choice["message"]["tool_calls"].append(deepcopy(choice["message"]["tool_calls"][0]))
            elif fault == "undeclared_tool":
                choice["message"]["tool_calls"][0]["function"]["name"] = "unoffered_tool"
            elif fault == "invalid_args":
                choice["message"]["tool_calls"][0]["function"]["arguments"] = "[]"
            else:
                choice["message"] = {"role": "assistant", "content": ""}
                choice["finish_reason"] = "stop"
        async with ProductModelPort(config(provider), transport=httpx2.MockTransport(lambda req: httpx2.Response(200, json=payload))) as port:
            with pytest.raises(ProductModelError):
                await port(request(tools=(TOOL,)))
    asyncio.run(check())


def test_minimax_mixed_private_reasoning_is_never_published():
    async def check():
        payload = reply("minimax")
        payload["choices"][0]["message"]["content"] = "<think>private</think>visible"
        async with ProductModelPort(config("minimax"), transport=httpx2.MockTransport(lambda req: httpx2.Response(200, json=payload))) as port:
            with pytest.raises(ProductModelError):
                await port(request())
    asyncio.run(check())


class Chunks(httpx2.AsyncByteStream):
    def __init__(self, parts, delay=0):
        self.parts, self.delay, self.closed, self.reads = parts, delay, False, 0
    async def __aiter__(self):
        for part in self.parts:
            await asyncio.sleep(self.delay)
            self.reads += 1
            yield part
    async def aclose(self):
        self.closed = True


def test_response_byte_deadline_and_cancellation_limits_close_stream():
    async def check():
        stream = Chunks([b"x" * 1024, b"x", b"unread"])
        transport = httpx2.MockTransport(lambda req: httpx2.Response(200, headers={"content-type": "application/json"}, stream=stream))
        async with ProductModelPort(config("openai"), max_response_bytes=1024, transport=transport) as port:
            with pytest.raises(ProductModelError, match="task_limit"):
                await port(request())
        assert stream.closed and stream.reads == 2
        stream = Chunks([b"{}"], delay=0.1)
        async with ProductModelPort(config("anthropic"), deadline_seconds=0.02, transport=transport) as port:
            with pytest.raises(ProductModelError, match="task_timeout"):
                await port(request())
        assert stream.closed
        stream = Chunks([b"{}"], delay=10)
        started = asyncio.Event()
        def handler(req):
            started.set()
            return httpx2.Response(200, headers={"content-type": "application/json"}, stream=stream)
        async with ProductModelPort(config("moonshot"), transport=httpx2.MockTransport(handler)) as port:
            task = asyncio.create_task(port(request()))
            await started.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert stream.closed
    asyncio.run(check())


@pytest.mark.parametrize("field,value", [
    ("baseUrl", "https://untrusted.invalid/v1"), ("apiKey", ""), ("model", "https://bad.invalid"),
    ("provider", "unknown"), ("agentEnabled", False), ("agentEnabledAt", None), ("extra_body", {"provider": "other"}),
])
def test_bad_configuration_never_enters_sdk(field, value):
    with pytest.raises(ProductModelError, match="model_configuration"):
        ProductModelPort({**config("openai"), field: value})


@pytest.mark.parametrize("messages", [
    [ModelRequest(parts=[UserPromptPart([BinaryContent(data=b"fixture", media_type="image/png")])])],
    [ModelResponse(parts=[NativeToolCallPart(tool_name="web_search", args={}, tool_call_id="native")])],
    [ModelRequest(parts=[UserPromptPart("x" * (256 * 1024))])],
])
def test_unbounded_media_and_native_history_cannot_enter_sdk(messages):
    async def check():
        async with ProductModelPort(config("openai"), transport=httpx2.MockTransport(lambda req: pytest.fail("network must not run"))) as port:
            original = port._model.request
            port._model.request = AsyncMock(wraps=original)
            with pytest.raises(ProductModelError, match="model_request_invalid"):
                await port(request(messages=messages))
            port._model.request.assert_not_awaited()
    asyncio.run(check())


@pytest.mark.parametrize("name", ["OPENAI_CUSTOM_HEADERS", "OPENAI_LOG", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_LOG"])
def test_sdk_environment_side_channels_are_refused(monkeypatch, name):
    monkeypatch.setenv(name, f"secret={KEY}")
    with pytest.raises(ProductModelError) as error:
        ProductModelPort(config("openai"))
    assert KEY not in str(error.value)


@pytest.mark.parametrize("provider", ["openai", "anthropic", "openrouter", "moonshot"])
def test_explicit_credentials_endpoints_no_environment_attribution(monkeypatch, provider):
    async def check():
        for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "MOONSHOTAI_API_KEY"):
            monkeypatch.setenv(key, "ambient-not-authorized")
        for key in ("OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "HTTP_PROXY", "HTTPS_PROXY"):
            monkeypatch.setenv(key, "http://127.0.0.1:1")
        monkeypatch.setenv("OPENROUTER_APP_TITLE", "ambient-attribution")
        monkeypatch.setenv("OPENROUTER_APP_URL", "https://ambient.invalid")
        def handler(req):
            assert "ambient" not in str(req.headers) and "ambient" not in str(req.url)
            return httpx2.Response(200, json=reply(provider))
        async with ProductModelPort(config(provider), transport=httpx2.MockTransport(handler)) as port:
            await port(request())
    asyncio.run(check())


def test_transport_enforces_one_send_even_if_adapter_attempts_recovery():
    async def check():
        calls = []
        def handler(req):
            calls.append(req)
            return httpx2.Response(200, json=reply("anthropic"))
        async with ProductModelPort(config("anthropic"), transport=httpx2.MockTransport(handler)) as port:
            original = port._model.request
            async def attempts(*args, **kwargs):
                await original(*args, **kwargs)
                return await original(*args, **kwargs)
            port._model.request = attempts
            with pytest.raises(ProductModelError):
                await port(request())
        assert len(calls) == 1
    asyncio.run(check())


def test_concurrent_steps_have_separate_request_leases():
    async def check():
        calls = []
        both = asyncio.Event()
        async def handler(req):
            calls.append(req)
            if len(calls) == 2:
                both.set()
            await both.wait()
            return httpx2.Response(200, json=reply("openai"))
        async with ProductModelPort(config("openai"), transport=httpx2.MockTransport(handler)) as port:
            responses = await asyncio.gather(port(request()), port(request()))
        assert len(calls) == 2 and all(r.usage.input_tokens == 12 for r in responses)
    asyncio.run(check())


@pytest.mark.parametrize("fault", ["compressed", "mime", "length", "tokens"])
def test_hostile_response_encoding_lengths_and_usage_detail(fault):
    async def check():
        payload = reply("moonshot")
        if fault == "tokens":
            payload["usage"]["completion_tokens_details"]["reasoning_tokens"] = True
        content = json.dumps(payload).encode()
        headers = {"content-type": "application/json"}
        if fault == "compressed":
            headers["content-encoding"] = "gzip"
        elif fault == "mime":
            headers["content-type"] = "text/event-stream"
        elif fault == "length":
            headers["content-length"] = str(2 * 1024 * 1024 + 1)
        stream = Chunks([content])
        async with ProductModelPort(config("moonshot"), transport=httpx2.MockTransport(lambda req: httpx2.Response(200, headers=headers, stream=stream))) as port:
            with pytest.raises(ProductModelError):
                await port(request())
        assert stream.closed
        if fault != "tokens":
            assert stream.reads == 0
    asyncio.run(check())


def test_real_localhost_request_uses_pinned_http_transport(monkeypatch):
    async def check():
        received = []
        content = json.dumps(reply("anthropic")).encode()
        async def handler(reader, writer):
            header = await reader.readuntil(b"\r\n\r\n")
            length = int(next(line.split(b":", 1)[1] for line in header.split(b"\r\n") if line.lower().startswith(b"content-length:")))
            received.append((header, await reader.readexactly(length)))
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n")
            for part in (content[:len(content)//2], content[len(content)//2:]):
                writer.write(f"{len(part):x}\r\n".encode() + part + b"\r\n")
                await writer.drain()
            writer.write(b"0\r\n\r\n")
            await writer.drain()
            writer.close()
            await writer.wait_closed()
        server = await asyncio.start_server(handler, "127.0.0.1", 0)
        port_number = server.sockets[0].getsockname()[1]
        class LocalTransport(httpx2.AsyncBaseTransport):
            def __init__(self):
                self.inner = httpx2.AsyncHTTPTransport(trust_env=False, retries=0)
            async def handle_async_request(self, req):
                assert str(req.url) == "https://api.anthropic.com/v1/messages"
                req.url = req.url.copy_with(scheme="http", host="127.0.0.1", port=port_number)
                return await self.inner.handle_async_request(req)
            async def aclose(self):
                await self.inner.aclose()
        monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1")
        try:
            async with ProductModelPort(config("anthropic"), transport=LocalTransport()) as port:
                result = await port(request(tools=(TOOL,)))
            assert result.text == "Visible answer" and len(received) == 1
            assert b"POST /v1/messages HTTP/1.1" in received[0][0]
            assert b"x-api-key: " + KEY.encode() in received[0][0]
            assert json.loads(received[0][1])["tools"][0]["name"] == TOOL.name
        finally:
            server.close()
            await server.wait_closed()
    asyncio.run(check())
