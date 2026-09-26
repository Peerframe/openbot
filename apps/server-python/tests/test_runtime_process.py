"""Process-level contract tests for the owned Agent Runtime supervisor.

Every case starts a real child process: the modes in ``tests/fixtures/runtime_child.py`` speak the
frozen profile and, mostly, speak it badly on purpose. No fake process objects are used, so the
framing, concurrency, teardown and descendant gates are observed from outside the seam.

These tests cover the supervisor only. They cannot establish Run identity, authority, budgets,
approval, SQL state or publication; those belong to the trusted host and the database.
"""

import asyncio
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

import pytest

from openbot_server import runtime_process, runtime_wire

FIXTURE = str(Path(__file__).resolve().parent / "fixtures" / "runtime_child.py")
CONTROL_PROMPT = "Continue the Server-bound task."
DELIVERED = "Delivered."
INVOCATION = {
    "jsonrpc": "2.0",
    "id": "run",
    "method": "runtime.execute",
    "params": {"protocol": runtime_wire.RUNTIME_PROTOCOL, "tools": [], "deadlineMs": 90_000},
}
# The interpreter injects this on macOS even when the environment is replaced outright: it is a
# platform artefact, not something the parent handed over.
_PLATFORM_INJECTED = {"__CF_USER_TEXT_ENCODING"}
# The state holder is the test's own directory; only the supervisor's own directories are checked.
_STATE_HOLDER_PREFIX = "ob-runtime-state-"


def _runtime_directories() -> set[str]:
    root = tempfile.gettempdir()
    return {name for name in os.listdir(root)
            if name.startswith(runtime_process._RUNTIME_DIRECTORY_PREFIX)}


@pytest.fixture(autouse=True)
def _no_leftover_runtime_directories():
    """The supervisor owns a fresh working directory per invocation and must remove it."""
    before = _runtime_directories()
    yield
    assert not _runtime_directories() - before


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _wait_dead(pid: int, timeout: float = 2.5) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _alive(pid):
            return True
        time.sleep(0.02)
    return not _alive(pid)


async def _wait_for_state(path: str, timeout: float = 8.0) -> dict:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        if os.path.exists(path):
            try:
                return _read_state(path)
            except ValueError:
                pass
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("the fixture never reported its process facts")
        await asyncio.sleep(0.01)


def _read_state(path: str) -> dict:
    import json

    return json.loads(Path(path).read_text())


def _default_dispatch(request: dict) -> dict:
    if request["method"] == "authority.check":
        return {}
    if request["method"] == "model.generate":
        return {"text": "", "tools": [{"id": "c1", "name": "read", "arguments": {}}],
                "usage": {"inputTokens": None, "outputTokens": 1}}
    return {"value": {"evidence": "facts"}}


class Record:
    """What one invocation of the seam produced."""

    def __init__(self, text, error, calls, state, spawned, seconds,
                 pending=None, frames_sent=False, gated=False):
        self.text = text
        self.error = error
        self.calls = calls
        self.state = state
        self.spawned = spawned
        self.seconds = seconds
        self.pending = pending if pending is not None else []
        self.frames_sent = frames_sent
        self.gated = gated

    @property
    def reason(self) -> str | None:
        return self.error.reason if isinstance(self.error, runtime_process.RuntimeProcessError) else None

    @property
    def methods(self) -> list[str]:
        return [call["method"] for call in self.calls]

    def refused(self, reason: str = "tool_unavailable") -> None:
        assert isinstance(self.error, runtime_process.RuntimeProcessError), f"unexpected {self.error!r}"
        assert self.reason == reason
        assert self.text is None

    def settled(self) -> None:
        """No task of a finished invocation may still be running behind its caller's back."""
        assert self.pending == [], f"tasks outlived the invocation: {self.pending}"

    def gone(self) -> None:
        assert self.state is not None, "the fixture never reported its process facts"
        assert _wait_dead(self.state["pid"]), "the leader is still alive"
        if "descendant" in self.state:
            assert _wait_dead(self.state["descendant"]), "the descendant is still alive"
        assert not os.path.exists(self.state["cwd"]), "the working directory was left behind"


