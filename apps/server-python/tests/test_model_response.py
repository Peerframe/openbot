from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import httpx2
import pytest

from openbot_server.model_response import ProductModelError, decode_model_json, read_model_response
from openbot_server.work_openai_model import ModelTransportError

URL = "https://model.invalid/v1/chat/completions"
JSON_HEADERS = {"content-type": "application/json"}
UNSET = object()


class TrackedStream(httpx2.AsyncByteStream):
    def __init__(self, *chunks: bytes, hang: asyncio.Event | None = None) -> None:
        self.chunks = chunks
        self.hang = hang
        self.pulled = 0
        self.closed = 0

    async def __aiter__(self):
        for chunk in self.chunks:
            self.pulled += 1
            yield chunk
        if self.hang is not None:
            self.hang.set()
            await asyncio.Event().wait()

    async def aclose(self) -> None:
        self.closed += 1


def make(stream: TrackedStream, status: int = 200, headers: dict[str, str] | None = None):
    request = httpx2.Request("POST", URL)
    response = httpx2.Response(status, headers=JSON_HEADERS if headers is None else headers,
                               stream=stream, request=request)
    return response, request


def run(response, request, *, maximum=64, provider="openai", attempt=None, validate=None):
    attempt = SimpleNamespace(downstream_reported=UNSET) if attempt is None else attempt
    seen: list[Any] = []
    def record(value: Any) -> None:
        seen.append(json.dumps(value))
    async def body():
        out = await read_model_response(response, request, maximum=maximum, provider=provider,
                                        attempt=attempt, validate_wire=validate or record)
        return out, await out.aread()
    out, content = asyncio.run(body())
    return SimpleNamespace(out=out, content=content, attempt=attempt, seen=seen)


def test_error_class_parent_and_default_code():
    error = ProductModelError()
    assert isinstance(error, ModelTransportError)
    assert error.code == "model_unavailable"
    assert str(ProductModelError("task_limit")) == "task_limit"


def test_decode_model_json_is_strict():
    assert decode_model_json(b'{"a":[1,2.5,null]}') == {"a": [1, 2.5, None]}
    for bad in (b'{"a":NaN}', b'{"a":Infinity}', b'{"a":-Infinity}', b"{", b"\xff"):
        with pytest.raises(ValueError):
            decode_model_json(bad)


def test_streamed_success_returns_identical_bytes_and_closes():
    body = b'{"id": "x",  "choices": []}'
    stream = TrackedStream(body[:9], body[9:])
    response, request = make(stream)
    result = run(response, request)
    assert result.content == body
    assert result.out.status_code == 200
    assert result.out.request is request
    assert dict(result.out.headers) == JSON_HEADERS
    assert result.seen == [json.dumps({"id": "x", "choices": []})]
    assert result.attempt.downstream_reported is UNSET
    assert stream.pulled == 2 and stream.closed == 1 and response.is_closed


def test_prebuffered_content_is_used_without_reiteration():
    body = b'{"ok":true}'
    stream = TrackedStream(body)
    response, request = make(stream)
    asyncio.run(response.aread())
    assert response.is_stream_consumed
    result = run(response, request, maximum=len(body))
    assert result.content == body
    assert stream.pulled == 1 and response.is_closed


def test_prebuffered_content_over_limit_is_refused():
    body = b'{"ok":true}'
    response, request = make(TrackedStream(body))
    asyncio.run(response.aread())
    with pytest.raises(ProductModelError) as info:
        run(response, request, maximum=len(body) - 1)
    assert info.value.code == "task_limit"
    assert response.is_closed


def test_exact_boundary_is_accepted():
    body = b'{"a":"xxxx"}'
    stream = TrackedStream(body[:5], body[5:])
    response, request = make(stream)
    assert run(response, request, maximum=len(body)).content == body
    assert stream.closed == 1


def test_stream_over_limit_stops_without_reading_further():
    first, second, third = b'{"a":', b'"xxxxx"', b"}"
    stream = TrackedStream(first, second, third)
    response, request = make(stream)
    with pytest.raises(ProductModelError) as info:
        run(response, request, maximum=len(first) + len(second) - 1)
    assert info.value.code == "task_limit"
    assert stream.pulled == 2 and stream.closed == 1 and response.is_closed


@pytest.mark.parametrize(("status", "headers", "code"), [
    (401, JSON_HEADERS, "model_credentials"),
    (403, JSON_HEADERS, "model_credentials"),
    (401, {"content-type": "text/plain"}, "model_credentials"),
    (429, JSON_HEADERS, "model_rate_limit"),
    (500, JSON_HEADERS, "model_unavailable"),
    (302, JSON_HEADERS, "model_unavailable"),
    (200, {"content-type": "text/plain"}, "model_unavailable"),
    (200, {}, "model_unavailable"),
    (200, {"content-type": "application/json", "content-encoding": "gzip"}, "model_unavailable"),
    (200, {"content-type": "application/json", "content-length": "abc"}, "task_limit"),
    (200, {"content-type": "application/json", "content-length": "-1"}, "task_limit"),
    (200, {"content-type": "application/json", "content-length": "+1"}, "task_limit"),
    (200, {"content-type": "application/json", "content-length": "65"}, "task_limit"),
])
def test_early_rejection_reads_nothing_and_closes(status, headers, code):
    stream = TrackedStream(b"{}")
    response, request = make(stream, status, headers)
    with pytest.raises(ProductModelError) as info:
        run(response, request, maximum=64)
    assert info.value.code == code
    assert stream.pulled == 0 and stream.closed == 1 and response.is_closed


