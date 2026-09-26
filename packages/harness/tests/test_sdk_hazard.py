"""Why the runtime never raises ``ToolFailed`` or ``ModelRetry`` from a port failure.

Most of the suite asserts a *negative*: that a failed port cannot become a successful
observation. That assertion only carries weight if the hazard is real, so the first
test here demonstrates it directly against the pinned SDK — a toolset that raises
``ToolFailed`` is turned into a failed observation and the loop happily continues to a
successful answer. The second test shows the runtime's different outcome for the same
scenario, which is the property the rest of the suite relies on.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from pydantic_ai import Agent
from pydantic_ai.exceptions import ToolFailed, UserError
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models import Model, ModelRequestParameters
from pydantic_ai.settings import ModelSettings
from pydantic_ai.tools import ToolDefinition
from pydantic_ai.toolsets import AbstractToolset
from pydantic_ai.toolsets.abstract import ToolsetTool
from pydantic_core import SchemaValidator, core_schema

from openbot_agent_runtime import FailureReason, RuntimePorts, execute_runtime
from openbot_agent_runtime.errors import RuntimeFailure
from openbot_agent_runtime import sdk_ports

from support import Authority, RecordingToolPort, ScriptedModelPort, call, descriptor, request, text

pytestmark = pytest.mark.anyio

PASSTHROUGH = SchemaValidator(schema=core_schema.any_schema())


class _RaisingToolset(AbstractToolset[object]):
    """A toolset that fails the way the SDK treats as a model-visible failure."""

    def __init__(self, error: BaseException) -> None:
        super().__init__()
        self._error = error
        self.calls = 0

    @property
    def id(self) -> str:
        return "hazard-probe"

    async def get_tools(self, ctx: Any) -> dict[str, ToolsetTool[object]]:
        definition = ToolDefinition(
            name="search",
            description="search",
            parameters_json_schema={"type": "object", "properties": {}},
        )
        return {
            "search": ToolsetTool(
                toolset=self, tool_def=definition, max_retries=0, args_validator=PASSTHROUGH
            )
        }

    async def call_tool(
        self, name: str, tool_args: dict[str, Any], ctx: Any, tool: ToolsetTool[object]
    ) -> Any:
        self.calls += 1
        raise self._error


class _ScriptedSdkModel(Model):
    """Minimal SDK model with no runtime ports, used only to probe SDK behaviour."""

    def __init__(self, script: list[Any]) -> None:
        super().__init__()
        self._script = script
        self.steps = 0

    @property
    def model_name(self) -> str:
        return "hazard-probe"

    @property
    def system(self) -> str:
        return "hazard-probe"

    async def request(
        self,
        messages: list[Any],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
    ) -> ModelResponse:
        self.steps += 1
        item = self._script.pop(0)
        return ModelResponse(parts=item if isinstance(item, list) else [item])


async def test_the_sdk_turns_a_tool_failed_into_a_successful_run() -> None:
    """The hazard, demonstrated rather than assumed."""
    model = _ScriptedSdkModel(
        [ToolCallPart("search", {}, tool_call_id="c1"), TextPart("recovered")]
    )
    toolset = _RaisingToolset(ToolFailed("the host refused the call"))

    result = await Agent(model=model, toolsets=[toolset], retries=0).run("a task")

    assert result.output == "recovered", (
        "the SDK no longer converts ToolFailed into an observation; the runtime's "
        "invariant that ports never raise ToolFailed/ModelRetry should be re-reviewed"
    )
    assert toolset.calls == 1
    assert model.steps == 2, "the loop continued past the failed tool instead of stopping"


async def test_the_runtime_refuses_the_same_scenario() -> None:
    """Same shape, real runtime: failure stops the run and the model is not retried."""
    model = ScriptedModelPort(
        [call("search", {"query": "a"}, call_id="c1"), text("recovered")]
    )
    tools = RecordingToolPort(error_for=frozenset({"search"}))

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[descriptor()]),
            RuntimePorts(model=model, tool=tools, authority=Authority()),
        )

    assert caught.value.reason is FailureReason.TOOL_PORT_ERROR
    assert len(model.requests) == 1, "the model was asked again after the tool failed"


async def test_direct_toolset_refuses_a_temporal_workflow_before_any_tool_effect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unwrapped custom toolset cannot silently run a tool during workflow replay."""
    monkeypatch.setattr(
        sdk_ports, "_temporal_workflow", SimpleNamespace(in_workflow=lambda: True)
    )
    model = ScriptedModelPort([call("search", {"query": "a"}, call_id="c1")])
    tools = RecordingToolPort()

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[descriptor()]),
            RuntimePorts(model=model, tool=tools, authority=Authority()),
        )

    assert caught.value.reason is FailureReason.UNEXPECTED
    assert isinstance(caught.value.__cause__, UserError)
    assert model.requests == []
    assert tools.calls == []
