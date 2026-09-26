"""Process hygiene: a run must not write to stdout on its own.

Run in a fresh interpreter on purpose. The SDK claims its startup banner once per
process, so an in-process assertion could pass merely because an earlier test
already triggered it. A clean process is the only honest check.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"

RUN_SCRIPT = """
import asyncio

from pydantic_ai.messages import ModelResponse, TextPart

from openbot_agent_runtime import RuntimePorts, RuntimeRequest, execute_runtime


async def model_port(step_request):
    return ModelResponse(parts=[TextPart("ok")])


async def tool_port(tool_request):
    return {"ok": True}


async def authority():
    return None


async def main():
    request = RuntimeRequest(instructions="instructions", task="a task")
    result = await execute_runtime(
        request, RuntimePorts(model=model_port, tool=tool_port, authority=authority)
    )
    assert result.text == "ok", result
    print("RUNTIME-OK")


asyncio.run(main())
"""


def test_a_completed_run_writes_nothing_to_stdout() -> None:
    env = {**os.environ, "PYTHONPATH": str(SRC)}
    env.pop("PYDANTIC_AI_NO_BANNER", None)
    completed = subprocess.run(
        [sys.executable, "-c", RUN_SCRIPT],
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout == "RUNTIME-OK\n", (
        "the runtime wrote to stdout; stdout is reserved for the runtime's own channel"
    )
