"""Frozen process-profile framing for the Python worker.

This is the transport half of ``docs/AGENT_RUNTIME_PROTOCOL.md``: UTF-8
newline-delimited JSON-RPC 2.0 on stdin and stdout, with the profile's frame,
direction, count, depth and finiteness bounds enforced *before* a frame reaches
any application logic.

Three properties are deliberate:

* **No threads.** stdin is read through ``loop.add_reader`` and stdout is written
  through non-blocking ``os.write`` driven by ``loop.add_writer``. A worker that
  parked a thread on a blocking read would be a process the parent could not shut
  down once the pipe closed, which the profile forbids.
* **No default retrieval.** Every refusal is computed from the bytes in hand; the
  codec never consults the environment, the filesystem or the network.
* **Fail closed, fixed text.** A protocol failure carries one of three fixed
  JSON-RPC errors with a fixed message. Raw exception text, payload fragments and
  private values never reach the channel.

The reader counts bytes and frames in the inbound direction, the writer in the
outbound direction; either exceeding its budget is a refusal, never a truncation.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
from typing import Any, Final

PROTOCOL_NAME: Final = "openbot-agent-runtime/1"

MAX_FRAME_BYTES: Final = 524_288
"""Bytes allowed in one frame, excluding the terminating LF."""

MAX_DIRECTION_BYTES: Final = 8 * 1024 * 1024
"""Bytes allowed in either direction for one invocation, delimiters included."""

MAX_DIRECTION_FRAMES: Final = 1024
"""Frames allowed in either direction for one invocation."""

MAX_STDERR_BYTES: Final = 64 * 1024
"""The parent's stderr bound. The worker writes nothing to stderr at all, so this
is the ceiling it must stay under rather than a quantity it measures."""

MAX_JSON_DEPTH: Final = 64
"""Maximum nesting depth of a JSON value, both directions."""

READ_CHUNK_BYTES: Final = 64 * 1024

INVALID_REQUEST_CODE: Final = -32600
METHOD_NOT_FOUND_CODE: Final = -32601
INVALID_PARAMS_CODE: Final = -32602

FIXED_MESSAGES: Final[dict[int, str]] = {
    INVALID_REQUEST_CODE: "Invalid request",
    METHOD_NOT_FOUND_CODE: "Method not found",
    INVALID_PARAMS_CODE: "Invalid params",
}
"""The only messages a protocol failure may carry. A caller cannot widen this."""

APPLICATION_ERROR_CODE: Final = -32000
APPLICATION_ERROR_MESSAGE: Final = "Runtime operation refused"

EXIT_SUCCESS: Final = 0
"""One final ``result`` response was emitted and flushed."""

EXIT_APPLICATION_ERROR: Final = 1
"""One final ``error`` response was emitted: the run was refused."""

EXIT_PROTOCOL_ERROR: Final = 2
"""The channel contract was violated: the channel is closed without a success."""


class ProtocolViolation(Exception):
    """A violation of the framing or envelope contract.

    Carries a fixed code and the fixed message for that code, so nothing derived
    from the offending bytes can travel back through the channel.
    """

    def __init__(self, code: int = INVALID_REQUEST_CODE) -> None:
        if code not in FIXED_MESSAGES:
            raise AssertionError(f"unfixed protocol code {code}")
        self.code = code
        self.message = FIXED_MESSAGES[code]
        super().__init__(self.message)


class WireLimitExceeded(Exception):
    """The worker would exceed its own outbound budget.

    Distinct from :class:`ProtocolViolation`: the parent did nothing wrong, the
    invocation asked for more outbound frames or bytes than the profile allows.
    """


def json_depth(value: Any) -> int:
    """Nesting depth of a decoded JSON value, with the root at level 0.

    This deliberately matches the Server's own bound (``assertRuntimeJson`` in
    ``apps/server/src/agent-runtime-wire.ts``): the root value is depth 0, every
    child is one deeper, and a scalar contributes its own level. An empty root
    container is therefore depth 0, ``[1]`` is depth 1 and ``[[[]]]`` is depth 3.
    The profile refuses a value whose depth exceeds :data:`MAX_JSON_DEPTH`.

    Computed iteratively on purpose. A recursive walk would inherit the
    interpreter's recursion limit, which is exactly the shape of input this check
    exists to judge.
    """
    depth = 0
    stack: list[tuple[Any, int]] = [(value, 0)]
    while stack:
        current, level = stack.pop()
        depth = max(depth, level)
        if isinstance(current, dict):
            stack.extend((item, level + 1) for item in current.values())
        elif isinstance(current, list):
            stack.extend((item, level + 1) for item in current)
    return depth


def _reject_constant(name: str) -> Any:
    """``json`` calls this for ``NaN``/``Infinity``/``-Infinity`` literals."""
    raise ValueError(f"non-finite JSON literal {name}")


def _no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Refuse an object that repeats a key instead of silently keeping the last.

    A duplicate key has two plausible readings, so it is a smuggling shape: the
    sender and the receiver can disagree about the value without either being able
    to detect it afterwards.
    """
    result: dict[str, Any] = {}
    for key, item in pairs:
        if key in result:
            raise ValueError(f"duplicate key {key!r}")
        result[key] = item
    return result


