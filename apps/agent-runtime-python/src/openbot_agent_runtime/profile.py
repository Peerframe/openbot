"""The frozen application profile: JSON-RPC shapes and SDK translation.

Three things live here and nothing else:

* the exact object shapes ``docs/AGENT_RUNTIME_PROTOCOL.md`` freezes for the one
  parent request and the three child request/response pairs;
* the translation from SDK messages to wire messages, and back;
* the refusal vocabulary for a payload that does not match.

The split between this module and :mod:`openbot_agent_runtime.wire` is deliberate
and load-bearing. ``wire`` judges the *channel* and refuses with a fixed JSON-RPC
error, closing it. This module judges the *payload* of an otherwise well-formed
exchange and refuses the run. A malformed envelope and a well-formed envelope that
carries an unsatisfiable payload are different events with different outcomes, so
they are never collapsed into one another.

Translation is strict in one direction for a verified reason: the SDK's own
``ToolCallPart.args_as_dict()`` deliberately degrades malformed or non-object
arguments into ``{"INVALID_JSON": "<raw>"}`` so that a *model API* can still be
called during a retry flow. Sending that wrapper onward would hand the Server a
fabricated object in place of arguments it must validate, so this module parses
the arguments itself and refuses anything that is not an object.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    ModelResponsePart,
    RequestUsage,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)

from .bounds import json_utf8_size
from .contracts import ToolDescriptor
from .errors import FailureReason, RuntimeFailure
from .wire import (
    INVALID_PARAMS_CODE,
    INVALID_REQUEST_CODE,
    METHOD_NOT_FOUND_CODE,
    PROTOCOL_NAME,
    ProtocolViolation,
)

CONTROL_PROMPT: Final = "Continue the Server-bound task."
"""The fixed control prompt. The Server replaces it with the original admitted
messages and retains the instructions and media; it is never the real task."""

PARENT_REQUEST_ID: Final = "run"
EXECUTE_METHOD: Final = "runtime.execute"
AUTHORITY_METHOD: Final = "authority.check"
MODEL_METHOD: Final = "model.generate"
TOOL_METHOD: Final = "tool.execute"

MAX_TOOLS: Final = 64
MAX_TOOL_CATALOG_BYTES: Final = 64 * 1024
MIN_DEADLINE_MS: Final = 1
MAX_DEADLINE_MS: Final = 300_000

MAX_WIRE_MESSAGES: Final = 128
MAX_WIRE_MESSAGE_BYTES: Final = 256 * 1024

MAX_MODEL_TOOL_INTENTS: Final = 64
"""Runtime-local bound on the tool intents of one model response.

The profile bounds the frame but not this array, so a response could ask for
thousands of calls that the unit's own tool-call counter would refuse one by one.
This bound refuses the response before the parts are built; it is below nothing the
Server declares, since a catalog has at most :data:`MAX_TOOLS` tools."""

MAX_TOOL_CALL_ID_CHARS: Final = 256
"""Runtime-local bound on a tool-call identifier, long enough for a provider id or
the SDK's generated ``pyd_ai_<uuid>`` stand-in."""


@dataclass(frozen=True, slots=True)
class ExecuteRequest:
    """The parent's one request, already bounded and shape-checked."""

    tools: tuple[ToolDescriptor, ...]
    deadline_ms: int


@dataclass(frozen=True, slots=True)
class ToolIntent:
    """One tool call the Server's model response asked for."""

    call_id: str
    name: str
    arguments: Mapping[str, Any]


# --- inbound: the parent's request --------------------------------------------


