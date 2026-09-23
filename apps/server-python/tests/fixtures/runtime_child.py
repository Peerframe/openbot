"""Adversarial transport fixture for the owned Agent Runtime subprocess tests.

Trusted test composition only: the parent owns this path and the mode argument, and no mode is
reachable from a task, a model or an HTTP request. This is not an SDK integration and not a model
or provider simulation. It speaks the frozen ``openbot-agent-runtime/1`` profile and, in most
modes, speaks it badly on purpose so the supervisor's refusals can be observed from outside.

Usage: ``runtime_child.py <mode> [state-path]``. The child always reads exactly one line, which is
the trusted invocation the parent sends first, and writes its process facts to ``state-path`` when
one is given so the test can check the environment, the working directory and liveness afterwards.

``descendant-before-frame`` is the one mode that does its work *before* that read, and it takes an
optional third argument: a path it creates only once a first line actually arrives. A parent that
withholds the invocation can therefore prove from outside that the frame was never sent.
"""

import json
import os
import signal
import subprocess
import sys
import time

_FINAL_TEXT = "Delivered."


def _send_raw(data: bytes) -> None:
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def _send(value: object) -> None:
    _send_raw(json.dumps(value).encode("utf-8") + b"\n")


def _frame(value: object) -> bytes:
    return json.dumps(value).encode("utf-8") + b"\n"


def _request(identity: str, method: str, params: object = None) -> None:
    _send({"jsonrpc": "2.0", "id": identity, "method": method, "params": {} if params is None else params})


def _final(text: str = _FINAL_TEXT) -> None:
    _send({"jsonrpc": "2.0", "id": "run", "result": {"text": text}})


def _hold() -> None:
    while True:
        time.sleep(0.05)


def _nested(depth: int) -> dict:
    value: dict = {}
    for _ in range(depth):
        value = {"next": value}
    return value


def _write_state(path: str, descendant: int | None = None) -> None:
    if not path or path == "-":
        return
    payload: dict = {"pid": os.getpid(), "cwd": os.getcwd(), "env": dict(os.environ)}
    if descendant is not None:
        payload["descendant"] = descendant
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)


def _wait_for_line() -> bytes:
    return sys.stdin.buffer.readline()


def _stubborn_descendant() -> int:
    """Fork a child that ignores SIGTERM and inherits our stdout.

    Only a signal to the invocation's whole process group can end it, and only the group ends the
    pipes the parent is reading.
    """
    return subprocess.Popen(
        [sys.executable, "-I", "-c",
         "import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
         "while True: time.sleep(0.05)\n"],
        stdin=subprocess.DEVNULL,
    ).pid


