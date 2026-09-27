"""Run-level refusals: failed ports, unusable tool calls, unusable results.

The recurring assertion is that a failure stops the run and is never converted into
something the model could treat as a successful observation — the SDK does exactly
that for ``ToolFailed`` and ``ModelRetry``, which is why those two are never raised
from a port failure and why the model must not be asked again after a failure.
"""

from __future__ import annotations

import pytest

from openbot_agent_runtime import (
    FailureReason,
    RuntimeLimits,
    RuntimePorts,
    execute_runtime,
)
from openbot_agent_runtime.errors import RuntimeFailure

from support import (
    Authority,
    CorrectionsPort,
    RecordingProgressPort,
    RecordingToolPort,
    ScriptedModelPort,
    ToolPortFailure,
    call,
    descriptor,
    request,
    text,
)

pytestmark = pytest.mark.anyio


def _ports(
    *, model: ScriptedModelPort, tools: RecordingToolPort, progress=None, corrections=None
) -> RuntimePorts:
    return RuntimePorts(
        model=model,
        tool=tools,
        authority=Authority(),
        progress=progress,
        corrections=corrections,
    )


async def test_a_failing_model_port_stops_the_run() -> None:
    model = ScriptedModelPort([text("x")], error=RuntimeError("provider exploded"))
    tools = RecordingToolPort()

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(request(tools=[descriptor()]), _ports(model=model, tools=tools))

    assert caught.value.reason is FailureReason.MODEL_PORT_ERROR
    assert tools.calls == []


async def test_a_model_port_returning_the_wrong_type_is_refused() -> None:
    """The model port must return a ModelResponse, not arbitrary JSON-ish data."""
    model = _RawModelPort()
    tools = RecordingToolPort()

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(request(tools=[]), _ports(model=model, tools=tools))  # type: ignore[arg-type]

    assert caught.value.reason is FailureReason.MODEL_RESPONSE_INVALID


class _RawModelPort:
    async def __call__(self, step_request: object) -> object:
        return {"text": "a dict is not a ModelResponse"}


async def test_a_failing_tool_port_stops_the_run_without_asking_the_model_again() -> None:
    model = ScriptedModelPort([call("search", {"query": "a"}, call_id="c1"), text("late")])
    tools = RecordingToolPort(error_for=frozenset({"search"}))

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(request(tools=[descriptor()]), _ports(model=model, tools=tools))

    assert caught.value.reason is FailureReason.TOOL_PORT_ERROR
    assert len(tools.calls) == 1
    assert len(model.requests) == 1, (
        "the failure was converted into a retry prompt the model could continue past"
    )


async def test_a_tool_port_that_is_not_async_is_refused() -> None:
    """A host adapter that forgot to await must fail, not silently succeed."""
    model = ScriptedModelPort([call("search", {"query": "a"}, call_id="c1"), text("late")])
    tools = RecordingToolPort(synchronous=True)

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(request(tools=[descriptor()]), _ports(model=model, tools=tools))

    assert caught.value.reason is FailureReason.TOOL_PORT_ERROR


async def test_a_model_invented_tool_name_is_refused_before_the_tool_port() -> None:
    model = ScriptedModelPort([call("hallucinated", {"query": "a"}, call_id="c1"), text("late")])
    tools = RecordingToolPort()

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(request(tools=[descriptor()]), _ports(model=model, tools=tools))

    assert caught.value.reason is FailureReason.UNKNOWN_TOOL
    assert tools.calls == []
    assert "hallucinated" in caught.value.detail


async def test_arguments_that_violate_the_declared_schema_never_reach_the_tool_port() -> None:
    model = ScriptedModelPort(
        [call("search", {"query": 12, "extra": "x"}, call_id="c1"), text("late")]
    )
    tools = RecordingToolPort()

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(request(tools=[descriptor()]), _ports(model=model, tools=tools))

    assert caught.value.reason is FailureReason.INVALID_ARGUMENTS
    assert tools.calls == []


async def test_a_tool_result_that_is_a_stream_is_refused() -> None:
    async def _stream() -> object:
        yield {"chunk": 1}

    model = ScriptedModelPort([call("search", {"query": "a"}, call_id="c1"), text("late")])
    tools = RecordingToolPort(results={"search": _stream()})

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(request(tools=[descriptor()]), _ports(model=model, tools=tools))

    assert caught.value.reason is FailureReason.TOOL_RESULT_INVALID