def parse_execute_request(value: Any) -> ExecuteRequest:
    """Validate the single ``runtime.execute`` request or refuse the channel.

    Shape errors here are protocol errors: the parent and this process disagree
    about the envelope, so the invocation cannot be interpreted at all.
    """
    envelope = _require_object(value, INVALID_REQUEST_CODE)
    _require_keys(envelope, {"jsonrpc", "id", "method", "params"}, INVALID_REQUEST_CODE)
    if envelope["jsonrpc"] != "2.0":
        raise ProtocolViolation(INVALID_REQUEST_CODE)
    method = envelope["method"]
    if not isinstance(method, str):
        raise ProtocolViolation(INVALID_REQUEST_CODE)
    if method != EXECUTE_METHOD:
        raise ProtocolViolation(METHOD_NOT_FOUND_CODE)
    if envelope["id"] != PARENT_REQUEST_ID:
        raise ProtocolViolation(INVALID_REQUEST_CODE)

    params = _require_object(envelope["params"], INVALID_PARAMS_CODE)
    _require_keys(params, {"protocol", "tools", "deadlineMs"}, INVALID_PARAMS_CODE)
    if params["protocol"] != PROTOCOL_NAME:
        raise ProtocolViolation(INVALID_PARAMS_CODE)

    tools_raw = params["tools"]
    if not isinstance(tools_raw, list) or len(tools_raw) > MAX_TOOLS:
        raise ProtocolViolation(INVALID_PARAMS_CODE)
    descriptors: list[ToolDescriptor] = []
    for item in tools_raw:
        entry = _require_object(item, INVALID_PARAMS_CODE)
        _require_keys(entry, {"name", "description", "inputSchema"}, INVALID_PARAMS_CODE)
        name, description, schema = entry["name"], entry["description"], entry["inputSchema"]
        if not isinstance(name, str) or not isinstance(description, str):
            raise ProtocolViolation(INVALID_PARAMS_CODE)
        if not isinstance(schema, dict):
            raise ProtocolViolation(INVALID_PARAMS_CODE)
        descriptors.append(
            ToolDescriptor(name=name, description=description, input_schema=schema)
        )
    declared = [
        {"name": item.name, "description": item.description, "inputSchema": item.input_schema}
        for item in descriptors
    ]
    if _json_size(declared, INVALID_PARAMS_CODE) > MAX_TOOL_CATALOG_BYTES:
        raise ProtocolViolation(INVALID_PARAMS_CODE)

    deadline = params["deadlineMs"]
    if isinstance(deadline, bool) or not isinstance(deadline, int):
        raise ProtocolViolation(INVALID_PARAMS_CODE)
    if deadline < MIN_DEADLINE_MS or deadline > MAX_DEADLINE_MS:
        raise ProtocolViolation(INVALID_PARAMS_CODE)

    # Deeper tool validation (name grammar, object schema, schema validity) is the
    # unit's catalog, which the executor runs before any model step. A schema the
    # catalog refuses is a payload refusal of the run, not a channel failure.
    return ExecuteRequest(tools=tuple(descriptors), deadline_ms=deadline)


# --- outbound: child requests -------------------------------------------------


def wire_messages(messages: Sequence[ModelMessage]) -> list[dict[str, Any]]:
    """Translate the SDK conversation into the three admitted wire shapes.

    Mapping rules, all from the frozen profile: parts are emitted in order; a
    ``ModelRequest`` contributes its user prompt and its tool returns; consecutive
    tool returns merge into one ``tool`` message; a ``ModelResponse`` becomes one
    ``assistant`` message. Anything the profile does not admit — a system role, a
    second user message, media, a retry prompt, a provider option, an unknown SDK
    part — is refused rather than dropped, because dropping it would silently
    change what the Server's model sees.
    """
    out: list[dict[str, Any]] = []
    pending_returns: list[dict[str, Any]] = []
    user_seen = False

    def flush_returns() -> None:
        if pending_returns:
            out.append({"role": "tool", "content": list(pending_returns)})
            pending_returns.clear()

    for message in messages:
        if isinstance(message, ModelRequest):
            if getattr(message, "instructions", None):
                _refuse(
                    FailureReason.MESSAGE_LIMIT,
                    "this profile carries no instructions; the Server retains them",
                )
            for part in message.parts:
                if isinstance(part, UserPromptPart):
                    flush_returns()
                    content = part.content
                    if user_seen or content != CONTROL_PROMPT:
                        _refuse(
                            FailureReason.MESSAGE_LIMIT,
                            "the control prompt must appear exactly once, first",
                        )
                    user_seen = True
                    out.append({"role": "user", "content": CONTROL_PROMPT})
                elif isinstance(part, ToolReturnPart):
                    pending_returns.append(_tool_result_part(part))
                else:
                    _refuse(
                        FailureReason.MESSAGE_LIMIT,
                        f"unsupported SDK request part {type(part).__name__}",
                    )
        elif isinstance(message, ModelResponse):
            flush_returns()
            if not message.parts:
                _refuse(FailureReason.MODEL_RESPONSE_INVALID, "empty SDK model response")
            out.append(
                {"role": "assistant", "content": [_assistant_part(part) for part in message.parts]}
            )
        else:
            _refuse(
                FailureReason.MESSAGE_LIMIT,
                f"unsupported SDK message type {type(message).__name__}",
            )
    flush_returns()

    if not out or out[0].get("role") != "user":
        _refuse(FailureReason.MESSAGE_LIMIT, "the control prompt must be the first message")
    return out


