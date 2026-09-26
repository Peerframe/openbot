"""Mandatory authority: there is no permissive fallback, and a late revocation counts.

Denial is triggered by an event (the model port or tool port having been used)
rather than by a call count, so each test binds to a cause instead of to how many
times the guard happens to check.
"""

from __future__ import annotations

import pytest

from openbot_agent_runtime import (
    BoundedExecutor,
    FailureReason,
    RuntimePorts,
    execute_runtime,
)
from openbot_agent_runtime.errors import RuntimeFailure
from openbot_agent_runtime.guard import RunGuard

from support import Authority, AuthorityRevoked, RecordingToolPort, ScriptedModelPort, call, descriptor, request, text

pytestmark = pytest.mark.anyio


async def test_a_missing_authority_port_fails_closed_before_any_work() -> None:
    model = ScriptedModelPort([text("never")])
    tools = RecordingToolPort()
    ports = RuntimePorts(model=model, tool=tools, authority=None)  # type: ignore[arg-type]

    with pytest.raises(RuntimeFailure) as caught:
        BoundedExecutor(ports)

    assert caught.value.reason is FailureReason.AUTHORITY_MISSING
    assert model.requests == []
    assert tools.calls == []


async def test_authority_that_answers_synchronously_is_refused() -> None:
    """A synchronous "ok" is not evidence of authority, so it must not be trusted."""
    model = ScriptedModelPort([text("never")])
    ports = RuntimePorts(
        model=model, tool=RecordingToolPort(), authority=Authority(synchronous=True)
    )

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(request(tools=[]), ports)

    assert caught.value.reason is FailureReason.AUTHORITY_INVALID
    assert model.requests == []


async def test_authority_failure_before_the_run_stops_all_host_work() -> None:
    model = ScriptedModelPort([text("never")])
    tools = RecordingToolPort()
    ports = RuntimePorts(
        model=model, tool=tools, authority=Authority(deny_when=lambda: True)
    )

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(request(tools=[descriptor()]), ports)

    assert caught.value.reason is FailureReason.AUTHORITY_REVOKED
    assert model.requests == []
    assert tools.calls == []


async def test_revocation_after_a_model_step_stops_before_the_tool_call() -> None:
    model = ScriptedModelPort([call("search", {"query": "a"}, call_id="c1"), text("late")])
    tools = RecordingToolPort()
    ports = RuntimePorts(
        model=model,
        tool=tools,
        authority=Authority(deny_when=lambda: bool(model.requests)),
    )

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(request(tools=[descriptor()]), ports)

    assert caught.value.reason is FailureReason.AUTHORITY_REVOKED
    assert len(model.requests) == 1
    assert tools.calls == []


async def test_revocation_after_tool_work_refuses_the_result() -> None:
    """The model and the tool both ran; the run still cannot complete."""
    model = ScriptedModelPort([call("search", {"query": "a"}, call_id="c1"), text("late")])
    tools = RecordingToolPort()
    ports = RuntimePorts(
        model=model,
        tool=tools,
        authority=Authority(deny_when=lambda: bool(tools.calls)),
    )

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(request(tools=[descriptor()]), ports)

    assert caught.value.reason is FailureReason.AUTHORITY_REVOKED
    assert len(tools.calls) == 1
    assert len(model.requests) == 1, "the model was asked again after authority was withdrawn"


async def test_revocation_after_the_final_text_does_not_produce_a_result() -> None:
    model = ScriptedModelPort([text("an answer that must not be returned")])
    ports = RuntimePorts(
        model=model,
        tool=RecordingToolPort(),
        authority=Authority(deny_when=lambda: bool(model.final_steps)),
    )

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(request(tools=[]), ports)

    assert caught.value.reason is FailureReason.AUTHORITY_REVOKED


async def test_authority_is_checked_around_every_boundary() -> None:
    """Two model steps and one tool call must produce more checks than boundaries."""
    model = ScriptedModelPort([call("search", {"query": "a"}, call_id="c1"), text("done")])
    tools = RecordingToolPort()
    authority = Authority()
    ports = RuntimePorts(model=model, tool=tools, authority=authority)

    await execute_runtime(request(tools=[descriptor()]), ports)

    boundaries = len(model.requests) + len(tools.calls)
    assert boundaries == 3
    # start, (before progress + after progress + after the model port) x 2 model steps,
    # (after progress + after the tool port) x 1 tool call, final result.
    assert authority.calls == 10


async def test_guard_refuses_every_check_after_a_refusal() -> None:
    """The seal is sticky: the authoritative cause is what a caller sees."""
    guard = RunGuard(
        authority=Authority(),
        progress=None,
        steps_limit=8,
        tool_calls_limit=16,
        progress_events_limit=8,
        deadline_seconds=None,
    )
    first = guard.fail(FailureReason.AUTHORITY_REVOKED, "withdrawn")
    second = guard.fail(FailureReason.UNEXPECTED, "a later, less relevant error")

    assert first is second
    with pytest.raises(RuntimeFailure) as caught:
        guard.check_sync("anything")
    assert caught.value.reason is FailureReason.AUTHORITY_REVOKED


async def test_guard_reports_a_revocation_from_the_authority_call_itself() -> None:
    guard = RunGuard(
        authority=_AlwaysDenied(),
        progress=None,
        steps_limit=8,
        tool_calls_limit=16,
        progress_events_limit=8,
        deadline_seconds=None,
    )

    with pytest.raises(RuntimeFailure) as caught:
        await guard.check("final result")

    assert caught.value.reason is FailureReason.AUTHORITY_REVOKED
    assert guard.authority_checks == 1


class _AlwaysDenied:
    async def __call__(self) -> None:
        raise AuthorityRevoked("withdrawn")
