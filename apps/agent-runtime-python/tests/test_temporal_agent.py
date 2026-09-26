"""Tests for the opt-in constructor-time Temporal composition.

The suite runs only where the optional Temporal SDK and the pinned Pydantic AI durable integration
are installed; the default runtime environment has neither, so it skips there (the same convention
as the other optional-SDK tests). Nothing here needs a Temporal server, a provider, a credential or
a network: the durable hooks are spied so the exact constructor-time wiring can be invoked directly.

Every assertion is about the reviewed boundary:

* a host factory is reached only inside a real Temporal activity, with ``ctx.deps`` of the declared
  type, and with nothing else (no prompt marker, no ``model_settings``, no current-Run global);
* only ``PORT_MODEL_NAME`` resolves; any other id fails closed rather than letting the SDK fall back;
* both synchronous and asynchronous factories are accepted, and a factory returning the wrong port
  type is refused;
* every invocation builds fresh ports and the builder itself never calls a host factory;
* the Agent is composed once, with the constructor-time ``DynamicToolset(id='openbot-ports')``,
  ``TemporalDurability`` and ``ResolveModelId`` capabilities, and copies its config mappings;
* optional ``deferred_tools`` are validated/detached through the catalog, attached once as a
  non-executing ``ExternalToolset(id='openbot-deferred')`` with a ``DeferredToolRequests`` output,
  and never reach the executing host toolset.
"""

from __future__ import annotations

import asyncio
import inspect
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import pytest

pytest.importorskip("temporalio")
pytest.importorskip("pydantic_ai.durable_exec.temporal")

from pydantic_ai import Agent
from pydantic_ai.messages import ModelResponse, TextPart
from temporalio.common import RetryPolicy

from openbot_agent_runtime import FailureReason, temporal_agent
from openbot_agent_runtime.catalog import ToolCatalog
from openbot_agent_runtime.contracts import (
    ModelStepRequest,
    RuntimeLimits,
    ToolCallRequest,
    ToolDescriptor,
)
from openbot_agent_runtime.errors import RuntimeFailure
from openbot_agent_runtime.guard import RunGuard
from openbot_agent_runtime.sdk_ports import PORT_MODEL_NAME, PortModel, PortToolset

pytestmark = pytest.mark.anyio

ACTIVITY_CONFIG: dict[str, Any] = {
    "start_to_close_timeout": timedelta(seconds=15),
    "retry_policy": RetryPolicy(maximum_attempts=2, initial_interval=timedelta(seconds=1)),
}
MODEL_ACTIVITY_CONFIG: dict[str, Any] = {"heartbeat_timeout": timedelta(seconds=4)}


@dataclass(frozen=True)
class RunDeps:
    """The caller's serializable per-Run dependency type."""

    label: str


@dataclass(frozen=True)
class OtherDeps:
    """A different dependency type, used to prove the ``isinstance`` gate."""

    label: str


@dataclass(frozen=True)
class FakeContext:
    """Minimal stand-in for the SDK ``RunContext``/``ModelResolutionContext``."""

    deps: Any


class _Recorder:
    """Wrap a host factory and record the exact deps each invocation received."""

    def __init__(self, factory: Any) -> None:
        self._factory = factory
        self.calls: list[Any] = []

    def __call__(self, deps: Any) -> Any:
        self.calls.append(deps)
        return self._factory(deps)


async def _authority() -> None:
    return None


async def _step_port(request: ModelStepRequest) -> ModelResponse:
    return ModelResponse(parts=[TextPart("ok")])


async def _tool_port(request: ToolCallRequest) -> dict[str, bool]:
    return {"ok": True}


def _guard() -> RunGuard:
    return RunGuard(
        authority=_authority,
        progress=None,
        steps_limit=1,
        tool_calls_limit=1,
        progress_events_limit=1,
        deadline_seconds=None,
    )


def _port_model() -> PortModel:
    return PortModel(
        step_port=_step_port,
        catalog=ToolCatalog((), max_tools=1, max_bytes=1024),
        guard=_guard(),
        limits=RuntimeLimits(),
    )


