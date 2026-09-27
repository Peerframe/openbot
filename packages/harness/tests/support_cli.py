"""Synthetic parent harness for the real worker subprocess.

The harness drives ``scripts/run-worker.py`` as an actual child process over real
pipes, because the properties under test — framing, EOF, exit status, a clean
stdout — only exist between two processes. Everything it supplies is synthetic: a
scripted model, a recording tool authority, a fixed authority reply. No provider,
no credential, no database and no network is involved.

The child is always launched exactly as the profile prescribes
(``python -I -u <package>/scripts/run-worker.py``) from an empty directory that is
not the package, with an explicit environment.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
from collections.abc import Callable, Iterator, Sequence
from pathlib import Path
from typing import Any

PACKAGE = Path(__file__).resolve().parents[1]
WORKER = PACKAGE / "scripts" / "run-worker.py"
VENV_PYTHON = PACKAGE / ".venv" / "bin" / "python"
SRC = PACKAGE / "src"

DEFAULT_TIMEOUT = 20.0

PROTOCOL_NAME = "openbot-agent-runtime/1"
CONTROL_PROMPT = "Continue the Server-bound task."
PARENT_ID = "run"

ENV_CANARY_NAME = "OPENBOT_TEST_ENV_CANARY"
ENV_CANARY_VALUE = "canary-must-never-be-read"
CREDENTIAL_NAMES = ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY")

SEARCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"query": {"type": "string"}},
    "required": ["query"],
    "additionalProperties": False,
}


def python_executable() -> str:
    """The interpreter the profile names, or the one running this suite.

    ``check.sh`` guarantees the package virtualenv, so the official gate exercises
    the exact prescribed command. A clean-room environment has no ``.venv`` beside
    the sources, so the running interpreter is used there instead.
    """
    if VENV_PYTHON.is_file():
        return str(VENV_PYTHON)
    return sys.executable


def tool(name: str = "search", *, schema: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "name": name,
        "description": f"Search the scoped corpus with {name}.",
        "inputSchema": dict(SEARCH_SCHEMA if schema is None else schema),
    }


def execute_request(
    *,
    tools: Sequence[dict[str, Any]] | None = None,
    deadline_ms: int = 5_000,
    **overrides: Any,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "protocol": PROTOCOL_NAME,
        "tools": list(tools if tools is not None else [tool()]),
        "deadlineMs": deadline_ms,
    }
    params.update(overrides)
    return {"jsonrpc": "2.0", "id": PARENT_ID, "method": "runtime.execute", "params": params}


def model_result(
    *, text: str = "", tools: Sequence[dict[str, Any]] = (), usage: Any = None
) -> dict[str, Any]:
    if usage is None:
        usage = {"inputTokens": None, "outputTokens": None}
    return {"text": text, "tools": list(tools), "usage": usage}


def intent(
    call_id: str, name: str = "search", arguments: Any = None
) -> dict[str, Any]:
    return {"id": call_id, "name": name, "arguments": {"query": "a"} if arguments is None else arguments}


def success(value: Any) -> dict[str, Any]:
    return {"value": value}


class ChildExited(RuntimeError):
    """The worker wrote no further frame and had already exited."""


class Worker:
    """One worker process and the pipes that drive it."""

    def __init__(
        self,
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        extra_argv: Sequence[str] = (),
        python_args: Sequence[str] = (),
        keep_cwd: bool = False,
    ) -> None:
        self._owns_cwd = cwd is None and not keep_cwd
        self.cwd = cwd or tempfile.mkdtemp(prefix="openbot-worker-cwd-", dir="/tmp")
        if env is None:
            env = {ENV_CANARY_NAME: ENV_CANARY_VALUE}
        self.env = env
        self.frames: list[Any] = []
        self.raw_frames: list[bytes] = []
        self._lines: queue.Queue[bytes | None] = queue.Queue()
        self._stderr: list[bytes] = []
        # ``python_args`` precedes the script so interpreter switches land where
        # the interpreter expects them; the profile's own ``-I -u`` is always
        # present and in this order.
        self.proc = subprocess.Popen(
            [python_executable(), *python_args, "-I", "-u", str(WORKER), *extra_argv],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=self.cwd,
            env=env,
        )
        assert self.proc.stdin is not None
        assert self.proc.stdout is not None
        assert self.proc.stderr is not None
        self._reader = threading.Thread(target=self._drain, args=(self.proc.stdout,), daemon=True)
        self._reader.start()
        self._err_reader = threading.Thread(
            target=self._drain_errors, args=(self.proc.stderr,), daemon=True
        )
        self._err_reader.start()

    # -- lifecycle -------------------------------------------------------------

    def __enter__(self) -> Worker:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(timeout=DEFAULT_TIMEOUT)
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                stream.close()  # type: ignore[union-attr]
            except Exception:
                pass
        if self._owns_cwd:
            try:
                os.rmdir(self.cwd)
            except OSError:
                pass

    def _drain(self, stream: Any) -> None:
        try:
            for line in stream:
                self._lines.put(line)
        finally:
            self._lines.put(None)

    def _drain_errors(self, stream: Any) -> None:
        try:
            self._stderr.append(stream.read())
        except Exception:
            pass

    # -- writing ---------------------------------------------------------------

    def send(self, value: dict[str, Any]) -> None:
        self.send_raw(json.dumps(value).encode("utf-8") + b"\n")

    def send_raw(self, data: bytes) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def close_stdin(self) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.close()

    # -- reading ---------------------------------------------------------------

    def recv_raw(self, timeout: float = DEFAULT_TIMEOUT) -> bytes:
        try:
            line = self._lines.get(timeout=timeout)
        except queue.Empty as exc:
            raise ChildExited(
                f"no frame within {timeout}s; exit={self.proc.poll()}; "
                f"stderr={self.stderr()!r}"
            ) from exc
        if line is None:
            raise ChildExited(f"the worker closed stdout; exit={self.proc.poll()}")
        self.raw_frames.append(line)
        return line

    def recv(self, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
        value = json.loads(self.recv_raw(timeout).decode("utf-8"))
        self.frames.append(value)
        return value

    def next_request(self, timeout: float = DEFAULT_TIMEOUT) -> tuple[str, str, dict[str, Any]]:
        """Read the next child request and return ``(id, method, params)``."""
        frame = self.recv(timeout)
        assert set(frame) == {"jsonrpc", "id", "method", "params"}, frame
        assert frame["jsonrpc"] == "2.0", frame
        return frame["id"], frame["method"], frame["params"]

    def reply(self, request_id: str, result: Any) -> None:
        self.send({"jsonrpc": "2.0", "id": request_id, "result": result})

    def reply_error(self, request_id: str, reason: str = "scope_revoked") -> None:
        self.send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32000,
                    "message": "Runtime operation refused",
                    "data": {"reason": reason},
                },
            }
        )

    def finish(self, timeout: float = DEFAULT_TIMEOUT) -> tuple[int, list[Any], str]:
        """Wait for exit and return ``(exit code, frames seen, stderr text)``."""
        code = self.proc.wait(timeout=timeout)
        self._reader.join(timeout=timeout)
        # Anything still queued arrived before exit; keep draining.
        while True:
            try:
                line = self._lines.get_nowait()
            except queue.Empty:
                break
            if line is not None:
                self.raw_frames.append(line)
                self.frames.append(json.loads(line.decode("utf-8")))
        self._err_reader.join(timeout=timeout)
        return code, self.frames, self.stderr()

    def collect(self, timeout: float = DEFAULT_TIMEOUT) -> list[dict[str, Any]]:
        """Read every frame the child writes, then require that it exits."""
        while True:
            try:
                self.recv(timeout=timeout)
            except ChildExited:
                break
        self.proc.wait(timeout=timeout)
        return self.frames

    def stderr(self) -> str:
        return b"".join(self._stderr).decode("utf-8", errors="replace")


class ScriptedServer:
    """A synthetic Server: answers child requests from a script and records them."""

    def __init__(self, worker: Worker, script: Callable[[str, dict[str, Any], int], Any]) -> None:
        self.worker = worker
        self.script = script
        self.requests: list[tuple[str, str, dict[str, Any]]] = []

    def serve_until(self, *, stop: str = "run") -> None:
        """Answer child requests until a terminal frame for ``stop`` arrives."""
        while True:
            frame = self.worker.recv()
            if frame.get("id") == stop and ("result" in frame or "error" in frame):
                return
            assert set(frame) == {"jsonrpc", "id", "method", "params"}, frame
            request_id, method, params = frame["id"], frame["method"], frame["params"]
            index = len(self.requests)
            self.requests.append((request_id, method, params))
            outcome = self.script(method, params, index)
            if isinstance(outcome, _Error):
                self.worker.reply_error(request_id, outcome.reason)
            else:
                self.worker.reply(request_id, outcome)


class _Error:
    def __init__(self, reason: str) -> None:
        self.reason = reason


def error(reason: str = "scope_revoked") -> _Error:
    """Ask for a JSON-RPC ``error`` reply to the next child request."""
    return _Error(reason)


class Driver:
    """Answers child requests one at a time, so a test can intervene precisely.

    ``ScriptedServer`` runs a whole journey; a test that needs to misbehave *at* a
    particular exchange — reply with the wrong identifier, inject an extra frame —
    needs to hold the conversation open instead.
    """

    def __init__(
        self,
        worker: Worker,
        script: Callable[[str, dict[str, Any], int], Any] | None = None,
    ) -> None:
        self.worker = worker
        self.script = script or deterministic_script()
        self.requests: list[tuple[str, str, dict[str, Any]]] = []

    def next(self) -> tuple[str, str, dict[str, Any]]:
        request_id, method, params = self.worker.next_request()
        self.requests.append((request_id, method, params))
        return request_id, method, params

    def answer(self, request_id: str, method: str, params: dict[str, Any]) -> None:
        outcome = self.script(method, params, len(self.requests) - 1)
        if isinstance(outcome, _Error):
            self.worker.reply_error(request_id, outcome.reason)
        else:
            self.worker.reply(request_id, outcome)

    def advance_until(self, method: str, *, occurrence: int = 1) -> tuple[str, str, dict[str, Any]]:
        """Answer every request until ``method`` has been seen ``occurrence`` times."""
        seen = 0
        while True:
            request_id, name, params = self.next()
            if name == method:
                seen += 1
                if seen == occurrence:
                    return request_id, name, params
            self.answer(request_id, name, params)

    def answer_to_terminal(self) -> dict[str, Any]:
        """Answer child requests until the parent's terminal frame arrives.

        A run re-checks authority after every awaited boundary, so a model reply
        the child accepts at the port — a tool intent, or an empty answer the SDK
        itself must reject — is followed by one more ``authority.check`` *before*
        the run decides its outcome. A test that injects a model reply rather than
        scripting the whole journey must therefore keep answering, not assume the
        next frame is terminal. Only ``authority.check`` can arrive here: any
        other request would mean the run moved on, which these tests do not drive.
        """
        while True:
            frame = self.worker.recv()
            if frame.get("id") == PARENT_ID and ("result" in frame or "error" in frame):
                return frame
            assert set(frame) == {"jsonrpc", "id", "method", "params"}, frame
            assert frame["method"] == "authority.check", frame
            self.requests.append((frame["id"], frame["method"], frame["params"]))
            self.worker.reply(frame["id"], {})

    def methods(self) -> list[str]:
        return [name for _, name, _ in self.requests]


def ids_are_monotonic(requests: Sequence[tuple[str, str, dict[str, Any]]]) -> bool:
    return [item[0] for item in requests] == [f"w{index + 1}" for index in range(len(requests))]


_DEFAULT_TOOL_VALUE = object()
"""Sentinel so that a synthetic tool may deliberately return JSON ``null``."""


def deterministic_script(
    *,
    tool_call_id: str = "tc-1",
    tool_value: Any = _DEFAULT_TOOL_VALUE,
) -> Callable[[str, dict[str, Any], int], Any]:
    """The canonical two-step journey: authority, plan, tool, answer."""
    state = {"model_steps": 0}

    def script(method: str, params: dict[str, Any], index: int) -> Any:
        if method == "authority.check":
            return {}
        if method == "model.generate":
            state["model_steps"] += 1
            if state["model_steps"] == 1:
                return model_result(
                    tools=[intent(tool_call_id)],
                    usage={"inputTokens": 7, "outputTokens": 3},
                )
            return model_result(text="final answer", usage={"inputTokens": 9, "outputTokens": 4})
        if method == "tool.execute":
            value = {"hits": [1, 2]} if tool_value is _DEFAULT_TOOL_VALUE else tool_value
            return success(value)
        raise AssertionError(f"unexpected method {method}")

    return script


def journey(
    *,
    tools: Sequence[dict[str, Any]] | None = None,
    deadline_ms: int = 5_000,
    script: Callable[[str, dict[str, Any], int], Any] | None = None,
    env: dict[str, str] | None = None,
    extra_argv: Sequence[str] = (),
    python_args: Sequence[str] = (),
    cwd: str | None = None,
) -> tuple[int, list[Any], str, list[tuple[str, str, dict[str, Any]]]]:
    """Run one complete journey and return its outcome and observed requests."""
    with Worker(env=env, extra_argv=extra_argv, python_args=python_args, cwd=cwd) as worker:
        worker.send(execute_request(tools=tools, deadline_ms=deadline_ms))
        server = ScriptedServer(worker, script or deterministic_script())
        server.serve_until()
        code, frames, stderr_text = worker.finish()
        return code, frames, stderr_text, server.requests


def iterate_tools() -> Iterator[dict[str, Any]]:
    return iter([tool()])
