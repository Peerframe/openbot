"""Profile tests: the frozen shapes, the SDK translation and the session invariants.

These run in-process because they judge pure translation and correlation logic, which
needs no second process. The channel itself — framing, EOF, exit status — is judged in
``test_cli_*`` instead, where a real child exists. Everything is synthetic: scripted
model results, a recording writer, no provider and no credential.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    RetryPromptPart,
    SystemPromptPart,
    TextPart,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)

import support_cli

from openbot_agent_runtime import wire
from openbot_agent_runtime import worker as worker_module
from openbot_agent_runtime.errors import SERVER_FAILURE_HINT, FailureReason, RuntimeFailure
from openbot_agent_runtime.profile import (
    AUTHORITY_METHOD,
    CONTROL_PROMPT,
    MAX_MODEL_TOOL_INTENTS,
    MAX_TOOL_CALL_ID_CHARS,
    MAX_WIRE_MESSAGES,
    MAX_WIRE_MESSAGE_BYTES,
    MODEL_METHOD,
    PARENT_REQUEST_ID,
    TOOL_METHOD,
    ToolIntent,
    bound_wire_messages,
    model_response_from_wire,
    parse_authority_result,
    parse_execute_request,
    parse_tool_result,
    refusal_reason_for,
    wire_messages,
)
from openbot_agent_runtime.worker import (
    FAILURE_REASON_FALLBACK,
    MAX_CHILD_REQUESTS,
    WIRE_LIMITS,
    WorkerSession,
)

pytestmark = pytest.mark.anyio

SRC = Path(__file__).resolve().parents[1] / "src" / "openbot_agent_runtime"


# --- the parent request -------------------------------------------------------


def _request(**overrides: object) -> dict[str, object]:
    frame = support_cli.execute_request(**overrides)  # type: ignore[arg-type]
    return frame


def test_the_frozen_request_is_accepted() -> None:
    parsed = parse_execute_request(_request())
    assert parsed.deadline_ms == 5_000
    assert [item.name for item in parsed.tools] == ["search"]
    assert parsed.tools[0].input_schema == support_cli.SEARCH_SCHEMA


def test_the_deadline_bounds_are_the_profile_bounds() -> None:
    assert parse_execute_request(_request(deadline_ms=1)).deadline_ms == 1
    assert parse_execute_request(_request(deadline_ms=300_000)).deadline_ms == 300_000


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param({"deadline_ms": 0}, id="deadline-zero"),
        pytest.param({"deadline_ms": 300_001}, id="deadline-too-large"),
        pytest.param({"deadline_ms": 1.5}, id="deadline-float"),
        pytest.param({"deadline_ms": True}, id="deadline-bool"),
        pytest.param({"deadline_ms": "5000"}, id="deadline-string"),
        pytest.param({"tools": [{"name": "s", "description": "d"}]}, id="tool-missing-key"),
        pytest.param(
            {"tools": [{"name": "s", "description": "d", "inputSchema": 1}]}, id="schema-not-object"
        ),
        pytest.param(
            {"tools": [{"name": 1, "description": "d", "inputSchema": {}}]}, id="name-not-string"
        ),
        pytest.param({"protocol": "openbot-agent-runtime/2"}, id="wrong-protocol"),
        pytest.param({"extra": 1}, id="unknown-params-field"),
        pytest.param({"tools": [support_cli.tool()] * 65}, id="too-many-tools"),
    ],
)
def test_invalid_params_are_refused_as_invalid_params(overrides: dict[str, object]) -> None:
    with pytest.raises(wire.ProtocolViolation) as caught:
        parse_execute_request(_request(**overrides))
    assert caught.value.code == wire.INVALID_PARAMS_CODE


@pytest.mark.parametrize(
    "frame",
    [
        pytest.param([1, 2, 3], id="batch"),
        pytest.param({"jsonrpc": "2.0", "method": "runtime.execute", "params": {}}, id="no-id"),
        pytest.param(
            {"jsonrpc": "1.0", "id": "run", "method": "runtime.execute", "params": {}},
            id="wrong-jsonrpc",
        ),
        pytest.param(
            {"jsonrpc": "2.0", "id": "other", "method": "runtime.execute", "params": {}},
            id="wrong-id",
        ),
        pytest.param(
            {"jsonrpc": "2.0", "id": "run", "method": "x", "params": {}}, id="unknown-method"
        ),
        pytest.param(
            {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute", "params": {}, "extra": 1},
            id="unknown-envelope-field",
        ),
        pytest.param(
            {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute"}, id="missing-params"
        ),
    ],
)
def test_a_broken_envelope_is_refused(frame: object) -> None:
    with pytest.raises(wire.ProtocolViolation) as caught:
        parse_execute_request(frame)
    assert caught.value.code in {wire.INVALID_REQUEST_CODE, wire.METHOD_NOT_FOUND_CODE}


def test_an_unknown_method_is_method_not_found() -> None:
    frame = support_cli.execute_request()
    frame["method"] = "runtime.other"
    with pytest.raises(wire.ProtocolViolation) as caught:
        parse_execute_request(frame)
    assert caught.value.code == wire.METHOD_NOT_FOUND_CODE


def test_the_profile_limits_are_the_frozen_numbers() -> None:
    assert WIRE_LIMITS.catalog_tools == 64
    assert WIRE_LIMITS.history_messages == 128
    assert WIRE_LIMITS.output_bytes == 32_000
    assert WIRE_LIMITS.steps == 8
    assert WIRE_LIMITS.tool_calls == 16
    WIRE_LIMITS.validated()


# --- SDK messages to the wire -------------------------------------------------


def test_the_control_prompt_is_the_first_user_message() -> None:
    messages = [ModelRequest(parts=[UserPromptPart(content=CONTROL_PROMPT)])]
    assert wire_messages(messages) == [{"role": "user", "content": CONTROL_PROMPT}]


def test_the_assistant_and_tool_shapes_are_exact() -> None:
    messages = [
        ModelRequest(parts=[UserPromptPart(content=CONTROL_PROMPT)]),
        ModelResponse(
            parts=[
                TextPart("thinking"),
                ToolCallPart("search", {"query": "a"}, tool_call_id="tc-1"),
            ]
        ),
        ModelRequest(
            parts=[
                ToolReturnPart(tool_name="search", content={"hits": [1]}, tool_call_id="tc-1"),
                ToolReturnPart(tool_name="search", content={"hits": [2]}, tool_call_id="tc-2"),
            ]
        ),
        ModelResponse(parts=[TextPart("done")]),
    ]
    assert wire_messages(messages) == [
        {"role": "user", "content": CONTROL_PROMPT},
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "thinking"},
                {
                    "type": "tool-call",
                    "toolCallId": "tc-1",
                    "toolName": "search",
                    "input": {"query": "a"},
                },
            ],
        },
        {
            "role": "tool",
            "content": [
                {
                    "type": "tool-result",
                    "toolCallId": "tc-1",
                    "toolName": "search",
                    "output": {"type": "json", "value": {"hits": [1]}},
                },
                {
                    "type": "tool-result",
                    "toolCallId": "tc-2",
                    "toolName": "search",
                    "output": {"type": "json", "value": {"hits": [2]}},
                },
            ],
        },
        {"role": "assistant", "content": [{"type": "text", "text": "done"}]},
    ]


def test_consecutive_tool_returns_become_one_tool_message() -> None:
    messages = [
        ModelRequest(parts=[UserPromptPart(content=CONTROL_PROMPT)]),
        ModelRequest(
            parts=[
                ToolReturnPart(tool_name="a", content=1, tool_call_id="t1"),
                ToolReturnPart(tool_name="b", content=2, tool_call_id="t2"),
            ]
        ),
    ]
    payload = wire_messages(messages)
    assert [message["role"] for message in payload] == ["user", "tool"]
    assert len(payload[1]["content"]) == 2


def test_arguments_given_as_a_json_string_become_an_object() -> None:
    messages = [
        ModelRequest(parts=[UserPromptPart(content=CONTROL_PROMPT)]),
        ModelResponse(parts=[ToolCallPart("search", '{"query": "a"}', tool_call_id="tc-1")]),
    ]
    payload = wire_messages(messages)
    assert payload[1]["content"][0]["input"] == {"query": "a"}


def test_arguments_given_as_malformed_json_are_refused_not_wrapped() -> None:
    """``args_as_dict()`` would substitute ``{"INVALID_JSON": ...}``; this must not."""
    messages = [
        ModelRequest(parts=[UserPromptPart(content=CONTROL_PROMPT)]),
        ModelResponse(parts=[ToolCallPart("search", "{not json", tool_call_id="tc-1")]),
    ]
    with pytest.raises(RuntimeFailure) as caught:
        wire_messages(messages)
    assert caught.value.reason is FailureReason.MODEL_RESPONSE_INVALID


def test_arguments_given_as_a_json_scalar_are_refused() -> None:
    messages = [
        ModelRequest(parts=[UserPromptPart(content=CONTROL_PROMPT)]),
        ModelResponse(parts=[ToolCallPart("search", "[1,2]", tool_call_id="tc-1")]),
    ]
    with pytest.raises(RuntimeFailure) as caught:
        wire_messages(messages)
    assert caught.value.reason is FailureReason.MODEL_RESPONSE_INVALID


def test_a_tool_call_without_arguments_becomes_an_empty_object() -> None:
    messages = [
        ModelRequest(parts=[UserPromptPart(content=CONTROL_PROMPT)]),
        ModelResponse(parts=[ToolCallPart("search", tool_call_id="tc-1")]),
    ]
    assert wire_messages(messages)[1]["content"][0]["input"] == {}


@pytest.mark.parametrize(
    "messages",
    [
        pytest.param([], id="no-messages"),
        pytest.param(
            [ModelRequest(parts=[SystemPromptPart(content="system")])], id="system-prompt"
        ),
        pytest.param(
            [ModelRequest(parts=[RetryPromptPart(content="again")])], id="retry-prompt"
        ),
        pytest.param(
            [ModelRequest(parts=[UserPromptPart(content="a different task")])],
            id="not-the-control-prompt",
        ),
        pytest.param(
            [
                ModelRequest(parts=[UserPromptPart(content=CONTROL_PROMPT)]),
                ModelRequest(parts=[UserPromptPart(content=CONTROL_PROMPT)]),
            ],
            id="second-user-message",
        ),
        pytest.param(
            [
                ModelRequest(parts=[UserPromptPart(content="other")]),
                ModelRequest(parts=[UserPromptPart(content=CONTROL_PROMPT)]),
            ],
            id="control-prompt-not-first",
        ),
        pytest.param([ModelResponse(parts=[TextPart("x")])], id="assistant-first"),
        pytest.param(
            [ModelRequest(instructions="do this instead", parts=[UserPromptPart(CONTROL_PROMPT)])],
            id="instructions-present",
        ),
        pytest.param(
            [
                ModelRequest(parts=[UserPromptPart(content=CONTROL_PROMPT)]),
                ModelResponse(parts=[ThinkingPart(content="hidden")]),
            ],
            id="thinking-part",
        ),
        pytest.param(
            [
                ModelRequest(parts=[UserPromptPart(content=CONTROL_PROMPT)]),
                ModelResponse(parts=[]),
            ],
            id="empty-assistant-message",
        ),
        pytest.param(
            [
                ModelRequest(parts=[UserPromptPart(content=CONTROL_PROMPT)]),
                ModelRequest(
                    parts=[
                        ToolReturnPart(
                            tool_name="a", content=1, tool_call_id="t1", outcome="denied"
                        )
                    ]
                ),
            ],
            id="non-success-tool-outcome",
        ),
        pytest.param(
            [
                ModelRequest(parts=[UserPromptPart(content=CONTROL_PROMPT)]),
                ModelRequest(
                    parts=[ToolReturnPart(tool_name="a", content=1, tool_call_id="")]
                ),
            ],
            id="tool-return-without-an-identifier",
        ),
        pytest.param(
            [
                ModelRequest(parts=[UserPromptPart(content=CONTROL_PROMPT)]),
                ModelRequest(
                    parts=[ToolReturnPart(tool_name="", content=1, tool_call_id="t1")]
                ),
            ],
            id="tool-return-without-a-name",
        ),
        pytest.param(
            [
                ModelRequest(parts=[UserPromptPart(content=CONTROL_PROMPT)]),
                ModelResponse(parts=[ToolCallPart("", {}, tool_call_id="t1")]),
            ],
            id="tool-call-without-a-name",
        ),
    ],
)
def test_a_shape_the_profile_does_not_admit_is_refused(messages: list[object]) -> None:
    with pytest.raises(RuntimeFailure) as caught:
        wire_messages(messages)  # type: ignore[arg-type]
    assert caught.value.reason in {
        FailureReason.MESSAGE_LIMIT,
        FailureReason.MODEL_RESPONSE_INVALID,
        FailureReason.TOOL_RESULT_INVALID,
    }


def test_a_tool_return_value_without_a_json_form_is_refused() -> None:
    messages = [
        ModelRequest(parts=[UserPromptPart(content=CONTROL_PROMPT)]),
        ModelRequest(
            parts=[ToolReturnPart(tool_name="a", content=object(), tool_call_id="t1")]
        ),
    ]
    with pytest.raises(RuntimeFailure) as caught:
        wire_messages(messages)  # type: ignore[arg-type]
    assert caught.value.reason is FailureReason.TOOL_RESULT_INVALID


def test_the_translated_message_bounds_are_enforced() -> None:
    ok = [{"role": "user", "content": CONTROL_PROMPT}]
    bound_wire_messages(ok)

    too_many = [dict(ok[0]) for _ in range(MAX_WIRE_MESSAGES + 1)]
    with pytest.raises(RuntimeFailure) as caught:
        bound_wire_messages(too_many)
    assert caught.value.reason is FailureReason.MESSAGE_LIMIT

    too_large = [{"role": "user", "content": "x" * (MAX_WIRE_MESSAGE_BYTES + 1)}]
    with pytest.raises(RuntimeFailure) as caught:
        bound_wire_messages(too_large)
    assert caught.value.reason is FailureReason.MESSAGE_LIMIT


# --- wire to the SDK ----------------------------------------------------------


def test_a_model_result_becomes_a_real_sdk_response() -> None:
    response = model_response_from_wire(
        {
            "text": "answer",
            "tools": [{"id": "tc-1", "name": "search", "arguments": {"query": "a"}}],
            "usage": {"inputTokens": 7, "outputTokens": 3},
        }
    )
    assert isinstance(response, ModelResponse)
    assert [type(part).__name__ for part in response.parts] == ["TextPart", "ToolCallPart"]
    assert response.parts[0].content == "answer"
    assert response.parts[1].tool_call_id == "tc-1"
    assert response.parts[1].tool_name == "search"
    assert response.parts[1].args == {"query": "a"}
    assert response.usage.input_tokens == 7
    assert response.usage.output_tokens == 3


def test_a_tool_only_result_has_no_text_part() -> None:
    response = model_response_from_wire(
        {
            "text": "",
            "tools": [{"id": "tc-1", "name": "search", "arguments": {}}],
            "usage": {"inputTokens": None, "outputTokens": None},
        }
    )
    assert [type(part).__name__ for part in response.parts] == ["ToolCallPart"]


def test_unreported_usage_leaves_the_sdk_default_in_place() -> None:
    """A null count is never turned into an observed zero anywhere.

    Python has no usage-report method in this profile, so the SDK's internal
    counter is the only place a null can land, and the Server never sees it.
    """
    response = model_response_from_wire(
        {"text": "x", "tools": [], "usage": {"inputTokens": None, "outputTokens": None}}
    )
    assert response.usage.input_tokens == 0
    assert response.usage.output_tokens == 0

    partial = model_response_from_wire(
        {"text": "x", "tools": [], "usage": {"inputTokens": None, "outputTokens": 4}}
    )
    assert partial.usage.output_tokens == 4


@pytest.mark.parametrize(
    "value",
    [
        pytest.param({"text": 5, "tools": [], "usage": {"inputTokens": None, "outputTokens": None}}, id="text-not-string"),
        pytest.param({"text": "x", "tools": []}, id="no-usage"),
        pytest.param({"text": "x", "tools": [], "usage": {}}, id="usage-missing-fields"),
        pytest.param(
            {"text": "x", "tools": [], "usage": {"inputTokens": -1, "outputTokens": None}},
            id="negative-usage",
        ),
        pytest.param(
            {"text": "x", "tools": [], "usage": {"inputTokens": "5", "outputTokens": None}},
            id="string-usage",
        ),
        pytest.param(
            {"text": "x", "tools": [], "usage": {"inputTokens": True, "outputTokens": None}},
            id="bool-usage",
        ),
        pytest.param({"text": "x", "tools": "none", "usage": {"inputTokens": None, "outputTokens": None}}, id="tools-not-a-list"),
        pytest.param(
            {"text": "x", "tools": [], "usage": {"inputTokens": None, "outputTokens": None}, "extra": 1},
            id="unknown-field",
        ),
        pytest.param(
            {"text": "x", "tools": [{"id": "t", "name": "s", "arguments": "a"}], "usage": {"inputTokens": None, "outputTokens": None}},
            id="arguments-not-an-object",
        ),
        pytest.param(
            {"text": "x", "tools": [{"id": "", "name": "s", "arguments": {}}], "usage": {"inputTokens": None, "outputTokens": None}},
            id="empty-intent-id",
        ),
        pytest.param(
            {"text": "x", "tools": [{"id": "t" * (MAX_TOOL_CALL_ID_CHARS + 1), "name": "s", "arguments": {}}], "usage": {"inputTokens": None, "outputTokens": None}},
            id="oversize-intent-id",
        ),
        pytest.param(
            {"text": "x", "tools": [{"id": "t", "name": "", "arguments": {}}], "usage": {"inputTokens": None, "outputTokens": None}},
            id="empty-intent-name",
        ),
        pytest.param(
            {"text": "x", "tools": [{"id": "t", "name": "s", "arguments": {}, "extra": 1}], "usage": {"inputTokens": None, "outputTokens": None}},
            id="intent-unknown-field",
        ),
        pytest.param(
            {
                "text": "x",
                "tools": [{"id": f"t{i}", "name": "s", "arguments": {}} for i in range(MAX_MODEL_TOOL_INTENTS + 1)],
                "usage": {"inputTokens": None, "outputTokens": None},
            },
            id="too-many-intents",
        ),
    ],
)
def test_a_model_payload_that_does_not_match_is_refused(value: object) -> None:
    with pytest.raises(RuntimeFailure) as caught:
        model_response_from_wire(value)
    assert caught.value.reason is FailureReason.MODEL_RESPONSE_INVALID


def test_authority_succeeds_only_with_an_empty_object() -> None:
    assert parse_authority_result({}) is None
    for value in ({"ok": True}, [], "ok", None, {"": 1}):
        with pytest.raises(RuntimeFailure) as caught:
            parse_authority_result(value)
        assert caught.value.reason is FailureReason.AUTHORITY_INVALID


def test_a_tool_result_must_be_exactly_a_value_envelope() -> None:
    assert parse_tool_result({"value": {"hits": [1]}}) == {"hits": [1]}
    assert parse_tool_result({"value": None}) is None
    assert parse_tool_result({"value": "text"}) == "text"
    for value in ({"value": 1, "extra": 2}, {"other": 1}, {"value": 1, "value2": 1}, []):
        with pytest.raises(RuntimeFailure) as caught:
            parse_tool_result(value)
        assert caught.value.reason is FailureReason.TOOL_RESULT_INVALID


def test_a_refused_child_request_maps_to_a_runtime_reason() -> None:
    assert refusal_reason_for(AUTHORITY_METHOD) is FailureReason.AUTHORITY_REVOKED
    assert refusal_reason_for(MODEL_METHOD) is FailureReason.MODEL_PORT_ERROR
    assert refusal_reason_for(TOOL_METHOD) is FailureReason.TOOL_PORT_ERROR
    assert refusal_reason_for("something.else") is FailureReason.UNEXPECTED


# --- session invariants -------------------------------------------------------


class _WriterStub:
    """Records the frames a session believes it has written."""

    def __init__(self) -> None:
        self.frames: list[dict[str, object]] = []

    async def write_value(self, value: object) -> None:
        self.frames.append(value)  # type: ignore[arg-type]


def _stub_session() -> tuple[WorkerSession, _WriterStub]:
    writer = _WriterStub()
    return WorkerSession(writer), writer  # type: ignore[arg-type]


async def test_child_identifiers_are_monotonic_and_bounded() -> None:
    session, writer = _stub_session()
    for index in range(MAX_CHILD_REQUESTS):
        # The reply must carry the identifier the session is about to send; a real
        # parent supplies it and `deliver` checks it, so the injection does too.
        session._inbox.put_nowait({"id": f"w{index + 1}", "result": {}})  # reviewed internal
        await session._call(AUTHORITY_METHOD, {})
    assert [frame["id"] for frame in writer.frames] == [
        f"w{index + 1}" for index in range(MAX_CHILD_REQUESTS)
    ]
    with pytest.raises(RuntimeFailure) as caught:
        await session._call(AUTHORITY_METHOD, {})
    assert caught.value.reason is FailureReason.LIMIT_EXCEEDED
    assert len(writer.frames) == MAX_CHILD_REQUESTS


async def test_a_second_child_request_cannot_overlap_the_first() -> None:
    session, writer = _stub_session()
    first = asyncio.create_task(session._call(AUTHORITY_METHOD, {}))
    for _ in range(4):
        await asyncio.sleep(0)
    assert session.outstanding_id == "w1"
    with pytest.raises(RuntimeFailure) as caught:
        await session._call(AUTHORITY_METHOD, {})
    assert caught.value.reason is FailureReason.OVERLAPPING_OPERATION
    assert len(writer.frames) == 1
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first


async def test_a_refused_child_request_raises_a_runtime_reason() -> None:
    session, _ = _stub_session()
    session._inbox.put_nowait(  # reviewed internal: the reply queue
        {
            "id": "w1",
            "error": {
                "code": -32000,
                "message": "Runtime operation refused",
                "data": {"reason": "scope_revoked"},
            },
        }
    )
    with pytest.raises(RuntimeFailure) as caught:
        await session._call(AUTHORITY_METHOD, {})
    assert caught.value.reason is FailureReason.AUTHORITY_REVOKED
    assert session.outstanding_id is None


@pytest.mark.parametrize(
    "frame",
    [
        pytest.param({"jsonrpc": "2.0", "id": "w1"}, id="neither-result-nor-error"),
        pytest.param(
            {"jsonrpc": "2.0", "id": "w1", "result": {}, "error": {}}, id="both"
        ),
        pytest.param({"jsonrpc": "1.0", "id": "w1", "result": {}}, id="wrong-jsonrpc"),
        pytest.param(
            {"jsonrpc": "2.0", "id": "w1", "result": {}, "extra": 1}, id="unknown-field"
        ),
        pytest.param({"jsonrpc": "2.0", "result": {}}, id="no-id"),
        pytest.param([], id="not-an-object"),
        pytest.param({"jsonrpc": "2.0", "id": "w2", "result": {}}, id="wrong-id"),
    ],
)
async def test_deliver_refuses_an_uncorrelated_reply(frame: object) -> None:
    session, _ = _stub_session()
    # Reviewed internal: the correlation invariant under test is which identifier
    # the session believes is outstanding.
    session._outstanding = "w1"
    with pytest.raises(wire.ProtocolViolation):
        session.deliver(frame)


@pytest.mark.parametrize(
    "frame",
    [
        pytest.param({"jsonrpc": "2.0", "id": "w1", "result": {}}, id="reply"),
        pytest.param({"jsonrpc": "2.0", "id": "run", "result": {}}, id="another-request"),
    ],
)
async def test_deliver_refuses_a_frame_with_no_call_in_flight(frame: object) -> None:
    session, _ = _stub_session()
    assert session.outstanding_id is None
    with pytest.raises(wire.ProtocolViolation):
        session.deliver(frame)


async def test_deliver_accepts_the_matching_reply() -> None:
    session, _ = _stub_session()
    session._outstanding = "w1"  # reviewed internal: the correlation invariant
    session.deliver({"jsonrpc": "2.0", "id": "w1", "result": {}})
    assert session._inbox.qsize() == 1  # reviewed internal: the reply queue


async def test_deliver_refuses_a_replayed_reply_once_the_call_has_finished() -> None:
    """``_call`` clears the outstanding identifier, so a repeat has no match."""
    session, writer = _stub_session()
    session._inbox.put_nowait({"id": "w1", "result": {}})  # reviewed internal: the reply queue
    await session._call(AUTHORITY_METHOD, {})
    assert session.outstanding_id is None
    assert len(writer.frames) == 1
    with pytest.raises(wire.ProtocolViolation):
        session.deliver({"jsonrpc": "2.0", "id": "w1", "result": {}})


async def test_a_duplicate_reply_is_refused_before_the_call_resumes() -> None:
    """Two replies for one identifier must not survive as the next call's result.

    ``deliver`` reserves the expected reply atomically, so the second copy is
    uncorrelated the instant the first is queued — even when both arrive in one
    read, before ``_call`` has had a chance to resume. Without that, the stale
    frame would sit in the inbox and be handed to the *next* call.
    """
    session, writer = _stub_session()
    first = asyncio.create_task(session._call(AUTHORITY_METHOD, {}))
    for _ in range(4):
        await asyncio.sleep(0)
    assert session.outstanding_id == "w1"
    session.deliver({"jsonrpc": "2.0", "id": "w1", "result": "first"})
    # Delivered a second time before the first call resumes.
    with pytest.raises(wire.ProtocolViolation):
        session.deliver({"jsonrpc": "2.0", "id": "w1", "result": "second"})
    assert await first == "first"
    assert session.outstanding_id is None
    assert session._inbox.qsize() == 0  # reviewed internal: no stale reply left behind
    assert len(writer.frames) == 1


class _BlockingWriter:
    """A writer whose only frame never completes, as when the parent stops reading."""

    async def write_value(self, value: object) -> None:
        await asyncio.Event().wait()


async def test_a_terminal_write_cannot_outlive_the_invocation_deadline() -> None:
    """A parent that stops draining stdout must not pin the process open."""
    session = WorkerSession(_BlockingWriter())  # type: ignore[arg-type]
    loop = asyncio.get_running_loop()
    published = await session._publish(
        {"jsonrpc": "2.0", "id": PARENT_REQUEST_ID, "result": {"text": "x"}},
        loop.time() + 0.05,
    )
    assert published is False


async def test_a_terminal_write_that_completes_immediately_ignores_a_past_deadline() -> None:
    """The ordinary fast write is unaffected even once the deadline instant passed."""
    writer = _WriterStub()
    session = WorkerSession(writer)  # type: ignore[arg-type]
    loop = asyncio.get_running_loop()
    frame = {"jsonrpc": "2.0", "id": PARENT_REQUEST_ID, "result": {"text": "x"}}
    published = await session._publish(frame, loop.time() - 5.0)
    assert published is True
    assert writer.frames == [frame]


class _FakeReader:
    """A reader that yields one prepared frame, then fails on the next read."""

    def __init__(self, first: object, failure: Exception) -> None:
        self._first = first
        self._failure = failure
        self.calls = 0
        self.closed = False

    async def next_value(self) -> object:
        self.calls += 1
        if self.calls == 1:
            return self._first
        raise self._failure

    def close(self) -> None:
        self.closed = True


async def test_a_read_violation_already_observed_wins_the_terminal_race(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the run and the reader finish together, a known violation must win.

    The run is stubbed to complete at once, so both tasks are done in the same
    ``asyncio.wait``. A reader that has already failed must not be ignored in favour
    of publishing the run's exit code: the channel closes without a result.
    """
    reader = _FakeReader(support_cli.execute_request(), wire.ProtocolViolation())
    writer = _WriterStub()

    async def instant_execute(self: object, request: object, received_at: float) -> int:
        return worker_module.EXIT_SUCCESS

    monkeypatch.setattr(worker_module.WorkerSession, "execute", instant_execute)
    code = await worker_module._session(reader, writer)  # type: ignore[arg-type]
    assert code == worker_module.EXIT_PROTOCOL_ERROR
    assert [frame for frame in writer.frames if "result" in frame] == []
    assert reader.closed is True