def _port_toolset() -> PortToolset:
    return PortToolset(
        catalog=ToolCatalog((), max_tools=1, max_bytes=1024),
        tool_port=_tool_port,
        guard=_guard(),
        limits=RuntimeLimits(),
    )


def _composition_kwargs(**overrides: Any) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "name": "openbot-temporal-test",
        "deps_type": RunDeps,
        "model_factory": lambda deps: _port_model(),
        "toolset_factory": lambda deps: _port_toolset(),
        "instructions": "Be brief.",
        "activity_config": ACTIVITY_CONFIG,
        "model_activity_config": MODEL_ACTIVITY_CONFIG,
    }
    kwargs.update(overrides)
    return kwargs


def _spy_temporal_hooks(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[Any]]:
    """Wrap the four constructor-time pieces and return what ``build_temporal_agent`` passed."""
    recorded: dict[str, list[Any]] = {
        "durability": [],
        "resolvers": [],
        "toolsets": [],
        "externals": [],
    }
    real_durability = temporal_agent.TemporalDurability
    real_resolve = temporal_agent.ResolveModelId
    real_dynamic = temporal_agent.DynamicToolset
    real_external = temporal_agent.ExternalToolset

    def durability_spy(**kwargs: Any) -> Any:
        recorded["durability"].append(kwargs)
        return real_durability(**kwargs)

    def resolve_spy(resolver: Any) -> Any:
        recorded["resolvers"].append(resolver)
        return real_resolve(resolver)

    def dynamic_spy(toolset_func: Any, *, id: str | None = None) -> Any:
        recorded["toolsets"].append((toolset_func, id))
        return real_dynamic(toolset_func, id=id)

    def external_spy(tool_defs: Any, *, id: str | None = None) -> Any:
        toolset = real_external(tool_defs, id=id)
        recorded["externals"].append((tool_defs, id, toolset))
        return toolset

    monkeypatch.setattr(temporal_agent, "TemporalDurability", durability_spy)
    monkeypatch.setattr(temporal_agent, "ResolveModelId", resolve_spy)
    monkeypatch.setattr(temporal_agent, "DynamicToolset", dynamic_spy)
    monkeypatch.setattr(temporal_agent, "ExternalToolset", external_spy)
    return recorded


# -- the activity / deps gate ---------------------------------------------------


def test_the_model_factory_is_not_called_outside_a_temporal_activity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: False)
    recorder = _Recorder(lambda deps: _port_model())

    with pytest.raises(RuntimeFailure) as caught:
        temporal_agent._resolve_port_model(
            FakeContext(RunDeps("run-a")),
            PORT_MODEL_NAME,
            deps_type=RunDeps,
            model_factory=recorder,
        )

    assert caught.value.reason is FailureReason.INVALID_REQUEST
    assert recorder.calls == []


def test_the_toolset_factory_is_not_called_outside_a_temporal_activity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: False)
    recorder = _Recorder(lambda deps: _port_toolset())

    with pytest.raises(RuntimeFailure) as caught:
        temporal_agent._resolve_port_toolset(
            FakeContext(RunDeps("run-a")),
            deps_type=RunDeps,
            toolset_factory=recorder,
        )

    assert caught.value.reason is FailureReason.INVALID_REQUEST
    assert recorder.calls == []


async def test_an_async_model_factory_is_never_called_outside_activity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: False)
    recorder = _Recorder(_async_model_factory)

    with pytest.raises(RuntimeFailure) as caught:
        temporal_agent._resolve_port_model(
            FakeContext(RunDeps("run-a")),
            PORT_MODEL_NAME,
            deps_type=RunDeps,
            model_factory=recorder,
        )

    assert caught.value.reason is FailureReason.INVALID_REQUEST
    assert recorder.calls == []


async def _async_model_factory(deps: Any) -> PortModel:
    return _port_model()


async def _async_toolset_factory(deps: Any) -> PortToolset:
    return _port_toolset()


