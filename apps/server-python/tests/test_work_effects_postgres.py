"""Control-side effect execution/readback against the owned PostgreSQL fixture.

The counterexample this file pins first: an external logical write commits before its response is
lost. A retry must settle the one Action from an authoritative lookup and must never call
``apply`` a second time. The trusted verifier is the only source of ``actual_tokens`` and receipt
evidence; a Worker/model-shaped report must leave the Action unknown without refunding it.
"""
import asyncio
import hashlib
from uuid import uuid4

import psycopg
import pytest

from openbot_server.work_effects import VerifiedOutcome, execute_action, recover_action
from openbot_server.work_values import InvalidWork, WorkConflict
from test_work_postgres import new, store


ACTION_KEY = 'fixture.effect'
INTENT = {'operation': 'fixture.record.update', 'record': 'row-1', 'value': 'exact'}


def evidence(action_id):
    label = 'owned-effect:' + action_id
    return {'source': 'owned-fixture', 'reference': label,
            'sha256': hashlib.sha256(label.encode()).hexdigest()}


class OwnedEffectService:
    """Owned synthetic external service; ``records`` is durable external truth.

    ``lose_apply_response`` models a committed write whose response never reached control.
    ``lookup_error`` models an authoritative lookup that cannot be trusted; either failure must
    leave the Action unknown rather than refunding it.
    """

    def __init__(self):
        self.applies = []
        self.lookups = []
        self.records = {}
        self.lose_apply_response = False
        self.lookup_error = None

    async def apply(self, action_id, intent):
        self.applies.append((action_id, dict(intent)))
        self.records[action_id] = dict(intent)
        if self.lose_apply_response:
            raise TimeoutError('synthetic lost apply response')

    async def lookup(self, action_id):
        self.lookups.append(action_id)
        if self.lookup_error is not None:
            raise self.lookup_error
        return self.records.get(action_id)


class TrustedVerifier:
    """Trusted control-side binding of the external record to one exact Action.

    ``malformed`` returns a plain report (the shape a Worker/model could supply) and the seam
    must refuse to resolve it. ``error`` models an unavailable trusted verifier.
    """

    def __init__(self, service, *, actual_tokens=3, applied=True, error=None, malformed=False):
        self.service = service
        self.actual_tokens = actual_tokens
        self.applied = applied
        self.error = error
        self.malformed = malformed

    async def verify(self, *, action_id, task_id, run_id, intent_digest, intent, lookup):
        if self.error is not None:
            raise self.error
        if self.malformed:
            return {'actionId': action_id, 'applied': self.applied}
        if type(lookup) is not dict or lookup != intent:
            return None
        return VerifiedOutcome(
            action_id=action_id, task_id=task_id, run_id=run_id, intent_digest=intent_digest,
            applied=self.applied, actual_tokens=self.actual_tokens, evidence=evidence(action_id))


async def claimed(fixture, limit=10):
    service = store(fixture)
    task = await new(fixture, service, limit)
    fence = await service.claim(task['id'], task['runs'][0]['id'], 'fixture-effect-claim')
    return service, task, fence


def effect_call(service, task, fence, adapter, verifier, **changes):
    values = dict(task_id=task['id'], run_id=task['runs'][0]['id'], fence=fence,
                  action_key=ACTION_KEY, intent=INTENT, reserved_tokens=6,
                  requires_approval=False, expires_seconds=300,
                  adapter=adapter, verifier=verifier)
    values.update(changes)
    return execute_action(service, **values)


async def snapshot(service, fixture, task):
    return await service.snapshot(fixture['token'], task['id'])


def test_new_admission_applies_once_then_records_verified_truth(fixture):
    async def check():
        service, task, fence = await claimed(fixture)
        external = OwnedEffectService()
        verifier = TrustedVerifier(external)
        result = await effect_call(service, task, fence, external, verifier)
        assert result.status == 'applied' and result.verified is True
        assert result.invoked_apply is True
        assert external.applies == [(result.action_id, INTENT)]
        assert external.lookups == [result.action_id]
        snap = await snapshot(service, fixture, task)
        action = snap['actions'][0]
        assert action['id'] == result.action_id and action['status'] == 'applied'
        assert action['actualTokens'] == 3 and action['evidence'] == evidence(result.action_id)
        assert snap['usage'] == {'tokenLimit': 10, 'reservedTokens': 0, 'spentTokens': 3}
        # Replaying the identical trusted request never applies again and records no new truth.
        replay = await effect_call(service, task, fence, external, verifier)
        assert replay.action_id == result.action_id and replay.invoked_apply is False
        assert replay.status == 'applied' and len(external.applies) == 1
        assert await snapshot(service, fixture, task) == snap
    asyncio.run(check())


