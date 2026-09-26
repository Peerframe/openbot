"""Owned subprocess supervision for one Agent Runtime invocation.

Port of ``apps/server/src/agent-runtime-process.ts`` onto the standard library. The seam is
internal trusted code, never an HTTP endpoint: the Server owns the executable, the arguments, the
environment, the working directory and the pipes, and nothing here accepts any of those from a task
or a model.

Lifecycle rules this module enforces, all of them observed from the reference implementation:

* one child and one invocation, no retry and no resume;
* exactly one outstanding child request, with every overlapping frame refused immediately;
* one authoritative dispatch result: the first Server-side failure is preserved unchanged even if
  the child later claims success;
* a provisional result only, and only after clean stdout EOF, exit zero and a settled dispatch;
* bounded teardown of the invocation-owned POSIX process group, including a start that was
  interrupted while the loop was still connecting the child's pipes, and including descendants
  that inherited a pipe after the leader exited.

POSIX only, and explicitly not a sandbox: an ordinary child process has whatever the deployment
gave it. Linux application qualification is separate evidence and Windows is unclaimed.
"""

import asyncio
import contextlib
import math
import os
import shutil
import signal
import tempfile
from collections.abc import Awaitable, Callable

from . import runtime_wire
from .runtime_child_process import PipeProcess
from .runtime_wire import RuntimeProtocolError

REASONS = ("tool_unavailable", "task_limit", "invalid_target")

# Fixed, child-independent text: a refusal must never transport worker output. The reason alone
# selects the diagnostic, so no exception message can carry task data or a private value.
_REASON_MESSAGES = {
    "tool_unavailable": "The Agent Runtime worker could not complete this invocation.",
    "task_limit": "The Agent Runtime invocation exceeded an enforced limit.",
    "invalid_target": "The Agent Runtime invocation target was refused.",
}

# ``LOCAL_LIMIT_REASONS`` in the reference: a well-formed denial that is a budget decision rather
# than a transport problem. Every other well-formed denial is reported as unavailable.
_LOCAL_LIMIT_REASONS = frozenset(
    (
        "deadline_exceeded",
        "step_limit",
        "tool_call_limit",
        "message_limit",
        "output_limit",
        "catalog_limit",
        "limit_exceeded",
    )
)

_DEADLINE_SECONDS_MAX = 300.0
# A result with a child that will not exit is not a completed invocation.
_FINAL_EXIT_GRACE_SECONDS = 1.0
_TERM_GRACE_SECONDS = 0.25
_REAP_GRACE_SECONDS = 1.0
_TASK_REAP_SECONDS = 1.0
_STDERR_BYTES_MAX = 64 * 1024
_READ_CHUNK_BYTES = 65_536
_RUNTIME_DIRECTORY_PREFIX = "openbot-runtime-"
_CHILD_ENVIRONMENT = {"LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}

# ECMAScript WhiteSpace + LineTerminator: exactly the characters ``String.prototype.trim`` removes,
# and therefore exactly the set the reference uses to decide that a final text is blank. The same
# frozen set is defined for creation inputs in ``identity_inputs``; it is repeated here so this
# supervision seam keeps no third-party import at all.
_ECMASCRIPT_WHITESPACE = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)


class RuntimeProcessError(Exception):
    """A refused invocation.

    ``reason`` is one of :data:`REASONS` and the message is fixed per reason. Worker text never
    reaches either: a child denial only selects a class, and the supervisor's own framing and
    teardown failures are reported as ``tool_unavailable``.
    """

    def __init__(self, reason: str) -> None:
        if reason not in REASONS:
            raise ValueError(f"Unknown runtime process reason: {reason!r}")
        self.reason = reason
        super().__init__(_REASON_MESSAGES[reason])


def _protocol_failure() -> RuntimeProcessError:
    return RuntimeProcessError("tool_unavailable")


def _is_blank(text: str) -> bool:
    return text.strip(_ECMASCRIPT_WHITESPACE) == ""


