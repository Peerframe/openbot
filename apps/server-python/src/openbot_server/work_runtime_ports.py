"""Optional Worker-only seam that composes one accepted activity's bounded runtime ports.

This module is the product-side counterpart of
:func:`openbot_agent_runtime.temporal_agent.build_temporal_agent` for deployments where the
control plane assembles the runtime ports itself. It adds no protocol, schema, dependency, Agent
or executor: it validates the existing runtime catalog/guard contracts, loads the accepted
product context through the existing read-only loader, and returns a fresh ``PortModel`` or
``PortToolset`` for one Activity. Both factory methods are directly usable as the
``model_factory``/``toolset_factory`` hooks of the existing builder.

Authority boundaries
--------------------

* ``store``, ``client``, the expected routing settings, ``load_services`` and the callbacks inside
  :class:`WorkRuntimeServices` are trusted composition supplied by the Worker. Nothing here reads
  an environment variable, a process-global Task/Run map, or a cache.
* The loader result and the returned ports are correlation evidence only. Neither grants a claim,
  fence, budget, approval or tool permission: the trusted ``model_step``/``tool_call`` callbacks
  still go through the existing durable control Action admission and settlement, and the guard
  counters are per-Activity secondary ceilings, never a persistent Run or Task budget.
* ``load_services`` only assembles configuration and callbacks. It may **not** bill a model,
  execute a tool, publish an output or authorize an effect; those stay with the callbacks and the
  existing control transactions they call.
* A :class:`openbot_agent_runtime.guard.RunGuard` brackets every model and tool await with a fresh
  authority check that re-binds this exact Activity, and the same guard refuses a context or
  service loader that outlives the configured deadline. Cancellation is never swallowed and no
  fallback model or toolset is ever substituted.

Schema detachment
-----------------

:class:`openbot_agent_runtime.catalog.ToolCatalog` shallow-copies a descriptor's top-level schema,
so nested objects can still alias the caller's mappings. The final model and executing catalogs
are therefore built from :func:`copy.deepcopy` copies of the validated bounded descriptors: a
mutation of the caller's nested schema can neither change a returned port nor leak state between
two Activities.
"""
from __future__ import annotations

import inspect
from collections.abc import Sequence
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from openbot_agent_runtime.catalog import ToolCatalog
from openbot_agent_runtime.contracts import (
    ModelStepPort,
    RuntimeLimits,
    ToolDescriptor,
    ToolPort,
    validate_deadline,
)
from openbot_agent_runtime.errors import FailureReason, RuntimeFailure
from openbot_agent_runtime.guard import RunGuard
from openbot_agent_runtime.sdk_ports import PortModel, PortToolset

from .work_store import PostgresWorkStore
from .work_temporal_activity import bind_current_activity
from .work_temporal_start import load_current_activity_task
from .work_values import InvalidWork, WorkConflict, text

__all__ = ['WorkRuntimeDeps', 'WorkRuntimePortFactory', 'WorkRuntimeServices']

SCOPE_MISMATCH = 'runtime_deps_scope_mismatch'
"""Exact conflict text the existing reference Worker uses for a deps/context disagreement.

Reusing one stable signal keeps callers, logs and tests aligned without inventing a new error
vocabulary.
"""


@dataclass(frozen=True)
class WorkRuntimeDeps:
    """Serializable routing identity for one Activity's ports.

    These are the exact ``{taskId, runId}`` values the Workflow handed the SDK as ``ctx.deps``.
    They are a routing hint, not authority: the factory re-derives the actual binding from the
    pinned SDK snapshot and refuses any disagreement before it assembles services.
    """
    task_id: str
    run_id: str


@dataclass(frozen=True)
class WorkRuntimeServices:
    """Trusted per-Activity services assembled by the Worker's ``load_services``.

    ``model_step`` and ``tool_call`` are the existing Runtime contract callbacks
    (:class:`openbot_agent_runtime.contracts.ModelStepPort` and
    :class:`openbot_agent_runtime.contracts.ToolPort`); ``model_tools`` is the descriptor sequence
    offered to the model and ``inline_tools`` the subset the executing toolset may reach. This is
    configuration only: it holds no guard, catalog, lease or budget, and it grants no effect.
    """
    model_step: ModelStepPort
    tool_call: ToolPort
    model_tools: Sequence[ToolDescriptor]
    inline_tools: Sequence[ToolDescriptor] = ()


