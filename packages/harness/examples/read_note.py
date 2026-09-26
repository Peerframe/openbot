"""Synthetic read-only contribution example; no product registration, credentials or network.

The trusted fixture host owns admission and cleanup. A real host must use the existing control
authorization port and publish facts/artifacts there. Model call IDs are only correlation.
"""

from __future__ import annotations

import asyncio
import io
import json
from typing import Literal, TypedDict

from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from openbot_agent_runtime import (
    FailureReason,
    ModelStepRequest,
    RuntimeFailure,
    RuntimePorts,
    RuntimeRequest,
    ToolCallRequest,
    ToolDescriptor,
    execute_runtime,
)

NOTE = ToolDescriptor(
    name="read_fixture_note",
    description="Read one synthetic note from the host's fixed fixture scope.",
    input_schema={
        "type": "object",
        "properties": {"id": {"const": "welcome"}},
        "required": ["id"],
        "additionalProperties": False,
    },
)


class NoteResult(TypedDict):
    status: Literal["read", "unknown"]
    noteId: str
    text: str | None


def model_summary(result: NoteResult) -> str:
    # Derive both projections from the canonical value; never treat model prose as tool evidence.
    return (
        "Note unavailable; outcome remains unknown."
        if result["status"] == "unknown"
        else str(result["text"])
    )


def ui_projection(result: NoteResult) -> dict[str, str]:
    return {"title": result["noteId"], "state": result["status"], "summary": model_summary(result)}


class FixtureHost:
    def __init__(self, *, allowed: bool = True, mode: str = "read") -> None:
        self.allowed = allowed
        self.mode = mode
        self.calls = 0
        self.closed = False
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.result: NoteResult | None = None

    async def authority(self) -> None:
        if not self.allowed:
            raise RuntimeFailure(FailureReason.AUTHORITY_REVOKED, "fixture scope refused")

    async def tool(self, request: ToolCallRequest) -> NoteResult:
        # Exact scope is host-owned even after the harness validates schema/name.
        await self.authority()
        if request.name != NOTE.name or request.arguments != {"id": "welcome"}:
            raise RuntimeFailure(FailureReason.INVALID_ARGUMENTS, "outside fixture scope")
        self.calls += 1
        stream = io.StringIO("A bounded fixture note.")
        try:
            self.started.set()
            if self.mode == "wait":
                await self.release.wait()
            if self.mode == "error":
                raise OSError("synthetic read failure")
            await self.authority()
            value: NoteResult = {
                "status": "unknown" if self.mode == "unknown" else "read",
                "noteId": "welcome",
                "text": None if self.mode == "unknown" else stream.read(128),
            }
            self.result = value
            return value
        finally:
            stream.close()
            self.closed = stream.closed

    async def model(self, request: ModelStepRequest) -> ModelResponse:
        if request.step == 1:
            return ModelResponse(
                parts=[ToolCallPart(NOTE.name, {"id": "welcome"}, tool_call_id="fixture-call")]
            )
        assert self.result is not None
        return ModelResponse(parts=[TextPart(model_summary(self.result))])

    async def run(self):
        return await execute_runtime(
            RuntimeRequest(task="Read the fixture note once.", tools=(NOTE,), deadline_seconds=5),
            RuntimePorts(authority=self.authority, model=self.model, tool=self.tool),
        )


async def main() -> None:
    import importlib.metadata
    import importlib.util
    import pathlib
    import openbot_agent_runtime

    host = FixtureHost()
    result = await host.run()
    assert host.result is not None and host.closed and host.calls == 1
    module = pathlib.Path(openbot_agent_runtime.__file__).resolve()
    assert "site-packages" in module.parts, module
    for absent in ("temporalio", "psycopg", "openbot_server", "hatchling", "pytest"):
        assert importlib.util.find_spec(absent) is None, absent
    print(
        json.dumps(
            {
                "distribution": importlib.metadata.version("openbot-agent-runtime"),
                "module": str(module),
                "canonical": host.result,
                "modelSummary": result.text,
                "ui": ui_projection(host.result),
                "closed": host.closed,
                "calls": host.calls,
            }
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
