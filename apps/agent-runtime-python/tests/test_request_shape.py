"""Request-shape refusals, driven through the real executor.

Each refusal must happen before any host port is used, so every test also asserts
that the model port was never reached.
"""

from __future__ import annotations

import pytest
from pydantic_ai.messages import ModelRequest, UserPromptPart

from openbot_agent_runtime import (
    FailureReason,
    RuntimeLimits,
    RuntimePorts,
    RuntimeRequest,
    execute_runtime,
)

from support import Authority, RecordingToolPort, ScriptedModelPort

pytestmark = pytest.mark.anyio


def _ports() -> tuple[RuntimePorts, ScriptedModelPort]:
    model = ScriptedModelPort([])
    return (
        RuntimePorts(model=model, tool=RecordingToolPort(), authority=Authority()),
        model,
    )


async def test_an_empty_request_is_refused() -> None:
    ports, model = _ports()

    with pytest.raises(Exception) as caught:
        await execute_runtime(RuntimeRequest(task=None, history=None), ports)

    assert caught.value.reason is FailureReason.INVALID_REQUEST
    assert model.requests == []


async def test_a_blank_task_is_refused() -> None:
    ports, model = _ports()

    with pytest.raises(Exception) as caught:
        await execute_runtime(RuntimeRequest(task="   "), ports)

    assert caught.value.reason is FailureReason.INVALID_REQUEST
    assert model.requests == []


async def test_a_non_string_instructions_value_is_refused() -> None:
    ports, _ = _ports()

    with pytest.raises(Exception) as caught:
        await execute_runtime(RuntimeRequest(task="t", instructions=None), ports)  # type: ignore[arg-type]

    assert caught.value.reason is FailureReason.INVALID_REQUEST


async def test_oversize_instructions_are_refused() -> None:
    ports, model = _ports()

    with pytest.raises(Exception) as caught:
        await execute_runtime(
            RuntimeRequest(task="t", instructions="x" * 512, limits=RuntimeLimits(message_bytes=256)),
            ports,
        )

    assert caught.value.reason is FailureReason.MESSAGE_LIMIT
    assert model.requests == []


async def test_a_history_above_the_message_count_limit_is_refused() -> None:
    ports, model = _ports()
    history = [
        ModelRequest(parts=[UserPromptPart(content=f"turn {index}")]) for index in range(9)
    ]

    with pytest.raises(Exception) as caught:
        await execute_runtime(
            RuntimeRequest(task=None, history=history, limits=RuntimeLimits(history_messages=8)),
            ports,
        )

    assert caught.value.reason is FailureReason.INVALID_REQUEST
    assert model.requests == []


async def test_a_history_entry_that_is_not_a_model_message_is_refused() -> None:
    ports, model = _ports()

    with pytest.raises(Exception) as caught:
        await execute_runtime(
            RuntimeRequest(task=None, history=[{"not": "a message"}]),  # type: ignore[list-item]
            ports,
        )

    assert caught.value.reason is FailureReason.INVALID_REQUEST
    assert model.requests == []


async def test_an_oversize_history_is_refused() -> None:
    ports, model = _ports()
    history = [ModelRequest(parts=[UserPromptPart(content="y" * 4000)])]

    with pytest.raises(Exception) as caught:
        await execute_runtime(
            RuntimeRequest(task=None, history=history, limits=RuntimeLimits(message_bytes=512)),
            ports,
        )

    assert caught.value.reason is FailureReason.MESSAGE_LIMIT
    assert model.requests == []


async def test_a_request_that_is_not_a_runtime_request_is_refused() -> None:
    ports, _ = _ports()

    with pytest.raises(Exception) as caught:
        await execute_runtime({"task": "t"}, ports)  # type: ignore[arg-type]

    assert caught.value.reason is FailureReason.INVALID_REQUEST
