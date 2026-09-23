"""Strict parent-side codec for the frozen ``openbot-agent-runtime/1`` profile.

The acceptance target is ``apps/server/src/agent-runtime-wire.ts`` running on the released
MCP/Zod codecs. This module is the *parent* half of that profile; the worker half lives in the
Agent Runtime package, which is deliberately never imported here (its initializer loads the model
SDK, which must not become a trusted-control dependency).

Everything asserted by this module was probed first against the real TypeScript profile. Three
differences remain and are documented rather than hidden, because the parent decodes bytes it did
not create:

* duplicate JSON object keys are refused, while ``JSON.parse`` silently keeps the last one;
* unpaired surrogates in a decoded string are refused, while a JSON ``\\udXXX`` escape survives
  ``JSON.parse``. A Python ``str`` holding one cannot be re-encoded as UTF-8, so admitting it would
  create a value this profile can never send back;
* the decoder enforces framing only. The TypeScript reader also applies the released MCP JSON-RPC
  union, so it refuses ``{"foo": 1}`` before the profile schema ever sees it. Every decoded frame
  reaches :func:`validate_worker_message` before a callback, so the seam refuses it there as well.

The profile itself is defined by ``docs/AGENT_RUNTIME_PROTOCOL.md``; no new key, limit or wire
method is introduced here.
"""

import json
import math
import re
from typing import NoReturn

PROTOCOL_FAILURE_TEXT = "Runtime protocol violation."

RUNTIME_PROTOCOL = "openbot-agent-runtime/1"

# ``RuntimeFrameReader`` / ``RuntimeFrameWriter`` bounds. A frame is its LF-terminated line; the
# per-frame bound excludes the LF. The direction bound counts every byte received in one direction.
RUNTIME_FRAME_BYTES = 524_288
RUNTIME_TOTAL_BYTES = 8 * 1024 * 1024
RUNTIME_MAX_FRAMES = 1024

# ``assertRuntimeJson``: values are rejected once a node sits deeper than this many ancestors.
RUNTIME_MAX_DEPTH = 64

# ``RuntimeWorkerMessageSchema`` bounds.
RUNTIME_DENIAL_CODE = -32000
RUNTIME_DENIAL_MESSAGE = "Runtime operation refused"
RUNTIME_MAX_DENIAL_REASON = 64
RUNTIME_FINAL_TEXT_MAX = 8000
RUNTIME_MAX_INTENT_ID = 256
RUNTIME_MAX_TOOL_NAME = 64
RUNTIME_MAX_MESSAGES = 128

# ``runtime.execute`` params bounds; the catalog byte bound is the host's publication bound.
RUNTIME_MAX_TOOL_DESCRIPTORS = 64
RUNTIME_CATALOG_BYTES = 64 * 1024
RUNTIME_DEADLINE_MS_MIN = 1
RUNTIME_DEADLINE_MS_MAX = 300_000

# The sequence bound is a process-layer rule: the schema alone admits ``w1``..``w999``.
RUNTIME_MAX_WORKER_ID = 512

# Zod measures string length in Unicode code points, which is exactly Python's ``len`` on ``str``.
# The oracle was asked directly: 8_000 astral characters pass ``.max(8000)`` and 8_001 fail, so a
# limit here is never a UTF-16 code-unit count.
_JSONRPC_VERSION = "2.0"

# Anchored in the reference; matched with ``fullmatch`` here so the Python-only ``$``-before-newline
# behaviour of the pattern language cannot widen the accepted set.
_WORKER_ID_PATTERN = re.compile(r"w[1-9][0-9]{0,2}")
_DENIAL_REASON_PATTERN = re.compile(r"[a-z0-9_]{1,%d}" % RUNTIME_MAX_DENIAL_REASON)

# HTML/XML parsers and JSON do not share rules; only the RFC 8259 productions are admitted.
_SURROGATE_PATTERN = re.compile("[\ud800-\udfff]")

_RESULT_KEYS = frozenset(("jsonrpc", "id", "result"))
_DENIAL_KEYS = frozenset(("jsonrpc", "id", "error"))
_REQUEST_KEYS = frozenset(("jsonrpc", "id", "method", "params"))
_INVOCATION_KEYS = frozenset(("jsonrpc", "id", "method", "params"))
_INVOCATION_PARAM_KEYS = frozenset(("protocol", "tools", "deadlineMs"))
_TOOL_DESCRIPTOR_KEYS = frozenset(("name", "description", "inputSchema"))
_INTENT_KEYS = frozenset(("id", "name", "arguments"))


class RuntimeProtocolError(Exception):
    """A frame or value outside the frozen profile.

    The message is fixed and never derived from the value under test: a refusal must not echo
    child-supplied text into a Server-visible error.
    """

    def __init__(self) -> None:
        super().__init__(PROTOCOL_FAILURE_TEXT)


