"""Control-side execution and recovery seam for one external Action effect.

Authority for a new effect is never inferred here. Trusted control code supplies the Task/Run,
the existing control :class:`openbot_server.work_claims.WorkFence`, the immutable Action key,
intent and policy (reserved tokens, approval requirement, lifetime), plus a trusted effect
adapter and a trusted verifier. The existing :meth:`PostgresWorkStore.propose` and
:meth:`PostgresWorkStore.admit` transactions remain the only gate that permits a first external
write, and Owner approval is still required whenever the policy says so. Nothing here reads a
model, callback or receipt to decide that authority; an Action pending approval never executes.

Replay safety: :func:`execute_action` calls the adapter's ``apply`` only after ``admit`` reports
a **new** admission. ``work_actions.status`` never returns to ``proposed`` and the transition to
``admitted`` is row-locked, so at most one caller can receive that admission for an Action. A
crash between admit and apply, a lost response, a verifier error or a restarted process therefore
only ever causes an authoritative ``lookup``; ``apply`` is never invoked a second time. A missing
or malformed receipt leaves the Action ``unknown`` (the reservation is never refunded and no
replacement Action is created). Only a trusted verifier that returns a :class:`VerifiedOutcome`
bound to the exact Action, Task/Run and intent digest may supply the bounded ``actual_tokens`` and
receipt evidence that reach :meth:`PostgresWorkStore.resolve`; a Worker/model report is never
forwarded there.

:func:`recover_action` is the separate readback path for an Action that is already ``admitted``
or ``unknown``. It records verified external truth, including after cancellation or revocation,
and never calls ``apply``, ``propose``, ``admit`` or mints a fence. This module adds no schema,
route, scheduler or retry loop, and it does not qualify a production Worker or a completed
migration.
"""
import asyncio
import json
from dataclasses import dataclass
from typing import Protocol

from .work_values import InvalidWork, WorkConflict, canonical, receipt, text, tokens

MAX_IDENTITY = 128
MAX_ACTION_KEY = 128

__all__ = ['EffectAdapter', 'EffectVerifier', 'EffectOutcome', 'VerifiedOutcome',
           'execute_action', 'recover_action']


class EffectAdapter(Protocol):
    """Trusted external-effect surface injected by control composition.

    ``apply`` performs the one permitted external write for an Action. Its return value is
    untrusted and ignored: proof comes only from ``lookup`` plus the trusted verifier.
    ``lookup`` reads the authoritative external record for the exact Action, and may return
    ``None`` or raise when no trustworthy record is available; both leave the Action unknown.
    """

    async def apply(self, action_id, intent):
        ...

    async def lookup(self, action_id):
        ...


@dataclass(frozen=True)
class VerifiedOutcome:
    """A trusted verifier's binding of external truth to one exact Action.

    Only control-side verification code may construct this object. Every identity field is
    compared again before ``resolve`` is called, so a receipt cannot be replayed onto another
    Action, Task, Run or intent, and the bounded ``actual_tokens``/``evidence`` never come from
    a Worker or model report.
    """
    action_id: str
    task_id: str
    run_id: str
    intent_digest: str
    applied: bool
    actual_tokens: int
    evidence: dict


class EffectVerifier(Protocol):
    """Trusted verification of one external receipt against the exact Action identity.

    The verifier receives the raw ``lookup`` value plus the exact identity and canonical intent.
    It must return a :class:`VerifiedOutcome` bound to those facts, or ``None`` when the receipt
    is absent, empty or cannot be trusted. Raising is treated as "not verified" and leaves the
    Action unknown, except for cancellation, which always propagates.
    """

    async def verify(self, *, action_id, task_id, run_id, intent_digest, intent, lookup):
        ...


@dataclass(frozen=True)
class EffectOutcome:
    """Bounded result of one execution/readback call.

    ``invoked_apply`` distinguishes this caller's first-effect attempt from a readback-only
    retry; ``verified`` records whether trusted external truth was written through ``resolve``.
    ``status`` is the durable Action status observed or recorded by this call.
    """
    action_id: str
    status: str
    invoked_apply: bool
    verified: bool
    reason: str


def _intent(value):
    """Return a canonical immutable copy of a bounded Action intent and its digest."""
    if type(value) is not dict:
        raise InvalidWork('invalid_action')
    data, digest = canonical(value)
    return json.loads(data), digest


def _bound(outcome, action_id, task_id, run_id, intent_digest):
    return ((outcome.action_id, outcome.task_id, outcome.run_id, outcome.intent_digest)
            == (action_id, task_id, run_id, intent_digest))


async def _read(store, action_id):
    async with store._transaction(trusted=True) as connection:
        return await store._action(connection, action_id)


async def _uncertain(store, action_id):
    # A concurrent trusted resolver may settle the Action before this write. Report its
    # durable status rather than claiming our failed lookup left an already-settled row unknown.
    try:
        await store.uncertain(action_id)
        return 'unknown'
    except WorkConflict as error:
        if str(error) != 'action_not_admitted':
            raise
        _, action = await _read(store, action_id)
        if action['status'] not in ('applied', 'not_applied'):
            raise
        return action['status']


async def _lookup(adapter, action_id):
    try:
        return await adapter.lookup(action_id)
    except asyncio.CancelledError:
        raise
    except Exception:
        # A lookup failure or an absent record is not proof that the effect did not happen.
        return None