def _supervise(mode, *, dispatch=None, deadline_seconds=15.0, extra="", pre_cancel=False,
               cancel_when_started=False, cancels_again=()) -> Record:
    holder = tempfile.mkdtemp(prefix=_STATE_HOLDER_PREFIX)
    state_path = os.path.join(holder, "state.json")
    calls: list[dict] = []
    outcome: dict = {"text": None, "error": None, "seconds": 0.0, "state": None, "spawned": False}

    async def call_through(request):
        calls.append(request)
        handler = dispatch or _default_dispatch
        outcome = handler(request)
        if asyncio.iscoroutine(outcome):
            return await outcome
        return outcome

    async def body():
        started = time.monotonic()
        argv = [sys.executable, "-I", "-u", FIXTURE, mode, state_path]
        if extra:
            argv.append(extra)
        task = asyncio.ensure_future(runtime_process.supervise_runtime(
            argv[0], tuple(argv[1:]), INVOCATION, call_through, deadline_seconds=deadline_seconds))
        try:
            if pre_cancel:
                task.cancel()
            elif cancel_when_started:
                outcome["state"] = await _wait_for_state(state_path)
                outcome["spawned"] = True
                task.cancel()
                for delay in cancels_again:
                    await asyncio.sleep(delay)
                    task.cancel()
            outcome["text"] = await task
        except BaseException as error:  # noqa: BLE001 - the seam's outcome is the assertion target
            outcome["error"] = error
        outcome["seconds"] = time.monotonic() - started

    try:
        asyncio.run(body())
        if outcome["state"] is None and os.path.exists(state_path):
            outcome["state"] = _read_state(state_path)
    finally:
        shutil.rmtree(holder, ignore_errors=True)
    return Record(outcome["text"], outcome["error"], calls, outcome["state"], outcome["spawned"],
                  outcome["seconds"])


def _slow(seconds: float, result=None):
    async def dispatch(request):
        await asyncio.sleep(seconds)
        return _default_dispatch(request) if result is None else result

    return dispatch


def _supervise_while_connecting_pipes(mode, *, trigger, deadline_seconds=15.0, timeout=15.0) -> Record:
    """Suspend pipe attachment after a real child has forked an early descendant.

    The former high-level asyncio factory withheld its PID until this await completed. The control
    adapter now owns Popen before attaching pipes, so cancellation must kill the group even when
    that attachment never completes. This differs from suspending the initial frame write.

    ``descendant-before-frame`` reports its facts before it reads anything, so the processes a
    teardown has to reach are observable precisely in this window.
    """
    holder = tempfile.mkdtemp(prefix=_STATE_HOLDER_PREFIX)
    state_path = os.path.join(holder, "state.json")
    frame_marker = os.path.join(holder, "first-frame.txt")
    calls: list[dict] = []
    outcome: dict = {"text": None, "error": None, "seconds": 0.0, "state": None,
                     "pending": [], "gated": False}

    async def call_through(request):
        calls.append(request)
        return _default_dispatch(request)

    async def body():
        loop = asyncio.get_running_loop()
        real_connect = loop.connect_write_pipe
        entered = asyncio.Event()
        release = asyncio.Event()

        async def gated(protocol_factory, pipe):
            entered.set()
            await release.wait()
            return await real_connect(protocol_factory, pipe)

        loop.connect_write_pipe = gated
        started = time.monotonic()
        argv = [sys.executable, "-I", "-u", FIXTURE, mode, state_path, frame_marker]
        task = asyncio.ensure_future(runtime_process.supervise_runtime(
            argv[0], tuple(argv[1:]), INVOCATION, call_through, deadline_seconds=deadline_seconds))
        try:
            await asyncio.wait_for(entered.wait(), 8)
            outcome["gated"] = True
            outcome["state"] = await _wait_for_state(state_path)
            if trigger == "cancel":
                task.cancel()
            else:
                # Let the parent's own deadline expire while the pipes are still unconnected.
                await asyncio.sleep(deadline_seconds + 0.35)
            release.set()
            done, _still = await asyncio.wait({task}, timeout=timeout)
            assert done, "the invocation did not finish in bounded time"
            if task.cancelled():
                outcome["error"] = asyncio.CancelledError()
            elif task.exception() is not None:
                outcome["error"] = task.exception()
            else:
                outcome["text"] = task.result()
            # Capture the evidence before deleting the fixture holder. Querying the path after
            # that cleanup would make every negative assertion pass regardless of child behavior.
            outcome["frame_sent"] = os.path.exists(frame_marker)
            outcome["pending"] = [live.get_coro().__qualname__ for live in asyncio.all_tasks()
                                  if live is not asyncio.current_task() and not live.done()]
        finally:
            release.set()
            loop.connect_write_pipe = real_connect
            outcome["seconds"] = time.monotonic() - started

    try:
        asyncio.run(body())
    finally:
        shutil.rmtree(holder, ignore_errors=True)
    return Record(outcome["text"], outcome["error"], calls, outcome["state"], outcome["gated"],
                  outcome["seconds"], outcome["pending"], outcome["frame_sent"], outcome["gated"])