def _refuse() -> NoReturn:
    raise RuntimeProtocolError()


def _fits_double(value: int) -> bool:
    """``JSON.parse`` rounds every integer literal to a double; one that overflows is not finite."""
    try:
        return math.isfinite(float(value))
    except OverflowError:
        return False


def assert_json_value(value: object) -> None:
    """``assertRuntimeJson``: bound nesting depth and require every number to be finite.

    Iterative on purpose: the bound must hold for a value that is too deep to walk recursively.
    Containers contribute their own level, so the root sits at depth 0.
    """
    pending: list[tuple[object, int]] = [(value, 0)]
    while pending:
        item, depth = pending.pop()
        if depth > RUNTIME_MAX_DEPTH:
            _refuse()
        if item is None or isinstance(item, bool):
            continue
        if isinstance(item, str):
            if _SURROGATE_PATTERN.search(item) is not None:
                _refuse()
            continue
        if isinstance(item, int):
            if not _fits_double(item):
                _refuse()
            continue
        if isinstance(item, float):
            if not math.isfinite(item):
                _refuse()
            continue
        if isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
            continue
        if isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str) or _SURROGATE_PATTERN.search(key) is not None:
                    _refuse()
                pending.append((child, depth + 1))
            continue
        _refuse()


def _serialize(value: object) -> bytes:
    """``JSON.stringify`` + UTF-8, without the line feed. Never truncates and never pads."""
    try:
        text = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError, UnicodeEncodeError):  # non-JSON value, or a surrogate escape
        _refuse()
    try:
        return text.encode("utf-8")
    except UnicodeEncodeError:
        _refuse()


def _duplicate_rejecting_pairs(pairs: list[tuple[str, object]]) -> dict:
    result: dict[str, object] = {}
    for key, item in pairs:
        if key in result:
            _refuse()
        result[key] = item
    return result


def _reject_constant(_name: str) -> NoReturn:
    """``NaN``/``Infinity``/``-Infinity`` are not JSON; the constants must not become numbers."""
    _refuse()


def _decode_frame(raw: bytes) -> object:
    """Decode one frame's content: fatal UTF-8, strict JSON, bounded depth, one trailing CR removed.

    ``ReadBuffer.readMessage`` strips a single trailing carriage return, so a CRLF writer is
    admitted by the reference and is admitted here. Python's ``str.strip()`` must not be used here:
    only the line feed terminates a frame.
    """
    if raw.endswith(b"\r"):
        raw = raw[:-1]
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        _refuse()
    try:
        value = json.loads(
            text,
            object_pairs_hook=_duplicate_rejecting_pairs,
            parse_constant=_reject_constant,
        )
    except RuntimeProtocolError:
        raise
    except (ValueError, RecursionError):  # malformed JSON, or nesting beyond the parser's stack
        _refuse()
    assert_json_value(value)
    return value


class FrameDecoder:
    """``RuntimeFrameReader``: LF framing, fatal UTF-8, and every direction bound applied first."""

    def __init__(self) -> None:
        self._pending = bytearray()
        self._bytes = 0
        self._frames = 0

    def push(self, chunk: bytes) -> list[dict]:
        """Feed received bytes; return the frames they completed, in order.

        Raises ``RuntimeProtocolError`` and returns nothing if any bound is exceeded, so a caller
        can never observe a prefix of a refused chunk.
        """
        if not isinstance(chunk, (bytes, bytearray, memoryview)):
            _refuse()
        view = bytes(chunk)
        self._bytes += len(view)
        if self._bytes > RUNTIME_TOTAL_BYTES:
            _refuse()
        frames: list[dict] = []
        offset = 0
        while True:
            newline = view.find(b"\n", offset)
            end = len(view) if newline < 0 else newline
            self._pending += view[offset:end]
            if len(self._pending) > RUNTIME_FRAME_BYTES:
                _refuse()
            if newline < 0:
                break
            self._frames += 1
            if self._frames > RUNTIME_MAX_FRAMES:
                _refuse()
            value = _decode_frame(bytes(self._pending))
            self._pending.clear()
            if not isinstance(value, dict):
                # The reference reader applies the released MCP JSON-RPC union, which admits only
                # objects; a batch, scalar or array is refused there and here.
                _refuse()
            frames.append(value)
            offset = newline + 1
        return frames

    def finish(self) -> None:
        """Refuse a stream that ended inside a frame. A decoded frame is never held back."""
        if self._pending:
            _refuse()


