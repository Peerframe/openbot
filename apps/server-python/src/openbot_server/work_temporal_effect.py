"""Activity-to-Action seam: one accepted engine activity plans and executes one external Action.

This is the narrow product-side composition a future Temporal Worker activity calls. It reads
exactly one ``temporalio.activity.info()`` snapshot through
:func:`openbot_server.work_temporal_activity._bind_activity_identity`, which refuses a wrong or
missing queue/type/attempt/chain, missing Activity ID or history, a closed Run and a
canceled/revoked Task before any policy or effect. Only then does the injected trusted
:class:`ControlPolicy` turn a bounded, detached copy of the untrusted tool request into one exact
:class:`ActionPlan`. After that plan validates, the accepted activity is claimed through the
existing control-owned
:func:`openbot_server.work_temporal_activity._claim_bound_activity`, and the stable logical Action
key, canonical intent, reservation, approval flag and lifetime are handed to the existing
:func:`openbot_server.work_effects.execute_action` seam. That seam's ``propose``/``admit``
transactions remain the only thing that permits a first external write.

The untrusted request and the trusted plan are deliberately separate objects. The model/tool
``call_id`` is bounded transport metadata only: it is never shown to the policy and cannot be a
fence, an Action key, an idempotency key or a substitute for approval. A plan that equals the
original call ID is also refused. The policy grants nothing by itself; a pending Owner approval still yields no external
apply. After approval, the same logical Action may be admitted and applied once; subsequent
calls for that admitted Action use lookup/verification only. Historical
readback stays with the separate :func:`openbot_server.work_effects.recover_action` path. This
module adds no scheduler, retry loop, route or schema, and it reaches no external apply path other
than ``execute_action``. The at-most-once result is scoped to the same trusted logical Action
key; this helper cannot prove that a future policy chooses the same key after a different Activity
or Worker restart. The production Worker must derive it from a durable control/workflow operation
fact, not from a model-provided call identifier.

Explicit limits: this is not a Worker service and neither installs nor runs one; it is not a
durable whole-Run budget (reservations are the existing per-Action store facts, not a Run-wide
counter); and it is not an OS sandbox for untrusted tool code. It keeps no process-global Run
registry, task/Run cache or credentials; every engine, claim and budget fact comes from the
trusted SDK snapshot and the existing control transactions.
"""
import json
from dataclasses import dataclass
from typing import Protocol

from .work_effects import MAX_ACTION_KEY, execute_action
from .work_temporal_activity import _bind_activity_identity, _claim_bound_activity
from .work_values import InvalidWork, WorkConflict, canonical, text, tokens

# The untrusted provider/tool call identifier is bounded transport metadata only. It is never a
# claim fence, Action key, exactly-once identity or approval substitute.
MAX_CALL_ID = 128
MAX_TOOL = 128

__all__ = ['ActionPlan', 'ControlPolicy', 'ToolRequest', 'execute_activity_action']


@dataclass(frozen=True)
class ToolRequest:
    """One bounded, detached copy of the untrusted tool request the policy may plan from.

    ``tool`` is bounded text. The caller's ``call_id`` is validated but deliberately excluded
    from this policy input. ``arguments`` is a fresh canonical-JSON copy of the
    untrusted arguments: :func:`openbot_server.work_values.canonical` has already bounded node
    count, depth, size and every JSON value, and the copy is detached from the caller's object.
    ``digest`` is that canonical copy's SHA-256 and exists for policy/logging use only; none of
    these fields is authority or an exactly-once key. Building this object touches neither the
    store nor the engine.
    """
    tool: str
    arguments: dict
    digest: str


@dataclass(frozen=True)
class ActionPlan:
    """The trusted policy's exact plan for one bounded external Action.

    ``action_key`` is the stable logical Action key (never the tool ``call_id``), ``intent`` is a
    canonical immutable copy, ``reserved_tokens`` is the reservation the existing store
    transactions enforce, ``requires_approval`` is the approval gate and ``expires_seconds`` the
    Action lifetime. The plan is only a request: ``store.propose``/``store.admit`` decide whether
    it may run, and Owner approval is still required when ``requires_approval`` is true.
    """
    action_key: str
    intent: dict
    reserved_tokens: int
    requires_approval: bool
    expires_seconds: int


class ControlPolicy(Protocol):
    """Trusted planning surface injected at composition time.

    ``plan`` sees only a bounded :class:`ToolRequest` without the model's call ID and must return a fresh
    :class:`ActionPlan` or raise. It never sees the request's ``call_id``, and it cannot grant an
    effect: the existing store transactions re-check the
    control fence, reservation, approval and Task/Run authority after it returns. An error or an
    invalid plan leaves no claim and no effect.
    """

    async def plan(self, request: ToolRequest) -> ActionPlan:
        ...