def main(argv: list[str]) -> int:
    mode = argv[0] if argv else "valid"
    state_path = argv[1] if len(argv) > 1 else "-"
    extra = argv[2] if len(argv) > 2 else ""

    if mode == "descendant-before-frame":
        # Forks and reports its facts before reading anything at all, so the descendant exists
        # while the parent is still connecting these pipes. A parent cancelled in that window has
        # no handle at all: the group is reachable only if it refuses to lose the one it is about
        # to be given.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        _write_state(state_path, _stubborn_descendant())
        if not _wait_for_line():
            return 1
        if extra and extra != "-":
            # The invocation did arrive: the marker is the outside proof that it did.
            with open(extra, "w", encoding="utf-8") as marker:
                marker.write("first-frame\n")
        _hold()

    if not _wait_for_line():
        return 1

    if mode in ("silent", "stall"):
        _write_state(state_path)
        _hold()
    if mode in ("descendant", "descendant-after-exit"):
        # Both the leader and its descendant ignore SIGTERM and hold our stdout, so only a group
        # kill can end the invocation: the leader's exit alone is not the end of the pipes.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        descendant = _stubborn_descendant()
        _write_state(state_path, descendant)
        if mode == "descendant-after-exit":
            # The final arrives and the leader exits zero, but the descendant still holds the pipe:
            # a clean leader exit must not be mistaken for the end of the invocation.
            _final()
            return 0
        _hold()

    _write_state(state_path)

    if mode == "valid":
        _request("w1", "authority.check")
        _wait_for_line()
        _request("w2", "model.generate",
                 {"messages": [{"role": "user", "content": "Continue the Server-bound task."}]})
        response = json.loads(_wait_for_line())
        _request("w3", "tool.execute", response["result"]["tools"][0])
        response = json.loads(_wait_for_line())
        _request("w4", "model.generate", {"messages": [
            {"role": "user", "content": "Continue the Server-bound task."},
            {"role": "assistant", "content": [
                {"type": "tool-call", "toolCallId": "c1", "toolName": "read", "input": {}}]},
            {"role": "tool", "content": [
                {"type": "tool-result", "toolCallId": "c1", "toolName": "read",
                 "output": {"type": "json", "value": response["result"]["value"]}}]},
        ]})
        _wait_for_line()
        _final()
        return 0
    if mode == "await-dispatch":
        _request("w1", "authority.check")
        _wait_for_line()
        return 0
    if mode == "dispatch-then-exit":
        # Exits on its own, whatever the Server operation did: used to show that cleanup can never
        # displace an earlier dispatch failure without leaving a process behind.
        _request("w1", "authority.check")
        time.sleep(0.05)
        return 0
    if mode == "claim-after-dispatch":
        # Claims success long after a Server refusal, and ignores SIGTERM so the claim really is
        # delivered while the invocation is being torn down.
        _request("w1", "authority.check")
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        time.sleep(0.1)
        _final("Claimed after refusal.")
        return 0
    if mode == "ids-past-limit":
        # 512 sequential ids are the profile maximum; the 513th must be refused.
        for index in range(1, 514):
            _request(f"w{index}", "authority.check")
            _wait_for_line()
        _final()
        return 0
    if mode == "stderr-chatter":
        _final()
        sys.stderr.buffer.write(b"diagnostic noise\n" * 50)
        sys.stderr.buffer.flush()
        return 0
    if mode == "denial":
        _send({"jsonrpc": "2.0", "id": "run", "error": {
            "code": -32000, "message": "Runtime operation refused", "data": {"reason": extra}}})
        return 0
    if mode == "malformed":
        _send_raw(b"not-json\n")
    elif mode == "bad-utf8":
        _send_raw(b"\x7b\x22\xc3\x28\x0a")
    elif mode == "partial":
        _send_raw(b'{"jsonrpc":')
        return 0
    elif mode == "crash":
        return 2
    elif mode == "no-final":
        return 0
    elif mode == "stdout-flood":
        _send_raw(b"x" * 524_289)
    elif mode == "stderr-flood":
        _final()
        sys.stderr.buffer.write(b"s" * 65_537)
        sys.stderr.buffer.flush()
        return 0
    elif mode == "unknown-method":
        _request("w1", "approval.grant")
    elif mode == "replay":
        _request("w1", "authority.check")
        _wait_for_line()
        _request("w1", "authority.check")
    elif mode == "bad-id":
        _request("w2", "authority.check")
    elif mode == "parallel":
        # One write, two frames: the supervisor must refuse the overlap instead of queueing it.
        _send_raw(_frame({"jsonrpc": "2.0", "id": "w1", "method": "authority.check", "params": {}})
                  + _frame({"jsonrpc": "2.0", "id": "w2", "method": "authority.check", "params": {}}))
    elif mode == "final-while-busy":
        _send_raw(_frame({"jsonrpc": "2.0", "id": "w1", "method": "authority.check", "params": {}})
                  + _frame({"jsonrpc": "2.0", "id": "run", "result": {"text": _FINAL_TEXT}}))
    elif mode == "final-then-extra":
        _final()
        _request("w1", "authority.check")
    elif mode == "hang-after-final":
        _final()
        _hold()
    elif mode == "stubborn":
        _final()
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        _hold()
    elif mode == "exit-signal":
        _final()
        os.kill(os.getpid(), signal.SIGKILL)
    elif mode == "denial-malformed":
        _send({"jsonrpc": "2.0", "id": "run", "error": {
            "code": -32600, "message": "Runtime operation refused", "data": {"reason": "x"}}})
    elif mode == "blank-final":
        _final("\u00a0   ")
    elif mode == "oversize-final":
        _final("a" * 8001)
    elif mode == "deep-arguments":
        _request("w1", "tool.execute", {"id": "c1", "name": "read", "arguments": _nested(63)})
    elif mode == "nonfinite-arguments":
        _send_raw(b'{"jsonrpc":"2.0","id":"w1","method":"tool.execute","params":'
                  b'{"id":"c1","name":"read","arguments":{"x":1e400}}}\n')
    elif mode == "duplicate-keys":
        _send_raw(b'{"jsonrpc":"2.0","id":"w1","method":"authority.check",'
                  b'"params":{},"params":{}}\n')
    elif mode == "crlf":
        _send_raw(json.dumps({"jsonrpc": "2.0", "id": "run",
                              "result": {"text": "\u4ea4\u4ed8"}}).encode("utf-8") + b"\r\n")
        return 0
    elif mode == "split-writes":
        for byte in _frame({"jsonrpc": "2.0", "id": "run", "result": {"text": "\u4ea4\u4ed8"}}):
            _send_raw(bytes([byte]))
        return 0
    else:
        _send_raw(f"unknown fixture mode: {mode}\n".encode("utf-8"))
        return 2
    _hold()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
