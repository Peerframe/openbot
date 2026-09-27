"""The happy path: a bounded journey that must succeed, and what it must expose.

These tests assert observable host-facing behaviour — what the ports received, in
what order, and what the result contains — rather than restating internal steps.
"""

from __future__ import annotations

import pytest

from openbot_agent_runtime import (
    BoundedExecutor,
    Correction,
    RuntimePorts,
    RuntimeRequest,
    RuntimeLimits,
    build_sdk_agent,
    execute_runtime,
)

from support import (
    Authority,
    CorrectionsPort,
    RecordingProgressPort,
    RecordingToolPort,
    ScriptedModelPort,
    call,
    descriptor,
    request,
    response,
    text,
)

pytestmark = pytest.mark.anyio


async def test_two_step_tool_observation_final_journey() -> None:
    model = ScriptedModelPort(
        [call("search", {"query": "widgets"}, call_id="call-1"), text("Widgets: 42.")]
    )
    tools = RecordingToolPort()
    authority = Authority()
    progress = RecordingProgressPort()
    ports = RuntimePorts(model=model, tool=tools, authority=authority, progress=progress)

    result = await BoundedExecutor(ports).execute(request(tools=[descriptor()]))

    assert result.text == "Widgets: 42."
    assert (result.steps, result.tool_calls) == (2, 1)
    assert result.applied_correction_ids == ()

    # The tool port sees the parsed arguments and the SDK's own call identifier.
    assert [invocation.name for invocation in tools.calls] == ["search"]
    assert tools.calls[0].arguments == {"query": "widgets"}
    assert tools.calls[0].call_id == "call-1"

    # The model port is called once per SDK model step and carries the step index,
    # the descriptors actually offered, and the bounded message list, so the Server
    # adapter can own per-step authority and usage persistence.
    assert [step_request.step for step_request in model.requests] == [1, 2]
    assert [item.name for item in model.requests[0].tools] == ["search"]
    assert len(model.requests[0].messages) == 1
    assert len(model.requests[1].messages) == 3

    # Authority is consulted before and after every awaited boundary, not once.
    assert authority.calls >= 6
    assert progress.events[0] == ("planning", "Model step 1.")
    assert ("observation", "Completed search.") in progress.events


async def test_corrections_are_applied_once_and_reported_by_identifier() -> None:
    model = ScriptedModelPort([text("ok")])
    corrections = CorrectionsPort(
        [Correction(id="c-1", instruction="Prefer metric units."), Correction(id="c-2", instruction="Cite sources.")]
    )
    ports = RuntimePorts(
        model=model, tool=RecordingToolPort(), authority=Authority(), corrections=corrections
    )

    result = await execute_runtime(
        request(tools=[], instructions="Base instructions."), ports
    )

    assert result.applied_correction_ids == ("c-1", "c-2")
    assert corrections.calls == 1
    # The SDK carries effective instructions on the first request message, so the
    # Server adapter can see exactly which instruction text this run used.
    effective = getattr(model.requests[0].messages[0], "instructions", None)
    assert isinstance(effective, str)
    assert "Base instructions." in effective
    assert "Prefer metric units." in effective and "Cite sources." in effective


async def test_history_only_request_needs_no_task() -> None:
    """A continuation carries a history and no new user prompt."""
    seed = ScriptedModelPort([text("first answer")])
    ports = RuntimePorts(model=seed, tool=RecordingToolPort(), authority=Authority())
    first = await execute_runtime(request(tools=[descriptor()]), ports)

    assert first.text == "first answer"

    continuation = ScriptedModelPort([text("continued")])
    continuation_ports = RuntimePorts(
        model=continuation, tool=RecordingToolPort(), authority=Authority()
    )
    from pydantic_ai.messages import ModelRequest, UserPromptPart

    history = [
        ModelRequest(parts=[UserPromptPart(content="Find the answer.")]),
        # A one-message history is enough to prove the history-only path.
    ]
    result = await execute_runtime(
        RuntimeRequest(task=None, history=history, tools=[descriptor()]), continuation_ports
    )

    assert result.text == "continued"
    assert continuation.requests[0].step == 1


async def test_two_tool_calls_in_one_response_run_one_at_a_time() -> None:
    """Tool calls from a single model response must not overlap."""
    model = ScriptedModelPort(
        [
            response(
                call("search", {"query": "a"}, call_id="c-a"),
                call("search", {"query": "b"}, call_id="c-b"),
            ),
            text("both done"),
        ]
    )
    tools = RecordingToolPort(delay=0.02)
    ports = RuntimePorts(model=model, tool=tools, authority=Authority())

    result = await execute_runtime(request(tools=[descriptor()]), ports)

    assert result.tool_calls == 2
    assert tools.max_in_flight == 1, "tool calls overlapped despite sequential mode"
    assert tools.completed == ["search", "search"]


async def test_limits_can_only_be_tightened() -> None:
    """A caller may tighten a limit; a looser one is refused before any work."""
    model = ScriptedModelPort([text("never reached")])
    ports = RuntimePorts(model=model, tool=RecordingToolPort(), authority=Authority())

    for limits in (
        RuntimeLimits(steps=9),
        RuntimeLimits(tool_calls=17),
        RuntimeLimits(tool_result_bytes=128 * 1024 + 1),
        RuntimeLimits(output_bytes=0),
    ):
        with pytest.raises(Exception):
            await execute_runtime(request(tools=[], limits=limits), ports)

    assert model.requests == []


async def test_sdk_agent_is_composed_without_instrumentation_or_retries() -> None:
    """The composition itself is reviewable: no tracing, no retry budget."""
    from openbot_agent_runtime.catalog import ToolCatalog
    from openbot_agent_runtime.guard import RunGuard

    catalog = ToolCatalog([descriptor()], max_tools=8, max_bytes=4096)
    guard = RunGuard(
        authority=Authority(),
        progress=None,
        steps_limit=8,
        tool_calls_limit=16,
        progress_events_limit=8,
        deadline_seconds=None,
    )
    agent = build_sdk_agent(
        ports=RuntimePorts(model=ScriptedModelPort([]), tool=RecordingToolPort(), authority=Authority()),
        catalog=catalog,
        guard=guard,
        limits=RuntimeLimits(),
        instructions="",
    )

    assert agent.instrument is False
    assert agent._max_tool_retries == 0  # noqa: SLF001 - the reviewed retry budget is zero
    assert agent._max_output_retries == 0  # noqa: SLF001
    assert agent.model is not None
    assert agent.model.model_name == "openbot-port"
