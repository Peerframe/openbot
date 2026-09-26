"""The bounded execution unit.

Composition: one real SDK ``Agent`` driven only through ``PortModel`` and
``PortToolset``, under the run guard. The unit owns no state that outlives the
call and writes nothing anywhere.

Verified SDK behaviour this module depends on (probe results in RESEARCH.md §3):

* ``ToolManager.parallel_execution_mode('sequential')`` is a public context manager
  that makes every tool call its own barrier; without it the SDK runs the tool
  calls of one response concurrently.
* An exception that is not ``ToolFailed``/``ModelRetry`` propagates out of the SDK
  unchanged and does not re-invoke the model port.
* ``UsageLimits`` violations and cancellations surface as exceptions, never as
  observations or as a successful completion.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Sequence
from typing import Any, Final

from pydantic_ai import Agent
from pydantic_ai.exceptions import ModelRetry, UnexpectedModelBehavior, UsageLimitExceeded
from pydantic_ai.messages import ModelMessage, ModelMessagesTypeAdapter
from pydantic_ai.tool_manager import ToolManager
from pydantic_ai.usage import UsageLimits

from .bounds import utf8_size
from .catalog import ToolCatalog
from .contracts import (
    Correction,
    RuntimeLimits,
    RuntimePorts,
    RuntimeRequest,
    RuntimeResult,
    validate_deadline,
)
from .errors import FailureReason, RuntimeFailure
from .guard import RunGuard
from .sdk_ports import PortModel, PortToolset, silence_sdk_startup_banner

MAX_CORRECTION_ID_BYTES: Final = 64
"""Runtime-local bound on a correction identifier."""

MAX_REFUSAL_DETAIL_CHARS: Final = 240
"""Diagnostics are truncated: a refusal detail must never become a payload channel."""


def build_sdk_agent(
    *,
    ports: RuntimePorts,
    catalog: ToolCatalog,
    guard: RunGuard,
    limits: RuntimeLimits,
    instructions: str,
) -> Agent[object]:
    """Compose the SDK agent. Exposed so the composition itself can be reviewed.

    Instrumentation is disabled explicitly: ``Agent.__init__`` in 2.47.0 has no
    ``instrument`` keyword, and the resolved default is off, but the unit asserts
    it rather than depending on a default it does not own. No sessions, no durable
    execution, no provider extras: the model port is the only model surface.
    """
    silence_sdk_startup_banner()
    agent: Agent[object] = Agent(
        model=PortModel(
            step_port=ports.model, catalog=catalog, guard=guard, limits=limits
        ),
        toolsets=[
            PortToolset(
                catalog=catalog, tool_port=ports.tool, guard=guard, limits=limits
            )
        ],
        output_type=str,
        instructions=instructions or None,
        retries=0,
    )
    agent.instrument = False
    return agent


class BoundedExecutor:
    """Async executor for one bounded run.

    Stateless between calls: every run gets its own catalog, guard and SDK agent,
    so two concurrent runs cannot share counters or seal state.
    """

    def __init__(self, ports: RuntimePorts) -> None:
        self._ports = ports.validated()

    async def execute(self, request: RuntimeRequest) -> RuntimeResult:
        """Run the bounded loop, or raise :class:`RuntimeFailure`.

        ``asyncio.CancelledError`` is deliberately re-raised rather than converted:
        cancelling the caller's task must stay a cancellation, not become a result.

        The whole asynchronous body — the entry authority check, the corrections
        read, the SDK run and the final authority check — executes inside one
        absolute monotonic deadline (``asyncio.timeout_at``). A relative timeout
        armed only around ``agent.run`` would leave a hanging entry or exit await
        unbounded, which is exactly what a deadline must prevent.
        """
        if not isinstance(request, RuntimeRequest):
            raise RuntimeFailure(
                FailureReason.INVALID_REQUEST,
                f"request must be a RuntimeRequest, got {type(request).__name__}",
            )
        limits = request.limits.validated()
        deadline = validate_deadline(request.deadline_seconds)
        task, messages = _validated_prompt(request, limits)
        catalog = ToolCatalog(
            request.tools, max_tools=limits.catalog_tools, max_bytes=limits.catalog_bytes
        )
        guard = RunGuard(
            authority=self._ports.authority,
            progress=self._ports.progress,
            steps_limit=limits.steps,
            tool_calls_limit=limits.tool_calls,
            progress_events_limit=limits.progress_events,
            deadline_seconds=deadline,
        )

        try:
            # ``timeout_at(None)`` applies no limit, so one code path covers both the
            # bounded and the unbounded request. The instant comes from the guard, so
            # the guard's own monotonic checks and the loop timer share one deadline.
            async with asyncio.timeout_at(guard.deadline_at):
                return await self._run_bounded(
                    request=request,
                    guard=guard,
                    catalog=catalog,
                    limits=limits,
                    task=task,
                    messages=messages,
                )
        except asyncio.CancelledError:
            guard.note_cancellation()
            raise
        except TimeoutError as exc:
            # ``asyncio.timeout_at`` turns the cancellation it issued into a
            # ``TimeoutError``. A port that swallowed the cancellation and returned
            # late is still refused by the guard's own monotonic check inside
            # ``_run_bounded`` and by ``ensure_success_allowed``.
            raise guard.fail(
                FailureReason.DEADLINE_EXCEEDED, f"the run exceeded its {deadline}s deadline"
            ) from exc

    async def _run_bounded(
        self,
        *,
        request: RuntimeRequest,
        guard: RunGuard,
        catalog: ToolCatalog,
        limits: RuntimeLimits,
        task: str | None,
        messages: list[ModelMessage] | None,
    ) -> RuntimeResult:
        """The guarded body. Callers must already hold the run's single deadline."""
        await guard.check("start")
        instructions, applied = await _apply_corrections(
            ports=self._ports, guard=guard, limits=limits, base=request.instructions
        )
        agent = build_sdk_agent(
            ports=self._ports, catalog=catalog, guard=guard, limits=limits, instructions=instructions
        )

        try:
            run_result = await _run_agent(agent, task=task, messages=messages, limits=limits)
        except RuntimeFailure:
            raise
        except UsageLimitExceeded as exc:
            # Backstop only: see `_run_agent` for why the SDK budget is one step
            # looser than the runtime counters, which are the enforcing layer.
            raise guard.fail(FailureReason.LIMIT_EXCEEDED, f"SDK budget backstop: {exc}") from exc
        except UnexpectedModelBehavior as exc:
            raise guard.fail(
                _classify_sdk_refusal(exc), f"the SDK refused the run: {_refusal_reason(exc)}"
            ) from exc
        except Exception as exc:
            raise guard.fail(
                FailureReason.UNEXPECTED, f"{type(exc).__name__} escaped the run"
            ) from exc

        guard.ensure_success_allowed()
        text = run_result.output
        if not isinstance(text, str):
            raise guard.fail(
                FailureReason.OUTPUT_INVALID, f"final output is {type(text).__name__}, not text"
            )
        # Mirror the Server's own final check (apps/server/src/agent-runtime.ts:238-246):
        # blank text is refused, and the accepted text is trimmed before it is returned,
        # so a whitespace-only "answer" cannot become a successful Run.
        if not text.strip():
            raise guard.fail(
                FailureReason.OUTPUT_INVALID, "final output is empty or whitespace-only"
            )
        if utf8_size(text) > limits.output_bytes:
            raise guard.fail(
                FailureReason.OUTPUT_LIMIT,
                f"final output is {utf8_size(text)} bytes, above the limit of {limits.output_bytes}",
            )
        await guard.check("final result")
        return RuntimeResult(
            text=text.strip(),
            applied_correction_ids=applied,
            steps=guard.steps,
            tool_calls=guard.tool_calls,
        )