def bound_wire_messages(payload: Sequence[Mapping[str, Any]]) -> None:
    """Refuse an over-long or over-large translated message array."""
    if len(payload) > MAX_WIRE_MESSAGES:
        _refuse(
            FailureReason.MESSAGE_LIMIT,
            f"translated history has {len(payload)} entries, above {MAX_WIRE_MESSAGES}",
        )
    try:
        size = json_utf8_size(list(payload))
    except (TypeError, ValueError) as exc:
        _refuse(FailureReason.MESSAGE_LIMIT, f"translated history has no JSON form: {type(exc).__name__}")
        raise AssertionError("unreachable") from exc
    if size > MAX_WIRE_MESSAGE_BYTES:
        _refuse(
            FailureReason.MESSAGE_LIMIT,
            f"translated history occupies {size} bytes, above {MAX_WIRE_MESSAGE_BYTES}",
        )


# --- inbound: child responses -------------------------------------------------


def parse_authority_result(value: Any) -> None:
    """``authority.check`` succeeds with exactly ``{}`` and nothing else."""
    _require_payload_object(value, frozenset(), FailureReason.AUTHORITY_INVALID)


def model_response_from_wire(value: Any) -> ModelResponse:
    """Build the real SDK model response the Server's answer describes.

    When the answer reports no token counts, the SDK's own default counter is left
    in place. Python has no usage-report method in this profile, so an unreported
    count can never be presented to the Server as an observed zero.
    """
    result = _require_payload_object(
        value, frozenset({"text", "tools", "usage"}), FailureReason.MODEL_RESPONSE_INVALID
    )
    text = result["text"]
    if not isinstance(text, str):
        _refuse(FailureReason.MODEL_RESPONSE_INVALID, "model text must be a string")

    intents_raw = result["tools"]
    if not isinstance(intents_raw, list) or len(intents_raw) > MAX_MODEL_TOOL_INTENTS:
        _refuse(
            FailureReason.MODEL_RESPONSE_INVALID,
            f"model tool intents must be a list of at most {MAX_MODEL_TOOL_INTENTS}",
        )

    parts: list[ModelResponsePart] = []
    if text:
        parts.append(TextPart(text))
    for item in intents_raw:
        intent = _tool_intent(item)
        parts.append(
            ToolCallPart(intent.name, dict(intent.arguments), tool_call_id=intent.call_id)
        )

    usage = _request_usage(result["usage"])
    if usage is None:
        return ModelResponse(parts=parts)
    return ModelResponse(parts=parts, usage=usage)


def parse_tool_result(value: Any) -> Any:
    """``tool.execute`` succeeds with exactly ``{value: JSON}``; return the value.

    The value is passed on unexamined here: the unit owns the one-JSON-value and
    byte-bound checks, and it refuses rather than truncates.
    """
    result = _require_payload_object(value, frozenset({"value"}), FailureReason.TOOL_RESULT_INVALID)
    return result["value"]


