"""A bounded OpenAI Responses ``ModelStepPort`` built from released SDK pieces.

This module is a thin host adapter: it composes the released Pydantic AI
``OpenAIResponsesModel``/``OpenAIProvider`` pair over an explicit official
``openai.AsyncOpenAI`` client and adds only the boundaries the runtime contract
already requires. It deliberately does not re-implement message conversion, an
Agent loop, retry logic or token accounting.

Authority and trust boundaries
------------------------------

* The provider base URL, endpoint, method, TLS verification and credentials are
  fixed here, never read from an environment variable or from the request. The
  only injectable seam is a trusted ``httpx2.AsyncBaseTransport`` used by tests.
* SDK features that would widen the call are not exposed: no inherited
  environment credentials or headers, no configured URL, no provider-hosted
  tools, no untrusted model settings, no background mode, no
  ``previous_response_id`` and no SDK retries. The only HTTP call is one
  non-streaming ``POST /v1/responses`` with ``store=false`` and an explicit
  output-token cap.
* The raw response is bounded and validated *before* the SDK decodes it, so a
  hostile or oversized body cannot reach the model layer, and a reply is only
  accepted when the Responses envelope is genuinely ``completed`` with a
  consistent usage record and a supported output kind. Only the SDK's own
  ``ModelResponse`` is returned; no token count is invented.
* Credentials and provider bodies never appear in an exception message, in
  ``repr`` or in a chained cause. The runtime's control plane still owns
  authority, budgets, approvals and durable settlement; nothing here grants any
  of them.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
from collections.abc import Sequence
from copy import deepcopy
from typing import Any, Final

import httpx2
from openai import AsyncOpenAI
from pydantic_ai.messages import (
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelResponse,
    ToolCallPart, SystemPromptPart, UserPromptPart, ToolReturnPart, RetryPromptPart,
    TextPart, ThinkingPart,
)
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.openai import OpenAIResponsesModel
from pydantic_ai.providers.openai import OpenAIProvider

from openbot_agent_runtime.catalog import ToolCatalog
from openbot_agent_runtime.contracts import (
    MAX_CATALOG_BYTES_CEILING,
    MAX_CATALOG_TOOLS_CEILING,
    ModelStepRequest,
)

__all__ = ["ModelTransportError", "OpenAIResponsesPort"]

BASE_URL: Final = "https://api.openai.com/v1"
"""The single reviewed endpoint family. There is no configurable URL."""

RESPONSES_PATH: Final = "/v1/responses"
PROVIDER_HOST: Final = "api.openai.com"

DEFAULT_MAX_OUTPUT_TOKENS: Final = 4096
DEFAULT_DEADLINE_SECONDS: Final = 30.0
DEFAULT_MAX_RESPONSE_BYTES: Final = 1024 * 1024

MAX_OUTPUT_TOKENS_CEILING: Final = 65536
MAX_RESPONSE_BYTES_CEILING: Final = 2 * 1024 * 1024
MAX_DEADLINE_SECONDS: Final = 120.0
"""Reviewed local ceilings; the caller may tighten but never loosen them."""

MAX_MESSAGE_BYTES: Final = 256 * 1024
MAX_MESSAGES: Final = 256
MAX_MODEL_CHARS: Final = 128
MAX_API_KEY_CHARS: Final = 8192

_AMBIENT_SDK_ENVIRONMENT: Final = ("OPENAI_CUSTOM_HEADERS", "OPENAI_LOG")
"""SDK 3.17.0 reads these even when explicit arguments are supplied.

Presence is refused without reading or printing the value, because a hostile
header line could otherwise ride along on a trusted request. The process
environment is never modified, so an unrelated caller is not affected.
"""

_SUPPORTED_OUTPUT_TYPES: Final = frozenset({"message", "function_call", "reasoning"})
"""Client-side output items this adapter accepts.