async def test_a_tool_result_with_no_json_form_is_refused() -> None:
    model = ScriptedModelPort([call("search", {"query": "a"}, call_id="c1"), text("late")])
    tools = RecordingToolPort(results={"search": object()})

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(request(tools=[descriptor()]), _ports(model=model, tools=tools))

    assert caught.value.reason is FailureReason.TOOL_RESULT_INVALID


async def test_a_tool_result_containing_nan_is_refused() -> None:
    """NaN is not valid JSON, so an "unbounded float" must not pass as a value."""
    model = ScriptedModelPort([call("search", {"query": "a"}, call_id="c1"), text("late")])
    tools = RecordingToolPort(results={"search": {"score": float("nan")}})

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(request(tools=[descriptor()]), _ports(model=model, tools=tools))

    assert caught.value.reason is FailureReason.TOOL_RESULT_INVALID


async def test_an_oversize_tool_result_is_refused_rather_than_truncated() -> None:
    model = ScriptedModelPort([call("search", {"query": "a"}, call_id="c1"), text("late")])
    tools = RecordingToolPort(results={"search": {"blob": "x" * 400}})
    limits = RuntimeLimits(tool_result_bytes=128)

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[descriptor()], limits=limits), _ports(model=model, tools=tools)
        )

    assert caught.value.reason is FailureReason.TOOL_RESULT_LIMIT
    assert "128" in caught.value.detail


async def test_oversize_final_output_is_refused() -> None:
    model = ScriptedModelPort([text("y" * 64)])
    limits = RuntimeLimits(output_bytes=16)

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[], limits=limits),
            _ports(model=model, tools=RecordingToolPort()),
        )

    assert caught.value.reason is FailureReason.OUTPUT_LIMIT


async def test_a_failing_progress_port_stops_the_run() -> None:
    model = ScriptedModelPort([text("late")])
    progress = RecordingProgressPort(error=RuntimeError("audit sink unavailable"))

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[]),
            _ports(model=model, tools=RecordingToolPort(), progress=progress),
        )

    assert caught.value.reason is FailureReason.PROGRESS_PORT_ERROR
    assert model.requests == []


async def test_a_progress_port_that_is_not_async_is_refused() -> None:
    progress = RecordingProgressPort(synchronous=True)

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[]),
            _ports(model=ScriptedModelPort([text("late")]), tools=RecordingToolPort(), progress=progress),
        )

    assert caught.value.reason is FailureReason.PROGRESS_PORT_ERROR


async def test_a_failing_corrections_port_stops_the_run() -> None:
    corrections = CorrectionsPort(error=RuntimeError("corrections unavailable"))

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[]),
            _ports(
                model=ScriptedModelPort([text("late")]),
                tools=RecordingToolPort(),
                corrections=corrections,
            ),
        )

    assert caught.value.reason is FailureReason.CORRECTION_INVALID


async def test_duplicate_correction_identifiers_are_refused() -> None:
    from openbot_agent_runtime import Correction

    corrections = CorrectionsPort(
        [Correction(id="dup", instruction="one"), Correction(id="dup", instruction="two")]
    )

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[]),
            _ports(
                model=ScriptedModelPort([text("late")]),
                tools=RecordingToolPort(),
                corrections=corrections,
            ),
        )

    assert caught.value.reason is FailureReason.CORRECTION_INVALID


async def test_too_many_corrections_are_refused() -> None:
    from openbot_agent_runtime import Correction

    corrections = CorrectionsPort(
        [Correction(id=f"c-{index}", instruction="do better") for index in range(9)]
    )

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[]),
            _ports(
                model=ScriptedModelPort([text("late")]),
                tools=RecordingToolPort(),
                corrections=corrections,
            ),
        )

    assert caught.value.reason is FailureReason.CORRECTION_INVALID


async def test_a_tool_port_failure_in_the_first_of_two_calls_stops_the_second() -> None:
    """A failure in one call must not be followed by the sibling call."""
    from pydantic_ai.messages import ToolCallPart
    from pydantic_ai.messages import ModelResponse

    from support import response

    model = ScriptedModelPort(
        [
            response(
                ToolCallPart("search", {"query": "a"}, tool_call_id="c-a"),
                ToolCallPart("search", {"query": "b"}, tool_call_id="c-b"),
            ),
            text("late"),
        ]
    )
    tools = RecordingToolPort(error_for=frozenset({"search"}))

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(request(tools=[descriptor()]), _ports(model=model, tools=tools))

    assert caught.value.reason is FailureReason.TOOL_PORT_ERROR
    assert len(tools.calls) == 1


def test_tool_port_failure_type_stays_a_plain_exception() -> None:
    """Guard against a fake accidentally raising an SDK-convertible exception."""
    assert issubclass(ToolPortFailure, Exception)