def refusal_reason_for(method: str) -> FailureReason:
    """The runtime reason for a JSON-RPC ``error`` reply to ``method``.

    The Server owns its own reason vocabulary and its own final mapping, so its
    reason text is never echoed into this process's output: the method that was
    refused is what selects a runtime reason here.
    """
    if method == AUTHORITY_METHOD:
        return FailureReason.AUTHORITY_REVOKED
    if method == MODEL_METHOD:
        return FailureReason.MODEL_PORT_ERROR
    if method == TOOL_METHOD:
        return FailureReason.TOOL_PORT_ERROR
    return FailureReason.UNEXPECTED


# --- translation helpers ------------------------------------------------------


def _assistant_part(part: Any) -> dict[str, Any]:
    if isinstance(part, TextPart):
        if not isinstance(part.content, str):
            _refuse(FailureReason.MODEL_RESPONSE_INVALID, "model text part is not text")
        return {"type": "text", "text": part.content}
    if isinstance(part, ToolCallPart):
        call_id = _bounded_call_id(part.tool_call_id)
        name = part.tool_name
        if not isinstance(name, str) or not name:
            _refuse(FailureReason.MODEL_RESPONSE_INVALID, "tool call has no name")
        return {
            "type": "tool-call",
            "toolCallId": call_id,
            "toolName": name,
            "input": _tool_arguments(part.args),
        }
    _refuse(
        FailureReason.MODEL_RESPONSE_INVALID,
        f"unsupported SDK model part {type(part).__name__}",
    )
    raise AssertionError("unreachable")


def _tool_arguments(raw: Any) -> dict[str, Any]:
    """Require an object, including when the adapter supplied a JSON string.

    Deliberately not ``args_as_dict()``: that helper substitutes
    ``{"INVALID_JSON": ...}`` for malformed input so a provider can be retried, and
    forwarding that wrapper would fabricate arguments.
    """
    if raw is None:
        return {}
    if isinstance(raw, Mapping):
        parsed: Any = dict(raw)
    elif isinstance(raw, str):
        try:
            parsed = json.loads(raw, parse_constant=_reject_constant)
        except (ValueError, RecursionError) as exc:
            _refuse(
                FailureReason.MODEL_RESPONSE_INVALID,
                f"tool arguments are not valid JSON: {type(exc).__name__}",
            )
            raise AssertionError("unreachable") from exc
    else:
        _refuse(
            FailureReason.MODEL_RESPONSE_INVALID,
            f"tool arguments are {type(raw).__name__}, not an object",
        )
        raise AssertionError("unreachable")
    if not isinstance(parsed, dict):
        _refuse(FailureReason.MODEL_RESPONSE_INVALID, "tool arguments must be a JSON object")
    try:
        json_utf8_size(parsed)
    except (TypeError, ValueError) as exc:
        _refuse(
            FailureReason.MODEL_RESPONSE_INVALID,
            f"tool arguments have no JSON form: {type(exc).__name__}",
        )
        raise AssertionError("unreachable") from exc
    return parsed


def _tool_result_part(part: ToolReturnPart) -> dict[str, Any]:
    call_id = _bounded_call_id(part.tool_call_id)
    name = part.tool_name
    if not isinstance(name, str) or not name:
        _refuse(FailureReason.TOOL_RESULT_INVALID, "tool return has no name")
    outcome = getattr(part, "outcome", "success")
    if outcome != "success":
        # The admitted wire shape cannot express a denied, failed or interrupted
        # tool outcome, and this unit never creates one: a failed tool call ends the
        # run. Refusing beats flattening it into an opaque value.
        _refuse(
            FailureReason.TOOL_RESULT_INVALID,
            f"tool return outcome {outcome!r} has no wire shape",
        )
    try:
        json_utf8_size(part.content)
    except (TypeError, ValueError) as exc:
        _refuse(
            FailureReason.TOOL_RESULT_INVALID,
            f"tool return value has no JSON form: {type(exc).__name__}",
        )
        raise AssertionError("unreachable") from exc
    return {
        "type": "tool-result",
        "toolCallId": call_id,
        "toolName": name,
        "output": {"type": "json", "value": part.content},
    }