class Boom(Exception):
    """A Server-side refusal that must be preserved exactly."""


# ---------------------------------------------------------------------------
# Target and invocation validation: nothing may start
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "label, executable, args, deadline",
    [
        ("relative executable", "python3", ("-I",), 5),
        ("empty executable", "", (), 5),
        ("non-string executable", 5, (), 5),
        ("non-string argument", sys.executable, ("-I", 5), 5),
        ("non-sequence arguments", sys.executable, 5, 5),
        ("zero deadline", sys.executable, (), 0),
        ("negative deadline", sys.executable, (), -1),
        ("over the deadline bound", sys.executable, (), 300.5),
        ("boolean deadline", sys.executable, (), True),
        ("non-numeric deadline", sys.executable, (), "5"),
        ("non-finite deadline", sys.executable, (), float("inf")),
        ("nan deadline", sys.executable, (), float("nan")),
    ],
)
def test_refuses_a_target_it_was_not_given(label, executable, args, deadline):
    before = _runtime_directories()

    async def attempt():
        await runtime_process.supervise_runtime(executable, args, INVOCATION,
                                                lambda request: {}, deadline_seconds=deadline)

    with pytest.raises(runtime_process.RuntimeProcessError) as raised:
        asyncio.run(attempt())
    assert raised.value.reason == "invalid_target"
    assert _runtime_directories() == before, "a refused target must not create a working directory"


def test_refuses_a_dispatch_that_is_not_callable():
    async def attempt():
        await runtime_process.supervise_runtime(sys.executable, ("-I",), INVOCATION, None,
                                               deadline_seconds=5)

    with pytest.raises(runtime_process.RuntimeProcessError) as raised:
        asyncio.run(attempt())
    assert raised.value.reason == "invalid_target"


@pytest.mark.parametrize(
    "invocation",
    [
        {},
        dict(INVOCATION, params={}),
        dict(INVOCATION, id="w1"),
        dict(INVOCATION, method="runtime.abort"),
        dict(INVOCATION, extra=True),
        [INVOCATION],
        "run",
    ],
)
def test_refuses_an_invocation_that_is_not_the_frozen_request(invocation):
    holder = tempfile.mkdtemp(prefix=_STATE_HOLDER_PREFIX)
    state_path = os.path.join(holder, "state.json")

    async def attempt():
        await runtime_process.supervise_runtime(
            sys.executable, ("-I", "-u", FIXTURE, "valid", state_path), invocation,
            lambda request: {}, deadline_seconds=5)

    try:
        with pytest.raises(runtime_process.RuntimeProcessError) as raised:
            asyncio.run(attempt())
        assert raised.value.reason == "invalid_target"
        assert not os.path.exists(state_path), "a refused invocation must not reach a child"
    finally:
        shutil.rmtree(holder, ignore_errors=True)


# ---------------------------------------------------------------------------
# One successful invocation
# ---------------------------------------------------------------------------

def test_runs_one_child_to_a_provisional_result():
    record = _supervise("valid")
    assert record.error is None, record.error
    assert record.text == DELIVERED
    assert record.methods == ["authority.check", "model.generate", "tool.execute", "model.generate"]
    record.gone()


def test_the_validated_worker_traffic_reaches_the_dispatch_in_profile_shape():
    record = _supervise("valid")
    assert record.calls[0] == {"jsonrpc": "2.0", "id": "w1", "method": "authority.check", "params": {}}
    assert record.calls[1]["params"]["messages"] == [{"role": "user", "content": CONTROL_PROMPT}]
    assert record.calls[2]["params"] == {"id": "c1", "name": "read", "arguments": {}}
    tail = record.calls[3]["params"]["messages"]
    assert [message["role"] for message in tail] == ["user", "assistant", "tool"]
    assert tail[2]["content"] == [{"type": "tool-result", "toolCallId": "c1", "toolName": "read",
                                   "output": {"type": "json", "value": {"evidence": "facts"}}}]


