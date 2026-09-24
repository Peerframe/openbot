"""Opt-in constructor-time Temporal composition for the bounded runtime.

This module is the Temporal counterpart of :func:`openbot_agent_runtime.executor.build_sdk_agent`:
it composes exactly one ``pydantic_ai.Agent`` **before** any Worker exists, from the existing
``PortModel``/``PortToolset`` and the pinned public ``TemporalDurability`` capability, the public
``ResolveModelId`` per-Run resolver and a constructor-time ``DynamicToolset`` wrapper.

Why the wrapper: TemporalDurability 2.47.0 only routes known toolset kinds through activities.
``PortToolset`` is a custom ``AbstractToolset``, so attaching it directly would execute its calls
inline in replayable workflow code. The pinned integration guide therefore requires executing
toolsets to be attached at construction time, and dynamic toolsets to carry a stable id. The id here
is :data:`TOOLSET_ID`, which matches ``PortToolset.id``. The reviewed evidence is in
``docs/research/work-temporal-journey.md`` (section "One constructor-time Agent across two
concurrent Runs") and ``RESEARCH.md``.

Where the factories run
-----------------------

``model_factory`` and ``toolset_factory`` are **trusted composition**: the caller uses them to build
a fresh ``PortModel``/``PortToolset`` (with a fresh ``RunGuard``, catalog and limits) for one
activity, from the serialized ``ctx.deps`` only. Both are called from an SDK hook that Temporal
executes as a durable activity, and both gates below fail closed before the host factory is reached:

* the call must happen inside a real Temporal activity (``in_activity()`` is true), so no factory is
  ever invoked during workflow replay or during an ordinary ``Agent.run`` outside Temporal;
* ``ctx.deps`` must be an instance of the caller-declared ``deps_type``.

The factory may return its port directly or awaitably; both are accepted. Nothing here caches a
model, toolset, guard or Run. Each activity calls its factory anew; the trusted factory must create fresh guards and ports
rather than returning shared mutable instances. Workflow bootstrap receives only inert model metadata whose request refuses. The loader binds
``deps`` to the accepted
actual engine Run (the same serializable identity the Workflow received); **authority and budgets
remain control-owned and durable** — this module holds no authority store, no whole-Run counter and
no Run registry.

What this is not
----------------

This builder is composition only. It is not ``BoundedExecutor.execute``: it does not apply
corrections, bound final output, enforce a durable aggregate budget or publish Task completion, and
it does not replace standalone execution. Those stay with the caller and control. Like the rest of
this package it reads no environment variable or credential, touches no file, database or shell,
performs no network call, publishes no output and adds no policy.

The module exists only for the pinned worker environment. It imports the optional Temporal SDK, so
it is deliberately **not** imported by ``openbot_agent_runtime.__init__``: callers that do not run
Temporal never install or import it.
"""

from __future__ import annotations

import functools
import inspect
from copy import deepcopy
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, Final, TypeAlias

from pydantic_ai import Agent
from pydantic_ai.models import Model
from pydantic_ai.durable_exec.temporal import TemporalDurability
from temporalio import activity as temporal_activity, workflow

try:  # Public location on the reviewed 2.47.0 release; fallback keeps the diagnostic readable.
    from pydantic_ai.capabilities import ResolveModelId
except ImportError:  # pragma: no cover - only reached if the pinned layout moved the class
    from pydantic_ai.capabilities.resolve_model_id import ResolveModelId

try:  # Public location on the reviewed 2.47.0 release; fallback keeps the diagnostic readable.
    from pydantic_ai.toolsets import DynamicToolset
except ImportError:  # pragma: no cover - only reached if the pinned layout moved the class
    from pydantic_ai.toolsets._dynamic import DynamicToolset

from .errors import FailureReason, RuntimeFailure
from .sdk_ports import PORT_MODEL_NAME, PortModel, PortToolset, silence_sdk_startup_banner

TOOLSET_ID: Final = "openbot-ports"
"""Stable constructor-time id for the dynamic wrapper around ``PortToolset``.

It matches ``PortToolset.id`` so the durable leaf and the port agree on one identity.
"""