def test_lost_apply_response_never_applies_again(fixture):
    async def check():
        service, task, fence = await claimed(fixture)
        external = OwnedEffectService()
        external.lose_apply_response = True
        external.lookup_error = RuntimeError('synthetic lookup unavailable')
        verifier = TrustedVerifier(external)
        first = await effect_call(service, task, fence, external, verifier)
        assert first.status == 'unknown' and first.invoked_apply is True
        assert len(external.applies) == 1 and len(external.lookups) == 1
        snap = await snapshot(service, fixture, task)
        assert snap['actions'][0]['status'] == 'unknown'
        assert snap['usage'] == {'tokenLimit': 10, 'reservedTokens': 6, 'spentTokens': 0}
        assert snap['attention'] == 'reconciliation'
        # A restarted trusted attempt with a new fence inspects the same durable Action only.
        restarted = store(fixture)
        retry_fence = await restarted.claim(task['id'], task['runs'][0]['id'], 'fixture-effect-retry')
        external.lookup_error = None
        second = await effect_call(restarted, task, retry_fence, external, verifier)
        assert second.action_id == first.action_id
        assert second.invoked_apply is False and second.status == 'applied'
        assert len(external.applies) == 1 and external.lookups[-1] == first.action_id
        final = await snapshot(service, fixture, task)
        assert final['actions'][0]['status'] == 'applied'
        assert final['usage'] == {'tokenLimit': 10, 'reservedTokens': 0, 'spentTokens': 3}
    asyncio.run(check())


def test_crash_between_admit_and_apply_performs_lookup_only(fixture):
    async def check():
        service, task, fence = await claimed(fixture)
        action_id = await service.propose(task['id'], task['runs'][0]['id'], fence=fence,
                                          action_key=ACTION_KEY, intent=INTENT, reserved_tokens=6,
                                          requires_approval=False)
        assert await service.admit(action_id, fence=fence) is True
        external = OwnedEffectService()
        result = await effect_call(service, task, fence, external, TrustedVerifier(external))
        assert result.action_id == action_id and result.status == 'unknown'
        assert result.invoked_apply is False
        assert external.applies == [] and external.lookups == [action_id]
        snap = await snapshot(service, fixture, task)
        assert snap['usage'] == {'tokenLimit': 10, 'reservedTokens': 6, 'spentTokens': 0}
    asyncio.run(check())


def test_concurrent_verified_resolution_is_not_reported_as_unknown(fixture):
    async def check():
        service, task, fence = await claimed(fixture)
        external = OwnedEffectService()

        class RacingVerifier:
            async def verify(self, *, action_id, task_id, run_id, intent_digest, intent, lookup):
                assert lookup == intent
                await service.resolve(action_id, applied=True, actual_tokens=3,
                                      evidence=evidence(action_id))
                return None

        result = await effect_call(service, task, fence, external, RacingVerifier())
        assert result.status == 'applied' and result.verified is True
        assert result.reason == 'settled_concurrently'
        assert len(external.applies) == 1
        assert (await snapshot(service, fixture, task))['actions'][0]['status'] == 'applied'
    asyncio.run(check())


def test_verifier_error_leaves_unknown_and_never_reapplies(fixture):
    async def check():
        service, task, fence = await claimed(fixture)
        external = OwnedEffectService()
        broken = TrustedVerifier(external, error=WorkConflict('synthetic_verifier_failure'))
        first = await effect_call(service, task, fence, external, broken)
        assert first.status == 'unknown' and first.invoked_apply is True
        assert len(external.applies) == 1
        assert (await snapshot(service, fixture, task))['actions'][0]['status'] == 'unknown'
        restarted = store(fixture)
        retry_fence = await restarted.claim(task['id'], task['runs'][0]['id'], 'fixture-effect-retry')
        second = await effect_call(restarted, task, retry_fence, external, TrustedVerifier(external))
        assert second.invoked_apply is False and second.status == 'applied'
        assert len(external.applies) == 1
    asyncio.run(check())