def _reject_lone_surrogates(value: Any) -> None:
    """Refuse text that cannot be UTF-8.

    A ``\\ud800`` escape is legal JSON grammar, decodes to a lone surrogate and is
    not encodable as UTF-8. Accepting it would let a frame pass byte-level UTF-8
    validation and then fail when the value is re-encoded.
    """
    stack: list[Any] = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, str):
            try:
                current.encode("utf-8")
            except UnicodeEncodeError as exc:
                raise ProtocolViolation(INVALID_REQUEST_CODE) from exc
        elif isinstance(current, dict):
            stack.extend(current.keys())
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)


def _reject_non_finite(value: Any) -> None:
    """Refuse any non-finite number, not only the literal spellings.

    ``parse_constant`` is handed ``NaN``/``Infinity``/``-Infinity`` by name, but a
    finite-looking literal such as ``1e400`` overflows to ``inf`` *inside* the
    number parser and never reaches that hook. The profile requires finite JSON, so
    every decoded float is checked here, nested containers included. Verified on
    the pinned CPython build (see RESEARCH.md §8a).
    """
    stack: list[Any] = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, float):
            if not math.isfinite(current):
                raise ProtocolViolation(INVALID_REQUEST_CODE)
        elif isinstance(current, dict):
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)


def decode_frame(payload: bytes) -> Any:
    """Decode one frame body (LF excluded), or refuse it.

    Checks, in order: strict UTF-8, JSON grammar with non-finite literals and
    duplicate keys refused, encodable text, finite numbers, nesting depth. A frame
    that fails any of them never reaches application code.
    """
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ProtocolViolation(INVALID_REQUEST_CODE) from exc
    try:
        value = json.loads(
            text, object_pairs_hook=_no_duplicate_keys, parse_constant=_reject_constant
        )
    except (ValueError, RecursionError) as exc:
        # Deeply nested input raises RecursionError from the C scanner before any
        # value exists; that is a refusal, not a crash. Verified on the pinned
        # CPython build (see RESEARCH.md §3c).
        raise ProtocolViolation(INVALID_REQUEST_CODE) from exc
    _reject_lone_surrogates(value)
    _reject_non_finite(value)
    if json_depth(value) > MAX_JSON_DEPTH:
        raise ProtocolViolation(INVALID_REQUEST_CODE)
    return value