def _require_target(executable: object, args: object, deadline_seconds: object) -> float:
    """Validate the trusted deployment target and the parent's own bounded deadline.

    Only the trusted composition can supply these; there is no path from a task, a model or an HTTP
    request into any of them.
    """
    if os.name != "posix":
        raise RuntimeProcessError("invalid_target")
    if not isinstance(executable, str) or not os.path.isabs(executable):
        raise RuntimeProcessError("invalid_target")
    if not isinstance(args, (tuple, list)) or not all(isinstance(item, str) for item in args):
        raise RuntimeProcessError("invalid_target")
    if isinstance(deadline_seconds, bool) or not isinstance(deadline_seconds, (int, float)):
        raise RuntimeProcessError("invalid_target")
    try:
        seconds = float(deadline_seconds)
    except (OverflowError, ValueError):
        raise RuntimeProcessError("invalid_target") from None
    if not math.isfinite(seconds) or not 0 < seconds <= _DEADLINE_SECONDS_MAX:
        raise RuntimeProcessError("invalid_target")
    return seconds


class _Supervision:
    """The owned child of one invocation: its streams, its tasks and its teardown.

    Every task this object creates is registered in ``_tasks`` before it can run, and the creation
    of the child is one of them. That is what makes a cancellation landing during the start — while
    the process already exists but no handle has been handed over — recoverable instead of fatal.
    """

    def __init__(
        self,
        executable: str,
        args: tuple[str, ...],
        invocation: dict,
        dispatch: Callable[[dict], Awaitable[dict]],
        directory: str,
    ) -> None:
        self._executable = executable
        self._args = args
        self._invocation = invocation
        self._dispatch = dispatch
        self._directory = directory
        self._process: PipeProcess | None = None
        self._pid: int | None = None
        self._spawn_task: asyncio.Task | None = None
        self._tasks: list[asyncio.Task] = []
        self._decoder = runtime_wire.FrameDecoder()
        self._encoder = runtime_wire.FrameEncoder()
        self._stdout_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._exited = asyncio.Event()
        self._stdout_done = asyncio.Event()
        self._stderr_done = asyncio.Event()
        self._closed = asyncio.Event()
        self._exit_code: int | None = None
        self._stderr_bytes = 0
        self._next_id = 1
        self._busy = False
        self._closing = False
        self.completed = asyncio.Event()
        self.failure: BaseException | None = None
        self.text: str | None = None

    @property
    def _stopped(self) -> bool:
        """The reference's ``failed``: no frame is accepted or sent once this is true."""
        return self.failure is not None or self._closing

    def fail(self, error: BaseException) -> None:
        """Latch the first failure. Later frames, results and cleanup cannot displace it."""
        if self.failure is not None:
            return
        self.failure = error
        self.completed.set()

    def _own(self, coroutine) -> asyncio.Task:
        task = asyncio.ensure_future(coroutine)
        self._tasks.append(task)
        return task

    async def spawn(self) -> None:
        """Own the PID before pipe attachment, and suppress invocation after cancellation."""
        self._spawn_task = self._own(self._connect())
        self._adopt(await asyncio.shield(self._spawn_task))
        await self._send(self._invocation)

    async def _connect(self) -> PipeProcess:
        if self._stopped:
            raise _protocol_failure()
        try:
            process = PipeProcess(self._executable, self._args, cwd=self._directory,
                                  env=dict(_CHILD_ENVIRONMENT))
            self._process, self._pid = process, process.pid
            await process.connect()
            return process
        except OSError:
            raise _protocol_failure() from None

    def _adopt(self, process: PipeProcess) -> None:
        """Own the handle and every task of it at once: no suspension point may sit in between.

        Both the pid the group signals are delivered to and the stream readers come from here, so
        whatever the caller does after this point, ``close()`` can still reach the group.
        """
        self._process = process
        self._pid = process.pid
        self._stdout_task = self._own(self._read_stdout())
        self._stderr_task = self._own(self._read_stderr())
        self._own(self._wait_exit())
        self._own(self._monitor())

    async def _send(self, value: dict) -> None:
        if self._stopped:
            return
        try:
            frame = self._encoder.encode(value)
        except RuntimeProtocolError:
            self.fail(_protocol_failure())
            return
        process = self._process
        if process is None or process.stdin is None:
            self.fail(_protocol_failure())
            return
        try:
            process.stdin.write(frame)
            await process.stdin.drain()
        except asyncio.CancelledError:
            raise
        except Exception:
            # A closed or broken pipe must never silently drop a frame.
            self.fail(_protocol_failure())

    async def _read_stdout(self) -> None:
        """Monitor frames concurrently with dispatch: an overlap is refused, never queued."""
        try:
            stream = self._process.stdout
            if stream is None:
                raise _protocol_failure()
            while True:
                chunk = await stream.read(_READ_CHUNK_BYTES)
                if not chunk:
                    # EOF: refuse a stream that ended inside a frame before anything else.
                    self._decoder.finish()
                    break
                if self._stopped:
                    break
                for message in self._decoder.push(chunk):
                    self._receive(message)
        except asyncio.CancelledError:
            raise
        except RuntimeProtocolError:
            self.fail(_protocol_failure())
        except RuntimeProcessError as error:
            self.fail(error)
        except Exception:
            self.fail(_protocol_failure())
        finally:
            self._stdout_done.set()

    async def _read_stderr(self) -> None:
        """Count stderr and discard it: imported code can print task data or private values."""
        try:
            stream = self._process.stderr
            if stream is None:
                raise _protocol_failure()
            while True:
                chunk = await stream.read(_READ_CHUNK_BYTES)
                if not chunk:
                    break
                self._stderr_bytes += len(chunk)
                if self._stderr_bytes > _STDERR_BYTES_MAX:
                    self.fail(_protocol_failure())
                    break
        except asyncio.CancelledError:
            raise
        except Exception:
            self.fail(_protocol_failure())
        finally:
            self._stderr_done.set()

    async def _wait_exit(self) -> None:
        code: int | None = None
        try:
            code = await self._process.wait()
        except asyncio.CancelledError:
            raise
        except Exception:
            self.fail(_protocol_failure())
        self._exit_code = code
        self._exited.set()

    async def _monitor(self) -> None:
        """Decide the outcome once the child exited *and* both pipes reached EOF.

        Waiting for the pipes, not only for the leader, is what makes a descendant that inherited
        stdout part of the invocation's lifetime: the reference's ``close`` event does the same.
        """
        await self._exited.wait()
        await asyncio.gather(self._stdout_task, self._stderr_task, return_exceptions=True)
        self._closed.set()
        if self._stopped:
            return
        if self._exit_code != 0 or self._busy or self.text is None:
            self.fail(_protocol_failure())
            return
        self.completed.set()

    def _receive(self, message: dict) -> None:
        if self._stopped:
            return
        if self.text is not None or self._busy:
            # A second final, or any frame while a dispatch is outstanding, is a protocol failure.
            raise _protocol_failure()
        try:
            value = runtime_wire.validate_worker_message(message)
        except RuntimeProtocolError:
            raise _protocol_failure() from None
        if "error" in value:
            reason = value["error"]["data"]["reason"]
            raise RuntimeProcessError(
                "task_limit" if reason in _LOCAL_LIMIT_REASONS else "tool_unavailable"
            )
        if "result" in value:
            text = value["result"]["text"]
            if _is_blank(text):
                raise _protocol_failure()
            self.text = text
            self._own(self._watch_for_exit())
            return
        identity = value["id"]
        if self._next_id > runtime_wire.RUNTIME_MAX_WORKER_ID or identity != f"w{self._next_id}":
            raise _protocol_failure()
        self._next_id += 1
        self._busy = True
        self._own(self._run_dispatch(value))

    async def _watch_for_exit(self) -> None:
        """A result followed by a hang is not a completed invocation."""
        await asyncio.sleep(_FINAL_EXIT_GRACE_SECONDS)
        self.fail(_protocol_failure())

    async def _run_dispatch(self, request: dict) -> None:
        try:
            # The reference defers dispatch by a microtask and rechecks its abort signal, so a
            # refusal that arrived first must keep the Server operation from starting at all.
            if self._stopped:
                return
            result = await self._dispatch(request)
        except asyncio.CancelledError as error:
            # A Server operation that cancelled itself is authoritative; a cancellation this seam
            # raised during teardown is not a failure to report.
            if not self._closing:
                self.fail(error)
            raise
        except BaseException as error:
            self.fail(error)
            return
        if self._stopped:
            return
        self._busy = False
        if not isinstance(result, dict):
            self.fail(_protocol_failure())
            return
        await self._send({"jsonrpc": "2.0", "id": request["id"], "result": result})

    def _signal_group(self, number: int) -> bool:
        """Signal the invocation-owned group (``setsid`` made the leader pid the group id)."""
        pid = self._pid
        if pid is None:
            return True
        try:
            os.killpg(pid, number)
        except ProcessLookupError:
            return True
        except OSError:
            return False
        return True

    async def _wait_closed(self, seconds: float) -> bool:
        try:
            await asyncio.wait_for(self._closed.wait(), seconds)
        except TimeoutError:
            return False
        return True

    async def _reap_tasks(self) -> None:
        """Own every task this invocation started, whatever the teardown path was."""
        pending = [task for task in self._tasks if not task.done()]
        for task in pending:
            task.cancel()
        if pending:
            _done, still = await asyncio.wait(pending, timeout=_TASK_REAP_SECONDS)
            # A dispatch that ignores two cancellations is outside its contract; it cannot change
            # the outcome, because `_stopped` already refuses every send and every frame.
            for task in still:
                task.cancel()
        for task in self._tasks:
            if task.done():
                with contextlib.suppress(BaseException):
                    task.exception()

    async def _teardown(self) -> RuntimeProcessError | None:
        """Terminate and reap even if no asyncio pipe ever finished attaching."""
        failure = None
        process = self._process
        # With the PID already owned, abort pending attachment before closing its raw pipes. This
        # prevents a delayed connector from constructing a transport around a closed descriptor.
        if self._spawn_task is not None and not self._spawn_task.done():
            self._spawn_task.cancel()
        try:
            if process is not None:
                process.close_stdin()
                if not self._signal_group(signal.SIGTERM):
                    failure = _protocol_failure()
                if not self._closed.is_set():
                    await self._wait_closed(_TERM_GRACE_SECONDS)
                if not self._signal_group(signal.SIGKILL):
                    failure = _protocol_failure()
                try:
                    await asyncio.wait_for(process.wait(), _REAP_GRACE_SECONDS)
                except TimeoutError:
                    failure = _protocol_failure()
        finally:
            if process is not None:
                process.close_pipes()
            await self._reap_tasks()
        return failure

    async def close(self) -> RuntimeProcessError | None:
        """Complete bounded teardown despite repeated cancellation, then preserve cancellation."""
        self._closing = True
        teardown = asyncio.create_task(self._teardown())
        cancelled = None
        while not teardown.done():
            try:
                await asyncio.shield(teardown)
            except asyncio.CancelledError as error:
                if cancelled is None:
                    cancelled = error
        result = teardown.result()
        if cancelled is not None:
            raise cancelled
        return result


