"""The one-invocation worker: RPC ports, lifecycle and exit codes.

This module is the application half of the frozen process profile. It turns the
parent's single ``runtime.execute`` request into a bounded run of the reviewed SDK
executor, with the parent supplying authority, model and tool results over the same
channel, and it owns the invocation's lifecycle:

* **One outstanding child request.** The profile permits at most one, so the
  channel is a strict request/response sequence and an overlapping call is refused
  rather than interleaved.
* **EOF at every await.** The parent may close the pipes at any moment. Because the
  run is a task racing the reader, a closed pipe cancels the run before it can
  publish, and no thread is left blocking on a descriptor nobody will write to.
* **One terminal frame.** Success writes exactly one ``result`` frame for ``run``
  and exits zero. A refused run writes exactly one fixed ``error`` frame and exits
  nonzero. A broken channel is closed with a fixed JSON-RPC error and exits
  nonzero. Nothing is ever written to stderr.

There is no progress, correction, usage, approval or result-submit method: those
are Server-owned and the child has no port for them.
"""

from __future__ import annotations

import asyncio
import re
import time
from typing import Any, Final

from .contracts import ModelStepRequest, RuntimeLimits, RuntimePorts, RuntimeRequest, ToolCallRequest
from .errors import FailureReason, RuntimeFailure
from .executor import execute_runtime
from .profile import (
    AUTHORITY_METHOD,
    CONTROL_PROMPT,
    MODEL_METHOD,
    PARENT_REQUEST_ID,
    TOOL_METHOD,
    ExecuteRequest,
    bound_wire_messages,
    model_response_from_wire,
    parse_authority_result,
    parse_execute_request,
    parse_tool_result,
    refusal_reason_for,
    wire_messages,
)
from .wire import (
    APPLICATION_ERROR_CODE,
    APPLICATION_ERROR_MESSAGE,
    EXIT_APPLICATION_ERROR,
    EXIT_PROTOCOL_ERROR,
    EXIT_SUCCESS,
    INVALID_REQUEST_CODE,
    FrameReader,
    FrameWriter,
    ProtocolViolation,
    WireLimitExceeded,
)

STDIN_FD: Final = 0
STDOUT_FD: Final = 1

MAX_CHILD_REQUESTS: Final = 512
"""``w1`` .. ``w512``: the profile's monotonic child identifier space."""

OUTPUT_BYTES: Final = 32_000
"""The profile's output bound. Below the unit's reviewed ceiling, as frozen."""

WIRE_LIMITS: Final = RuntimeLimits(
    catalog_tools=64,
    history_messages=128,
    output_bytes=OUTPUT_BYTES,
)
"""The exact limits the profile fixes for this adapter.

``catalog_tools`` and ``history_messages`` are the profile's own numbers;
``output_bytes`` is the protocol's 32,000. The remaining reviewed limits keep their
defaults, so the child's bounds never expand the Server's.
"""

_REASON_PATTERN: Final = re.compile(r"^[a-z0-9_]{1,64}$")
FAILURE_REASON_FALLBACK: Final = "unexpected"
"""Emitted if a reviewed reason ever failed the profile's reason grammar."""