def encode_frame(value: Any) -> bytes:
    """Encode one frame body for the outbound direction, or refuse it.

    The body excludes the LF; the caller appends the delimiter and counts both.
    Anything the profile cannot carry (non-finite numbers, unencodable text,
    excess depth, an oversize body) is refused rather than trimmed.
    """
    if json_depth(value) > MAX_JSON_DEPTH:
        raise ProtocolViolation(INVALID_REQUEST_CODE)
    try:
        text = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        payload = text.encode("utf-8")
    except (TypeError, ValueError) as exc:
        # ``allow_nan=False`` raises for NaN/Infinity; ``encode`` raises for a
        # lone surrogate.
        raise ProtocolViolation(INVALID_REQUEST_CODE) from exc
    if len(payload) > MAX_FRAME_BYTES:
        raise ProtocolViolation(INVALID_REQUEST_CODE)
    return payload


class FrameReader:
    """Reads newline-delimited frames from one file descriptor, without threads."""

    def __init__(self, fd: int) -> None:
        self._fd = fd
        self._buffer = bytearray()
        self._ready: list[Any] = []
        self._bytes = 0
        self._frames = 0
        self._eof = False
        self._closed = False
        self._registered = False
        self._waiter: asyncio.Future[None] | None = None
        self._violation: ProtocolViolation | None = None

    @property
    def bytes_read(self) -> int:
        return self._bytes

    @property
    def frames_read(self) -> int:
        return self._frames

    @property
    def violation(self) -> ProtocolViolation | None:
        """The sticky protocol failure, if one was observed."""
        return self._violation

    @property
    def at_eof(self) -> bool:
        return self._eof

    async def next_value(self) -> Any | None:
        """Return the next decoded frame, or ``None`` at a clean end of input."""
        while True:
            if self._violation is not None:
                raise self._violation
            if self._ready:
                return self._ready.pop(0)
            if self._eof:
                if self._buffer:
                    # Bytes that never became a frame: the sender stopped mid-frame.
                    raise self._stick(ProtocolViolation(INVALID_REQUEST_CODE))
                return None
            await self._wait_readable()

    def close(self) -> None:
        """Stop watching the descriptor. Safe to call more than once."""
        self._closed = True
        self._unregister()

    # -- internals -------------------------------------------------------------

    def _stick(self, violation: ProtocolViolation) -> ProtocolViolation:
        if self._violation is None:
            self._violation = violation
        self._unregister()
        self._wake()
        return self._violation

    async def _wait_readable(self) -> None:
        loop = asyncio.get_running_loop()
        waiter: asyncio.Future[None] = loop.create_future()
        self._waiter = waiter
        try:
            self._register(loop)
        except OSError as exc:
            self._waiter = None
            raise self._stick(ProtocolViolation(INVALID_REQUEST_CODE)) from exc
        try:
            await waiter
        finally:
            if self._waiter is waiter:
                self._waiter = None

    def _register(self, loop: asyncio.AbstractEventLoop) -> None:
        if self._closed or self._registered:
            return
        loop.add_reader(self._fd, self._on_readable)
        self._registered = True

    def _unregister(self) -> None:
        if not self._registered:
            return
        self._registered = False
        try:
            asyncio.get_running_loop().remove_reader(self._fd)
        except (RuntimeError, OSError, ValueError):
            # The loop is already closing, or the descriptor is gone: there is
            # nothing left to unregister from.
            pass

    def _wake(self) -> None:
        waiter = self._waiter
        if waiter is not None and not waiter.done():
            waiter.set_result(None)

    def _on_readable(self) -> None:
        try:
            chunk = os.read(self._fd, READ_CHUNK_BYTES)
        except (BlockingIOError, InterruptedError):
            return
        except OSError as exc:
            self._stick(ProtocolViolation(INVALID_REQUEST_CODE))
            del exc
            return
        if not chunk:
            self._eof = True
            self._unregister()
            self._wake()
            return
        self._bytes += len(chunk)
        if self._bytes > MAX_DIRECTION_BYTES:
            self._stick(ProtocolViolation(INVALID_REQUEST_CODE))
            return
        self._buffer.extend(chunk)
        try:
            self._extract()
        except ProtocolViolation as violation:
            self._stick(violation)
            return
        self._wake()

    def _extract(self) -> None:
        """Split every complete frame out of the buffer, checking bounds first."""
        while True:
            index = self._buffer.find(b"\n")
            if index < 0:
                if len(self._buffer) > MAX_FRAME_BYTES:
                    # The frame bound is judged before its delimiter arrives, so an
                    # unterminated oversize frame cannot be buffered indefinitely.
                    raise ProtocolViolation(INVALID_REQUEST_CODE)
                return
            if index > MAX_FRAME_BYTES:
                raise ProtocolViolation(INVALID_REQUEST_CODE)
            body = bytes(self._buffer[:index])
            del self._buffer[: index + 1]
            self._frames += 1
            if self._frames > MAX_DIRECTION_FRAMES:
                raise ProtocolViolation(INVALID_REQUEST_CODE)
            self._ready.append(decode_frame(body))