async def execute_runtime(request: RuntimeRequest, ports: RuntimePorts) -> RuntimeResult:
    """Convenience entry point for a single run."""
    return await BoundedExecutor(ports).execute(request)


def _classify_sdk_refusal(error: UnexpectedModelBehavior) -> FailureReason:
    """Tell a refused tool call apart from an unusable model response.

    ``ToolManager._check_max_retries`` raises ``UnexpectedModelBehavior ... from
    error`` (pydantic_ai/tool_manager.py:305-308), so the originating ``ModelRetry``
    survives as ``__cause__``. With ``max_retries=0`` the first attempt already
    exhausts the budget, which is why a model-invented tool name arrives here: the
    SDK resolves tool names *before* the toolset is called, so an unknown name never
    reaches ``PortToolset.call_tool`` at all. Verified against the pinned build.
    """
    if isinstance(error.__cause__, ModelRetry):
        return FailureReason.UNKNOWN_TOOL
    return FailureReason.MODEL_RESPONSE_INVALID


def _refusal_reason(error: BaseException) -> str:
    """Bounded diagnostic text, preferring the originating cause."""
    source = error.__cause__ or error
    return f"{type(source).__name__}: {source}"[:MAX_REFUSAL_DETAIL_CHARS]


async def _run_agent(
    agent: Agent[object],
    *,
    task: str | None,
    messages: list[ModelMessage] | None,
    limits: RuntimeLimits,
) -> Any:
    """Run the agent sequentially, under the SDK backstop budget only.

    The deadline is owned by :meth:`BoundedExecutor.execute`, which puts the whole
    asynchronous body under one absolute monotonic ``asyncio.timeout_at``. This
    helper deliberately adds no second, relative timeout: a nested one would restart
    the clock after preparation and hide a hanging entry or exit await.

    The SDK budget is set exactly one step looser than the runtime's own counters.
    At the same threshold the SDK's check would fire first — it runs before the
    model port, while the runtime's counter runs inside it — which would replace the
    runtime's reason (``step_limit``/``tool_call_limit``) with a generic SDK one.
    Loosening it by one keeps the runtime the enforcing layer and leaves the SDK
    limit as a genuine backstop for a counter that failed to fire.
    """
    usage_limits = UsageLimits(
        request_limit=limits.steps + 1, tool_calls_limit=limits.tool_calls + 1
    )
    with ToolManager.parallel_execution_mode("sequential"):
        return await agent.run(task, message_history=messages, usage_limits=usage_limits)


