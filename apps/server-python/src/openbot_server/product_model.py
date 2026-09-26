"""One bounded SDK model step for the eleven existing OpenBot provider configurations.

The released Pydantic AI 2.47.0 models own message/tool/reasoning conversion and usage extraction;
OpenAI 3.17.0 and Anthropic 1.8.0 own their protocols. This adapter selects explicit clients and
preserves OpenBot's existing endpoint, no-fallback and reasoning-separation rules. It does not
own an Agent loop, authority, Action admission, retries or durable usage settlement.

Reviewed sources: python-model-services.md, work-model-ports.md and native-agent.ts. OpenRouter's
released model is also used for MiniMax's compatible reasoning_details extension. Plain reasoning
is promoted to that SDK-supported wire extension before decoding, so it is not lost on replay.
No upstream source is copied. There are no inherited provider credentials or optional cloud clients.
"""
from __future__ import annotations

import asyncio
from collections.abc import Mapping
from contextvars import ContextVar
from copy import deepcopy
from dataclasses import dataclass
import json
import os
import re
from typing import Any

import httpx2
from anthropic import AsyncAnthropic
from openai import AsyncOpenAI
from opentelemetry.trace import INVALID_SPAN_CONTEXT, NonRecordingSpan, use_span
from pydantic_ai.messages import ModelResponse, TextPart, ThinkingPart, ToolCallPart
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
from pydantic_ai.models.openrouter import OpenRouterModel
from pydantic_ai.profiles.openai import OpenAIJsonSchemaTransformer, OpenAIModelProfile
from pydantic_ai.providers import Provider
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.deepseek import DeepSeekProvider
from pydantic_ai.providers.moonshotai import MoonshotAIProvider
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.providers.openrouter import OpenRouterProvider

from openbot_agent_runtime.catalog import ToolCatalog
from openbot_agent_runtime.contracts import ModelStepRequest

from .model_media import PreparedModelMedia, inject, adapt_wire
from .work_values import WorkConflict, InvalidWork
from .model_presets import ModelSettingsInput, RetainedModelSettings, model_provider_base_url
from .work_openai_model import (
    ModelTransportError, _bounded_deadline, _bounded_messages, _bounded_positive_int, _plain_json,
)

__all__ = ["ProductModelPort", "ProductModelError"]