@pytest.mark.parametrize("mode, expected", [("crlf", "\u4ea4\u4ed8"), ("split-writes", "\u4ea4\u4ed8")])
def test_accepts_a_frame_the_child_split_or_terminated_with_a_carriage_return(mode, expected):
    record = _supervise(mode)
    assert record.error is None, record.error
    assert record.text == expected
    record.gone()


def test_gives_the_child_a_private_environment_and_working_directory(monkeypatch):
    monkeypatch.setenv("OPENBOT_TEST_PRIVATE_CANARY", "must-not-inherit")
    record = _supervise("valid")
    assert record.error is None, record.error
    state = record.state
    assert state["env"]["LANG"] == "C.UTF-8"
    assert state["env"]["LC_ALL"] == "C.UTF-8"
    assert "OPENBOT_TEST_PRIVATE_CANARY" not in state["env"]
    assert set(state["env"]) - _PLATFORM_INJECTED == {"LANG", "LC_ALL"}
    assert os.path.dirname(os.path.realpath(state["cwd"])) == os.path.realpath(tempfile.gettempdir())
    assert os.path.basename(state["cwd"]).startswith(runtime_process._RUNTIME_DIRECTORY_PREFIX)
    assert state["cwd"] != os.getcwd()
    record.gone()


def test_discards_bounded_stderr_and_never_surfaces_it():
    record = _supervise("stderr-chatter")
    assert record.error is None, record.error
    assert record.text == DELIVERED
    record.gone()


# ---------------------------------------------------------------------------
# Worker denials
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "reason, expected",
    [
        ("deadline_exceeded", "task_limit"),
        ("step_limit", "task_limit"),
        ("tool_call_limit", "task_limit"),
        ("message_limit", "task_limit"),
        ("output_limit", "task_limit"),
        ("catalog_limit", "task_limit"),
        ("limit_exceeded", "task_limit"),
        ("server_interrupted", "tool_unavailable"),
        ("boom", "tool_unavailable"),
    ],
)
def test_maps_a_well_formed_worker_denial_to_its_class(reason, expected):
    record = _supervise("denial", extra=reason)
    record.refused(expected)
    assert record.calls == []
    record.gone()


def test_a_malformed_denial_is_a_protocol_failure():
    record = _supervise("denial-malformed")
    record.refused("tool_unavailable")
    record.gone()


def test_the_fixed_message_never_carries_worker_text():
    first = _supervise("malformed")
    second = _supervise("crash")
    assert str(first.error) == str(second.error)
    assert DELIVERED not in str(first.error)


# ---------------------------------------------------------------------------
# Framing, identity and overlap refusals
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "mode",
    ["malformed", "bad-utf8", "partial", "crash", "no-final", "stdout-flood", "stderr-flood",
     "unknown-method", "bad-id", "final-then-extra", "blank-final", "oversize-final",
     "deep-arguments", "nonfinite-arguments", "duplicate-keys", "exit-signal"],
)
def test_refuses_malformed_traffic_without_dispatching_anything(mode):
    record = _supervise(mode)
    record.refused("tool_unavailable")
    assert record.calls == [], "a refused frame must never reach a Server operation"
    record.gone()


def test_refuses_a_replayed_id_after_exactly_one_dispatch():
    record = _supervise("replay")
    record.refused("tool_unavailable")
    assert len(record.calls) == 1
    record.gone()


def test_bounds_the_invocation_at_512_sequential_ids():
    record = _supervise("ids-past-limit")
    record.refused("tool_unavailable")
    assert len(record.calls) == runtime_wire.RUNTIME_MAX_WORKER_ID
    assert record.calls[-1]["id"] == "w512"
    record.gone()


@pytest.mark.parametrize("mode", ["parallel", "final-while-busy"])
def test_refuses_an_overlap_instead_of_queueing_it(mode):
    record = _supervise(mode, dispatch=_slow(0.3))
    record.refused("tool_unavailable")
    assert len(record.calls) <= 1, "an overlapping frame must not become a second operation"
    record.gone()


# ---------------------------------------------------------------------------
# Bounded lifetime
# ---------------------------------------------------------------------------

def test_the_deadline_is_the_parent_own_bound_and_maps_to_a_task_limit():
    record = _supervise("silent", deadline_seconds=0.3)
    record.refused("task_limit")
    assert 0.3 <= record.seconds < 3.0
    record.gone()


