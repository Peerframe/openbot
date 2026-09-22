"""The run guard: authority, secondary budget counters, deadline and sealing.

Two invariants make the rest of the unit safe:

1. No awaited boundary is crossed without a fresh authority check. Every model
   step, every tool call and the final result are bracketed by ``check()``, and
   ``check()`` re-examines the deadline after the authority round trip, so a
   revocation or an expiry that happens *during* an await is still observed.
2. Failure is sticky. The first refusal seals the run; later attempts can only
   re-raise it. A port that swallows a cancellation and returns late therefore
   cannot produce a success, because the seal is examined before any result is
   accepted.

Marked internal: it is exercised directly by tests, but it is not part of the
public port contract.
"""

from __future__ import annotations

import inspect
import time
from typing import Any

from .contracts import ProgressStage
from .errors import FailureReason, RuntimeFailure


class RunGuard:
    """Authority checks, budget counters and failure sealing for one run."""

    def __init__(
        self,
        *,
        authority: Any,
        progress: Any,
        steps_limit: int,
        tool_calls_limit: int,
        progress_events_limit: int,
        deadline_seconds: float | None,
        clock: Any = time.monotonic,
    ) -> None:
        self._authority = authority
        self._progress = progress
        self._steps_limit = steps_limit
        self._tool_calls_limit = tool_calls_limit
        self._progress_events_limit = progress_events_limit
        self._clock = clock
        self._deadline_at = None if deadline_seconds is None else clock() + deadline_seconds
        self._failure: RuntimeFailure | None = None
        self._cancelled = False
        self.steps = 0
        self.tool_calls = 0
        self.authority_checks = 0
        self.progress_events = 0
        self._call_ids: set[str] = set()

    # -- state -----------------------------------------------------------------

    @property
    def failure(self) -> RuntimeFailure | None:
        return self._failure

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    @property
    def deadline_at(self) -> float | None:
        """Absolute monotonic instant this run must finish by, if a deadline was set.

        Exposed so the executor can put the whole asynchronous body under a single
        ``asyncio.timeout_at`` on the same clock. A relative timeout started after
        preparation would let a hanging entry or exit await run unbounded, and a
        restarted duration would give a slow preparation a fresh budget.
        """
        return self._deadline_at

    def deadline_passed(self) -> bool:
        return self._deadline_at is not None and self._clock() >= self._deadline_at

    # -- failure sealing -------------------------------------------------------

    def fail(self, reason: FailureReason, detail: str = "") -> RuntimeFailure:
        """Seal the run with ``reason`` and return the failure to be raised.

        The first refusal wins: once sealed, this returns that failure, so a
        cascade of secondary errors cannot overwrite the authoritative cause.
        """
        failure = RuntimeFailure(reason, detail)
        if self._failure is None:
            self._failure = failure
        return self._failure

    def note_cancellation(self) -> None:
        """Record that cancellation was observed, so no result may be accepted."""
        self._cancelled = True

    # -- checkpoints -----------------------------------------------------------

    def check_sync(self, where: str) -> None:
        """Check the seal, cancellation and deadline without awaiting anything."""
        if self._failure is not None:
            raise self._failure
        if self._cancelled:
            raise self.fail(FailureReason.CANCELLED, f"cancellation observed before {where}")
        if self.deadline_passed():
            raise self.fail(FailureReason.DEADLINE_EXCEEDED, f"deadline passed before {where}")

    async def check(self, where: str) -> None:
        """Check the seal and deadline, then require fresh Server authority."""
        self.check_sync(where)
        self.authority_checks += 1
        try:
            outcome = self._authority()
        except RuntimeFailure:
            raise
        except Exception as exc:
            raise self.fail(
                FailureReason.AUTHORITY_REVOKED, f"{where}: authority raised {type(exc).__name__}"
            ) from exc
        if not inspect.isawaitable(outcome):
            # A synchronous "ok" is not evidence of authority. Treating it as one
            # would be exactly the permissive fallback this unit must not have.
            raise self.fail(
                FailureReason.AUTHORITY_INVALID,
                f"{where}: authority returned {type(outcome).__name__}, not an awaitable",
            )
        try:
            await outcome
        except RuntimeFailure:
            raise
        except Exception as exc:
            raise self.fail(
                FailureReason.AUTHORITY_REVOKED, f"{where}: authority raised {type(exc).__name__}"
            ) from exc
        self.check_sync(where)

    def ensure_success_allowed(self) -> None:
        """Refuse a completion that appeared after cancellation or the deadline."""
        if self._failure is not None:
            raise self._failure
        if self._cancelled:
            raise self.fail(
                FailureReason.LATE_RESULT, "a result appeared after cancellation was observed"
            )
        if self.deadline_passed():
            raise self.fail(FailureReason.DEADLINE_EXCEEDED, "the run completed after its deadline")

    # -- counters --------------------------------------------------------------

    def note_model_step(self) -> int:
        """Admit one model step. The Server remains the primary budget authority."""
        self.check_sync("model step")
        if self.steps >= self._steps_limit:
            raise self.fail(
                FailureReason.STEP_LIMIT,
                f"refusing model step {self.steps + 1}; the limit is {self._steps_limit}",
            )
        self.steps += 1
        self._call_ids.clear()
        return self.steps

    def note_tool_call(self, name: str, call_id: str) -> int:
        """Admit one tool call; a repeated identifier is refused as a correlation check.

        This is deliberately **not** replay protection and must not be cited as such.
        The identifier is model-invocation data (see ``ToolCallRequest.call_id``), so
        the same name and arguments under a *fresh* identifier are admitted like any
        other call. A later model step may reuse a consumed identifier for a new
        intent; duplicates within the current step remain refused. Exactly-once effect
        safety belongs to the Server, at authorisation or at the effect itself, and
        cannot be provided by this counter.

        Nothing about this check grants authority either: it runs with the authority
        port as the only thing able to deny a call, and that port receives no call
        data at all (see ``check``). A repeat is refused even when authority is fully
        granted, and a fresh identifier never restores withdrawn authority.
        """
        self.check_sync("tool call")
        if self.tool_calls >= self._tool_calls_limit:
            raise self.fail(
                FailureReason.TOOL_CALL_LIMIT,
                f"refusing tool call {self.tool_calls + 1}; the limit is {self._tool_calls_limit}",
            )
        if call_id in self._call_ids:
            raise self.fail(
                FailureReason.DUPLICATE_TOOL_CALL,
                f"tool call identifier {call_id!r} was already executed in this model step",
            )
        self._call_ids.add(call_id)
        self.tool_calls += 1
        return self.tool_calls

    async def progress(self, stage: ProgressStage, message: str) -> None:
        """Notify the optional observer. Not durable; the runtime stores nothing."""
        if self._progress is None:
            return
        self.check_sync(f"progress:{stage}")
        if self.progress_events >= self._progress_events_limit:
            raise self.fail(
                FailureReason.LIMIT_EXCEEDED,
                f"progress events exceed the limit of {self._progress_events_limit}",
            )
        self.progress_events += 1
        try:
            outcome = self._progress(stage, message)
        except RuntimeFailure:
            raise
        except Exception as exc:
            raise self.fail(
                FailureReason.PROGRESS_PORT_ERROR, f"progress port raised {type(exc).__name__}"
            ) from exc
        if not inspect.isawaitable(outcome):
            raise self.fail(
                FailureReason.PROGRESS_PORT_ERROR,
                f"progress port returned {type(outcome).__name__}, not an awaitable",
            )
        try:
            await outcome
        except RuntimeFailure:
            raise
        except Exception as exc:
            raise self.fail(
                FailureReason.PROGRESS_PORT_ERROR, f"progress port raised {type(exc).__name__}"
            ) from exc


__all__ = ["RunGuard"]