class FrameEncoder:
    """``RuntimeFrameWriter``: same three bounds, applied to what this side is about to send."""

    def __init__(self) -> None:
        self._bytes = 0
        self._frames = 0

    def encode(self, value: dict) -> bytes:
        """Return one LF-terminated frame, or refuse. The result is never a truncated encoding."""
        if not isinstance(value, dict):
            _refuse()
        assert_json_value(value)
        frame = _serialize(value)
        self._bytes += len(frame) + 1
        self._frames += 1
        if (
            len(frame) > RUNTIME_FRAME_BYTES
            or self._bytes > RUNTIME_TOTAL_BYTES
            or self._frames > RUNTIME_MAX_FRAMES
        ):
            _refuse()
        return frame + b"\n"


def _strict_object(value: object, keys: frozenset[str]) -> dict:
    """``z.strictObject``: a plain object with exactly these keys and no others."""
    if not isinstance(value, dict):
        _refuse()
    if frozenset(value.keys()) != keys:
        _refuse()
    return value


def _bounded_text(value: object, maximum: int | None = None, minimum: int = 0) -> str:
    """``z.string().min().max()`` measured in Unicode code points; ``None`` is unbounded."""
    if not isinstance(value, str):
        _refuse()
    length = len(value)
    if length < minimum or (maximum is not None and length > maximum):
        _refuse()
    return value


def _json_object(value: object) -> dict:
    """``z.record(z.string(), z.json())``: an object whose values are JSON, already depth-bounded."""
    if not isinstance(value, dict):
        _refuse()
    return value


def _validate_text_part(part: object) -> dict:
    item = _strict_object(part, frozenset(("type", "text")))
    if item["type"] != "text":
        _refuse()
    # The reference is ``z.string()``: a text part has no length bound of its own.
    return {"type": "text", "text": _bounded_text(item["text"])}


def _validate_tool_call_part(part: object) -> dict:
    item = _strict_object(part, frozenset(("type", "toolCallId", "toolName", "input")))
    if item["type"] != "tool-call":
        _refuse()
    return {
        "type": "tool-call",
        "toolCallId": _bounded_text(item["toolCallId"], RUNTIME_MAX_INTENT_ID, minimum=1),
        "toolName": _bounded_text(item["toolName"], RUNTIME_MAX_TOOL_NAME, minimum=1),
        "input": _json_object(item["input"]),
    }


def _validate_tool_result_part(part: object) -> dict:
    item = _strict_object(part, frozenset(("type", "toolCallId", "toolName", "output")))
    if item["type"] != "tool-result":
        _refuse()
    output = _strict_object(item["output"], frozenset(("type", "value")))
    if output["type"] != "json":
        _refuse()
    return {
        "type": "tool-result",
        "toolCallId": _bounded_text(item["toolCallId"], RUNTIME_MAX_INTENT_ID, minimum=1),
        "toolName": _bounded_text(item["toolName"], RUNTIME_MAX_TOOL_NAME, minimum=1),
        "output": {"type": "json", "value": output["value"]},
    }


def _validate_wire_message(value: object) -> dict:
    """One ``wireMessageSchema`` branch: user text, assistant text/tool-call parts, tool results."""
    if not isinstance(value, dict):
        _refuse()
    role = value.get("role")
    if role == "user":
        item = _strict_object(value, frozenset(("role", "content")))
        content = item["content"]
        if not isinstance(content, str):
            _refuse()
        return {"role": "user", "content": content}
    if role == "assistant":
        item = _strict_object(value, frozenset(("role", "content")))
        content = item["content"]
        if not isinstance(content, list) or not content:
            _refuse()
        parts = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "tool-call":
                parts.append(_validate_tool_call_part(part))
            else:
                parts.append(_validate_text_part(part))
        return {"role": "assistant", "content": parts}
    if role == "tool":
        item = _strict_object(value, frozenset(("role", "content")))
        content = item["content"]
        if not isinstance(content, list) or not content:
            _refuse()
        return {"role": "tool", "content": [_validate_tool_result_part(part) for part in content]}
    _refuse()


def _validate_intent(value: object) -> dict:
    """``RuntimeIntentSchema``: the model's proposal, which grants nothing by itself."""
    item = _strict_object(value, _INTENT_KEYS)
    return {
        "id": _bounded_text(item["id"], RUNTIME_MAX_INTENT_ID, minimum=1),
        "name": _bounded_text(item["name"], RUNTIME_MAX_TOOL_NAME, minimum=1),
        "arguments": _json_object(item["arguments"]),
    }