def _validated_prompt(
    request: RuntimeRequest, limits: RuntimeLimits
) -> tuple[str | None, list[ModelMessage] | None]:
    """Bound and check the prompt, refusing an empty request."""
    if not isinstance(request, RuntimeRequest):
        raise RuntimeFailure(
            FailureReason.INVALID_REQUEST, f"request must be a RuntimeRequest, got {type(request).__name__}"
        )
    if not isinstance(request.instructions, str):
        raise RuntimeFailure(FailureReason.INVALID_REQUEST, "instructions must be a string")
    if utf8_size(request.instructions) > limits.message_bytes:
        raise RuntimeFailure(
            FailureReason.MESSAGE_LIMIT, "instructions exceed the message byte limit"
        )

    task = request.task
    if task is not None:
        if not isinstance(task, str) or not task.strip():
            raise RuntimeFailure(FailureReason.INVALID_REQUEST, "task must be a non-empty string")
        if utf8_size(task) > limits.message_bytes:
            raise RuntimeFailure(FailureReason.MESSAGE_LIMIT, "task exceeds the message byte limit")

    messages = _validated_history(request.history, limits)
    if task is None and not messages:
        raise RuntimeFailure(
            FailureReason.INVALID_REQUEST, "a task or a non-empty message history is required"
        )
    return task, messages