Provider-hosted tool items (web search, file search, code interpreter, image
generation, MCP, computer use, local shell, tool search, ...) are not accepted,
so a hosted side effect can never be mistaken for a bounded local step.
"""

_STRIPPED_RESPONSE_HEADERS: Final = ("content-encoding", "content-length", "transfer-encoding")
"""Body-length and transport-encoding headers are rebuilt after bounded draining."""


class ModelTransportError(Exception):
    """A bounded, generic transport failure.

    Messages are fixed literals chosen here: a provider body, a credential or a
    raw SDK exception is never interpolated into one, and callers raise it with
    ``from None`` so no raw chained cause is exposed.
    """


class OpenAIResponsesPort:
    """A real ``ModelStepPort`` backed by the released OpenAI Responses SDK.

    One instance owns one explicit ``AsyncOpenAI`` client (and its HTTP client)
    and is closed with :meth:`aclose`. Construction performs no network call.
    """

    def __init__(
        self,
        *,
        model: str,
        api_key: str,
        max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS,
        deadline_seconds: float = DEFAULT_DEADLINE_SECONDS,
        max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
        transport: httpx2.AsyncBaseTransport | None = None,
    ) -> None:
        _refuse_ambient_sdk_environment()
        self._model_name = _validated_model(model)
        self._max_output_tokens = _bounded_positive_int(
            max_output_tokens, MAX_OUTPUT_TOKENS_CEILING, "max_output_tokens"
        )
        self._max_response_bytes = _bounded_positive_int(
            max_response_bytes, MAX_RESPONSE_BYTES_CEILING, "max_response_bytes"
        )
        self._deadline_seconds = _bounded_deadline(deadline_seconds)
        if transport is not None and not isinstance(transport, httpx2.AsyncBaseTransport):
            raise ModelTransportError("transport must be an httpx2.AsyncBaseTransport")

        validated_key = _validated_api_key(api_key)
        inner: httpx2.AsyncBaseTransport = (
            transport
            if transport is not None
            else httpx2.AsyncHTTPTransport(retries=0, trust_env=False)
        )
        # The bounded wrapper is what the SDK actually talks to. Environment
        # proxies and credentials are ignored, redirects are never followed and
        # TLS verification stays on.
        self._http_client = httpx2.AsyncClient(
            transport=_BoundedTransport(inner, self._max_response_bytes),
            trust_env=False,
            follow_redirects=False,
            verify=True,
        )
        # Every SDK option that could otherwise be inherited from the process
        # environment is passed explicitly, including empty strings. The key is
        # never stored on this object; the official client owns it.
        self._client = AsyncOpenAI(
            api_key=validated_key,
            base_url=BASE_URL,
            max_retries=0,
            organization="",
            project="",
            admin_api_key="",
            webhook_secret="",
            http_client=self._http_client,
        )
        self._model = OpenAIResponsesModel(
            self._model_name, provider=OpenAIProvider(openai_client=self._client)
        )
        self._closed = False

    def __repr__(self) -> str:
        return f"{type(self).__name__}(model={self._model_name!r})"

    async def __call__(self, request: ModelStepRequest) -> ModelResponse:
        """Run exactly one bounded non-streaming Responses request."""
        if not isinstance(request, ModelStepRequest):
            raise ModelTransportError("model step request was refused")
        messages = _bounded_messages(request.messages)
        # ToolCatalog validates names, descriptions, schemas and byte bounds;
        # deepcopy detaches nested schema mappings from the caller. Only these
        # declared function tools are offered, and only their names may return.
        declared = ToolCatalog(
            request.tools,
            max_tools=MAX_CATALOG_TOOLS_CEILING,
            max_bytes=MAX_CATALOG_BYTES_CEILING,
        )
        catalog = ToolCatalog(deepcopy(declared.descriptors),
            max_tools=MAX_CATALOG_TOOLS_CEILING, max_bytes=MAX_CATALOG_BYTES_CEILING)
        parameters = ModelRequestParameters(
            function_tools=list(catalog.sdk_definitions().values())
        )
        settings = {"max_tokens": self._max_output_tokens, "openai_store": False}
        try:
            # One monotonic deadline spans send, bounded read and SDK decoding.
            async with asyncio.timeout(self._deadline_seconds):
                response = await self._model.request(messages, settings, parameters)
        except TimeoutError:
            raise ModelTransportError("model request timed out") from None
        except ModelTransportError:
            raise
        except asyncio.CancelledError:
            raise
        except Exception:
            # Status, network, parse and provider errors are collapsed into one
            # generic failure; the raw exception is deliberately not chained.
            raise ModelTransportError("model request failed") from None
        return _validated_model_response(response, catalog)

    async def aclose(self) -> None:
        """Close the owned client and its HTTP transport, including a test one."""
        if self._closed:
            return
        self._closed = True
        await self._client.close()


class _BoundedTransport(httpx2.AsyncBaseTransport):
    """A transport that bounds, validates and closes every provider response.

    It sits between the official SDK and the real network (or a test transport),
    so the SDK only ever decodes a response whose origin, method, path, status,
    size and Responses envelope were already checked here.
    """

    def __init__(self, inner: httpx2.AsyncBaseTransport, max_response_bytes: int) -> None:
        self._inner = inner
        self._max_response_bytes = max_response_bytes

    async def aclose(self) -> None:
        await self._inner.aclose()

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        _require_responses_endpoint(request)
        request.headers["accept-encoding"] = "identity"
        response = await self._inner.handle_async_request(request)
        try:
            if 300 <= response.status_code < 400:
                raise ModelTransportError("provider redirect was refused")
            if response.headers.get("content-encoding", "identity").lower() != "identity":
                raise ModelTransportError("compressed provider response was refused")
            body = await self._drain(response)
        finally:
            await response.aclose()
        if 200 <= response.status_code < 300:
            _validate_raw_response(body)
        return httpx2.Response(
            status_code=response.status_code,
            headers=_rebuilt_headers(response),
            stream=_BufferedStream(body),
            request=request,
        )

    async def _drain(self, response: httpx2.Response) -> bytes:
        """Read at most ``max_response_bytes`` and refuse anything larger."""
        collected = bytearray()
        async for chunk in response.aiter_bytes():
            if not chunk:
                continue
            if len(collected) + len(chunk) > self._max_response_bytes:
                raise ModelTransportError("provider response exceeded the size limit")
            collected.extend(chunk)
        return bytes(collected)


class _BufferedStream(httpx2.AsyncByteStream):
    """An already-drained body exposed as an async stream.

    An async transport must hand the client an async stream; a content-built
    response would carry a synchronous one.
    """

    def __init__(self, body: bytes) -> None:
        self._body = body

    async def __aiter__(self):
        yield self._body

    async def aclose(self) -> None:
        return None


def _refuse_ambient_sdk_environment() -> None:
    for name in _AMBIENT_SDK_ENVIRONMENT:
        # Membership checks the key only; the value is never read or printed.
        if name in os.environ:
            raise ModelTransportError(f"ambient {name} is not accepted")


def _validated_model(model: Any) -> str:
    if not isinstance(model, str) or not model.strip() or len(model) > MAX_MODEL_CHARS:
        raise ModelTransportError("model must be a non-empty bounded string")
    if _has_control_characters(model):
        raise ModelTransportError("model must not contain control characters")
    return model


def _validated_api_key(api_key: Any) -> str:
    if not isinstance(api_key, str) or not api_key.strip() or len(api_key) > MAX_API_KEY_CHARS:
        raise ModelTransportError("api_key must be a non-empty bounded string")
    if "\r" in api_key or "\n" in api_key:
        raise ModelTransportError("api_key must not contain line breaks")
    return api_key


def _bounded_positive_int(value: Any, maximum: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ModelTransportError(f"{name} must be a positive integer")
    if value < 1 or value > maximum:
        raise ModelTransportError(f"{name} must be within 1..{maximum}")
    return value


def _bounded_deadline(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ModelTransportError("deadline_seconds must be a finite number of seconds")
    number = float(value)
    if not math.isfinite(number) or number <= 0.0 or number > MAX_DEADLINE_SECONDS:
        raise ModelTransportError(f"deadline_seconds must be within 0..{MAX_DEADLINE_SECONDS}")
    return number


def _has_control_characters(value: str) -> bool:
    return any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)


def _bounded_messages(messages: Any) -> list[ModelMessage]:
    if isinstance(messages, (str, bytes)) or not isinstance(messages, Sequence):
        raise ModelTransportError("model messages were refused")
    values = list(messages)
    if len(values) > MAX_MESSAGES:
        raise ModelTransportError("model messages exceeded the count limit")
    try:
        payload = ModelMessagesTypeAdapter.dump_json(values)
    except Exception:
        raise ModelTransportError("model messages were not a valid sequence") from None
    if len(payload) > MAX_MESSAGE_BYTES:
        raise ModelTransportError("model messages exceeded the size limit")
    try:
        detached = ModelMessagesTypeAdapter.validate_json(payload)
        for message in detached:
            for part in message.parts:
                if isinstance(part, (SystemPromptPart, TextPart, ThinkingPart)):
                    if type(part.content) is not str:
                        raise ValueError()
                elif isinstance(part, UserPromptPart):
                    if type(part.content) is not str and not (
                        type(part.content) in (list, tuple) and all(type(x) is str for x in part.content)):
                        raise ValueError()
                elif isinstance(part, (ToolReturnPart, RetryPromptPart)):
                    _plain_json(part.content)
                elif isinstance(part, ToolCallPart):
                    _plain_json(part.args)
                else:
                    raise ValueError()
    except Exception:
        raise ModelTransportError('only text and function message history is supported') from None
    return detached


def _plain_json(value, depth=0):
    # Tool content remains text/JSON. SDK media classes can start a separate download
    # or tell the provider to read a remote URL, outside the one fixed HTTP endpoint.
    if depth > 12:
        raise ValueError()
    if value is None or type(value) in (str, bool, int):
        return
    if type(value) is float and math.isfinite(value):
        return
    if type(value) is list:
        for child in value:
            _plain_json(child, depth + 1)
        return
    if type(value) is dict and all(type(key) is str for key in value):
        for child in value.values():
            _plain_json(child, depth + 1)
        return
    raise ValueError()


def _require_responses_endpoint(request: httpx2.Request) -> None:
    """Refuse anything but the one reviewed ``POST https://api.openai.com/v1/responses``."""
    url = request.url
    if request.method != "POST":
        raise ModelTransportError("provider request method was refused")
    if url.scheme != "https" or url.host != PROVIDER_HOST or url.port not in (None, 443):
        raise ModelTransportError("provider request origin was refused")
    if url.path != RESPONSES_PATH or url.query or url.username or url.password:
        raise ModelTransportError("provider request path was refused")