def _tool_intent(value: Any) -> ToolIntent:
    entry = _require_payload_object(
        value, frozenset({"id", "name", "arguments"}), FailureReason.MODEL_RESPONSE_INVALID
    )
    call_id = _bounded_call_id(entry["id"], reason=FailureReason.MODEL_RESPONSE_INVALID)
    name = entry["name"]
    if not isinstance(name, str) or not name:
        _refuse(FailureReason.MODEL_RESPONSE_INVALID, "tool intent has no name")
    arguments = entry["arguments"]
    if not isinstance(arguments, dict):
        _refuse(FailureReason.MODEL_RESPONSE_INVALID, "tool intent arguments must be an object")
    try:
        json_utf8_size(arguments)
    except (TypeError, ValueError) as exc:
        _refuse(
            FailureReason.MODEL_RESPONSE_INVALID,
            f"tool intent arguments have no JSON form: {type(exc).__name__}",
        )
        raise AssertionError("unreachable") from exc
    return ToolIntent(call_id=call_id, name=name, arguments=arguments)


def _request_usage(value: Any) -> RequestUsage | None:
    entry = _require_payload_object(
        value, frozenset({"inputTokens", "outputTokens"}), FailureReason.MODEL_RESPONSE_INVALID
    )
    fields: dict[str, int] = {}
    for wire_key, sdk_key in (("inputTokens", "input_tokens"), ("outputTokens", "output_tokens")):
        count = entry[wire_key]
        if count is None:
            continue
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            _refuse(
                FailureReason.MODEL_RESPONSE_INVALID,
                f"{wire_key} must be a non-negative integer or null",
            )
        fields[sdk_key] = count
    if not fields:
        return None
    return RequestUsage(**fields)


def _bounded_call_id(value: Any, *, reason: FailureReason = FailureReason.MODEL_RESPONSE_INVALID) -> str:
    if not isinstance(value, str) or not value or len(value) > MAX_TOOL_CALL_ID_CHARS:
        _refuse(
            reason,
            f"tool call identifiers must be strings of 1..{MAX_TOOL_CALL_ID_CHARS} characters",
        )
    return value


def _reject_constant(name: str) -> Any:
    raise ValueError(f"non-finite JSON literal {name}")


def _require_object(value: Any, code: int) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProtocolViolation(code)
    return value


def _require_keys(value: Mapping[str, Any], expected: set[str] | frozenset[str], code: int) -> None:
    if set(value) != set(expected):
        raise ProtocolViolation(code)


def _json_size(value: Any, code: int) -> int:
    try:
        return json_utf8_size(value)
    except (TypeError, ValueError) as exc:
        raise ProtocolViolation(code) from exc


def _require_payload_object(
    value: Any, expected: frozenset[str], reason: FailureReason
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != set(expected):
        _refuse(reason, "the response payload does not match the frozen shape")
    return value


def _refuse(reason: FailureReason, detail: str) -> None:
    """Raise a runtime refusal for a payload that cannot be honoured."""
    raise RuntimeFailure(reason, detail)


__all__ = [
    "AUTHORITY_METHOD",
    "CONTROL_PROMPT",
    "EXECUTE_METHOD",
    "ExecuteRequest",
    "MAX_DEADLINE_MS",
    "MAX_MODEL_TOOL_INTENTS",
    "MAX_TOOL_CALL_ID_CHARS",
    "MAX_TOOL_CATALOG_BYTES",
    "MAX_TOOLS",
    "MAX_WIRE_MESSAGES",
    "MAX_WIRE_MESSAGE_BYTES",
    "MIN_DEADLINE_MS",
    "MODEL_METHOD",
    "PARENT_REQUEST_ID",
    "TOOL_METHOD",
    "ToolIntent",
    "bound_wire_messages",
    "model_response_from_wire",
    "parse_authority_result",
    "parse_execute_request",
    "parse_tool_result",
    "refusal_reason_for",
    "wire_messages",
]