def _validated_history(
    history: Sequence[ModelMessage] | None, limits: RuntimeLimits
) -> list[ModelMessage] | None:
    """Check the input history count and bytes before any run work starts."""
    if history is None:
        return None
    if isinstance(history, (str, bytes)) or not isinstance(history, Sequence):
        raise RuntimeFailure(
            FailureReason.INVALID_REQUEST, "message history must be a sequence of model messages"
        )
    if len(history) > limits.history_messages:
        raise RuntimeFailure(
            FailureReason.INVALID_REQUEST,
            f"message history has {len(history)} entries, above the limit of {limits.history_messages}",
        )
    items = list(history)
    try:
        # Validate structurally rather than only serializing: the message adapter
        # can serialize a near-miss with warnings, which would let a malformed
        # history reach the SDK and fail much later for an unrelated-looking reason.
        validated = ModelMessagesTypeAdapter.validate_python(items)
        payload = ModelMessagesTypeAdapter.dump_json(validated)
    except Exception as exc:
        raise RuntimeFailure(
            FailureReason.INVALID_REQUEST,
            f"message history is not a valid model message sequence: {type(exc).__name__}",
        ) from exc
    if len(payload) > limits.message_bytes:
        raise RuntimeFailure(
            FailureReason.MESSAGE_LIMIT,
            f"message history occupies {len(payload)} bytes, above the limit of {limits.message_bytes}",
        )
    return list(validated)


async def _apply_corrections(
    *,
    ports: RuntimePorts,
    guard: RunGuard,
    limits: RuntimeLimits,
    base: str,
) -> tuple[str, tuple[str, ...]]:
    """Take one bounded snapshot of the caller's corrections.

    Corrections are supplied by the caller and applied to this run only: the unit
    keeps no copy, stores nothing and reports only which identifiers it applied.
    """
    if ports.corrections is None:
        return base, ()
    await guard.check("corrections")
    try:
        outcome = ports.corrections()
    except RuntimeFailure:
        raise
    except Exception as exc:
        raise guard.fail(
            FailureReason.CORRECTION_INVALID, f"corrections port raised {type(exc).__name__}"
        ) from exc
    if not inspect.isawaitable(outcome):
        raise guard.fail(
            FailureReason.CORRECTION_INVALID,
            f"corrections port returned {type(outcome).__name__}, not an awaitable",
        )
    try:
        items = await outcome
    except RuntimeFailure:
        raise
    except Exception as exc:
        raise guard.fail(
            FailureReason.CORRECTION_INVALID, f"corrections port raised {type(exc).__name__}"
        ) from exc
    await guard.check("corrections")

    if isinstance(items, (str, bytes)) or not isinstance(items, Sequence):
        raise guard.fail(
            FailureReason.CORRECTION_INVALID, "corrections must be a sequence of Correction values"
        )
    if len(items) > limits.corrections:
        raise guard.fail(
            FailureReason.CORRECTION_INVALID,
            f"{len(items)} corrections supplied, above the limit of {limits.corrections}",
        )

    applied: list[str] = []
    texts: list[str] = []
    total = 0
    for item in items:
        if not isinstance(item, Correction):
            raise guard.fail(
                FailureReason.CORRECTION_INVALID,
                f"corrections must be Correction values, got {type(item).__name__}",
            )
        if (
            not isinstance(item.id, str)
            or not item.id
            or utf8_size(item.id) > MAX_CORRECTION_ID_BYTES
            or item.id in applied
        ):
            raise guard.fail(
                FailureReason.CORRECTION_INVALID, "correction identifiers must be unique and bounded"
            )
        if not isinstance(item.instruction, str) or not item.instruction.strip():
            raise guard.fail(
                FailureReason.CORRECTION_INVALID, f"correction {item.id!r} has no instruction"
            )
        total += utf8_size(item.instruction)
        if total > limits.correction_bytes:
            raise guard.fail(
                FailureReason.CORRECTION_INVALID,
                f"corrections exceed the {limits.correction_bytes} byte bound",
            )
        applied.append(item.id)
        texts.append(item.instruction)

    if not texts:
        return base, ()
    combined = "\n".join([base, *texts]) if base else "\n".join(texts)
    if utf8_size(combined) > limits.message_bytes:
        raise guard.fail(
            FailureReason.MESSAGE_LIMIT, "combined instructions exceed the message byte limit"
        )
    return combined, tuple(applied)


__all__ = ["BoundedExecutor", "build_sdk_agent", "execute_runtime"]