def _rebuilt_headers(response: httpx2.Response) -> httpx2.Headers:
    headers = response.headers.copy()
    for name in _STRIPPED_RESPONSE_HEADERS:
        if name in headers:
            del headers[name]
    return headers


def _validate_raw_response(body: bytes) -> None:
    """Validate the raw Responses envelope before the SDK may decode it."""
    try:
        payload = json.loads(body)
    except Exception:
        raise ModelTransportError("provider response was not valid JSON") from None
    if not isinstance(payload, dict):
        raise ModelTransportError("provider response was not a JSON object")
    if payload.get("status") != "completed":
        raise ModelTransportError("provider response did not complete")
    if payload.get("error") is not None:
        raise ModelTransportError("provider response carried an error")
    if payload.get("incomplete_details") is not None:
        raise ModelTransportError("provider response was incomplete")
    _validate_raw_usage(payload.get("usage"))
    _validate_raw_output(payload.get("output"))


def _validate_raw_usage(usage: Any) -> None:
    if not isinstance(usage, dict):
        raise ModelTransportError("provider response omitted usage")
    values: dict[str, int] = {}
    for name in ("input_tokens", "output_tokens", "total_tokens"):
        value = usage.get(name)
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 1_000_000_000:
            raise ModelTransportError("provider response carried invalid usage")
        values[name] = value
    if values["total_tokens"] != values["input_tokens"] + values["output_tokens"]:
        raise ModelTransportError("provider response carried inconsistent usage")