class WorkerSession:
    """A sequential JSON-RPC client for the three child methods."""

    def __init__(self, writer: FrameWriter) -> None:
        self._writer = writer
        self._inbox: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._sequence = 0
        self._outstanding: str | None = None

    @property
    def outstanding_id(self) -> str | None:
        return self._outstanding

    def deliver(self, frame: Any) -> None:
        """Check one parent response envelope and queue it.

        The envelope is judged here rather than in :meth:`_call` so that an
        unsolicited or mis-correlated frame is a channel failure even when no call
        is waiting for it. The expected identifier is **consumed atomically**: the
        instant a correlated reply is queued, ``_outstanding`` is cleared, so a
        second reply for the same identifier — including a duplicate that arrives
        in the very same read — is refused as uncorrelated instead of being left in
        the inbox to be mistaken for the next call's result.
        """
        if not isinstance(frame, dict):
            raise ProtocolViolation(INVALID_REQUEST_CODE)
        keys = set(frame)
        if ("result" in keys) == ("error" in keys):
            # Neither, or both: the profile allows exactly one.
            raise ProtocolViolation(INVALID_REQUEST_CODE)
        expected = {"jsonrpc", "id", "result" if "result" in keys else "error"}
        if keys != expected:
            raise ProtocolViolation(INVALID_REQUEST_CODE)
        if frame["jsonrpc"] != "2.0":
            raise ProtocolViolation(INVALID_REQUEST_CODE)
        if self._outstanding is None or frame["id"] != self._outstanding:
            # A replayed, unknown or out-of-order identifier. IDs are correlation
            # only, but an uncorrelated reply means the channel state is unknown.
            raise ProtocolViolation(INVALID_REQUEST_CODE)
        self._outstanding = None
        self._inbox.put_nowait(frame)

    async def execute(self, request: ExecuteRequest, received_at: float) -> int:
        """Run one invocation and emit exactly one terminal frame."""
        deadline_at = received_at + request.deadline_ms / 1000.0
        if deadline_at - time.monotonic() <= 0.0:
            return await self._terminate_error(
                FailureReason.DEADLINE_EXCEEDED, deadline_at, EXIT_APPLICATION_ERROR
            )

        ports = RuntimePorts(model=self._model, tool=self._tool, authority=self._authority)
        try:
            result = await execute_runtime(
                RuntimeRequest(
                    task=CONTROL_PROMPT,
                    tools=request.tools,
                    limits=WIRE_LIMITS,
                    deadline_seconds=deadline_at - time.monotonic(),
                ),
                ports,
            )
        except RuntimeFailure as failure:
            return await self._terminate_error(
                failure.reason, deadline_at, EXIT_APPLICATION_ERROR
            )
        return await self._terminate_result(result.text, deadline_at)

    async def _terminate_result(self, text: str, deadline_at: float) -> int:
        """Publish the single success frame, bounded by the invocation deadline."""
        published = await self._publish(
            {"jsonrpc": "2.0", "id": PARENT_REQUEST_ID, "result": {"text": text}},
            deadline_at,
        )
        return EXIT_SUCCESS if published else EXIT_PROTOCOL_ERROR

    async def _terminate_error(
        self, reason: FailureReason, deadline_at: float, ok_code: int
    ) -> int:
        """Publish the single fixed error frame, bounded by the invocation deadline."""
        name = reason.value if _REASON_PATTERN.match(reason.value) else FAILURE_REASON_FALLBACK
        published = await self._publish(
            {
                "jsonrpc": "2.0",
                "id": PARENT_REQUEST_ID,
                "error": {
                    "code": APPLICATION_ERROR_CODE,
                    "message": APPLICATION_ERROR_MESSAGE,
                    "data": {"reason": name},
                },
            },
            deadline_at,
        )
        return ok_code if published else EXIT_PROTOCOL_ERROR

    async def _publish(self, frame: dict[str, Any], deadline_at: float) -> bool:
        """Write one terminal frame, but never past the invocation deadline.

        A parent that stops draining stdout leaves a non-blocking write waiting on
        the loop's writer. Unbounded, that wait could outlive the invocation, so the
        terminal frame carries the same absolute deadline as the run: a write that
        cannot complete by then ends the process rather than pinning it. A write that
        succeeds without yielding — the ordinary case — is unaffected, including when
        the deadline instant has already passed.
        """
        try:
            async with asyncio.timeout_at(deadline_at):
                await self._writer.write_value(frame)
        except (TimeoutError, ProtocolViolation, WireLimitExceeded):
            return False
        return True

    # -- the three ports -------------------------------------------------------

    async def _authority(self) -> None:
        parse_authority_result(await self._call(AUTHORITY_METHOD, {}))

    async def _model(self, step: ModelStepRequest) -> Any:
        payload = wire_messages(step.messages)
        bound_wire_messages(payload)
        response = await self._call(MODEL_METHOD, {"messages": payload})
        return model_response_from_wire(response)

    async def _tool(self, request: ToolCallRequest) -> Any:
        # The identifier is carried through verbatim: it is the model provider's
        # correlation value, which the Server matches against its own intent list.
        params = {"id": request.call_id, "name": request.name, "arguments": dict(request.arguments)}
        return parse_tool_result(await self._call(TOOL_METHOD, params))

    # -- transport -------------------------------------------------------------

    async def _call(self, method: str, params: dict[str, Any]) -> Any:
        if self._outstanding is not None:
            raise RuntimeFailure(
                FailureReason.OVERLAPPING_OPERATION,
                f"a child request is already outstanding; refusing {method}",
            )
        self._sequence += 1
        if self._sequence > MAX_CHILD_REQUESTS:
            raise RuntimeFailure(
                FailureReason.LIMIT_EXCEEDED,
                f"the child request budget of {MAX_CHILD_REQUESTS} is exhausted",
            )
        request_id = f"w{self._sequence}"
        self._outstanding = request_id
        try:
            try:
                await self._writer.write_value(
                    {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
                )
            except WireLimitExceeded as exc:
                raise RuntimeFailure(FailureReason.LIMIT_EXCEEDED, str(exc)) from exc
            frame = await self._inbox.get()
        finally:
            self._outstanding = None
        if not isinstance(frame, dict) or frame.get("id") != request_id:
            # Unreachable while `deliver` consumes on correlation; asserted anyway so
            # a later change cannot silently let one call consume another's reply.
            raise ProtocolViolation(INVALID_REQUEST_CODE)
        if "error" in frame:
            # The parent refused the operation. Its reason text is the Server's
            # vocabulary and is never echoed; the method selects a runtime reason.
            raise RuntimeFailure(
                refusal_reason_for(method), f"the parent refused {method} for {request_id}"
            )
        return frame["result"]


async def _serve() -> int:
    """Own the channel for one invocation and return the process exit code."""
    reader = FrameReader(STDIN_FD)
    writer = FrameWriter(STDOUT_FD)
    try:
        return await _session(reader, writer)
    except ProtocolViolation as violation:
        await _best_effort_protocol_error(writer, PARENT_REQUEST_ID, violation)
        return EXIT_PROTOCOL_ERROR
    except asyncio.CancelledError:
        raise
    except Exception:
        # Fail closed and say nothing about it: a traceback would carry private
        # values to stderr and could exceed the parent's stderr bound.
        await _best_effort_application_error(writer)
        return EXIT_APPLICATION_ERROR
    finally:
        reader.close()


async def _session(reader: FrameReader, writer: FrameWriter) -> int:
    """Read the one request, run it while watching for EOF, then close."""
    try:
        first = await reader.next_value()
    except ProtocolViolation as violation:
        await _best_effort_protocol_error(writer, None, violation)
        return EXIT_PROTOCOL_ERROR
    if first is None:
        # The parent produced no request at all: there is nothing to answer.
        return EXIT_PROTOCOL_ERROR

    # Measured once, here, on receipt: preparation must not extend the run.
    received_at = time.monotonic()
    try:
        request = parse_execute_request(first)
    except ProtocolViolation as violation:
        await _best_effort_protocol_error(writer, _frame_id(first), violation)
        return EXIT_PROTOCOL_ERROR

    session = WorkerSession(writer)
    run_task = asyncio.create_task(session.execute(request, received_at))
    read_task = asyncio.create_task(reader.next_value())
    violation: ProtocolViolation | None = None
    try:
        while True:
            await asyncio.wait({run_task, read_task}, return_when=asyncio.FIRST_COMPLETED)
            if run_task.done():
                # Both tasks can finish in one wake-up. A run must not publish a
                # result after input it would have refused was already observed, so
                # an already-completed read wins the race when it is a violation.
                # A clean EOF does not: closing the parent's end is expected.
                if read_task.done():
                    try:
                        extra = read_task.result()
                        if extra is not None:
                            session.deliver(extra)
                    except ProtocolViolation as exc:
                        violation = exc
                break
            try:
                frame = read_task.result()
            except ProtocolViolation as exc:
                violation = exc
                break
            if frame is None:
                # Parent EOF. The run is cancelled so that no await outlives the
                # parent and no provisional success is published.
                run_task.cancel()
                await _swallow(run_task)
                return EXIT_PROTOCOL_ERROR
            try:
                session.deliver(frame)
            except ProtocolViolation as exc:
                violation = exc
                break
            read_task = asyncio.create_task(reader.next_value())

        if violation is not None:
            run_task.cancel()
            await _swallow(run_task)
            await _best_effort_protocol_error(writer, PARENT_REQUEST_ID, violation)
            return EXIT_PROTOCOL_ERROR
        return await run_task
    finally:
        read_task.cancel()
        await _swallow(read_task)
        reader.close()


def _frame_id(value: Any) -> str | None:
    """The parent's request identifier, when the frame carried one as a string."""
    if isinstance(value, dict):
        identifier = value.get("id")
        if isinstance(identifier, str):
            return identifier
    return None


async def _swallow(task: asyncio.Task[Any]) -> None:
    """Await a task that is already finished or cancelled, ignoring its outcome."""
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception:
        pass


async def _best_effort_protocol_error(
    writer: FrameWriter, request_id: str | None, violation: ProtocolViolation
) -> None:
    """Report a channel violation with a fixed error, then let the caller close."""
    frame = {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": violation.code, "message": violation.message},
    }
    try:
        await writer.write_value(frame)
    except Exception:
        # The channel is already gone, which is the expected case for a violation.
        pass


async def _best_effort_application_error(writer: FrameWriter) -> None:
    """Report an internal refusal without letting its cause reach the channel."""
    try:
        await writer.write_value(
            {
                "jsonrpc": "2.0",
                "id": PARENT_REQUEST_ID,
                "error": {
                    "code": APPLICATION_ERROR_CODE,
                    "message": APPLICATION_ERROR_MESSAGE,
                    "data": {"reason": FailureReason.UNEXPECTED.value},
                },
            }
        )
    except Exception:
        pass


def main() -> int:
    """Process entry point. Returns the exit code and never raises a traceback."""
    try:
        return asyncio.run(_serve())
    except ProtocolViolation:
        return EXIT_PROTOCOL_ERROR
    except KeyboardInterrupt:
        return EXIT_PROTOCOL_ERROR
    except Exception:
        return EXIT_APPLICATION_ERROR


__all__ = ["MAX_CHILD_REQUESTS", "OUTPUT_BYTES", "WIRE_LIMITS", "WorkerSession", "main"]