def _bound_request(value):
    """Return a bounded policy input and separate call ID, refusing any other shape.

    The exact three-key shape avoids a superset smuggling a second intent past the policy. The
    arguments are canonicalized by the shared bounded JSON visitor before the policy can see them,
    and the returned copy shares no mutable structure with the caller's object.
    """
    if type(value) is not dict or set(value) != {'call_id', 'tool', 'arguments'}:
        raise InvalidWork('invalid_tool_request')
    call_id = text(value['call_id'], MAX_CALL_ID)
    tool = text(value['tool'], MAX_TOOL)
    if type(value['arguments']) is not dict:
        raise InvalidWork('invalid_tool_request')
    data, digest = canonical(value['arguments'])
    return ToolRequest(tool=tool, arguments=json.loads(data), digest=digest), call_id


async def _validated_plan(policy, request, call_id):
    """Await the trusted policy and return a bounded exact plan, or fail closed.

    The policy is trusted composition, but a throwing or malformed plan must never leave a claim
    or an effect, so every failure is converted to a bounded failure before the claim step. A plan
    whose Action key is the untrusted tool ``call_id`` is refused: transport metadata must not
    become the logical exactly-once identity.
    """
    try:
        plan = await policy.plan(request)
    except Exception as error:
        raise WorkConflict('action_plan_unavailable') from error
    if type(plan) is not ActionPlan:
        raise InvalidWork('invalid_action_plan')
    action_key = text(plan.action_key, MAX_ACTION_KEY)
    if action_key == call_id:
        raise InvalidWork('invalid_action_plan')
    if type(plan.intent) is not dict:
        raise InvalidWork('invalid_action_plan')
    data, _ = canonical(plan.intent)
    tokens(plan.reserved_tokens)
    if type(plan.requires_approval) is not bool:
        raise InvalidWork('invalid_action_plan')
    if type(plan.expires_seconds) is not int or not 1 <= plan.expires_seconds <= 3600:
        raise InvalidWork('invalid_action_plan')
    # Return fresh canonical copies so later mutation of the policy's objects changes nothing.
    return ActionPlan(action_key=action_key, intent=json.loads(data),
                      reserved_tokens=plan.reserved_tokens,
                      requires_approval=plan.requires_approval,
                      expires_seconds=plan.expires_seconds)


async def execute_activity_action(store, client, *, expected_namespace, expected_queue,
                                  expected_workflow_type, request, policy, adapter, verifier,
                                  claim_expires_seconds=60):
    """Plan and execute at most one external Action for this exact accepted engine activity.

    Trusted composition only. ``store`` and ``client`` are the existing control store and pinned
    engine client; ``expected_namespace``/``expected_queue``/``expected_workflow_type`` are trusted
    settings; ``policy``, ``adapter`` and ``verifier`` are trusted composition surfaces. ``request``
    is untrusted tool output: the Task/Run, fence, Activity ID, history, expectation settings and
    approval decision are never accepted from it. Exactly one SDK snapshot is read internally and
    reused for the binding and the activity-derived claim.

    Ordering is the safety property: a malformed request and a wrong or missing SDK identity fail
    before the policy is asked, an invalid or throwing policy fails before any claim or effect, and
    the claim happens before the existing effect seam. The effect itself goes only through
    :func:`openbot_server.work_effects.execute_action` with the accepted Task/Run and the
    control-owned fence, so ``propose``/``admit`` still decide and a pending approval yields no
    apply. This function never retries an unknown effect and never mints authority from a closed
    Task or Run.
    """
    bounded, call_id = _bound_request(request)
    accepted, activity_id = await _bind_activity_identity(
        store, client, expected_namespace=expected_namespace, expected_queue=expected_queue,
        expected_workflow_type=expected_workflow_type)
    plan = await _validated_plan(policy, bounded, call_id)
    fence = await _claim_bound_activity(store, accepted, activity_id,
                                       expires_seconds=claim_expires_seconds)
    return await execute_action(
        store, task_id=accepted.task_id, run_id=accepted.run_id, fence=fence,
        action_key=plan.action_key, intent=plan.intent, reserved_tokens=plan.reserved_tokens,
        requires_approval=plan.requires_approval, adapter=adapter, verifier=verifier,
        expires_seconds=plan.expires_seconds)