def validate_worker_message(value: object) -> dict:
    """Validate one decoded worker frame against the current union, and return its parsed shape.

    The result is a fresh object with exactly the union's keys, so a caller never sees a key the
    profile does not define.
    """
    assert_json_value(value)
    if not isinstance(value, dict):
        _refuse()
    if value.get("jsonrpc") != _JSONRPC_VERSION:
        _refuse()
    keys = frozenset(value.keys())
    identity = value["id"] if "id" in value else None

    if keys == _RESULT_KEYS and identity == "run":
        result = _strict_object(value["result"], frozenset(("text",)))
        text = _bounded_text(result["text"], RUNTIME_FINAL_TEXT_MAX, minimum=1)
        # Blank-only text is refused by the supervisor, not by the schema, exactly as in the
        # reference: the wire layer must not invent a rule Zod does not have.
        return {"jsonrpc": _JSONRPC_VERSION, "id": "run", "result": {"text": text}}

    if keys == _DENIAL_KEYS and identity == "run":
        error = _strict_object(value["error"], frozenset(("code", "message", "data")))
        if error["message"] != RUNTIME_DENIAL_MESSAGE:
            _refuse()
        code = error["code"]
        if isinstance(code, bool) or not isinstance(code, (int, float)):
            _refuse()
        if code != RUNTIME_DENIAL_CODE:
            _refuse()
        data = _strict_object(error["data"], frozenset(("reason",)))
        reason = data["reason"]
        if not isinstance(reason, str) or _DENIAL_REASON_PATTERN.fullmatch(reason) is None:
            _refuse()
        return {
            "jsonrpc": _JSONRPC_VERSION,
            "id": "run",
            "error": {
                "code": RUNTIME_DENIAL_CODE,
                "message": RUNTIME_DENIAL_MESSAGE,
                "data": {"reason": reason},
            },
        }

    if keys == _REQUEST_KEYS:
        if not isinstance(identity, str) or _WORKER_ID_PATTERN.fullmatch(identity) is None:
            _refuse()
        method = value["method"]
        params = value["params"]
        if method == "authority.check":
            _strict_object(params, frozenset())
            return {"jsonrpc": _JSONRPC_VERSION, "id": identity, "method": "authority.check", "params": {}}
        if method == "model.generate":
            item = _strict_object(params, frozenset(("messages",)))
            messages = item["messages"]
            if not isinstance(messages, list) or not messages or len(messages) > RUNTIME_MAX_MESSAGES:
                _refuse()
            return {
                "jsonrpc": _JSONRPC_VERSION,
                "id": identity,
                "method": "model.generate",
                "params": {"messages": [_validate_wire_message(message) for message in messages]},
            }
        if method == "tool.execute":
            return {
                "jsonrpc": _JSONRPC_VERSION,
                "id": identity,
                "method": "tool.execute",
                "params": _validate_intent(params),
            }

    _refuse()


def validate_invocation(value: object) -> dict:
    """Validate the one ``runtime.execute`` request this parent is trusted to send.

    The request is composed by trusted Server code, never by a task; validating it here keeps a
    composition mistake from reaching a child that would refuse it anyway. The shape is the current
    single-request profile: no batch, no notification, no second method.
    """
    assert_json_value(value)
    item = _strict_object(value, _INVOCATION_KEYS)
    if (
        item["jsonrpc"] != _JSONRPC_VERSION
        or item["id"] != "run"
        or item["method"] != "runtime.execute"
    ):
        _refuse()
    params = _strict_object(item["params"], _INVOCATION_PARAM_KEYS)
    if params["protocol"] != RUNTIME_PROTOCOL:
        _refuse()
    deadline = params["deadlineMs"]
    # ``Number.isInteger`` in the reference: an integral float is the same double there.
    if isinstance(deadline, bool) or not isinstance(deadline, (int, float)):
        _refuse()
    if isinstance(deadline, float) and not deadline.is_integer():
        _refuse()
    if not RUNTIME_DEADLINE_MS_MIN <= deadline <= RUNTIME_DEADLINE_MS_MAX:
        _refuse()
    tools = params["tools"]
    if not isinstance(tools, list) or len(tools) > RUNTIME_MAX_TOOL_DESCRIPTORS:
        _refuse()
    descriptors = []
    for tool in tools:
        descriptor = _strict_object(tool, _TOOL_DESCRIPTOR_KEYS)
        name = _bounded_text(descriptor["name"], RUNTIME_MAX_TOOL_NAME, minimum=1)
        description = descriptor["description"]
        if not isinstance(description, str):
            _refuse()
        schema = descriptor["inputSchema"]
        if not isinstance(schema, dict):
            _refuse()
        descriptors.append({"name": name, "description": description, "inputSchema": schema})
    if len(_serialize(descriptors)) > RUNTIME_CATALOG_BYTES:
        _refuse()
    return {
        "jsonrpc": _JSONRPC_VERSION,
        "id": "run",
        "method": "runtime.execute",
        "params": {
            "protocol": RUNTIME_PROTOCOL,
            "tools": descriptors,
            "deadlineMs": int(deadline),
        },
    }