ModelFactory: TypeAlias = Callable[[Any], PortModel | Awaitable[PortModel]]
"""Trusted builder of one fresh ``PortModel``, called with ``ctx.deps`` only."""

ToolsetFactory: TypeAlias = Callable[[Any], PortToolset | Awaitable[PortToolset]]
"""Trusted builder of one fresh ``PortToolset``, called with ``ctx.deps`` only."""


def _in_real_activity() -> bool:
    """True only inside a Temporal activity worker context.

    Indirection over the pinned SDK so the activity boundary is one auditable predicate.
    """
    return temporal_activity.in_activity()


def _require_activity(port: str) -> None:
    """Refuse before any host factory runs outside a real Temporal activity."""
    if not _in_real_activity():
        raise RuntimeFailure(
            FailureReason.INVALID_REQUEST,
            f"the OpenBot {port} factory may only run inside a Temporal activity; "
            "no host factory is called during workflow replay or outside Temporal",
        )


class _WorkflowPortModel(Model):
    """Pure bootstrap metadata; the SDK re-resolves the id inside its activity.

    Workflow preparation/replay must never load host ports, guards or credentials.
    A missing durable wrapper therefore refuses instead of doing inline work.
    """

    @property
    def model_name(self) -> str:
        return PORT_MODEL_NAME

    @property
    def system(self) -> str:
        return "openbot"

    async def request(self, messages, model_settings, model_request_parameters):
        raise RuntimeFailure(
            FailureReason.INVALID_REQUEST,
            "Workflow model metadata cannot execute; a Temporal activity must resolve the port",
        )


def _require_deps(ctx: Any, deps_type: type[Any], port: str) -> Any:
    """Return ``ctx.deps``, or refuse a context carrying the wrong dependency type."""
    deps = getattr(ctx, "deps", None)
    try:
        matches = isinstance(deps, deps_type)
    except TypeError:
        # A caller-supplied non-class cannot be a runtime-checkable dependency type.
        matches = False
    if not matches:
        raise RuntimeFailure(
            FailureReason.INVALID_REQUEST,
            f"the {port} factory requires deps of type {deps_type!r}, got {type(deps).__name__}",
        )
    return deps


def _checked_port_model(outcome: Any) -> PortModel:
    if not isinstance(outcome, PortModel):
        raise RuntimeFailure(
            FailureReason.MODEL_PORT_UNAVAILABLE,
            f"the model factory returned {type(outcome).__name__}, not PortModel",
        )
    return outcome


def _checked_port_toolset(outcome: Any) -> PortToolset:
    if not isinstance(outcome, PortToolset):
        raise RuntimeFailure(
            FailureReason.TOOL_PORT_UNAVAILABLE,
            f"the toolset factory returned {type(outcome).__name__}, not PortToolset",
        )
    return outcome


async def _awaited_port_model(outcome: Awaitable[Any]) -> PortModel:
    return _checked_port_model(await outcome)


async def _awaited_port_toolset(outcome: Awaitable[Any]) -> PortToolset:
    return _checked_port_toolset(await outcome)


def _resolve_port_model(
    ctx: Any,
    model_id: str | None,
    *,
    deps_type: type[Any],
    model_factory: ModelFactory,
) -> Model | Awaitable[PortModel]:
    """Resolve one activity's ``PortModel`` through the public ``ResolveModelId`` resolver.

    Inputs are the construction-time model id and the activity's serialized ``ctx.deps`` only. A
    model id other than ``PORT_MODEL_NAME`` (or ``None`` when the durable hook leaves it unset) is
    refused instead of returning ``None``, because returning ``None`` would hand the decision to the
    SDK's own fallback and could route the Run to a different provider. ``ctx.deps`` is read here,
    never a process-local "current Run", a prompt marker or ``model_settings``.
    """
    if model_id not in (PORT_MODEL_NAME, None):
        raise RuntimeFailure(
            FailureReason.INVALID_REQUEST,
            f"model id {model_id!r} is not the OpenBot port id {PORT_MODEL_NAME!r}; "
            "refusing instead of letting the SDK fall back to another provider",
        )
    deps = _require_deps(ctx, deps_type, "model")
    if not _in_real_activity() and workflow.in_workflow():
        return _WorkflowPortModel()
    _require_activity("model")
    outcome = model_factory(deps)
    if inspect.isawaitable(outcome):
        return _awaited_port_model(outcome)
    return _checked_port_model(outcome)