class WorkRuntimePortFactory:
    """Trusted composition of one Activity's runtime ports through the existing loader contracts.

    One factory instance is reused across Activities and holds only trusted routing settings and
    the ``load_services`` caller. It keeps no per-Run state, so every :meth:`model_factory` and
    :meth:`toolset_factory` call builds a fresh guard, catalog and port.
    """

    def __init__(self, store: PostgresWorkStore, client: Any, *, expected_namespace,
                 expected_queue, expected_workflow_type, load_services,
                 limits: RuntimeLimits = RuntimeLimits(), deadline_seconds: float = 30) -> None:
        if not isinstance(limits, RuntimeLimits):
            raise RuntimeFailure(
                FailureReason.INVALID_REQUEST,
                f"limits must be RuntimeLimits, got {type(limits).__name__}")
        # The existing contracts own both validations: one bounded limit set and one bounded,
        # finite, positive deadline. Expected routing is deliberately not re-validated here; the
        # existing binding gate owns it.
        self._limits = limits.validated()
        self._deadline_seconds = validate_deadline(deadline_seconds)
        if not callable(load_services):
            raise RuntimeFailure(FailureReason.INVALID_REQUEST, "load_services must be callable")
        self._store = store
        self._client = client
        self._expected_namespace = expected_namespace
        self._expected_queue = expected_queue
        self._expected_workflow_type = expected_workflow_type
        self._load_services = load_services

    async def model_factory(self, deps: WorkRuntimeDeps) -> PortModel:
        """Return a fresh ``PortModel`` for one Activity, or refuse before any model work.

        ``deps`` is the Activity's serialized routing identity. The accepted context is loaded
        through the existing read-only loader, the routing identity is matched against it, and the
        actual current binding is re-derived before services are assembled. The returned guard's
        authority callback re-derives that binding before and after every model await.
        """
        guard, services, model_catalog, _ = await self._prepare(deps)
        return PortModel(step_port=services.model_step, catalog=model_catalog, guard=guard,
                         limits=self._limits)

    async def deferred_catalog(self, deps: WorkRuntimeDeps) -> ToolCatalog:
        """Detached non-executing declarations from this accepted activity's trusted catalog."""
        _, _, model, inline = await self._prepare(deps)
        names = {tool.name for tool in inline.descriptors}
        return ToolCatalog(tuple(tool for tool in model.descriptors if tool.name not in names),
            max_tools=self._limits.catalog_tools, max_bytes=self._limits.catalog_bytes)

    async def toolset_factory(self, deps: WorkRuntimeDeps) -> PortToolset:
        """Return a fresh ``PortToolset`` for one Activity, or refuse before any tool work.

        The executing catalog is built from ``inline_tools`` only, so a deferred or model-only
        declaration can never be reached through the toolset.
        """
        guard, services, _, inline_catalog = await self._prepare(deps)
        return PortToolset(catalog=inline_catalog, tool_port=services.tool_call, guard=guard,
                           limits=self._limits)

    # -- internals -------------------------------------------------------------

    async def _prepare(self, deps: WorkRuntimeDeps
                       ) -> tuple[RunGuard, WorkRuntimeServices, ToolCatalog, ToolCatalog]:
        """Validate one Activity and return its fresh guard, services and final catalogs."""
        _validated_deps(deps)
        # The guard is created before the context load so its single monotonic deadline spans the
        # context load, the service load and the model/tool work that follows; it is never reset.
        guard = RunGuard(
            authority=lambda: self._assert_scope(deps),
            progress=None,
            steps_limit=self._limits.steps,
            tool_calls_limit=self._limits.tool_calls,
            progress_events_limit=self._limits.progress_events,
            deadline_seconds=self._deadline_seconds,
        )
        context = await load_current_activity_task(
            self._store, self._client, expected_namespace=self._expected_namespace,
            expected_queue=self._expected_queue,
            expected_workflow_type=self._expected_workflow_type)
        if (context.task_id, context.run_id) != (deps.task_id, deps.run_id):
            raise WorkConflict(SCOPE_MISMATCH)
        # A context loader that outlived the deadline is refused here, and the actual current
        # binding is re-derived before any service is assembled: cancellation, revocation or a
        # superseding Activity during that awaited load must not reach load_services.
        guard.check_sync('context load')
        await self._assert_scope(deps)
        guard.check_sync('binding before services')
        outcome = self._load_services(context)
        services = await outcome if inspect.isawaitable(outcome) else outcome
        services = _validated_services(services)
        # The same deadline still applies after the service loader; it is never restarted.
        guard.check_sync('service load')
        await self._assert_scope(deps)
        guard.check_sync('binding after services')
        model_catalog, inline_catalog = _detached_catalogs(services, self._limits)
        return guard, services, model_catalog, inline_catalog

    async def _assert_scope(self, deps: WorkRuntimeDeps) -> None:
        """Re-derive the actual current binding and refuse any deps disagreement.

        This is the guard's authority callback, so it runs before and after every model and tool
        await. It reads one fresh SDK snapshot through the existing correlation gate and never
        trusts the serialized routing identity.
        """
        accepted = await bind_current_activity(
            self._store, self._client, expected_namespace=self._expected_namespace,
            expected_queue=self._expected_queue,
            expected_workflow_type=self._expected_workflow_type)
        if (accepted.task_id, accepted.run_id) != (deps.task_id, deps.run_id):
            raise WorkConflict(SCOPE_MISMATCH)