def test_every_reviewed_reason_is_a_valid_wire_reason() -> None:
    """The profile bounds a reason to lowercase letters, digits and underscores."""
    for reason in FailureReason:
        assert len(reason.value) <= 64, reason
        assert reason.value.isascii(), reason
        assert reason.value.replace("_", "").isalnum(), reason
        assert reason.value == reason.value.lower(), reason
        assert reason.value[0].isalpha(), reason
    assert FAILURE_REASON_FALLBACK in {reason.value for reason in FailureReason}


def test_every_reviewed_reason_has_an_advisory_server_code() -> None:
    for reason in FailureReason:
        assert reason in SERVER_FAILURE_HINT, reason


# --- environment isolation ----------------------------------------------------


@pytest.mark.parametrize(
    "module",
    [
        "wire",
        "profile",
        "worker",
        "executor",
        "sdk_ports",
        "guard",
        "catalog",
        "bounds",
        "contracts",
        "errors",
    ],
)
def test_no_runtime_module_reads_the_environment(module: str) -> None:
    """A credential or endpoint could only arrive through the environment.

    The reviewed modules never consult it, so the child's configuration cannot come
    from inherited variables. This is a source-level complement to the runtime
    evidence in ``test_cli_journey``, not a substitute for it.
    """
    source = (SRC / f"{module}.py").read_text(encoding="utf-8")
    assert "os.environ" not in source, module
    assert "getenv" not in source, module
    assert "putenv" not in source, module


def test_tool_intent_is_a_plain_data_carrier() -> None:
    intent = ToolIntent(call_id="tc-1", name="search", arguments={"query": "a"})
    assert json.loads(json.dumps(support_cli.intent("tc-1"))) == {
        "id": "tc-1",
        "name": "search",
        "arguments": {"query": "a"},
    }
    assert intent == ToolIntent(call_id="tc-1", name="search", arguments={"query": "a"})
