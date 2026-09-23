"""SDK adapters: the only two places the runtime touches the host.

``PortModel`` maps every SDK model step onto the model port and ``PortToolset``
maps every SDK tool call onto the tool port. Both are deliberately thin: they add
bounds, counters and authority checks, and they add no fallback. Neither raises
``ToolFailed`` or ``ModelRetry``, because the SDK converts exactly those two into
model-visible observations; anything else propagates and stops the run
(verified in RESEARCH.md §3.2).

The SDK's own argument validator is a pass-through by design: it is constructed as
``SchemaValidator(schema=core_schema.any_schema())`` and the SDK documents that
schema validation of the arguments is skipped for schema-built tools. Argument
validation is owned by :mod:`openbot_agent_runtime.catalog`.
"""

from __future__ import annotations

from typing import Any, Final

import pydantic_ai
from pydantic_ai.exceptions import UserError
from pydantic_ai.messages import ModelMessage, ModelMessagesTypeAdapter, ModelResponse, ToolCallPart
from pydantic_ai.models import Model, ModelRequestParameters
from pydantic_ai.settings import ModelSettings
from pydantic_ai.toolsets import AbstractToolset
from pydantic_ai.toolsets.abstract import ToolsetTool
from pydantic_core import SchemaValidator, core_schema

from .bounds import is_stream_like, json_utf8_size
from .catalog import ToolCatalog
from .contracts import ModelStepRequest, RuntimeLimits, ToolCallRequest, ToolDescriptor
from .errors import FailureReason, RuntimeFailure
from .guard import RunGuard

try:
    from temporalio import workflow as _temporal_workflow
except ImportError:
    # The standalone supervised Runtime deliberately has no Temporal dependency.
    _temporal_workflow = None


def _refuse_inline_temporal_tool() -> None:
    # TemporalDurability 2.47.0 does not wrap arbitrary AbstractToolset leaves. Without a
    # constructor-time DynamicToolset, this port would execute in replayable workflow code.
    if _temporal_workflow is not None and _temporal_workflow.in_workflow():
        raise UserError("OpenBot tool ports require a registered Temporal tool activity")

PASSTHROUGH_ARGS_VALIDATOR: Final = SchemaValidator(schema=core_schema.any_schema())
"""Accepts any argument shape so the SDK never rejects what this unit must judge."""

PORT_MODEL_NAME: Final = "openbot-port"
"""Placeholder identity. The real provider/model identity is Server-owned and is
carried by the model port, not invented here."""


def silence_sdk_startup_banner() -> None:
    """Keep stdout clean.

    The SDK prints a startup banner to stdout on the first agent run (observed by
    running the pinned build, not inferred). This unit is meant to be supervised as
    a process whose stdout is reserved for its own channel, so an incidental write
    to stdout is a defect rather than a cosmetic issue. The banner is switched off
    through the SDK's documented public flag instead of an environment variable the
    runtime does not own.
    """
    pydantic_ai.BANNER_ENABLED = False


class PortModel(Model):
    """A `Model` whose every step is a call to the host's model port."""

    def __init__(
        self,
        *,
        step_port: Any,
        catalog: ToolCatalog,
        guard: RunGuard,
        limits: RuntimeLimits,
    ) -> None:
        super().__init__()
        self._step_port = step_port
        self._catalog = catalog
        self._guard = guard
        self._limits = limits

    @property
    def model_name(self) -> str:
        return PORT_MODEL_NAME

    @property
    def system(self) -> str:
        return "openbot"

    async def request(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
    ) -> ModelResponse:
        guard = self._guard
        guard.check_sync("model step")
        step = guard.note_model_step()
        await guard.check("model step")
        bounded = _bounded_messages(messages, self._limits.message_bytes, guard)
        offered = self._offered_tools(model_request_parameters)
        await guard.progress("planning", f"Model step {step}.")
        # Progress is itself an awaited boundary, and a revocation or expiry can
        # happen while it runs (the Server's own loop re-checks authority after its
        # audit/progress await for the same reason). Re-check before any model-port
        # work so a step revoked during progress never reaches the model.
        await guard.check("model step")
        try:
            response = await self._step_port(
                ModelStepRequest(step=step, messages=bounded, tools=offered)
            )
        except RuntimeFailure:
            raise
        except Exception as exc:
            raise guard.fail(
                FailureReason.MODEL_PORT_ERROR,
                f"model port raised {type(exc).__name__} on step {step}",
            ) from exc
        await guard.check("model step")
        if not isinstance(response, ModelResponse):
            raise guard.fail(
                FailureReason.MODEL_RESPONSE_INVALID,
                f"model port returned {type(response).__name__}, not a ModelResponse",
            )
        # Reject ambiguous correlation before the SDK can schedule any tool from this response.
        ids: set[str] = set()
        for part in response.parts:
            if isinstance(part, ToolCallPart):
                if part.tool_call_id in ids:
                    raise guard.fail(
                        FailureReason.DUPLICATE_TOOL_CALL,
                        "model response contains duplicate tool call identifiers",
                    )
                ids.add(part.tool_call_id)
        return response

    def _offered_tools(
        self, model_request_parameters: ModelRequestParameters
    ) -> tuple[ToolDescriptor, ...]:
        """The descriptors actually offered in this step, in SDK order."""
        return tuple(
            self._catalog.descriptor(definition.name)
            for definition in model_request_parameters.function_tools
        )


