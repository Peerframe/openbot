"""Limits, deadlines and cancellation.

The two guarantees under test: a bounded ceiling stops the run instead of being
silently exceeded, and cancelled or out-of-time work can never produce a result.

The cancellation checks are end-to-end against the real SDK. The seal that refuses
a *late* completion is additionally unit-tested on the guard, because the SDK
re-delivers cancellation so reliably that a completed-after-cancellation run is not
reachable through the public path — the guard test is labelled accordingly rather
than dressed up as an integration result.
"""

from __future__ import annotations

import asyncio

import pytest

from openbot_agent_runtime import (
    FailureReason,
    RuntimeLimits,
    RuntimePorts,
    RuntimeResult,
    execute_runtime,
)
from openbot_agent_runtime.errors import RuntimeFailure
from openbot_agent_runtime.guard import RunGuard

from support import (
    Authority,
    RecordingToolPort,
    ScriptedModelPort,
    call,
    descriptor,
    request,
    response,
    text,
)

pytestmark = pytest.mark.anyio


def _ports(model: ScriptedModelPort, tools: RecordingToolPort) -> RuntimePorts:
    return RuntimePorts(model=model, tool=tools, authority=Authority())


async def test_the_step_ceiling_stops_the_run() -> None:
    model = ScriptedModelPort(
        [
            call("search", {"query": "a"}, call_id="c1"),
            call("search", {"query": "b"}, call_id="c2"),
            call("search", {"query": "c"}, call_id="c3"),
            text("never"),
        ]
    )
    tools = RecordingToolPort()

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[descriptor()], limits=RuntimeLimits(steps=2)),
            _ports(model, tools),
        )

    assert caught.value.reason is FailureReason.STEP_LIMIT
    assert len(model.requests) == 2
    assert len(tools.calls) == 2


async def test_the_tool_call_ceiling_stops_the_run() -> None:
    model = ScriptedModelPort(
        [
            response(
                call("search", {"query": "a"}, call_id="c1"),
                call("search", {"query": "b"}, call_id="c2"),
            ),
            text("never"),
        ]
    )
    tools = RecordingToolPort()

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[descriptor()], limits=RuntimeLimits(tool_calls=1)),
            _ports(model, tools),
        )

    assert caught.value.reason is FailureReason.TOOL_CALL_LIMIT
    assert len(tools.calls) == 1


async def test_a_repeated_call_identifier_is_refused_as_a_correlation_check() -> None:
    """A repeated SDK identifier is refused, but this is *not* replay protection.

    The identifier is model-invocation data, so this only catches a literal repeat of
    one identifier inside one run. It says nothing about the same name and arguments
    under *different* identifiers, which are admitted separately — see the honest-limit
    disclosure in ``tests/test_review_002.py``. The authority port here grants every
    check, so the refusal is a correlation decision and not an authority one.
    """
    model = ScriptedModelPort(
        [
            call("search", {"query": "a"}, call_id="same-id"),
            call("search", {"query": "b"}, call_id="same-id"),
            text("never"),
        ]
    )
    tools = RecordingToolPort()

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(request(tools=[descriptor()]), _ports(model, tools))

    assert caught.value.reason is FailureReason.DUPLICATE_TOOL_CALL
    assert len(tools.calls) == 1


async def test_a_deadline_during_a_model_step_fails_the_run() -> None:
    model = ScriptedModelPort([text("too late")], delay=5.0)
    tools = RecordingToolPort()

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[], deadline_seconds=0.1), _ports(model, tools)
        )

    assert caught.value.reason is FailureReason.DEADLINE_EXCEEDED


async def test_a_deadline_during_a_tool_call_fails_the_run() -> None:
    model = ScriptedModelPort([call("search", {"query": "a"}, call_id="c1"), text("too late")])
    tools = RecordingToolPort(delay=5.0)

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[descriptor()], deadline_seconds=0.1), _ports(model, tools)
        )

    assert caught.value.reason is FailureReason.DEADLINE_EXCEEDED


async def test_a_model_port_that_swallows_the_timeout_cannot_complete() -> None:
    """Even if the host adapter eats the cancellation, the run must not succeed."""
    model = ScriptedModelPort([text("late success")], delay=5.0, swallow_cancel=True)
    tools = RecordingToolPort()

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[], deadline_seconds=0.1), _ports(model, tools)
        )

    assert caught.value.reason is FailureReason.DEADLINE_EXCEEDED