def test_header_matching_is_case_insensitive_and_length_at_limit_passes():
    body = b"{}"
    headers = {"content-type": "Application/JSON; charset=utf-8", "content-encoding": "IDENTITY",
               "content-length": str(len(body))}
    response, request = make(TrackedStream(body), 200, headers)
    assert run(response, request, maximum=len(body)).content == body


@pytest.mark.parametrize("body", [b"{", b'{"a":NaN}', b'{"a":Infinity}', b"\xff"])
def test_invalid_json_propagates_and_closes(body):
    stream = TrackedStream(body)
    response, request = make(stream)
    with pytest.raises(ValueError) as info:
        run(response, request)
    assert not isinstance(info.value, ProductModelError)
    assert stream.closed == 1 and response.is_closed


def test_validator_exception_is_preserved_and_response_closed():
    class Boom(Exception):
        pass
    boom = Boom()
    def validate(_: Any) -> None:
        raise boom
    stream = TrackedStream(b'{"provider":"x"}')
    response, request = make(stream)
    attempt = SimpleNamespace(downstream_reported=UNSET)
    with pytest.raises(Boom) as info:
        run(response, request, provider="openrouter", attempt=attempt, validate=validate)
    assert info.value is boom
    assert attempt.downstream_reported is UNSET
    assert stream.closed == 1 and response.is_closed


def test_cancellation_closes_response():
    async def body():
        hang = asyncio.Event()
        stream = TrackedStream(b'{"a":', hang=hang)
        response, request = make(stream)
        task = asyncio.create_task(read_model_response(
            response, request, maximum=64, provider="openai",
            attempt=SimpleNamespace(downstream_reported=UNSET), validate_wire=lambda _: None))
        await hang.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return stream, response
    stream, response = asyncio.run(body())
    assert stream.closed == 1 and response.is_closed


def router_body(message: dict[str, Any], **extra: Any) -> bytes:
    return json.dumps({"choices": [{"message": message}], **extra}).encode()


def compact(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), allow_nan=False).encode()


@pytest.mark.parametrize("provider", ["openrouter", "minimax"])
@pytest.mark.parametrize("field", ["reasoning", "reasoning_content"])
def test_router_missing_attribution_sentinel_and_plain_reasoning(provider, field):
    body = router_body({"content": "hi", field: "think"})
    response, request = make(TrackedStream(body))
    result = run(response, request, provider=provider, maximum=len(body))
    expected_message = {"content": "hi", field: "think", "reasoning_details": [
        {"type": "reasoning.text", "text": "think", "format": "unknown"}]}
    assert result.content == compact({"choices": [{"message": expected_message}], "provider": ""})
    assert result.attempt.downstream_reported is False
    assert "provider" not in json.loads(result.seen[0])


@pytest.mark.parametrize("provider", ["openrouter", "minimax"])
def test_router_actual_attribution_preserved(provider):
    body = router_body({"content": "hi"}, provider="DeepSeek")
    response, request = make(TrackedStream(body))
    result = run(response, request, provider=provider, maximum=len(body))
    assert result.content == compact({"choices": [{"message": {"content": "hi"}}], "provider": "DeepSeek"})
    assert result.attempt.downstream_reported is True


def test_router_existing_reasoning_details_not_overwritten():
    details = [{"type": "reasoning.encrypted", "data": "opaque"}]
    message = {"content": "hi", "reasoning": "plain", "reasoning_details": details}
    body = router_body(message, provider="p")
    response, request = make(TrackedStream(body))
    result = run(response, request, provider="openrouter", maximum=len(body))
    assert json.loads(result.content)["choices"][0]["message"]["reasoning_details"] == details


def test_router_empty_details_filled_and_absent_reasoning_left_alone():
    body = router_body({"reasoning": "r", "reasoning_details": []})
    response, request = make(TrackedStream(body))
    filled = json.loads(run(response, request, provider="minimax", maximum=len(body)).content)["choices"][0]["message"]
    assert filled["reasoning_details"] == [{"type": "reasoning.text", "text": "r", "format": "unknown"}]
    body = router_body({"content": "hi", "reasoning": ""})
    response, request = make(TrackedStream(body))
    plain = json.loads(run(response, request, provider="openrouter", maximum=len(body)).content)["choices"][0]["message"]
    assert "reasoning_details" not in plain


def test_non_router_bytes_preserved_without_normalization():
    body = b'{ "choices": [ {"message": {"reasoning": "think"}} ] }'
    response, request = make(TrackedStream(body))
    result = run(response, request, provider="openai")
    assert result.content == body
    assert result.attempt.downstream_reported is UNSET


def test_existing_public_entries_share_one_error_class():
    from openbot_server import model_connections_port, product_model
    assert product_model.ProductModelError is ProductModelError
    assert model_connections_port.ProductModelError is ProductModelError


def test_close_failure_is_not_suppressed_or_retried():
    failure = OSError("synthetic close failure")
    class FailingClose(TrackedStream):
        async def aclose(self):
            await super().aclose()
            raise failure
    stream = FailingClose(b"{}")
    response, request = make(stream, status=401)
    with pytest.raises(OSError) as error:
        run(response, request)
    assert error.value is failure
    assert stream.closed == 1 and stream.pulled == 0