@pytest.mark.parametrize("port", ["model", "tool"])
def test_a_factory_is_not_called_for_the_wrong_deps_type(
    monkeypatch: pytest.MonkeyPatch, port: str
) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)
    model_recorder = _Recorder(lambda deps: _port_model())
    toolset_recorder = _Recorder(lambda deps: _port_toolset())

    with pytest.raises(RuntimeFailure) as caught:
        if port == "model":
            temporal_agent._resolve_port_model(
                FakeContext(OtherDeps("run-a")),
                PORT_MODEL_NAME,
                deps_type=RunDeps,
                model_factory=model_recorder,
            )
        else:
            temporal_agent._resolve_port_toolset(
                FakeContext(OtherDeps("run-a")),
                deps_type=RunDeps,
                toolset_factory=toolset_recorder,
            )

    assert caught.value.reason is FailureReason.INVALID_REQUEST
    assert model_recorder.calls == []
    assert toolset_recorder.calls == []


@pytest.mark.parametrize("deps", [None, "run-a", OtherDeps("run-a")])
def test_a_missing_or_foreign_deps_value_is_refused(
    monkeypatch: pytest.MonkeyPatch, deps: Any
) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)
    recorder = _Recorder(lambda received: _port_model())

    with pytest.raises(RuntimeFailure) as caught:
        temporal_agent._resolve_port_model(
            FakeContext(deps),
            PORT_MODEL_NAME,
            deps_type=RunDeps,
            model_factory=recorder,
        )

    assert caught.value.reason is FailureReason.INVALID_REQUEST
    assert recorder.calls == []


# -- model id rejection instead of SDK fallback ---------------------------------


def test_an_unexpected_model_id_is_refused_before_the_factory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)
    recorder = _Recorder(lambda deps: _port_model())

    with pytest.raises(RuntimeFailure) as caught:
        temporal_agent._resolve_port_model(
            FakeContext(RunDeps("run-a")),
            "openai:gpt-5",
            deps_type=RunDeps,
            model_factory=recorder,
        )

    assert caught.value.reason is FailureReason.INVALID_REQUEST
    assert recorder.calls == [], "an unexpected id must not reach the trusted model factory"


@pytest.mark.parametrize("model_id", [PORT_MODEL_NAME, None])
def test_the_port_model_resolves_for_the_port_id_and_for_an_unset_id(
    monkeypatch: pytest.MonkeyPatch, model_id: str | None
) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)
    deps = RunDeps("run-a")

    outcome = temporal_agent._resolve_port_model(
        FakeContext(deps),
        model_id,
        deps_type=RunDeps,
        model_factory=_Recorder(lambda received: _port_model()),
    )

    assert isinstance(outcome, PortModel)


# -- sync and async factories ---------------------------------------------------


def test_a_sync_model_factory_returns_the_port_without_awaiting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)

    outcome = temporal_agent._resolve_port_model(
        FakeContext(RunDeps("run-a")),
        PORT_MODEL_NAME,
        deps_type=RunDeps,
        model_factory=lambda deps: _port_model(),
    )

    assert isinstance(outcome, PortModel)
    assert not inspect.isawaitable(outcome)


async def test_an_async_model_factory_is_awaited(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)

    outcome = temporal_agent._resolve_port_model(
        FakeContext(RunDeps("run-a")),
        PORT_MODEL_NAME,
        deps_type=RunDeps,
        model_factory=_async_model_factory,
    )

    assert inspect.isawaitable(outcome)
    assert isinstance(await outcome, PortModel)


def test_a_sync_toolset_factory_returns_the_port_without_awaiting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)

    outcome = temporal_agent._resolve_port_toolset(
        FakeContext(RunDeps("run-a")),
        deps_type=RunDeps,
        toolset_factory=lambda deps: _port_toolset(),
    )

    assert isinstance(outcome, PortToolset)
    assert not inspect.isawaitable(outcome)


async def test_an_async_toolset_factory_is_awaited(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)

    outcome = temporal_agent._resolve_port_toolset(
        FakeContext(RunDeps("run-a")),
        deps_type=RunDeps,
        toolset_factory=_async_toolset_factory,
    )

    assert inspect.isawaitable(outcome)
    assert isinstance(await outcome, PortToolset)