def test_absent_lookup_is_unknown_and_never_refunded(fixture):
    async def check():
        service, task, fence = await claimed(fixture)
        action_id = await service.propose(task['id'], task['runs'][0]['id'], fence=fence,
                                          action_key=ACTION_KEY, intent=INTENT, reserved_tokens=6,
                                          requires_approval=False)
        assert await service.admit(action_id, fence=fence) is True
        external = OwnedEffectService()
        verifier = TrustedVerifier(external)
        result = await recover_action(service, task_id=task['id'], run_id=task['runs'][0]['id'],
                                      action_id=action_id, adapter=external, verifier=verifier)
        assert result.status == 'unknown' and result.invoked_apply is False
        assert external.applies == [] and external.lookups == [action_id]
        snap = await snapshot(service, fixture, task)
        assert snap['actions'][0]['status'] == 'unknown'
        assert snap['usage'] == {'tokenLimit': 10, 'reservedTokens': 6, 'spentTokens': 0}
    asyncio.run(check())


def test_oversized_external_receipt_never_reaches_verifier(fixture):
    class OversizedLookup(OwnedEffectService):
        async def lookup(self, action_id):
            self.lookups.append(action_id)
            return {'raw': 'x' * 20_000}

    class PermissiveVerifier:
        calls = 0

        async def verify(self, *, action_id, task_id, run_id, intent_digest, intent, lookup):
            self.calls += 1
            return VerifiedOutcome(action_id, task_id, run_id, intent_digest, True, 3,
                                   evidence(action_id))

    async def check():
        service, task, fence = await claimed(fixture)
        external = OversizedLookup()
        verifier = PermissiveVerifier()
        result = await effect_call(service, task, fence, external, verifier)
        assert result.status == 'unknown' and result.verified is False
        assert len(external.applies) == 1 and verifier.calls == 0
        snap = await snapshot(service, fixture, task)
        assert snap['usage'] == {'tokenLimit': 10, 'reservedTokens': 6, 'spentTokens': 0}
    asyncio.run(check())


def test_untrusted_report_is_never_resolved(fixture):
    async def check():
        service, task, fence = await claimed(fixture)
        external = OwnedEffectService()
        verifier = TrustedVerifier(external, malformed=True)
        result = await effect_call(service, task, fence, external, verifier)
        assert result.status == 'unknown' and result.verified is False
        assert len(external.applies) == 1
        snap = await snapshot(service, fixture, task)
        assert snap['actions'][0]['status'] == 'unknown'
        assert snap['actions'][0]['actualTokens'] is None
        assert snap['usage'] == {'tokenLimit': 10, 'reservedTokens': 6, 'spentTokens': 0}
    asyncio.run(check())


def test_verified_outcome_must_bind_the_exact_action(fixture):
    class MismatchedVerifier:
        async def verify(self, *, action_id, task_id, run_id, intent_digest, intent, lookup):
            return VerifiedOutcome(action_id=str(uuid4()), task_id=task_id, run_id=run_id,
                                   intent_digest=intent_digest, applied=True, actual_tokens=3,
                                   evidence=evidence(action_id))

    async def check():
        service, task, fence = await claimed(fixture)
        external = OwnedEffectService()
        with pytest.raises(WorkConflict, match='effect_receipt_mismatch'):
            await effect_call(service, task, fence, external, MismatchedVerifier())
        assert len(external.applies) == 1
        snap = await snapshot(service, fixture, task)
        assert snap['actions'][0]['status'] == 'unknown'
        assert snap['usage'] == {'tokenLimit': 10, 'reservedTokens': 6, 'spentTokens': 0}
    asyncio.run(check())


def test_same_key_with_changed_intent_is_rejected_before_any_effect(fixture):
    async def check():
        service, task, fence = await claimed(fixture)
        external = OwnedEffectService()
        verifier = TrustedVerifier(external)
        first = await effect_call(service, task, fence, external, verifier)
        assert first.status == 'applied'
        with pytest.raises(WorkConflict, match='action_content_changed'):
            await effect_call(service, task, fence, external, verifier,
                              intent={**INTENT, 'value': 'changed'})
        assert len(external.applies) == 1
        snap = await snapshot(service, fixture, task)
        assert len(snap['actions']) == 1
        assert snap['usage'] == {'tokenLimit': 10, 'reservedTokens': 0, 'spentTokens': 3}
    asyncio.run(check())