def _validate_raw_output(output: Any) -> None:
    if not isinstance(output, list):
        raise ModelTransportError("provider response carried an invalid output list")
    call_ids: set[str] = set()
    for item in output:
        if not isinstance(item, dict):
            raise ModelTransportError("provider response carried an invalid output item")
        kind = item.get("type")
        if kind not in _SUPPORTED_OUTPUT_TYPES:
            raise ModelTransportError("provider response carried an unsupported output kind")
        if kind in ('message', 'function_call') and item.get('status') != 'completed':
            raise ModelTransportError('provider output item did not complete')
        if kind == "function_call":
            call_id = item.get("call_id")
            if not isinstance(call_id, str) or not call_id.strip() or len(call_id) > 128 or _has_control_characters(call_id):
                raise ModelTransportError("provider response carried an invalid tool call identifier")
            if call_id in call_ids:
                raise ModelTransportError("provider response carried duplicate tool call identifiers")
            call_ids.add(call_id)
            name = item.get("name")
            if not isinstance(name, str) or not name:
                raise ModelTransportError("provider response carried an invalid tool call name")
        elif kind == "message":
            content = item.get("content")
            if not isinstance(content, list):
                raise ModelTransportError("provider response carried an invalid message")
            for entry in content:
                if not isinstance(entry, dict) or entry.get("type") != "output_text":
                    raise ModelTransportError(
                        "provider response carried an unsupported message content"
                    )


def _validated_model_response(response: Any, catalog: ToolCatalog) -> ModelResponse:
    """Accept only the SDK's own completed response with declared tool names."""
    if not isinstance(response, ModelResponse):
        raise ModelTransportError("provider returned an unsupported model response")
    details = response.provider_details or {}
    if details.get("finish_reason") != "completed":
        raise ModelTransportError("provider response did not complete")
    usage = response.usage
    if not _is_nonnegative_int(getattr(usage, "input_tokens", None)) or not _is_nonnegative_int(
        getattr(usage, "output_tokens", None)
    ):
        raise ModelTransportError("provider response carried invalid usage")
    seen: set[str] = set()
    for part in response.parts:
        if not isinstance(part, ToolCallPart):
            continue
        if part.tool_name not in catalog.names:
            raise ModelTransportError("provider returned an undeclared tool call")
        call_id = part.tool_call_id
        if not isinstance(call_id, str) or not call_id.strip() or len(call_id) > 128 or _has_control_characters(call_id):
            raise ModelTransportError("provider returned an invalid tool call identifier")
        if call_id in seen:
            raise ModelTransportError("provider returned duplicate tool call identifiers")
        seen.add(call_id)
    return response


def _is_nonnegative_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0