_REQUEST_BYTES = 512 * 1024
_MAX_COUNT = 1_000_000_000
_FORBIDDEN_ENV = ("OPENAI_CUSTOM_HEADERS", "OPENAI_LOG", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_LOG")
_ROUTER_POLICY = {"require_parameters": True, "allow_fallbacks": False, "data_collection": "deny"}


class ProductModelError(ModelTransportError):
    """Fixed public failure classification; no SDK/provider body or credential in the message."""
    def __init__(self, code: str = "model_unavailable"):
        self.code = code
        super().__init__(code)


def _refuse_ambient_options() -> None:
    # The SDKs inherit these even with explicit credential/base_url arguments. Refuse membership
    # without reading their values, both at construction and before each request.
    if any(name in os.environ for name in _FORBIDDEN_ENV):
        raise ProductModelError()


def _parse_configuration(value: Any) -> ModelSettingsInput:
    try:
        if not isinstance(value, Mapping):
            raise ValueError()
        if "agentEnabledAt" in value:
            retained = RetainedModelSettings.model_validate(dict(value))
            if not retained.agentEnabled or retained.agentEnabledAt is None:
                raise ValueError()
            return retained
        # A credential-only snapshot is a trusted composition input, not a substitute for the
        # Server's active-settings check. Never accept caller-supplied protocol/model options.
        parsed = ModelSettingsInput.model_validate({"revision": None, **dict(value)})
        if "agentEnabled" in value and not parsed.agentEnabled:
            raise ValueError()
        return parsed
    except Exception:
        raise ProductModelError("model_configuration") from None


class _ConfiguredProvider(Provider[Any]):
    """Public SDK Provider seam with explicit identity/client and released profile selection.

    Using a prebuilt provider avoids provider constructors reading optional attribution/key
    environment variables, and preserves the selected regional base URL in response metadata.
    """
    def __init__(self, client: Any, name: str, base_url: str, profile: dict[str, Any]):
        self._client, self._name, self._base_url, self._profile = client, name, base_url, profile

    @property
    def name(self) -> str:
        return self._name

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def client(self) -> Any:
        return self._client

    def model_profile(self, model_name: str) -> dict[str, Any]:
        return deepcopy(self._profile)


def _profile(provider: str, model: str) -> dict[str, Any]:
    factories = {
        "openai": OpenAIProvider.model_profile, "anthropic": AnthropicProvider.model_profile,
        "moonshot": MoonshotAIProvider.model_profile, "deepseek": DeepSeekProvider.model_profile,
        "openrouter": OpenRouterProvider.model_profile,
    }
    if provider in factories:
        profile = dict(factories[provider](model) or {})
    else:
        profile = OpenAIModelProfile(
            json_schema_transformer=OpenAIJsonSchemaTransformer,
            openai_chat_supports_max_completion_tokens=False,
            openai_supports_strict_tool_definition=False,
        )
    if provider != "openai" and provider != "anthropic":
        # Existing compatibility endpoints use max_tokens. Do not select an OpenAI profile
        # merely because a third-party model happens to have a GPT-like name.
        profile["openai_chat_supports_max_completion_tokens"] = False
    return profile


@dataclass
class _Attempt:
    count: int = 0
    input_tokens: int | None = None
    output_tokens: int | None = None
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    tool_ids: tuple[str, ...] = ()
    downstream_reported: bool = True
    media: PreparedModelMedia | None = None


class ProductModelPort:
    """Explicit active configuration -> one non-streaming ModelStepRequest/ModelResponse.

    Root obtains active_settings from ``await settings.active()`` and admits each invocation
    through its durable Model Action boundary. An instance snapshots one configuration; a
    revision/disable change must revoke the old instance in that boundary, not silently switch
    providers mid-Run. Close the owned SDK/HTTP client with ``aclose``.
    """
    def __init__(self, active_settings: Mapping[str, Any], *, max_output_tokens: int = 4096,
                 deadline_seconds: float = 30, max_response_bytes: int = 512 * 1024,
                 transport: httpx2.AsyncBaseTransport | None = None, before_send=None, media_loader=None):
        _refuse_ambient_options()
        config = _parse_configuration(active_settings)
        try:
            self.max_output_tokens = _bounded_positive_int(max_output_tokens, 65536, "max_output_tokens")
            self._deadline = _bounded_deadline(deadline_seconds)
            maximum = _bounded_positive_int(max_response_bytes, 2 * 1024 * 1024, "max_response_bytes")
            if transport is not None and not isinstance(transport, httpx2.AsyncBaseTransport):
                raise ValueError()
            if media_loader is not None and not callable(media_loader):
                raise ValueError()
            if before_send is not None and not callable(before_send):
                raise ValueError()
        except Exception:
            raise ProductModelError("model_configuration") from None
        self.provider_id, self.model_name = config.provider, config.model
        self.base_url = model_provider_base_url(config.provider, config.baseUrl)
        self.protocol = ("responses-v1" if config.provider == "openai" else
                         "anthropic-messages-v1" if config.provider == "anthropic" else "chat-completions-v1")
        self._closed = False
        self._media_loader = media_loader
        profile = _profile(config.provider, config.model)
        self._attempt: ContextVar[_Attempt | None] = ContextVar(f"openbot-product-model-{id(self)}", default=None)
        bounded = _BoundedTransport(
            transport if transport is not None else httpx2.AsyncHTTPTransport(retries=0, trust_env=False),
            provider=config.provider, model=config.model, base_url=self.base_url, key=config.apiKey,
            maximum=maximum, max_output=self.max_output_tokens, attempt=self._attempt, before_send=before_send,
        )
        http = httpx2.AsyncClient(transport=bounded, trust_env=False, follow_redirects=False,
                                 verify=True, timeout=self._deadline)
        if config.provider == "anthropic":
            self._client = AsyncAnthropic(api_key=config.apiKey, auth_token=None, credentials=None,
                config=None, profile=None, webhook_key="", base_url=self.base_url, max_retries=0,
                timeout=self._deadline, default_headers={}, default_query={}, middleware=[], http_client=http)
        else:
            self._client = AsyncOpenAI(api_key=config.apiKey, base_url=self.base_url, max_retries=0,
                organization="", project="", admin_api_key="", webhook_secret="", timeout=self._deadline,
                default_headers={}, default_query={}, http_client=http)
        provider = _ConfiguredProvider(self._client, config.provider, self.base_url, profile)
        model_type = (OpenAIResponsesModel if config.provider == "openai" else
                      AnthropicModel if config.provider == "anthropic" else
                      OpenRouterModel if config.provider in {"openrouter", "minimax"} else OpenAIChatModel)
        self._model = model_type(config.model, provider=provider, profile=profile)
        self._settings: dict[str, Any] = {"max_tokens": self.max_output_tokens}
        if config.provider == "openai":
            self._settings["openai_store"] = False
        elif config.provider == "openrouter":
            self._settings["openrouter_provider"] = deepcopy(_ROUTER_POLICY)
        elif config.provider == "deepseek":
            self._settings["extra_body"] = {"thinking": {"type": "disabled"}}
        elif config.provider == "minimax":
            self._settings["extra_body"] = {"reasoning_split": True}

    def __repr__(self) -> str:
        return f"ProductModelPort(provider={self.provider_id!r}, model={self.model_name!r})"

    async def aclose(self) -> None:
        if not self._closed:
            self._closed = True
            await self._client.close()

    async def __aenter__(self) -> "ProductModelPort":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def __call__(self, request: ModelStepRequest) -> ModelResponse:
        if self._closed:
            raise ProductModelError()
        _refuse_ambient_options()
        try:
            if type(request) is not ModelStepRequest or type(request.step) is not int or request.step < 1:
                raise ValueError()
            messages = _bounded_messages(request.messages)
            if not messages:
                raise ValueError()
            declared = ToolCatalog(request.tools, max_tools=64, max_bytes=64 * 1024)
            catalog = ToolCatalog(deepcopy(declared.descriptors), max_tools=64, max_bytes=64 * 1024)
            parameters = ModelRequestParameters(function_tools=list(catalog.sdk_definitions().values()))
        except Exception:
            raise ProductModelError("model_request_invalid") from None
        attempt = _Attempt()
        token = self._attempt.set(attempt)
        try:
            async with asyncio.timeout(self._deadline):
                if self._media_loader is not None:
                    attempt.media = await self._media_loader()
                    messages = inject(messages, attempt.media, provider=self.provider_id, protocol=self.protocol)
                # This direct model call never installs instrumentation or creates an Agent.
                # Anthropic may annotate an inherited span; use a non-recording local context.
                with use_span(NonRecordingSpan(INVALID_SPAN_CONTEXT), end_on_exit=False):
                    result = await self._model.request(messages, deepcopy(self._settings), parameters)
                _validate_result(result, attempt, catalog)
                return result
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            raise ProductModelError("task_timeout") from None
        except ProductModelError:
            raise
        except (WorkConflict, InvalidWork) as error:
            code = str(error)
            raise ProductModelError(code if code in ("attachment_model_unsupported", "attachment_unavailable", "task_limit") else "attachment_unavailable") from None
        except Exception as error:
            # Official SDKs wrap transport exceptions; recover only our fixed classifications,
            # never their error message/body. No raw SDK exception is exposed as a cause.
            code = "model_unavailable"
            for _ in range(6):
                if isinstance(error, ProductModelError):
                    code = error.code
                    break
                error = error.__cause__ or error.__context__
                if error is None:
                    break
            raise ProductModelError(code) from None
        finally:
            self._attempt.reset(token)


class _BufferedStream(httpx2.AsyncByteStream):
    def __init__(self, content: bytes):
        self.content = content

    async def __aiter__(self):
        yield self.content


def _json(value: bytes) -> Any:
    def invalid(_: str) -> None:
        raise ValueError()
    return json.loads(value.decode("utf-8"), parse_constant=invalid)


class _BoundedTransport(httpx2.AsyncBaseTransport):
    def __init__(self, inner, *, provider, model, base_url, key, maximum, max_output, attempt, before_send=None):
        self._inner, self._provider, self._model = inner, provider, model
        suffix = "/responses" if provider == "openai" else "/v1/messages" if provider == "anthropic" else "/chat/completions"
        self._url, self._key = httpx2.URL(base_url + suffix), key
        self._maximum, self._max_output, self._attempt = maximum, max_output, attempt
        self._before_send = before_send

    async def aclose(self):
        await self._inner.aclose()

    async def handle_async_request(self, request):
        try:
            attempt = self._attempt.get()
            if attempt is None or attempt.count:
                raise ProductModelError()
            # Pydantic AI uses the released Anthropic beta resource for typed reasoning blocks.
            # Its one fixed beta=true query is removed so the actual network destination remains
            # exactly the existing /v1/messages endpoint; beta feature headers remain bounded.
            if self._provider == "anthropic" and request.url.query == b"beta=true":
                request.url = request.url.copy_with(query=None)
            if request.method != "POST" or request.url != self._url:
                raise ProductModelError()
            body = request.content
            if attempt.media is not None:
                try:
                    protocol = "responses-v1" if self._provider == "openai" else "anthropic-messages-v1" if self._provider == "anthropic" else "chat-completions-v1"
                    body = adapt_wire(body, attempt.media, provider=self._provider, protocol=protocol)
                except (WorkConflict, InvalidWork) as error:
                    raise ProductModelError(str(error) if str(error) == "task_limit" else "attachment_unavailable") from None
                request = httpx2.Request(request.method, request.url, headers=request.headers, content=body, extensions=request.extensions)
            elif len(body) > _REQUEST_BYTES:
                raise ProductModelError("task_limit")
            payload = _json(body)
            self._check_request(payload)
            # Keep protocol/auth headers only; SDK attribution/runtime headers are not required.
            headers = {"Host": self._url.host, "Content-Type": "application/json", "Accept": "application/json",
                       "Accept-Encoding": "identity", "Content-Length": str(len(body))}
            if self._provider == "anthropic":
                headers.update({"x-api-key": self._key, "anthropic-version": "2023-06-01"})
                if beta := request.headers.get("anthropic-beta"):
                    if len(beta) > 1024 or re.fullmatch(r"[a-zA-Z0-9,._-]+", beta) is None:
                        raise ProductModelError()
                    headers["anthropic-beta"] = beta
            else:
                headers["Authorization"] = f"Bearer {self._key}"
            request.headers.clear()
            request.headers.update(headers)
            if self._before_send is not None:
                await self._before_send()
            attempt.count += 1
            response = await self._inner.handle_async_request(request)
            try:
                if response.status_code in {401, 403}:
                    raise ProductModelError("model_credentials")
                if response.status_code == 429:
                    raise ProductModelError("model_rate_limit")
                if (not 200 <= response.status_code < 300
                        or "application/json" not in response.headers.get("content-type", "").lower()
                        or response.headers.get("content-encoding", "identity").lower() != "identity"):
                    raise ProductModelError()
                length = response.headers.get("content-length")
                if length is not None and (not length.isdigit() or int(length) > self._maximum):
                    raise ProductModelError("task_limit")
                chunks = bytearray()
                if response.is_stream_consumed:
                    if len(response.content) > self._maximum:
                        raise ProductModelError("task_limit")
                    chunks.extend(response.content)
                else:
                    async for chunk in response.aiter_raw():
                        if len(chunks) + len(chunk) > self._maximum:
                            raise ProductModelError("task_limit")
                        chunks.extend(chunk)
                value = _json(bytes(chunks))
                _validate_wire(value, self._provider, attempt)
                if self._provider in {"openrouter", "minimax"}:
                    # The released common codec additionally requires Router attribution.
                    # Preserve actual attribution when present; an empty internal sentinel is
                    # removed from the result when this Chat endpoint did not supply it.
                    attempt.downstream_reported = "provider" in value
                    value.setdefault("provider", "")
                    message = value["choices"][0]["message"]
                    if not message.get("reasoning_details"):
                        plain = message.get("reasoning") or message.get("reasoning_content")
                        if plain:
                            # Use the released common reasoning_details codec for round trips.
                            message["reasoning_details"] = [{"type": "reasoning.text", "text": plain, "format": "unknown"}]
                    chunks = bytearray(json.dumps(value, separators=(",", ":"), allow_nan=False).encode())
                return httpx2.Response(response.status_code, headers={"content-type": "application/json"},
                                       stream=_BufferedStream(bytes(chunks)), request=request)
            finally:
                await response.aclose()
        except asyncio.CancelledError:
            raise
        except httpx2.TimeoutException:
            raise ProductModelError("task_timeout") from None
        except ProductModelError:
            raise
        except Exception:
            raise ProductModelError() from None

    def _check_request(self, body):
        if (not isinstance(body, dict) or body.get("model") != self._model or body.get("stream", False) is not False
                or body.get("n", 1) != 1 or body.get("store", False) is not False):
            raise ProductModelError()
        output_field = "max_output_tokens" if self._provider == "openai" else "max_tokens"
        if type(body.get(output_field)) is not int or body[output_field] != self._max_output:
            raise ProductModelError()
        if any(body.get(name) is not None for name in (
            "background", "previous_response_id", "conversation", "mcp_servers", "plugins", "container",
            "context_management", "web_search_options", "models", "service_tier",
        )):
            raise ProductModelError()
        if self._provider == "openai" and body.get("store") is not False:
            raise ProductModelError()
        if self._provider == "openrouter" and body.get("provider") != _ROUTER_POLICY:
            raise ProductModelError()
        if self._provider == "deepseek" and body.get("thinking") != {"type": "disabled"}:
            raise ProductModelError()
        if self._provider == "minimax" and body.get("reasoning_split") is not True:
            raise ProductModelError()
        tools = body.get("tools", [])
        if not isinstance(tools, list) or len(tools) > 64:
            raise ProductModelError()
        for tool in tools:
            if not isinstance(tool, dict) or (
                tool.get("type") not in (None, "custom") if self._provider == "anthropic" else tool.get("type") != "function"
            ):
                raise ProductModelError()


def _count(value: Any) -> int:
    if type(value) is not int or not 0 <= value <= _MAX_COUNT:
        raise ProductModelError()
    return value


def _text(value: Any, maximum: int | None = None, *, empty: bool = True) -> str:
    if type(value) is not str or (not empty and not value) or (maximum is not None and len(value) > maximum):
        raise ProductModelError()
    return value


def _call(identifier, name, args, seen, *, encoded):
    _text(identifier, 128, empty=False)
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in identifier) or identifier in seen:
        raise ProductModelError()
    _text(name, 64, empty=False)
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", name) is None:
        raise ProductModelError()
    if encoded:
        args = _json(_text(args).encode())
    if type(args) is not dict:
        raise ProductModelError()
    _plain_json(args)
    seen.append(identifier)