async def supervise_runtime(
    executable: str,
    args: tuple[str, ...],
    invocation: dict,
    dispatch: Callable[[dict], Awaitable[dict]],
    *,
    deadline_seconds: float,
) -> str:
    """Run one invocation to a provisional final text, or refuse it.

    The returned text is provisional by construction: this seam proves that one final frame arrived,
    that the child closed stdout cleanly, exited zero and left no outstanding dispatch and no live
    owned process. It cannot prove that the text equals the last admitted model answer, that the
    caller still holds authority, or that the result may be published or committed; the trusted host
    and the database own those checks, and the caller rechecks them.

    Raises ``RuntimeProcessError`` for a refusal, the dispatch callable's own exception unchanged
    for a Server-side failure, and ``asyncio.CancelledError`` after bounded teardown when the
    caller's task is cancelled.
    """
    seconds = _require_target(executable, args, deadline_seconds)
    if not callable(dispatch):
        raise RuntimeProcessError("invalid_target")
    try:
        request = runtime_wire.validate_invocation(invocation)
    except RuntimeProtocolError:
        raise RuntimeProcessError("invalid_target") from None
    directory = tempfile.mkdtemp(prefix=_RUNTIME_DIRECTORY_PREFIX)
    supervisor = _Supervision(executable, tuple(args), request, dispatch, directory)
    failure: BaseException | None = None
    text: str | None = None
    cleanup: RuntimeProcessError | None = None
    try:
        deadline_at = asyncio.get_running_loop().time() + seconds
        try:
            async with asyncio.timeout_at(deadline_at):
                await supervisor.spawn()
                await supervisor.completed.wait()
        except TimeoutError:
            supervisor.fail(RuntimeProcessError("task_limit"))
        failure = supervisor.failure
        text = supervisor.text
    except BaseException as error:
        failure = supervisor.failure or error
    try:
        cleanup = await supervisor.close()
    except BaseException as error:
        # Preserve the first body/Server refusal. A first cancellation during otherwise successful
        # cleanup still cancels the invocation; repeated cancellation cannot become a success.
        if failure is None:
            failure = error
    finally:
        shutil.rmtree(directory, ignore_errors=True)
    if failure is not None:
        raise failure
    if cleanup is not None:
        raise cleanup
    if text is None:
        raise _protocol_failure()
    return text