async def _verify(verifier, *, action_id, task_id, run_id, intent_digest, intent, lookup):
    try:
        return await verifier.verify(action_id=action_id, task_id=task_id, run_id=run_id,
                                     intent_digest=intent_digest, intent=intent, lookup=lookup)
    except asyncio.CancelledError:
        raise
    except Exception:
        return None


async def _settle(store, *, task_id, run_id, action_id, intent, intent_digest, adapter,
                  verifier, invoke_apply):
    """Settle one durable Action without ever permitting a second effect."""
    _, action = await _read(store, action_id)
    if action['task_id'] != task_id or action['run_id'] != run_id:
        raise WorkConflict('effect_scope_changed')
    if action['intent_digest'] != intent_digest:
        raise WorkConflict('effect_intent_changed')
    if action['status'] in ('applied', 'not_applied'):
        # Settled truth stands; a replay never applies again or overwrites recorded truth.
        return EffectOutcome(action_id, action['status'], False, True, 'already_settled')
    if action['status'] not in ('admitted', 'unknown'):
        # A proposed Action still requires the explicit approval/admit gate.
        raise WorkConflict('effect_not_admitted')

    if invoke_apply:
        try:
            await adapter.apply(action_id, intent)
        except asyncio.CancelledError:
            # Cancellation propagates; the durable Action stays admitted for a lookup-only retry.
            raise
        except Exception:
            # A lost response is not proof the write did not commit; fall through to lookup.
            pass

    lookup = await _lookup(adapter, action_id)
    outcome = None
    if lookup is not None:
        outcome = await _verify(verifier, action_id=action_id, task_id=task_id, run_id=run_id,
                                intent_digest=intent_digest, intent=intent, lookup=lookup)
    if type(outcome) is not VerifiedOutcome:
        # Absent, empty, malformed, untrusted or unresolvable: an explicit unknown, never a refund.
        status = await _uncertain(store, action_id)
        return EffectOutcome(action_id, status, invoke_apply, status != 'unknown',
                             'settled_concurrently' if status != 'unknown' else 'receipt_unverified')

    try:
        if not _bound(outcome, action_id, task_id, run_id, intent_digest):
            raise InvalidWork('invalid_outcome')
        if type(outcome.applied) is not bool:
            raise InvalidWork('invalid_outcome')
        tokens(outcome.actual_tokens)
        receipt(outcome.evidence)
    except InvalidWork:
        # A receipt that does not bind this exact Action fails closed; it is never recorded.
        await _uncertain(store, action_id)
        raise WorkConflict('effect_receipt_mismatch') from None
    await store.resolve(action_id, applied=outcome.applied, actual_tokens=outcome.actual_tokens,
                        evidence=outcome.evidence)
    return EffectOutcome(action_id, 'applied' if outcome.applied else 'not_applied',
                         invoke_apply, True, 'verified')


async def execute_action(store, *, task_id, run_id, fence, action_key, intent, reserved_tokens,
                         requires_approval, adapter, verifier, expires_seconds=300):
    """Execute at most one external effect for the immutable Action identified by ``action_key``.

    ``propose``/``admit`` remain the only new-effect gate, so this function performs the external
    write only when ``admit`` reports a new admission. Repeating the request with the same Action
    key and intent never applies again: the existing Action is read back through the authoritative
    lookup and resolved only by a matching :class:`VerifiedOutcome`. A missing or malformed
    receipt leaves the Action unknown. Pending Owner approval and every other admission conflict
    propagate before any effect, and cancellation always propagates.
    """
    text(task_id, MAX_IDENTITY)
    text(run_id, MAX_IDENTITY)
    text(action_key, MAX_ACTION_KEY)
    tokens(reserved_tokens)
    if type(requires_approval) is not bool:
        raise InvalidWork('invalid_action')
    if type(expires_seconds) is not int or not 1 <= expires_seconds <= 3600:
        raise InvalidWork('invalid_action')
    immutable_intent, digest = _intent(intent)

    action_id = await store.propose(task_id, run_id, fence=fence, action_key=action_key,
                                    intent=immutable_intent, reserved_tokens=reserved_tokens,
                                    requires_approval=requires_approval,
                                    expires_seconds=expires_seconds)
    admitted = await store.admit(action_id, fence=fence)
    return await _settle(store, task_id=task_id, run_id=run_id, action_id=action_id,
                         intent=immutable_intent, intent_digest=digest, adapter=adapter,
                         verifier=verifier, invoke_apply=admitted)


async def recover_action(store, *, task_id, run_id, action_id, adapter, verifier):
    """Record verified external truth for an existing admitted/unknown Action, effect-free.

    This repair/readback path never calls ``apply``, ``propose`` or ``admit`` and never mints a
    fence, so it grants no new authority after closure. It uses only the stored immutable intent
    and the authoritative lookup, and it is valid after cancellation or revocation because
    :meth:`PostgresWorkStore.resolve` records past truth without reopening work. A proposed
    Action is refused rather than admitted.
    """
    text(task_id, MAX_IDENTITY)
    text(run_id, MAX_IDENTITY)
    text(action_id, MAX_IDENTITY)
    _, action = await _read(store, action_id)
    if action['task_id'] != task_id or action['run_id'] != run_id:
        raise WorkConflict('effect_scope_changed')
    immutable_intent, digest = _intent(action['intent'])
    if digest != action['intent_digest']:
        # The stored row is internally inconsistent; fail closed without any lookup or effect.
        raise WorkConflict('effect_intent_changed')
    return await _settle(store, task_id=task_id, run_id=run_id, action_id=action_id,
                         intent=immutable_intent, intent_digest=digest, adapter=adapter,
                         verifier=verifier, invoke_apply=False)
