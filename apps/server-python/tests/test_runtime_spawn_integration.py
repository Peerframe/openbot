"""Independent cancellation/timeout checks before asyncio returns the real child handle."""
import asyncio
import contextlib
import json
import os
from pathlib import Path
import shutil
import signal
import sys

import pytest

from openbot_server.runtime_process import RuntimeProcessError, supervise_runtime

pytestmark = pytest.mark.skipif(os.name != "posix", reason="POSIX process-group reference only")

# Model/runtime code may execute during imports, before reading the trusted invocation. The fork
# happens before the parent has attached asyncio pipes; this is the ownership gap under test.
EARLY_CHILD = """
import json, os, signal, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = os.fork()
if child == 0:
    while True: time.sleep(.05)
with open(sys.argv[1], 'w') as out:
    json.dump({'pid': os.getpid(), 'descendant': child, 'cwd': os.getcwd()}, out)
if sys.stdin.buffer.readline():
    open(sys.argv[1] + '.invoked', 'w').close()
while True: time.sleep(.05)
"""


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@pytest.mark.parametrize("ending", ["cancel", "deadline", "cancel_no_attach"])
def test_ending_during_pipe_setup_adopts_and_reaps_the_early_group(monkeypatch, tmp_path, ending):
    async def check():
        loop = asyncio.get_running_loop()
        gate = asyncio.Event()
        connect = loop.connect_write_pipe
        async def suspended(*args, **kwargs):
            await gate.wait()
            return await connect(*args, **kwargs)
        monkeypatch.setattr(loop, "connect_write_pipe", suspended)
        state_path = tmp_path / "state.json"
        state = None
        calls = []
        async def dispatch(request):
            calls.append(request)
            return {}
        invocation = {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute", "params": {
            "protocol": "openbot-agent-runtime/1", "tools": [], "deadlineMs": 10000}}
        task = asyncio.create_task(supervise_runtime(sys.executable,
            ("-I", "-u", "-c", EARLY_CHILD, str(state_path)), invocation, dispatch,
            deadline_seconds=1 if ending == "deadline" else 10))
        try:
            async with asyncio.timeout(3):
                while state is None:
                    try:
                        state = json.loads(state_path.read_text())
                    except (FileNotFoundError, ValueError):
                        await asyncio.sleep(.01)
            if ending != "deadline":
                task.cancel("during-spawn")
            if ending != "cancel_no_attach":
                loop.call_later(1.05 if ending == "deadline" else .05, gate.set)
            if ending != "deadline":
                with pytest.raises(asyncio.CancelledError) as error:
                    await asyncio.wait_for(task, 3)
                assert error.value.args == ("during-spawn",)
            else:
                with pytest.raises(RuntimeProcessError) as error:
                    await asyncio.wait_for(task, 3)
                assert error.value.reason == "task_limit"
            assert not alive(state["pid"]), "leader survived cancellation before handle adoption"
            # Orphans are reaped by the host/init; poll briefly instead of confusing a zombie with
            # a successful live child. Linux fixture requires the Docker init reaper.
            async with asyncio.timeout(2):
                while alive(state["descendant"]):
                    await asyncio.sleep(.02)
            assert not Path(state["cwd"]).exists()
            assert not Path(str(state_path) + ".invoked").exists()
            assert not calls
        finally:
            gate.set()
            if state:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(state["pid"], signal.SIGKILL)
            with contextlib.suppress(BaseException):
                await asyncio.wait_for(task, 2)
            if state:
                shutil.rmtree(state["cwd"], ignore_errors=True)
            await asyncio.sleep(.05)
    asyncio.run(check())
