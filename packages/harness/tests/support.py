"""Deterministic fakes for the host ports.

Everything here is synthetic: no paid API, no provider SDK, no credentials, no
database. The model port returns fixed ``ModelResponse`` fixtures and the tool port
records calls instead of performing effects, so a test asserts runtime behaviour
rather than restating the implementation.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart

from openbot_agent_runtime import (
    Correction,
    ModelStepRequest,
    RuntimeRequest,
    ToolCallRequest,
    ToolDescriptor,
)

SEARCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"query": {"type": "string"}, "limit": {"type": "integer"}},
    "required": ["query"],
    "additionalProperties": False,
}


def descriptor(
    name: str = "search",
    *,
    schema: dict[str, Any] | None = None,
    description: str = "Search the scoped corpus.",
) -> ToolDescriptor:
    return ToolDescriptor(
        name=name,
        description=description,
        input_schema=dict(SEARCH_SCHEMA if schema is None else schema),
    )


def text(value: str) -> TextPart:
    return TextPart(value)


def call(name: str, args: Any = None, *, call_id: str) -> ToolCallPart:
    return ToolCallPart(name, {} if args is None else args, tool_call_id=call_id)


def response(*parts: Any) -> list[Any]:
    """A model step returning several parts, e.g. two tool calls at once."""
    return list(parts)


def request(
    *,
    task: str | None = "Find the answer.",
    history: Sequence[Any] | None = None,
    tools: Sequence[ToolDescriptor] = (),
    instructions: str = "Be brief.",
    limits: Any = None,
    deadline_seconds: float | None = None,
) -> RuntimeRequest:
    kwargs: dict[str, Any] = {
        "instructions": instructions,
        "task": task,
        "history": history,
        "tools": tuple(tools),
        "deadline_seconds": deadline_seconds,
    }
    if limits is not None:
        kwargs["limits"] = limits
    return RuntimeRequest(**kwargs)


class ScriptExhausted(AssertionError):
    """A test asked for more model steps than it scripted."""


class ScriptedModelPort:
    """Model port that replays a script of responses, one per SDK model step."""

    def __init__(
        self,
        steps: Sequence[Any],
        *,
        delay: float = 0.0,
        swallow_cancel: bool = False,
        error: BaseException | None = None,
    ) -> None:
        self._steps = list(steps)
        self.requests: list[ModelStepRequest] = []
        self.final_steps = 0
        self.delay = delay
        self.swallow_cancel = swallow_cancel
        self.error = error

    async def __call__(self, step_request: ModelStepRequest) -> ModelResponse:
        self.requests.append(step_request)
        if self.error is not None:
            raise self.error
        if not self._steps:
            raise ScriptExhausted(
                f"model port called for step {step_request.step} with an exhausted script"
            )
        item = self._steps.pop(0)
        if self.delay:
            try:
                await asyncio.sleep(self.delay)
            except asyncio.CancelledError:
                if not self.swallow_cancel:
                    raise
        parts = item if isinstance(item, (list, tuple)) else [item]
        if any(isinstance(part, TextPart) for part in parts):
            self.final_steps += 1
        return ModelResponse(parts=list(parts))


class ToolPortFailure(RuntimeError):
    """Raised by the fake tool port, standing in for a failing host adapter."""


class RecordingToolPort:
    """Tool port that records calls and detects concurrent execution."""

    def __init__(
        self,
        *,
        results: dict[str, Any] | None = None,
        error_for: frozenset[str] = frozenset(),
        raise_error: BaseException | None = None,
        delay: float = 0.0,
        synchronous: bool = False,
    ) -> None:
        self.calls: list[ToolCallRequest] = []
        self.results = results or {}
        self.error_for = error_for
        self.raise_error = raise_error
        self.delay = delay
        self.synchronous = synchronous
        self.in_flight = 0
        self.max_in_flight = 0
        self.completed: list[str] = []

    def __call__(self, tool_request: ToolCallRequest) -> Awaitable[Any] | Any:
        if self.synchronous:
            # A host adapter that forgot to be async. Awaiting this must abort.
            return {"ok": True}
        return self._run(tool_request)

    async def _run(self, tool_request: ToolCallRequest) -> Any:
        self.calls.append(tool_request)
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            if self.raise_error is not None:
                raise self.raise_error
            if tool_request.name in self.error_for:
                raise ToolPortFailure(f"host refused {tool_request.name}")
            self.completed.append(tool_request.name)
            return self.results.get(tool_request.name, {"ok": tool_request.name})
        finally:
            self.in_flight -= 1


class AuthorityRevoked(RuntimeError):
    """Raised by the fake authority port when the Server withdraws authority."""


class Authority:
    """Authority port with event-driven denial, so tests bind to causes not counts."""

    def __init__(
        self,
        *,
        deny_when: Callable[[], bool] | None = None,
        deny_error: BaseException | None = None,
        synchronous: bool = False,
    ) -> None:
        self.calls = 0
        self.deny_when = deny_when
        self.deny_error = deny_error or AuthorityRevoked("scope revoked")
        self.synchronous = synchronous

    def __call__(self) -> Awaitable[None] | None:
        self.calls += 1
        denying = self.deny_when is not None and self.deny_when()
        if self.synchronous:
            if denying:
                raise self.deny_error
            return None
        return self._decide(denying)

    async def _decide(self, denying: bool) -> None:
        if denying:
            raise self.deny_error
        return None


class RecordingProgressPort:
    def __init__(
        self,
        *,
        error: BaseException | None = None,
        synchronous: bool = False,
        on_event: Callable[[], None] | None = None,
    ) -> None:
        self.events: list[tuple[str, str]] = []
        self.error = error
        self.synchronous = synchronous
        self.on_event = on_event

    def __call__(self, stage: str, message: str) -> Awaitable[None] | None:
        if self.synchronous:
            return None
        return self._record(stage, message)

    async def _record(self, stage: str, message: str) -> None:
        if self.error is not None:
            raise self.error
        if self.on_event is not None:
            # Lets a test withdraw authority *during* the progress await, which is
            # the window the post-progress authority check must close.
            self.on_event()
        self.events.append((stage, message))


class HangingPort:
    """A port that never returns, to prove a deadline bounds every awaited boundary.

    Cancellation is not swallowed: the point is that an unresponsive host callback
    must not be able to outlive the run's deadline.
    """

    def __init__(self) -> None:
        self.calls = 0

    async def __call__(self, *args: Any, **kwargs: Any) -> None:
        self.calls += 1
        await asyncio.Event().wait()


class SlowPort:
    """A port that takes a fixed, non-trivial time before answering."""

    def __init__(self, delay: float) -> None:
        self.delay = delay
        self.calls = 0

    async def __call__(self, *args: Any, **kwargs: Any) -> None:
        self.calls += 1
        await asyncio.sleep(self.delay)


class CorrectionsPort:
    def __init__(self, corrections: Sequence[Correction] = (), *, error: BaseException | None = None) -> None:
        self.corrections = list(corrections)
        self.error = error
        self.calls = 0

    async def __call__(self) -> Sequence[Correction]:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return list(self.corrections)