# -- wrong return types fail closed ---------------------------------------------


def test_a_model_factory_returning_another_type_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)

    with pytest.raises(RuntimeFailure) as caught:
        temporal_agent._resolve_port_model(
            FakeContext(RunDeps("run-a")),
            PORT_MODEL_NAME,
            deps_type=RunDeps,
            model_factory=lambda deps: object(),
        )

    assert caught.value.reason is FailureReason.MODEL_PORT_UNAVAILABLE


async def test_an_async_model_factory_returning_another_type_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)

    async def wrong_type(deps: Any) -> Any:
        return object()

    outcome = temporal_agent._resolve_port_model(
        FakeContext(RunDeps("run-a")),
        PORT_MODEL_NAME,
        deps_type=RunDeps,
        model_factory=wrong_type,
    )

    with pytest.raises(RuntimeFailure) as caught:
        await outcome

    assert caught.value.reason is FailureReason.MODEL_PORT_UNAVAILABLE


def test_a_toolset_factory_returning_another_type_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)

    with pytest.raises(RuntimeFailure) as caught:
        temporal_agent._resolve_port_toolset(
            FakeContext(RunDeps("run-a")),
            deps_type=RunDeps,
            toolset_factory=lambda deps: object(),
        )

    assert caught.value.reason is FailureReason.TOOL_PORT_UNAVAILABLE


async def test_an_async_toolset_factory_returning_another_type_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)

    async def wrong_type(deps: Any) -> Any:
        return object()

    outcome = temporal_agent._resolve_port_toolset(
        FakeContext(RunDeps("run-a")),
        deps_type=RunDeps,
        toolset_factory=wrong_type,
    )

    with pytest.raises(RuntimeFailure) as caught:
        await outcome

    assert caught.value.reason is FailureReason.TOOL_PORT_UNAVAILABLE


# -- factory freshness and isolation --------------------------------------------


def test_each_model_invocation_calls_the_factory_anew_with_fresh_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)
    recorder = _Recorder(lambda deps: _port_model())
    first_deps, second_deps = RunDeps("run-a"), RunDeps("run-b")

    first = temporal_agent._resolve_port_model(
        FakeContext(first_deps), PORT_MODEL_NAME, deps_type=RunDeps, model_factory=recorder
    )
    second = temporal_agent._resolve_port_model(
        FakeContext(second_deps), PORT_MODEL_NAME, deps_type=RunDeps, model_factory=recorder
    )

    assert recorder.calls == [first_deps, second_deps]
    assert first is not second
    assert first._guard is not second._guard  # noqa: SLF001 - fresh guard per activity is required


def test_each_toolset_invocation_calls_the_factory_anew_with_fresh_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)
    recorder = _Recorder(lambda deps: _port_toolset())
    first_deps, second_deps = RunDeps("run-a"), RunDeps("run-b")

    first = temporal_agent._resolve_port_toolset(
        FakeContext(first_deps), deps_type=RunDeps, toolset_factory=recorder
    )
    second = temporal_agent._resolve_port_toolset(
        FakeContext(second_deps), deps_type=RunDeps, toolset_factory=recorder
    )

    assert recorder.calls == [first_deps, second_deps]
    assert first is not second
    assert first._guard is not second._guard  # noqa: SLF001