def _validated_deps(deps: WorkRuntimeDeps) -> WorkRuntimeDeps:
    """Refuse a dependency object that is not the declared routing type.

    The typed dependency is a routing hint and is matched against the loaded context afterwards.
    """
    if not isinstance(deps, WorkRuntimeDeps):
        raise RuntimeFailure(
            FailureReason.INVALID_REQUEST,
            f"runtime deps must be WorkRuntimeDeps, got {type(deps).__name__}")
    try:
        text(deps.task_id, 128)
        text(deps.run_id, 128)
    except InvalidWork as error:
        raise RuntimeFailure(FailureReason.INVALID_REQUEST, 'Invalid Task/Run correlation ID') from error
    return deps


def _validated_services(services: Any) -> WorkRuntimeServices:
    """Refuse anything but the declared services shape with two callable callbacks."""
    if not isinstance(services, WorkRuntimeServices):
        raise RuntimeFailure(
            FailureReason.INVALID_REQUEST,
            f"load_services must return WorkRuntimeServices, got {type(services).__name__}")
    if not callable(services.model_step):
        raise RuntimeFailure(FailureReason.MODEL_PORT_UNAVAILABLE, "model_step must be callable")
    if not callable(services.tool_call):
        raise RuntimeFailure(FailureReason.TOOL_PORT_UNAVAILABLE, "tool_call must be callable")
    return services


def _detached_catalogs(services: WorkRuntimeServices,
                       limits: RuntimeLimits) -> tuple[ToolCatalog, ToolCatalog]:
    """Validate, cross-check and detach the model and executing catalogs.

    The existing :class:`ToolCatalog` validates every descriptor, name, schema and byte bound. An
    inline descriptor must be declared by the model catalog and be identical to that declaration,
    so the executing toolset can never reach a tool the model was not offered. Both final catalogs
    are then rebuilt from deep copies of the validated descriptors, because ``ToolCatalog`` only
    shallow-copies a nested schema and an alias would let a later caller mutation change a live
    port.
    """
    model_declared = ToolCatalog(services.model_tools, max_tools=limits.catalog_tools,
                                 max_bytes=limits.catalog_bytes)
    inline_declared = ToolCatalog(services.inline_tools, max_tools=limits.catalog_tools,
                                  max_bytes=limits.catalog_bytes)
    for descriptor in inline_declared.descriptors:
        try:
            declared = model_declared.descriptor(descriptor.name)
        except RuntimeFailure:
            raise RuntimeFailure(
                FailureReason.CATALOG_INVALID,
                f"inline tool {descriptor.name!r} is not declared by the model catalog") from None
        if declared != descriptor:
            raise RuntimeFailure(
                FailureReason.CATALOG_INVALID,
                f"inline tool {descriptor.name!r} does not match its model declaration")
    model_catalog = ToolCatalog(deepcopy(list(model_declared.descriptors)),
                                max_tools=limits.catalog_tools, max_bytes=limits.catalog_bytes)
    inline_catalog = ToolCatalog(deepcopy(list(inline_declared.descriptors)),
                                 max_tools=limits.catalog_tools, max_bytes=limits.catalog_bytes)
    return model_catalog, inline_catalog