class PortToolset(AbstractToolset[object]):
    """An `AbstractToolset` whose calls are host tool calls, never local effects."""

    def __init__(
        self,
        *,
        catalog: ToolCatalog,
        tool_port: Any,
        guard: RunGuard,
        limits: RuntimeLimits,
    ) -> None:
        super().__init__()
        self._catalog = catalog
        self._tool_port = tool_port
        self._guard = guard
        self._limits = limits

    @property
    def id(self) -> str:
        return "openbot-ports"

    async def get_tools(self, ctx: Any) -> dict[str, ToolsetTool[object]]:
        _refuse_inline_temporal_tool()
        self._guard.check_sync("tool catalog")
        return {
            name: ToolsetTool(
                toolset=self,
                tool_def=definition,
                max_retries=0,
                args_validator=PASSTHROUGH_ARGS_VALIDATOR,
            )
            for name, definition in self._catalog.sdk_definitions().items()
        }

    async def call_tool(
        self, name: str, tool_args: dict[str, Any], ctx: Any, tool: ToolsetTool[object]
    ) -> Any:
        _refuse_inline_temporal_tool()
        guard = self._guard
        guard.check_sync("tool call")
        call_id = ctx.tool_call_id
        if not isinstance(call_id, str) or not call_id:
            raise guard.fail(
                FailureReason.TOOL_CALL_UNIDENTIFIED,
                f"tool {name!r} arrived without an SDK call identifier",
            )
        self._catalog.descriptor(name)
        arguments = self._catalog.validate_arguments(name, tool_args)
        guard.note_tool_call(name, call_id)
        await guard.progress("observation", f"Calling {name}.")
        await guard.check("tool call")
        try:
            result = await self._tool_port(
                ToolCallRequest(name=name, arguments=arguments, call_id=call_id)
            )
        except RuntimeFailure:
            raise
        except Exception as exc:
            raise guard.fail(
                FailureReason.TOOL_PORT_ERROR, f"tool port raised {type(exc).__name__} for {name!r}"
            ) from exc
        await guard.check("tool call")
        payload = _bounded_tool_result(result, name, self._limits.tool_result_bytes, guard)
        await guard.progress("observation", f"Completed {name}.")
        return payload


def _bounded_messages(
    messages: list[ModelMessage], limit: int, guard: RunGuard
) -> tuple[ModelMessage, ...]:
    """Bound the exact bytes handed to the model port, fail closed when exceeded."""
    try:
        payload = ModelMessagesTypeAdapter.dump_json(messages)
    except Exception as exc:
        raise guard.fail(
            FailureReason.INVALID_REQUEST,
            f"model messages are not a valid sequence: {type(exc).__name__}",
        ) from exc
    if len(payload) > limit:
        raise guard.fail(
            FailureReason.MESSAGE_LIMIT,
            f"model messages occupy {len(payload)} bytes, above the limit of {limit}",
        )
    return tuple(messages)


def _bounded_tool_result(result: Any, name: str, limit: int, guard: RunGuard) -> Any:
    """Require exactly one JSON value within the byte bound. Never truncate."""
    if is_stream_like(result):
        raise guard.fail(
            FailureReason.TOOL_RESULT_INVALID,
            f"tool {name!r} returned a stream; one completed JSON value is required",
        )
    try:
        size = json_utf8_size(result)
    except (TypeError, ValueError) as exc:
        raise guard.fail(
            FailureReason.TOOL_RESULT_INVALID,
            f"tool {name!r} returned a value with no JSON form: {type(exc).__name__}",
        ) from exc
    if size > limit:
        raise guard.fail(
            FailureReason.TOOL_RESULT_LIMIT,
            f"tool {name!r} returned {size} bytes, above the limit of {limit}",
        )
    return result


__all__ = [
    "PASSTHROUGH_ARGS_VALIDATOR",
    "PORT_MODEL_NAME",
    "PortModel",
    "PortToolset",
    "silence_sdk_startup_banner",
]