class FrameWriter:
    """Writes newline-delimited frames to one file descriptor, without threads."""

    def __init__(self, fd: int) -> None:
        self._fd = fd
        self._bytes = 0
        self._frames = 0
        self._writable_waiter: asyncio.Future[None] | None = None
        # Non-blocking so a parent that stops draining stdout cannot pin the event
        # loop and thereby outlive the invocation deadline.
        os.set_blocking(fd, False)

    @property
    def bytes_written(self) -> int:
        return self._bytes

    @property
    def frames_written(self) -> int:
        return self._frames

    async def write_value(self, value: Any) -> None:
        """Encode, bound-check and write one frame, delimiter included."""
        body = encode_frame(value)
        total = len(body) + 1
        if self._frames + 1 > MAX_DIRECTION_FRAMES:
            raise WireLimitExceeded("outbound frame budget exhausted")
        if self._bytes + total > MAX_DIRECTION_BYTES:
            raise WireLimitExceeded("outbound byte budget exhausted")
        await self._write_all(body + b"\n")
        self._frames += 1
        self._bytes += total

    async def _write_all(self, data: bytes) -> None:
        view = memoryview(data)
        while view:
            try:
                written = os.write(self._fd, view)
            except BlockingIOError:
                await self._wait_writable()
                continue
            except InterruptedError:
                continue
            except OSError as exc:
                raise ProtocolViolation(INVALID_REQUEST_CODE) from exc
            if written <= 0:
                raise ProtocolViolation(INVALID_REQUEST_CODE)
            view = view[written:]

    async def _wait_writable(self) -> None:
        loop = asyncio.get_running_loop()
        waiter: asyncio.Future[None] = loop.create_future()
        self._writable_waiter = waiter
        loop.add_writer(self._fd, self._wake_writable)
        try:
            await waiter
        finally:
            try:
                loop.remove_writer(self._fd)
            except (RuntimeError, OSError, ValueError):
                pass
            if self._writable_waiter is waiter:
                self._writable_waiter = None

    def _wake_writable(self) -> None:
        waiter = self._writable_waiter
        if waiter is not None and not waiter.done():
            waiter.set_result(None)


__all__ = [
    "APPLICATION_ERROR_CODE",
    "APPLICATION_ERROR_MESSAGE",
    "EXIT_APPLICATION_ERROR",
    "EXIT_PROTOCOL_ERROR",
    "EXIT_SUCCESS",
    "FIXED_MESSAGES",
    "FrameReader",
    "FrameWriter",
    "INVALID_PARAMS_CODE",
    "INVALID_REQUEST_CODE",
    "METHOD_NOT_FOUND_CODE",
    "MAX_DIRECTION_BYTES",
    "MAX_DIRECTION_FRAMES",
    "MAX_FRAME_BYTES",
    "MAX_JSON_DEPTH",
    "MAX_STDERR_BYTES",
    "PROTOCOL_NAME",
    "ProtocolViolation",
    "WireLimitExceeded",
    "decode_frame",
    "encode_frame",
    "json_depth",
]