async def test_concurrent_async_invocations_do_not_share_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two activities resolving at once must each receive their own deps and their own port."""
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)
    received: list[Any] = []

    async def factory(deps: Any) -> PortModel:
        received.append(deps)
        return _port_model()

    first, second = await asyncio.gather(
        temporal_agent._resolve_port_model(
            FakeContext(RunDeps("run-a")), PORT_MODEL_NAME, deps_type=RunDeps, model_factory=factory
        ),
        temporal_agent._resolve_port_model(
            FakeContext(RunDeps("run-b")), PORT_MODEL_NAME, deps_type=RunDeps, model_factory=factory
        ),
    )

    assert received == [RunDeps("run-a"), RunDeps("run-b")]
    assert first is not second


# -- constructor-time composition -----------------------------------------------


async def test_the_builder_wires_one_constructor_time_agent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)
    recorded = _spy_temporal_hooks(monkeypatch)

    activity_config = dict(ACTIVITY_CONFIG)
    model_activity_config = dict(MODEL_ACTIVITY_CONFIG)
    agent = temporal_agent.build_temporal_agent(
        **_composition_kwargs(
            activity_config=activity_config, model_activity_config=model_activity_config
        )
    )

    assert isinstance(agent, Agent)
    assert agent.instrument is False
    assert agent._max_tool_retries == 0  # noqa: SLF001 - the reviewed retry budget is zero
    assert agent._max_output_retries == 0  # noqa: SLF001

    assert len(recorded["resolvers"]) == 1, "ResolveModelId must be attached at construction"
    assert len(recorded["toolsets"]) == 1, "DynamicToolset must be attached at construction"

    toolset_func, toolset_id = recorded["toolsets"][0]
    assert toolset_id == temporal_agent.TOOLSET_ID == "openbot-ports"
    assert toolset_id == _port_toolset().id, "the wrapper id must match PortToolset.id"

    # The wired closures are the reviewed gates, and they build fresh ports per invocation.
    model = recorded["resolvers"][0](FakeContext(RunDeps("run-a")), PORT_MODEL_NAME)
    assert isinstance(model, PortModel)
    toolset = toolset_func(FakeContext(RunDeps("run-a")))
    assert isinstance(toolset, PortToolset)

    # Config mappings are copied, so later caller mutation cannot change the composed Agent.
    assert recorded["durability"][0]["activity_config"] == activity_config
    assert recorded["durability"][0]["model_activity_config"] == model_activity_config
    assert recorded["durability"][0]["activity_config"] is not activity_config
    assert recorded["durability"][0]["model_activity_config"] is not model_activity_config
    activity_config["start_to_close_timeout"] = timedelta(seconds=99)
    model_activity_config["heartbeat_timeout"] = timedelta(seconds=99)
    assert recorded["durability"][0]["activity_config"] == ACTIVITY_CONFIG
    assert recorded["durability"][0]["model_activity_config"] == MODEL_ACTIVITY_CONFIG


async def test_the_builder_accepts_async_factories(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)
    recorded = _spy_temporal_hooks(monkeypatch)

    agent = temporal_agent.build_temporal_agent(
        **_composition_kwargs(
            model_factory=_async_model_factory, toolset_factory=_async_toolset_factory
        )
    )

    assert isinstance(agent, Agent)
    toolset_func, _ = recorded["toolsets"][0]
    model = await recorded["resolvers"][0](FakeContext(RunDeps("run-a")), PORT_MODEL_NAME)
    assert isinstance(model, PortModel)
    toolset = toolset_func(FakeContext(RunDeps("run-a")))
    assert inspect.isawaitable(toolset)
    assert isinstance(await toolset, PortToolset)


def test_building_the_agent_never_calls_a_host_factory(monkeypatch: pytest.MonkeyPatch) -> None:
    """Construction composes; the factories belong to activities, not to the builder."""
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: False)
    model_recorder = _Recorder(lambda deps: _port_model())
    toolset_recorder = _Recorder(lambda deps: _port_toolset())

    agent = temporal_agent.build_temporal_agent(
        **_composition_kwargs(
            model_factory=model_recorder, toolset_factory=toolset_recorder
        )
    )

    assert isinstance(agent, Agent)
    assert model_recorder.calls == []
    assert toolset_recorder.calls == []


@pytest.mark.parametrize(
    "overrides",
    [
        {"name": ""},
        {"name": 7},
        {"deps_type": "RunDeps"},
        {"model_factory": None},
        {"toolset_factory": None},
        {"instructions": 7},
        {"activity_config": "not-a-mapping"},
        {"model_activity_config": 7},
    ],
)
def test_the_builder_refuses_an_invalid_composition(overrides: dict[str, Any]) -> None:
    with pytest.raises(RuntimeFailure) as caught:
        temporal_agent.build_temporal_agent(**_composition_kwargs(**overrides))

    assert caught.value.reason is FailureReason.INVALID_REQUEST


def test_the_package_does_not_re_export_the_opt_in_module() -> None:
    """Importing the default package must not force the optional Temporal installation."""
    import openbot_agent_runtime

    assert "build_temporal_agent" not in openbot_agent_runtime.__all__
    assert not hasattr(openbot_agent_runtime, "build_temporal_agent")


async def test_real_agent_entry_outside_temporal_never_calls_host_factories() -> None:
    model_calls = _Recorder(lambda deps: _port_model())
    tool_calls = _Recorder(lambda deps: _port_toolset())
    agent = temporal_agent.build_temporal_agent(**_composition_kwargs(
        model_factory=model_calls, toolset_factory=tool_calls,
    ))
    with pytest.raises(RuntimeFailure):
        await agent.run('Synthetic input.', deps=RunDeps('run-a'))
    assert model_calls.calls == tool_calls.calls == []


async def test_workflow_bootstrap_is_inert_and_cannot_execute_a_model(monkeypatch) -> None:
    from temporalio import workflow
    monkeypatch.setattr(temporal_agent, '_in_real_activity', lambda: False)
    monkeypatch.setattr(workflow, 'in_workflow', lambda: True)
    recorder = _Recorder(lambda deps: _port_model())
    model = temporal_agent._resolve_port_model(
        FakeContext(RunDeps('run-a')), PORT_MODEL_NAME,
        deps_type=RunDeps, model_factory=recorder,
    )
    assert model.model_name == PORT_MODEL_NAME
    assert model.system == 'openbot'
    assert recorder.calls == []
    with pytest.raises(RuntimeFailure):
        await model.request([], None, None)
    assert recorder.calls == []


def test_nested_retry_policy_is_detached_from_caller_mutation(monkeypatch) -> None:
    recorded = _spy_temporal_hooks(monkeypatch)
    policy = RetryPolicy(maximum_attempts=2, non_retryable_error_types=['Denied'])
    temporal_agent.build_temporal_agent(**_composition_kwargs(
        activity_config={**ACTIVITY_CONFIG, 'retry_policy': policy},
        model_activity_config={'retry_policy': policy},
    ))
    policy.maximum_attempts = 0
    policy.non_retryable_error_types.append('Changed')
    for config in ('activity_config', 'model_activity_config'):
        copied = recorded['durability'][0][config]['retry_policy']
        assert copied.maximum_attempts == 2
        assert copied.non_retryable_error_types == ['Denied']


# -- optional deferred proposals ------------------------------------------------


DEFERRED_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"recipient": {"type": "string"}, "body": {"type": "string"}},
    "required": ["recipient"],
    "additionalProperties": False,
}
INLINE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"query": {"type": "string"}},
    "required": ["query"],
    "additionalProperties": False,
}


def _deferred(
    name: str = "send_message",
    *,
    description: str = "Propose a message for control to approve.",
    schema: dict[str, Any] | None = None,
) -> ToolDescriptor:
    return ToolDescriptor(
        name=name,
        description=description,
        input_schema=dict(DEFERRED_SCHEMA) if schema is None else schema,
    )


def _inline_port_toolset() -> PortToolset:
    catalog = ToolCatalog(
        [ToolDescriptor(name="inline_tool", description="Inline.", input_schema=dict(INLINE_SCHEMA))],
        max_tools=8,
        max_bytes=8192,
    )
    return PortToolset(
        catalog=catalog, tool_port=_tool_port, guard=_guard(), limits=RuntimeLimits()
    )


def test_deferred_tools_are_off_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """An absent declaration keeps the exact prior composition: one dynamic leaf and ``str``."""
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)
    recorded = _spy_temporal_hooks(monkeypatch)

    agent = temporal_agent.build_temporal_agent(**_composition_kwargs())

    assert recorded["externals"] == []
    assert len(recorded["toolsets"]) == 1
    assert agent.output_type is str


async def test_deferred_tools_attach_one_non_executing_external_toolset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)
    recorded = _spy_temporal_hooks(monkeypatch)
    tool_calls = _Recorder(lambda deps: _inline_port_toolset())

    agent = temporal_agent.build_temporal_agent(
        **_composition_kwargs(
            toolset_factory=tool_calls,
            deferred_tools=[_deferred("send_message"), _deferred("open_ticket")],
        )
    )

    assert tool_calls.calls == [], "declaring proposals must not build the host toolset"
    assert len(recorded["externals"]) == 1
    tool_defs, toolset_id, external = recorded["externals"][0]
    assert toolset_id == temporal_agent.DEFERRED_TOOLSET_ID == "openbot-deferred"
    assert sorted(definition.name for definition in tool_defs) == ["open_ticket", "send_message"]
    assert agent.output_type == [str, temporal_agent.DeferredToolRequests]

    tools = await external.get_tools(None)
    assert set(tools) == {"open_ticket", "send_message"}
    for tool in tools.values():
        assert tool.tool_def.kind == "external"
        assert tool.max_retries == 0
    with pytest.raises(NotImplementedError):
        await external.call_tool("send_message", {"recipient": "ops"}, None, tools["send_message"])
    assert tool_calls.calls == [], "a deferred proposal must never reach the host toolset"

    # The executing port contract: an inline-only catalog cannot resolve a deferred name.
    inline_tools = await _inline_port_toolset().get_tools(None)
    assert set(inline_tools) == {"inline_tool"}


async def test_deferred_declarations_are_detached_from_caller_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(temporal_agent, "_in_real_activity", lambda: True)
    recorded = _spy_temporal_hooks(monkeypatch)
    from copy import deepcopy
    schema = deepcopy(DEFERRED_SCHEMA)
    declarations = [_deferred("send_message", schema=schema)]

    temporal_agent.build_temporal_agent(**_composition_kwargs(deferred_tools=declarations))

    tool_defs, _, _ = recorded["externals"][0]
    stored = tool_defs[0]
    assert stored.name == "send_message"
    assert stored.parameters_json_schema is not schema
    schema["properties"]["recipient"]["type"] = "integer"
    assert stored.parameters_json_schema["properties"]["recipient"]["type"] == "string"
    schema["type"] = "array"
    schema["properties"] = {}
    assert stored.parameters_json_schema["type"] == "object"
    assert stored.parameters_json_schema["properties"], "the detached schema must survive"


_INVALID_DEFERRED = [
    pytest.param("send_message", FailureReason.CATALOG_INVALID, id="not-a-sequence"),
    pytest.param([object()], FailureReason.CATALOG_INVALID, id="not-a-descriptor"),
    pytest.param(
        [_deferred("dup"), _deferred("dup")], FailureReason.CATALOG_INVALID, id="duplicate-name"
    ),
    pytest.param([_deferred("bad name")], FailureReason.CATALOG_INVALID, id="malformed-name"),
    pytest.param(
        [_deferred(schema={"type": "array"})], FailureReason.CATALOG_INVALID, id="non-object-schema"
    ),
    pytest.param([_deferred(description="")], FailureReason.CATALOG_INVALID, id="empty-description"),
    pytest.param(
        [
            _deferred(
                schema={
                    "type": "object",
                    "properties": {"x": {"$ref": "https://example.invalid/schema.json"}},
                }
            )
        ],
        FailureReason.CATALOG_INVALID,
        id="external-reference",
    ),
    pytest.param(
        [_deferred(f"tool-{index}") for index in range(33)],
        FailureReason.CATALOG_LIMIT,
        id="above-catalog-tools",
    ),
]


@pytest.mark.parametrize(("deferred_tools", "reason"), _INVALID_DEFERRED)
def test_invalid_deferred_descriptors_are_refused_through_the_catalog(
    deferred_tools: Any, reason: FailureReason
) -> None:
    with pytest.raises(RuntimeFailure) as caught:
        temporal_agent.build_temporal_agent(**_composition_kwargs(deferred_tools=deferred_tools))

    assert caught.value.reason is reason