def test_refuses_a_result_from_a_child_that_does_not_exit_within_one_second():
    record = _supervise("hang-after-final")
    record.refused("tool_unavailable")
    assert 0.9 <= record.seconds < 3.0
    record.gone()


def test_kills_and_reaps_a_child_that_ignores_sigterm():
    record = _supervise("stubborn")
    record.refused("tool_unavailable")
    # The one-second exit grace plus the 250 ms SIGTERM grace: a longer run would mean the
    # escalation to SIGKILL never happened.
    assert 0.9 <= record.seconds < 3.5
    record.gone()


def test_a_missing_executable_is_an_unavailable_worker_without_a_working_directory():
    before = _runtime_directories()

    async def attempt():
        await runtime_process.supervise_runtime("/nonexistent-openbot-runtime", (), INVOCATION,
                                                lambda request: {}, deadline_seconds=5)

    with pytest.raises(runtime_process.RuntimeProcessError) as raised:
        asyncio.run(attempt())
    assert raised.value.reason == "tool_unavailable"
    assert _runtime_directories() == before


# ---------------------------------------------------------------------------
# Server-side authority
# ---------------------------------------------------------------------------

def test_preserves_the_first_dispatch_failure_unchanged():
    boom = Boom("scope revoked")

    async def dispatch(request):
        raise boom

    record = _supervise("valid", dispatch=dispatch)
    assert record.error is boom
    record.gone()


def test_a_late_claim_cannot_replace_the_first_failure():
    boom = Boom("scope revoked")

    async def dispatch(request):
        raise boom

    record = _supervise("claim-after-dispatch", dispatch=dispatch)
    assert record.error is boom
    record.gone()


def test_cleanup_failure_rejects_a_result_but_cannot_erase_a_denial(monkeypatch):
    monkeypatch.setattr(runtime_process._Supervision, "_signal_group", lambda self, number: False)
    success = _supervise("valid")
    success.refused("tool_unavailable")
    success.gone()

    boom = Boom("scope revoked")

    async def dispatch(request):
        raise boom

    denial = _supervise("dispatch-then-exit", dispatch=dispatch)
    assert denial.error is boom
    denial.gone()


# ---------------------------------------------------------------------------
# Cancellation
# ---------------------------------------------------------------------------

def test_cancellation_before_the_task_starts_spawns_nothing():
    record = _supervise("valid", pre_cancel=True)
    assert isinstance(record.error, asyncio.CancelledError)
    assert record.state is None, "no child may start for a task cancelled before its first step"
    assert record.calls == []


def test_cancellation_after_spawn_terminates_the_owned_group():
    record = _supervise("silent", cancel_when_started=True)
    assert isinstance(record.error, asyncio.CancelledError)
    assert record.spawned
    record.gone()


def test_repeated_cancellation_still_tears_down_every_process_and_directory():
    """A cancellation delivered again must not abandon the group, the pipes or the directory."""
    record = _supervise("descendant", cancel_when_started=True, cancels_again=(0.04, 0.04))
    assert isinstance(record.error, asyncio.CancelledError)
    assert record.seconds < 4.0, "the teardown must stay bounded however often it is cancelled"
    record.gone()


def test_cancellation_while_the_spawn_is_still_running_still_owns_the_child(monkeypatch):
    created: list = []
    suspension: dict = {}
    real_adopt = runtime_process._Supervision._adopt
    real_send = runtime_process._Supervision._send

    def recording_adopt(self, process):
        real_adopt(self, process)
        created.append(process)

    async def suspended_send(self, value):
        # The invocation is never written, so the seam is suspended inside `spawn()`: the process
        # handle and every task already exist, which is the window a cancellation must survive
        # without losing ownership. The window *before* the handle exists is covered separately, by
        # the pipe-connection cases below.
        await suspension["gate"].wait()
        return await real_send(self, value)

    monkeypatch.setattr(runtime_process._Supervision, "_adopt", recording_adopt)
    monkeypatch.setattr(runtime_process._Supervision, "_send", suspended_send)
    holder = tempfile.mkdtemp(prefix=_STATE_HOLDER_PREFIX)
    state_path = os.path.join(holder, "state.json")
    outcome: dict = {}

    async def body():
        suspension["gate"] = asyncio.Event()
        task = asyncio.ensure_future(runtime_process.supervise_runtime(
            sys.executable, ("-I", "-u", FIXTURE, "silent", state_path), INVOCATION,
            _default_dispatch, deadline_seconds=15))
        while not created:
            if task.done():
                raise AssertionError("the seam finished before the child existed")
            await asyncio.sleep(0.01)
        task.cancel()
        try:
            outcome["text"] = await task
        except BaseException as error:  # noqa: BLE001 - the outcome is the assertion target
            outcome["error"] = error
        finally:
            suspension["gate"].set()
        outcome["state_written"] = os.path.exists(state_path)

    try:
        asyncio.run(body())
    finally:
        shutil.rmtree(holder, ignore_errors=True)
    assert isinstance(outcome.get("error"), asyncio.CancelledError)
    assert created, "the child was never started"
    assert created[0].returncode is not None, "the owned child was never reaped"
    assert outcome["state_written"] is False, "the invocation was suspended, so it never reached the child"