def _resolve_port_toolset(
    ctx: Any,
    *,
    deps_type: type[Any],
    toolset_factory: ToolsetFactory,
) -> PortToolset | Awaitable[PortToolset]:
    """Build one activity's ``PortToolset`` from the activity's serialized ``ctx.deps`` only."""
    _require_activity("tool")
    deps = _require_deps(ctx, deps_type, "tool")
    outcome = toolset_factory(deps)
    if inspect.isawaitable(outcome):
        return _awaited_port_toolset(outcome)
    return _checked_port_toolset(outcome)


def _validate_composition(
    *,
    name: str,
    deps_type: type[Any],
    model_factory: ModelFactory,
    toolset_factory: ToolsetFactory,
    instructions: str,
    activity_config: Mapping[str, Any],
    model_activity_config: Mapping[str, Any],
) -> None:
    """Refuse a composition the durable worker could only fail on later, at activity time."""
    if not isinstance(name, str) or not name.strip():
        raise RuntimeFailure(FailureReason.INVALID_REQUEST, "name must be a non-empty string")
    if not isinstance(deps_type, type):
        raise RuntimeFailure(
            FailureReason.INVALID_REQUEST,
            f"deps_type must be the caller's dependency class, got {type(deps_type).__name__}",
        )
    if not callable(model_factory):
        raise RuntimeFailure(FailureReason.INVALID_REQUEST, "model_factory must be callable")
    if not callable(toolset_factory):
        raise RuntimeFailure(FailureReason.INVALID_REQUEST, "toolset_factory must be callable")
    if not isinstance(instructions, str):
        raise RuntimeFailure(FailureReason.INVALID_REQUEST, "instructions must be a string")
    for label, config in (
        ("activity_config", activity_config),
        ("model_activity_config", model_activity_config),
    ):
        if not isinstance(config, Mapping):
            raise RuntimeFailure(FailureReason.INVALID_REQUEST, f"{label} must be a mapping")


def build_temporal_agent(
    *,
    name: str,
    deps_type: type[Any],
    model_factory: ModelFactory,
    toolset_factory: ToolsetFactory,
    instructions: str,
    activity_config: Mapping[str, Any],
    model_activity_config: Mapping[str, Any],
) -> Agent[Any]:
    """Compose one constructor-time durable ``Agent`` for the pinned Temporal worker.

    The two config mappings are deeply copied, so a caller that later mutates its own dictionaries cannot
    change this Agent's activity options. The Agent carries no model, toolset, guard or Run state of
    its own: the capabilities call the trusted factories per activity, with ``ctx.deps`` only.
    """
    silence_sdk_startup_banner()
    _validate_composition(
        name=name,
        deps_type=deps_type,
        model_factory=model_factory,
        toolset_factory=toolset_factory,
        instructions=instructions,
        activity_config=activity_config,
        model_activity_config=model_activity_config,
    )
    resolve_model = functools.partial(
        _resolve_port_model, deps_type=deps_type, model_factory=model_factory
    )
    build_toolset = functools.partial(
        _resolve_port_toolset, deps_type=deps_type, toolset_factory=toolset_factory
    )
    agent: Agent[Any] = Agent(
        PORT_MODEL_NAME,
        deps_type=deps_type,
        name=name,
        toolsets=[DynamicToolset(build_toolset, id=TOOLSET_ID)],
        output_type=str,
        instructions=instructions or None,
        retries=0,
        capabilities=[
            TemporalDurability(
                activity_config=deepcopy(dict(activity_config)),
                model_activity_config=deepcopy(dict(model_activity_config)),
            ),
            ResolveModelId(resolve_model),
        ],
    )
    # Same explicit assertion as ``build_sdk_agent``: instrumentation is off and owned here, not
    # inherited from a default this module does not control.
    agent.instrument = False
    return agent


__all__ = [
    "ModelFactory",
    "TOOLSET_ID",
    "ToolsetFactory",
    "build_temporal_agent",
]
