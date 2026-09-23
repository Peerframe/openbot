"""One bounded handoff decision; an injected engine port owns transport.

This module contains no scheduler, retry loop, environment read, or permission source. The
PostgreSQL reservation is the only authority to contact the engine, and an acknowledgement
records a verified past fact without reopening work or granting new execution authority.

One reservation permits one high-level start invocation. The pinned Temporal SDK may retry that
same request ID at the RPC layer. The adapter must not create a new start request after an unknown
response; a later delivery only inspects the original workflow. A duplicate ID is not proof.

It mirrors the already-reviewed reference in ``experiments/work-journey/dispatch.py`` while
keeping ``temporalio`` out of the control package: the trusted adapter is injected as
:class:`EnginePort`.
"""
from dataclasses import dataclass
from typing import Protocol

from .work_values import InvalidWork, WorkConflict, text

# The reviewed deterministic identity; the namespace is bound into the durable reference.
WORKFLOW_ID_PREFIX = 'openbot-work-v1-'
REFERENCE_PREFIX = 'temporal:'
MAX_EXECUTION_TIMEOUT_SECONDS = 86_400


class EngineAlreadyStarted(Exception):
    """The engine rejected a duplicate workflow ID; only the stored history may decide."""


@dataclass(frozen=True)
class StartEvent:
    """Immutable facts decoded from the engine's workflow-started event."""
    workflow_type: str
    task_queue: str
    input: dict
    first_run_id: str


@dataclass(frozen=True)
class DispatchResult:
    """Outcome of one bounded handoff; ``acknowledged`` is a recorded fact, not new authority.

    ``start_requested`` records only that this caller invoked start for the reserved
    attempt, including a collision that raised :class:`EngineAlreadyStarted`. It does not claim
    an engine run started; only the inspected start event and the durable acknowledgement can
    establish that.
    """
    acknowledged: bool
    start_requested: bool
    reason: str


class EnginePort(Protocol):
    """Minimal trusted engine surface; the injected adapter binds namespace and credentials.

    ``namespace`` is the actual connected client namespace. This module invokes start at most
    once per reservation; an SDK transport retry must reuse its request ID. The adapter must
    not create a new high-level start request after an unknown response. Redelivery only inspects.
    """

    namespace: str

    async def start_workflow(self, workflow_id, workflow_type, queue, identity, execution_timeout):
        """Start once with reject-duplicate semantics or raise :class:`EngineAlreadyStarted`.

        A duplicate ID or lost response carries no second high-level start invocation.
        """

    async def inspect_start(self, workflow_id):
        """Return decoded :class:`StartEvent` facts, or ``None`` when history is unavailable."""


async def dispatch_one(task_id, run_id, namespace, queue, workflow_type,
                       execution_timeout, handoff, engine):
    """Decide one Task/Run handoff from explicit inputs and a trusted injected engine port.

    Every routing choice is an argument; no environment or model data is read here. The exact
    reservation is taken before the first engine contact, so missing history, a
    scope/type/queue mismatch, or an inspection failure stays unacknowledged and can never
    trigger a second start from this function. Inspection exceptions propagate so operators
    retain the actual transport failure instead of mistaking it for missing history.
    """
    text(task_id, 128)
    text(run_id, 128)
    text(namespace, 64)
    text(queue, 256)
    text(workflow_type, 256)
    if type(execution_timeout) is not int or not 1 <= execution_timeout <= MAX_EXECUTION_TIMEOUT_SECONDS:
        raise InvalidWork('invalid_execution_timeout')
    if type(getattr(engine, 'namespace', None)) is not str or engine.namespace != namespace:
        raise InvalidWork('engine_namespace_mismatch')

    workflow_id = WORKFLOW_ID_PREFIX + run_id
    reference = REFERENCE_PREFIX + namespace + ':' + workflow_id
    identity = {'taskId': task_id, 'runId': run_id}

    prior = await handoff.unconfirmed_for(task_id, run_id)
    if prior is not None:
        # A prior attempt is an inspection obligation, never permission to start again.
        if prior.get('engineReference') != reference:
            raise WorkConflict('handoff_reference_changed')
        return await _confirm(task_id, run_id, reference, workflow_id,
                              workflow_type, queue, identity, handoff, engine,
                              start_requested=False)

    # The exact durable reservation, taken before any engine contact, is the sole start authority.
    if not await handoff.reserve_submission(task_id, run_id, reference):
        # Another writer owns the one attempt (or it already exists): inspect only.
        return await _confirm(task_id, run_id, reference, workflow_id,
                              workflow_type, queue, identity, handoff, engine,
                              start_requested=False)

    try:
        await engine.start_workflow(workflow_id, workflow_type, queue, identity, execution_timeout)
    except EngineAlreadyStarted:
        # A colliding identifier alone does not prove the engine accepted this Task/Run.
        pass
    return await _confirm(task_id, run_id, reference, workflow_id,
                          workflow_type, queue, identity, handoff, engine, start_requested=True)


async def _confirm(task_id, run_id, reference, workflow_id, workflow_type, queue,
                   identity, handoff, engine, start_requested):
    """Inspect the immutable start event and acknowledge only a fully matching acceptance."""
    event = await engine.inspect_start(workflow_id)
    if event is None:
        # Retention or a lost first response leaves the durable reservation unresolved.
        return DispatchResult(False, start_requested, 'unconfirmed_missing_history')
    try:
        text(getattr(event, 'first_run_id', None), 128)
    except InvalidWork:
        return DispatchResult(False, start_requested, 'unconfirmed_start_event_mismatch')
    if (getattr(event, 'workflow_type', None) != workflow_type
            or getattr(event, 'task_queue', None) != queue
            or getattr(event, 'input', None) != identity):
        return DispatchResult(False, start_requested, 'unconfirmed_start_event_mismatch')
    recorded = await handoff.acknowledge(task_id, run_id, reference, event.first_run_id)
    return DispatchResult(True, start_requested, 'acknowledged' if recorded else 'already_acknowledged')
