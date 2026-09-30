"""Bound and close one already-sent response shared by the product model ports.

Callers retain request authorization, single-send accounting, protocol validators
and client ownership. This stage never sends, retries or reads ambient credentials.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from typing import Any, Protocol

import httpx2

from .work_openai_model import ModelTransportError


class ProductModelError(ModelTransportError):
    """Fixed public failure classification; no SDK/provider body or credential in the message."""
    def __init__(self, code: str = "model_unavailable"):
        self.code = code
        super().__init__(code)


class ResponseAttempt(Protocol):
    downstream_reported: bool


class _BufferedStream(httpx2.AsyncByteStream):
    def __init__(self, content: bytes):
        self.content = content

    async def __aiter__(self) -> AsyncIterator[bytes]:
        yield self.content


def decode_model_json(value: bytes) -> Any:
    """Strict UTF-8 JSON; NaN, Infinity and -Infinity are refused."""
    def invalid(_: str) -> None:
        raise ValueError()
    return json.loads(value.decode("utf-8"), parse_constant=invalid)


def _reject_before_read(response: httpx2.Response, maximum: int) -> None:
    status = response.status_code
    if status in {401, 403}:
        raise ProductModelError("model_credentials")
    if status == 429:
        raise ProductModelError("model_rate_limit")
    if (not 200 <= status < 300
            or "application/json" not in response.headers.get("content-type", "").lower()
            or response.headers.get("content-encoding", "identity").lower() != "identity"):
        raise ProductModelError()
    length = response.headers.get("content-length")
    if length is not None and (not length.isdigit() or int(length) > maximum):
        raise ProductModelError("task_limit")


async def _read_bounded(response: httpx2.Response, maximum: int) -> bytes:
    if response.is_stream_consumed:
        content = response.content
        if len(content) > maximum:
            raise ProductModelError("task_limit")
        return bytes(content)
    chunks = bytearray()
    async for chunk in response.aiter_raw():
        if len(chunks) + len(chunk) > maximum:
            raise ProductModelError("task_limit")
        chunks.extend(chunk)
    return bytes(chunks)


def _normalize_router(value: Any, attempt: ResponseAttempt) -> bytes:
    # The released codec requires Router attribution. A missing attribution uses
    # an empty sentinel; the caller removes it from the decoded SDK result.
    attempt.downstream_reported = "provider" in value
    value.setdefault("provider", "")
    message = value["choices"][0]["message"]
    if not message.get("reasoning_details"):
        plain = message.get("reasoning") or message.get("reasoning_content")
        if plain:
            # Use the released common reasoning_details codec for round trips.
            message["reasoning_details"] = [{"type": "reasoning.text", "text": plain, "format": "unknown"}]
    return json.dumps(value, separators=(",", ":"), allow_nan=False).encode()


async def read_model_response(
    response: httpx2.Response,
    request: httpx2.Request,
    *,
    maximum: int,
    provider: str,
    attempt: ResponseAttempt,
    validate_wire: Callable[[Any], None],
) -> httpx2.Response:
    """Retain the caller's validator and close the input on every exit, including cancellation."""
    try:
        _reject_before_read(response, maximum)
        body = await _read_bounded(response, maximum)
        value = decode_model_json(body)
        validate_wire(value)
        if provider in {"openrouter", "minimax"}:
            body = _normalize_router(value, attempt)
        return httpx2.Response(
            response.status_code,
            headers={"content-type": "application/json"},
            stream=_BufferedStream(body),
            request=request,
        )
    finally:
        await response.aclose()
