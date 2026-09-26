"""Explicit feature-source Chat/Anthropic protocol constructor over the reviewed SDK port.

Only constructor and wire-policy differences live here. ProductModelPort owns the released SDK
step conversion, bounded input catalog, cancellation, fixed errors and result/usage validation.
No Responses substitution, provider fallback, implicit web tool, environment credential or Agent.
"""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
from copy import deepcopy
from dataclasses import replace
import json
import re

import httpx2
from anthropic import AsyncAnthropic
from openai import AsyncOpenAI
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.models.openrouter import OpenRouterModel

from .model_media import adapt_wire
from .work_values import WorkConflict, InvalidWork
from .model_connections_inputs import ConnectionPolicy, ResolvedModelConnection, api_key, model_id
from .product_model import (
    ProductModelPort, ProductModelError, _Attempt, _BufferedStream, _ConfiguredProvider,
    _ROUTER_POLICY, _REQUEST_BYTES, _json, _profile, _refuse_ambient_options, _validate_wire,
)
from .work_openai_model import _bounded_deadline, _bounded_positive_int


class ModelConnectionPort(ProductModelPort):
    def __init__(self, resolved: ResolvedModelConnection, *, policy: ConnectionPolicy | None = None,
                 max_output_tokens=4096, deadline_seconds=30, max_response_bytes=512 * 1024,
                 transport=None, before_send=None, media_loader=None):
        _refuse_ambient_options()
        try:
            if type(resolved) is not ResolvedModelConnection:
                raise ValueError()
            policy = policy or ConnectionPolicy()
            self.base_url = policy.endpoint(resolved.preset_id, resolved.base_url, resolved.protocol)
            self.model_name = model_id(resolved.model_id)
            key = api_key(resolved.api_key)
            self.max_output_tokens = _bounded_positive_int(max_output_tokens, 65536, "max_output_tokens")
            self._deadline = _bounded_deadline(deadline_seconds)
            maximum = _bounded_positive_int(max_response_bytes, 2 * 1024 * 1024, "max_response_bytes")
            if transport is not None and not isinstance(transport, httpx2.AsyncBaseTransport):
                raise ValueError()
            if media_loader is not None and not callable(media_loader):
                raise ValueError()
            if before_send is not None and not callable(before_send):
                raise ValueError()
            if resolved.reasoning_effort not in (None, "low", "high", "max") or (resolved.reasoning_effort and resolved.preset_id != "kimi"):
                raise ValueError()
        except Exception:
            raise ProductModelError("model_configuration") from None
        self.provider_id = resolved.preset_id
        self.protocol = "anthropic-messages-v1" if resolved.protocol == "anthropic-messages" else "chat-completions-v1"
        self._closed = False
        self._media_loader = media_loader
        profile_id = "moonshot" if resolved.preset_id == "kimi" else resolved.preset_id
        # The F DTO also accepts a provider's bare aliases. The released Router profile
        # resolver insists on a slash, so use its compatible generic profile for that case;
        # the exact original model still goes to the same OpenRouter endpoint once.
        profile = _profile("custom" if profile_id == "openrouter" and "/" not in self.model_name else profile_id, self.model_name)
        resolved = replace(resolved, base_url=self.base_url, model_id=self.model_name, api_key=key)
        completion_tokens = resolved.preset_id == "openai" or (resolved.preset_id == "kimi" and (
            self.model_name == "kimi-k3" or resolved.reasoning_effort is not None))
        if resolved.protocol == "openai-chat":
            profile["openai_chat_supports_max_completion_tokens"] = completion_tokens
        self._attempt = ContextVar(f"openbot-connection-model-{id(self)}", default=None)
        bounded = _ConnectionTransport(transport or httpx2.AsyncHTTPTransport(retries=0, trust_env=False),
            resolved=resolved, key=key, maximum=maximum, max_output=self.max_output_tokens,
            completion_tokens=completion_tokens, attempt=self._attempt, before_send=before_send)
        http = httpx2.AsyncClient(transport=bounded, trust_env=False, follow_redirects=False,
                                 verify=True, timeout=self._deadline)
        if resolved.protocol == "anthropic-messages":
            self._client = AsyncAnthropic(api_key=key, auth_token=None, credentials=None, config=None,
                profile=None, webhook_key="", base_url=self.base_url, max_retries=0, timeout=self._deadline,
                default_headers={}, default_query={}, middleware=[], http_client=http)
            model_type = AnthropicModel
        else:
            self._client = AsyncOpenAI(api_key=key, base_url=self.base_url, max_retries=0,
                organization="", project="", admin_api_key="", webhook_secret="", timeout=self._deadline,
                default_headers={}, default_query={}, http_client=http)
            model_type = OpenRouterModel if resolved.preset_id in {"openrouter", "minimax"} else OpenAIChatModel
        provider = _ConfiguredProvider(self._client, resolved.preset_id, self.base_url, profile)
        self._model = model_type(self.model_name, provider=provider, profile=profile)
        self._settings = {"max_tokens": self.max_output_tokens}
        if resolved.preset_id == "openai":
            self._settings["openai_store"] = False
        elif resolved.preset_id == "openrouter":
            self._settings["openrouter_provider"] = deepcopy(_ROUTER_POLICY)
        elif resolved.preset_id == "minimax":
            self._settings["extra_body"] = {"reasoning_split": True}
        if resolved.preset_id == "kimi" and completion_tokens:
            self._settings["openai_reasoning_effort"] = resolved.reasoning_effort or "low"

    def __repr__(self):
        return f"ModelConnectionPort(provider={self.provider_id!r}, model={self.model_name!r}, protocol={self.protocol!r})"