def _validate_wire(body, provider, attempt):
    if type(body) is not dict or body.get("error") is not None:
        raise ProductModelError()
    _plain_json(body)
    _text(body.get("id"), 256, empty=False)
    _text(body.get("model"), 128, empty=False)
    usage = body.get("usage")
    if type(usage) is not dict:
        raise ProductModelError()
    _validate_usage_fields(usage)
    ids: list[str] = []
    visible = False
    if provider == "anthropic":
        if body.get("type") != "message" or body.get("role") != "assistant" or body.get("stop_reason") not in {"end_turn", "stop_sequence", "tool_use"}:
            raise ProductModelError()
        attempt.cache_read_tokens = _count(0 if usage.get("cache_read_input_tokens") is None else usage["cache_read_input_tokens"])
        attempt.cache_write_tokens = _count(0 if usage.get("cache_creation_input_tokens") is None else usage["cache_creation_input_tokens"])
        attempt.input_tokens = _count(usage.get("input_tokens")) + attempt.cache_read_tokens + attempt.cache_write_tokens
        attempt.output_tokens = _count(usage.get("output_tokens"))
        if usage.get("iterations") or usage.get("server_tool_use") or body.get("container") or body.get("stop_details"):
            raise ProductModelError()
        parts = body.get("content")
        if type(parts) is not list:
            raise ProductModelError()
        for part in parts:
            if type(part) is not dict:
                raise ProductModelError()
            kind = part.get("type")
            if kind == "text":
                visible = bool(_text(part.get("text"))) or visible
            elif kind == "thinking":
                _text(part.get("thinking")); _text(part.get("signature"), empty=False)
            elif kind == "redacted_thinking":
                _text(part.get("data"), empty=False)
            elif kind == "tool_use":
                _call(part.get("id"), part.get("name"), part.get("input"), ids, encoded=False)
            else:
                raise ProductModelError()
        if bool(ids) != (body["stop_reason"] == "tool_use"):
            raise ProductModelError()
    elif provider == "openai":
        if body.get("status") != "completed" or body.get("incomplete_details") is not None:
            raise ProductModelError()
        attempt.input_tokens, attempt.output_tokens = _count(usage.get("input_tokens")), _count(usage.get("output_tokens"))
        if _count(usage.get("total_tokens")) != attempt.input_tokens + attempt.output_tokens:
            raise ProductModelError()
        parts = body.get("output")
        if type(parts) is not list:
            raise ProductModelError()
        for part in parts:
            if type(part) is not dict:
                raise ProductModelError()
            kind = part.get("type")
            if kind == "function_call":
                if part.get("status") != "completed":
                    raise ProductModelError()
                _call(part.get("call_id"), part.get("name"), part.get("arguments"), ids, encoded=True)
            elif kind == "message":
                if part.get("status") != "completed" or part.get("role") != "assistant" or type(part.get("content")) is not list:
                    raise ProductModelError()
                for entry in part["content"]:
                    if type(entry) is not dict or entry.get("type") != "output_text":
                        raise ProductModelError()
                    visible = bool(_text(entry.get("text"))) or visible
            elif kind == "reasoning":
                if part.get("encrypted_content") is not None:
                    _text(part["encrypted_content"])
                if type(part.get("summary", [])) is not list:
                    raise ProductModelError()
                for entry in part.get("summary", []):
                    if type(entry) is not dict or entry.get("type") != "summary_text":
                        raise ProductModelError()
                    _text(entry.get("text"))
            else:
                raise ProductModelError()
    else:
        attempt.input_tokens, attempt.output_tokens = _count(usage.get("prompt_tokens")), _count(usage.get("completion_tokens"))
        if _count(usage.get("total_tokens")) != attempt.input_tokens + attempt.output_tokens:
            raise ProductModelError()
        choices = body.get("choices")
        if type(choices) is not list or len(choices) != 1 or type(choices[0]) is not dict:
            raise ProductModelError()
        choice = choices[0]
        if choice.get("finish_reason") not in {"stop", "tool_calls"} or choice.get("error"):
            raise ProductModelError()
        message = choice.get("message")
        if type(message) is not dict or message.get("role") != "assistant" or message.get("refusal"):
            raise ProductModelError()
        if message.get("content") is not None:
            text = _text(message["content"])
            visible = bool(text)
            if provider == "minimax" and re.search(r"</?think>", text, flags=re.IGNORECASE):
                raise ProductModelError()
        for field in ("reasoning", "reasoning_content"):
            if message.get(field) is not None:
                _text(message[field])
        if message.get("reasoning_details") is not None:
            if provider not in {"openrouter", "minimax"} or type(message["reasoning_details"]) is not list:
                raise ProductModelError()
            for detail in message["reasoning_details"]:
                if type(detail) is not dict or detail.get("type") not in {"reasoning.text", "reasoning.summary", "reasoning.encrypted"}:
                    raise ProductModelError()
                field = {"reasoning.text": "text", "reasoning.summary": "summary", "reasoning.encrypted": "data"}[detail["type"]]
                _text(detail.get(field))
        calls = message.get("tool_calls")
        if calls is None:
            calls = []
        if type(calls) is not list:
            raise ProductModelError()
        for call in calls:
            if type(call) is not dict or call.get("type") != "function" or type(call.get("function")) is not dict:
                raise ProductModelError()
            _call(call.get("id"), call["function"].get("name"), call["function"].get("arguments"), ids, encoded=True)
        if bool(ids) != (choice["finish_reason"] == "tool_calls"):
            raise ProductModelError()
    if len(ids) > 64 or (not ids and not visible):
        raise ProductModelError()
    attempt.tool_ids = tuple(ids)


def _validate_usage_fields(value):
    for key, child in value.items():
        if key.endswith("_tokens") and child is not None:
            _count(child)
        elif type(child) is dict:
            _validate_usage_fields(child)


def _validate_result(result, attempt, catalog):
    if (not isinstance(result, ModelResponse) or attempt.count != 1 or result.state != "complete"
            or result.finish_reason not in {"stop", "tool_call"} or not result.parts):
        raise ProductModelError()
    if (_count(result.usage.input_tokens) != attempt.input_tokens
            or _count(result.usage.output_tokens) != attempt.output_tokens):
        raise ProductModelError()
    for count in (result.usage.cache_read_tokens, result.usage.cache_write_tokens):
        _count(count)
    ids = []
    for part in result.parts:
        if isinstance(part, ToolCallPart):
            if part.tool_name not in catalog.names:
                raise ProductModelError()
            ids.append(part.tool_call_id)
        elif not isinstance(part, (TextPart, ThinkingPart)):
            raise ProductModelError()
    if tuple(ids) != attempt.tool_ids:
        raise ProductModelError()
    if not attempt.downstream_reported and result.provider_details is not None:
        result.provider_details.pop("downstream_provider", None)