async def test_cancelling_the_task_during_a_model_step_yields_no_result() -> None:
    model = ScriptedModelPort([text("late success")], delay=5.0)
    tools = RecordingToolPort()
    task = asyncio.create_task(execute_runtime(request(tools=[]), _ports(model, tools)))

    await asyncio.sleep(0.05)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task


async def test_cancelling_the_task_during_a_tool_call_yields_no_result() -> None:
    model = ScriptedModelPort([call("search", {"query": "a"}, call_id="c1"), text("late")])
    tools = RecordingToolPort(delay=5.0)
    task = asyncio.create_task(
        execute_runtime(request(tools=[descriptor()]), _ports(model, tools))
    )

    await asyncio.sleep(0.05)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task


async def test_a_model_port_that_swallows_cancellation_cannot_complete() -> None:
    model = ScriptedModelPort([text("late success")], delay=5.0, swallow_cancel=True)
    tools = RecordingToolPort()
    task = asyncio.create_task(execute_runtime(request(tools=[]), _ports(model, tools)))

    await asyncio.sleep(0.05)
    task.cancel()

    with pytest.raises((asyncio.CancelledError, RuntimeFailure)) as caught:
        await task

    # A refusal is acceptable; a late completion is not. Success is excluded by
    # raising at all, and the only permitted reason is the late-result seal.
    if isinstance(caught.value, RuntimeFailure):
        assert caught.value.reason is FailureReason.LATE_RESULT


async def test_guard_refuses_further_work_after_cancellation() -> None:
    guard = _guard()
    guard.note_cancellation()

    with pytest.raises(RuntimeFailure) as blocked:
        guard.check_sync("any further work")

    assert blocked.value.reason is FailureReason.CANCELLED


async def test_guard_refuses_a_completion_after_cancellation() -> None:
    guard = _guard()
    guard.note_cancellation()

    with pytest.raises(RuntimeFailure) as caught:
        guard.ensure_success_allowed()

    assert caught.value.reason is FailureReason.LATE_RESULT


async def test_guard_refuses_a_completion_after_the_deadline() -> None:
    now = [0.0]
    guard = RunGuard(
        authority=Authority(),
        progress=None,
        steps_limit=8,
        tool_calls_limit=16,
        progress_events_limit=8,
        deadline_seconds=10.0,
        clock=lambda: now[0],
    )
    guard.check_sync("start")

    now[0] = 10.5

    with pytest.raises(RuntimeFailure) as caught:
        guard.ensure_success_allowed()
    assert caught.value.reason is FailureReason.DEADLINE_EXCEEDED


async def test_guard_refuses_a_completion_after_a_recorded_failure() -> None:
    guard = _guard()
    guard.fail(FailureReason.TOOL_PORT_ERROR, "host refused the call")

    with pytest.raises(RuntimeFailure) as caught:
        guard.ensure_success_allowed()

    assert caught.value.reason is FailureReason.TOOL_PORT_ERROR


def test_runtime_result_carries_no_status_usage_or_server_handles() -> None:
    """The result shape is part of the contract, so it is asserted explicitly."""
    fields = set(RuntimeResult.__dataclass_fields__)
    assert fields == {"text", "applied_correction_ids", "steps", "tool_calls"}


async def test_the_sdk_budget_backstop_sits_one_step_beyond_the_ceiling() -> None:
    """Pin the deliberate gap: the runtime counters enforce, the SDK backstops.

    At an equal threshold the SDK's own check fires first (it runs before the model
    port and before each tool call), which would report a generic SDK limit instead
    of the runtime's ``step_limit``/``tool_call_limit``. This test keeps that gap
    from being quietly removed.
    """
    from openbot_agent_runtime.executor import _run_agent

    agent = _CapturingAgent()
    limits = RuntimeLimits()

    with pytest.raises(_StopRun):
        await _run_agent(agent, task="t", messages=None, limits=limits)

    composed = agent.kwargs["usage_limits"]
    assert composed.request_limit == limits.steps + 1
    assert composed.tool_calls_limit == limits.tool_calls + 1


class _StopRun(Exception):
    """Sentinel: the capture agent never runs a real model step."""


class _CapturingAgent:
    def __init__(self) -> None:
        self.kwargs: dict[str, object] = {}

    async def run(self, task, *, message_history=None, usage_limits=None):  # noqa: ANN001
        self.kwargs = {"task": task, "usage_limits": usage_limits}
        raise _StopRun


def _guard() -> RunGuard:
    return RunGuard(
        authority=Authority(),
        progress=None,
        steps_limit=8,
        tool_calls_limit=16,
        progress_events_limit=8,
        deadline_seconds=None,
    )