def test_pending_owner_approval_never_executes(fixture):
    async def check():
        service, task, fence = await claimed(fixture)
        external = OwnedEffectService()
        verifier = TrustedVerifier(external)
        with pytest.raises(WorkConflict, match='action_not_authorized'):
            await effect_call(service, task, fence, external, verifier, requires_approval=True)
        assert external.applies == [] and external.lookups == []
        snap = await snapshot(service, fixture, task)
        assert snap['actions'][0]['status'] == 'proposed'
        assert snap['actions'][0]['decision'] == 'pending'
        assert snap['attention'] == 'approval'
        assert snap['usage'] == {'tokenLimit': 10, 'reservedTokens': 0, 'spentTokens': 0}
    asyncio.run(check())


@pytest.mark.parametrize('restriction', ['cancel', 'revoke'])
def test_readback_after_cancel_or_revoke_never_reapplies_or_admits(fixture, restriction):
    async def check():
        service, task, fence = await claimed(fixture)
        external = OwnedEffectService()
        external.lose_apply_response = True
        external.lookup_error = RuntimeError('synthetic lookup unavailable')
        verifier = TrustedVerifier(external)
        first = await effect_call(service, task, fence, external, verifier)
        assert first.status == 'unknown' and len(external.applies) == 1
        with psycopg.connect(fixture['dsn']) as db:
            before = (
                db.execute('SELECT count(*) FROM work_actions WHERE task_id=%s',
                           (task['id'],)).fetchone()[0],
                db.execute('SELECT count(*) FROM work_claims c JOIN work_runs r ON r.id=c.run_id '
                           'WHERE r.task_id=%s', (task['id'],)).fetchone()[0])
        await getattr(service, restriction)(fixture['token'], task['id'])
        external.lookup_error = None
        recovered = await recover_action(service, task_id=task['id'], run_id=task['runs'][0]['id'],
                                         action_id=first.action_id, adapter=external,
                                         verifier=verifier)
        assert recovered.invoked_apply is False and recovered.status == 'applied'
        assert len(external.applies) == 1
        with psycopg.connect(fixture['dsn']) as db:
            after = (
                db.execute('SELECT count(*) FROM work_actions WHERE task_id=%s',
                           (task['id'],)).fetchone()[0],
                db.execute('SELECT count(*) FROM work_claims c JOIN work_runs r ON r.id=c.run_id '
                           'WHERE r.task_id=%s', (task['id'],)).fetchone()[0])
        assert after == before
        snap = await snapshot(service, fixture, task)
        assert snap['actions'][0]['status'] == 'applied'
        assert snap['usage'] == {'tokenLimit': 10, 'reservedTokens': 0, 'spentTokens': 3}
        assert snap['authorityActive'] is False
    asyncio.run(check())


def test_readback_never_admits_a_proposed_action(fixture):
    async def check():
        service, task, fence = await claimed(fixture)
        action_id = await service.propose(task['id'], task['runs'][0]['id'], fence=fence,
                                          action_key=ACTION_KEY, intent=INTENT, reserved_tokens=6,
                                          requires_approval=True)
        external = OwnedEffectService()
        verifier = TrustedVerifier(external)
        with pytest.raises(WorkConflict, match='effect_not_admitted'):
            await recover_action(service, task_id=task['id'], run_id=task['runs'][0]['id'],
                                 action_id=action_id, adapter=external, verifier=verifier)
        assert external.applies == [] and external.lookups == []
        snap = await snapshot(service, fixture, task)
        assert snap['actions'][0]['status'] == 'proposed'
        assert snap['usage']['reservedTokens'] == 0
    asyncio.run(check())


@pytest.mark.parametrize('changes', [
    {'action_key': ''}, {'action_key': ' '}, {'action_key': 'a\x00b'},
    {'reserved_tokens': -1}, {'reserved_tokens': True}, {'reserved_tokens': 1.5},
    {'requires_approval': 'yes'}, {'expires_seconds': 0}, {'expires_seconds': True},
    {'intent': []}, {'intent': {'operation': 'x', 'value': float('nan')}},
])
def test_execute_bounds_inputs_before_any_effect(fixture, changes):
    async def check():
        service, task, fence = await claimed(fixture)
        external = OwnedEffectService()
        verifier = TrustedVerifier(external)
        with pytest.raises(InvalidWork):
            await effect_call(service, task, fence, external, verifier, **changes)
        with psycopg.connect(fixture['dsn']) as db:
            created = db.execute('SELECT count(*) FROM work_actions WHERE task_id=%s',
                                 (task['id'],)).fetchone()[0]
        assert created == 0
        assert external.applies == [] and external.lookups == []
    asyncio.run(check())