def test_cancellation_kills_descendants_that_inherited_the_pipe():
    record = _supervise("descendant", cancel_when_started=True)
    assert isinstance(record.error, asyncio.CancelledError)
    assert record.spawned
    record.gone()


def test_a_leader_that_exits_before_its_descendant_is_not_a_completed_invocation():
    """A clean leader exit with a descendant still holding stdout is not the end of the invocation."""
    record = _supervise("descendant-after-exit")
    record.refused("tool_unavailable")
    record.gone()


def test_cancellation_while_the_loop_is_connecting_the_pipes_still_reaps_the_group():
    """Cancelling the start must not lose the handle to a process that already exists.

    This reproduced a missing-ownership window in asyncio's high-level factory. The current
    Popen adapter must retain the PID while attachment waits and terminate the whole group.
    """
    record = _supervise_while_connecting_pipes("descendant-before-frame", trigger="cancel")
    assert record.gated, "the pipe connection was never suspended"
    assert isinstance(record.error, asyncio.CancelledError), record.error
    assert record.calls == [], "no Server operation may start for a cancelled invocation"
    assert not record.frames_sent, "the invocation must never be written after a cancellation"
    assert record.seconds < 6.0, "the teardown must stay bounded"
    record.settled()
    record.gone()


def test_a_deadline_that_expires_while_the_pipes_are_being_connected_still_reaps_the_group():
    """The parent's own deadline is the same window: it must refuse without leaking the group."""
    record = _supervise_while_connecting_pipes("descendant-before-frame", trigger="deadline",
                                               deadline_seconds=0.4)
    assert record.gated, "the pipe connection was never suspended"
    record.refused("task_limit")
    assert not record.frames_sent, "the invocation must never be written after the deadline"
    assert record.seconds < 6.0, "the teardown must stay bounded"
    record.settled()
    record.gone()


def test_a_dispatch_that_swallows_cancellation_cannot_produce_success():
    holder = tempfile.mkdtemp(prefix=_STATE_HOLDER_PREFIX)
    state_path = os.path.join(holder, "state.json")
    started = asyncio.Event()
    swallows = []
    outcome: dict = {}

    async def swallowing(request):
        started.set()
        while True:
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                # Deliberately outside the contract: an operation that hides its cancellation and
                # then claims a result. It must still be impossible to report success. The count is
                # finite so the caller's own loop shutdown can still finish.
                swallows.append(1)
                if len(swallows) >= 3:
                    return {"value": {"evidence": "fabricated"}}

    async def body():
        task = asyncio.ensure_future(runtime_process.supervise_runtime(
            sys.executable, ("-I", "-u", FIXTURE, "await-dispatch", state_path), INVOCATION,
            swallowing, deadline_seconds=15))
        await asyncio.wait_for(started.wait(), 8)
        outcome["state"] = await _wait_for_state(state_path)
        task.cancel()
        try:
            outcome["text"] = await task
        except BaseException as error:  # noqa: BLE001 - the outcome is the assertion target
            outcome["error"] = error
        outcome["seconds"] = 0.0

    try:
        asyncio.run(body())
    finally:
        shutil.rmtree(holder, ignore_errors=True)
    assert isinstance(outcome.get("error"), asyncio.CancelledError)
    assert "text" not in outcome, "a swallowed cancellation must never yield a result"
    assert swallows, "the operation never saw a cancellation"
    assert _wait_dead(outcome["state"]["pid"])
    assert not os.path.exists(outcome["state"]["cwd"])