def _validate_connection_wire(value, preset, attempt):
    if type(value) is not dict:
        raise ProductModelError()
    # Only the source DTO's model-text bound differs. Validate that field at 256, then reuse
    # the same full structural/usage checks on a shallow validation view. SDK bytes stay intact.
    model = value.get("model")
    if type(model) is not str or not 1 <= len(model) <= 256:
        raise ProductModelError()
    check = {**value, "model": "bounded-model"}
    _validate_wire(check, "openai-chat" if preset == "openai" else preset, attempt)


class _ConnectionTransport(httpx2.AsyncBaseTransport):
    def __init__(self, inner, *, resolved, key, maximum, max_output, completion_tokens, attempt, before_send):
        self._inner, self._resolved, self._key = inner, resolved, key
        suffix = "/v1/messages" if resolved.protocol == "anthropic-messages" else "/chat/completions"
        self._url = httpx2.URL(resolved.base_url + suffix)
        self._maximum, self._max_output = maximum, max_output
        self._attempt, self._before_send = attempt, before_send
        self._output_field = "max_completion_tokens" if completion_tokens else "max_tokens"

    async def aclose(self):
        await self._inner.aclose()

    async def handle_async_request(self, request):
        try:
            resolved = self._resolved
            attempt = self._attempt.get()
            if attempt is None or attempt.count:
                raise ProductModelError()
            if resolved.protocol == "anthropic-messages" and request.url.query == b"beta=true":
                request.url = request.url.copy_with(query=None)
            if request.method != "POST" or request.url != self._url:
                raise ProductModelError()
            body = request.content
            if attempt.media is not None:
                try:
                    protocol = "anthropic-messages-v1" if resolved.protocol == "anthropic-messages" else "chat-completions-v1"
                    body = adapt_wire(body, attempt.media, provider=resolved.preset_id, protocol=protocol)
                except (WorkConflict, InvalidWork) as error:
                    raise ProductModelError(str(error) if str(error) == "task_limit" else "attachment_unavailable") from None
                request = httpx2.Request(request.method, request.url, headers=request.headers, content=body, extensions=request.extensions)
            elif len(body) > _REQUEST_BYTES:
                raise ProductModelError("task_limit")
            self._check_request(_json(body))
            headers = {"Host": request.url.netloc.decode("ascii"), "Content-Type": "application/json",
                       "Accept": "application/json", "Accept-Encoding": "identity", "Content-Length": str(len(body))}
            if resolved.protocol == "anthropic-messages":
                headers.update({"x-api-key": self._key, "anthropic-version": "2023-06-01"})
                if beta := request.headers.get("anthropic-beta"):
                    if len(beta) > 1024 or re.fullmatch(r"[a-zA-Z0-9,._-]+", beta) is None:
                        raise ProductModelError()
                    headers["anthropic-beta"] = beta
            else:
                headers["Authorization"] = "Bearer " + self._key
            request.headers.clear()
            request.headers.update(headers)
            if self._before_send is not None:
                await self._before_send()
            attempt.count += 1
            response = await self._inner.handle_async_request(request)
            try:
                if response.status_code in (401, 403):
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
                _validate_connection_wire(value, resolved.preset_id, attempt)
                if resolved.preset_id in {"openrouter", "minimax"}:
                    attempt.downstream_reported = "provider" in value
                    value.setdefault("provider", "")
                    message = value["choices"][0]["message"]
                    if not message.get("reasoning_details"):
                        plain = message.get("reasoning") or message.get("reasoning_content")
                        if plain:
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
        if (type(body) is not dict or body.get("model") != self._resolved.model_id
                or body.get("stream", False) is not False or body.get("n", 1) != 1
                or body.get("store", False) is not False or type(body.get(self._output_field)) is not int
                or body[self._output_field] != self._max_output):
            raise ProductModelError()
        if any(body.get(name) is not None for name in (
            "background", "previous_response_id", "conversation", "mcp_servers", "plugins", "container",
            "context_management", "web_search_options", "models", "service_tier")):
            raise ProductModelError()
        if self._resolved.preset_id == "openai" and body.get("store") is not False:
            raise ProductModelError()
        if self._resolved.preset_id == "openrouter" and body.get("provider") != _ROUTER_POLICY:
            raise ProductModelError()
        if self._resolved.preset_id == "minimax" and body.get("reasoning_split") is not True:
            raise ProductModelError()
        tools = body.get("tools", [])
        if type(tools) is not list or len(tools) > 64:
            raise ProductModelError()
        for tool in tools:
            if type(tool) is not dict or (tool.get("type") not in (None, "custom")
                    if self._resolved.protocol == "anthropic-messages" else tool.get("type") != "function"):
                raise ProductModelError()
