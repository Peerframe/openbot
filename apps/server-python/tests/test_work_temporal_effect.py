"""Activity-to-Action seam tests: one accepted activity, one trusted plan, one bounded effect.

Every engine fact comes from the fake SDK activity context and fake pinned client already used by
``test_work_temporal_activity``; the PostgreSQL store is the owned control fixture. The seam must
read one SDK snapshot, refuse a wrong or missing engine identity before the policy is asked, refuse
a malformed or throwing policy before any claim or effect, and only then claim and hand the plan to
the existing ``execute_action`` seam. The model/tool call ID is bounded transport metadata, never
an Action key, and a lost apply response must resolve through the existing lookup path without a
second apply.
"""
import asyncio
import hashlib

import pytest

pytest.importorskip('temporalio')

from openbot_server import work_temporal_activity
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_temporal_activity import derive_claim_id
from openbot_server.work_temporal_effect import (ActionPlan, ToolRequest,
                                                 execute_activity_action)
from openbot_server.work_values import InvalidWork, WorkConflict, canonical
from test_work_effects_postgres import OwnedEffectService, TrustedVerifier
from test_work_temporal_activity import (ACTIVITY_ID, CURRENT_RUN_ID, NAMESPACE, QUEUE,
                                         WORKFLOW_TYPE, Client, History, acknowledged, claim_rows,
                                         current, info, run_state, settings, started_event)

ACTION_KEY = 'fixture.activity.effect'
INTENT = {'operation': 'fixture.record.update', 'record': 'row-1', 'value': 'activity'}
REQUEST = {'call_id': 'call-1', 'tool': 'fixture.record.update',
           'arguments': {'record': 'row-1', 'value': 'activity'}}


def make_plan(**changes):
    values = dict(action_key=ACTION_KEY, intent=INTENT, reserved_tokens=6,
                  requires_approval=False, expires_seconds=300)
    values.update(changes)
    return ActionPlan(**values)


class StaticPolicy:
    """Trusted policy double: records the bounded request and returns or raises a scripted value."""

    def __init__(self, value=None, error=None):
        self.value = value
        self.error = error
        self.requests = []

    async def plan(self, request):
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        return self.value


def call(service, client, policy, adapter, verifier, **changes):
    values = dict(**settings(), request=REQUEST, policy=policy, adapter=adapter, verifier=verifier)
    values.update(changes)
    return execute_activity_action(service, client, **values)


def test_seam_binds_the_exact_run_claims_the_activity_and_applies_once(fixture, monkeypatch):
    async def check():
        service = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, service)
        current(monkeypatch, workflow_id)
        external = OwnedEffectService()
        policy = StaticPolicy(make_plan())
        result = await call(service, client, policy, external, TrustedVerifier(external))
        assert result.status == 'applied' and result.verified is True
        assert result.invoked_apply is True
        assert external.applies == [(result.action_id, INTENT)]
        # Binding opened only the activity's exact current Run, never a latest-Run handle.
        assert client.handles == [(workflow_id, CURRENT_RUN_ID)]
        claim_id = derive_claim_id(NAMESPACE, workflow_id, CURRENT_RUN_ID, ACTIVITY_ID)
        assert claim_rows(fixture, run_id) == [(claim_id, 1, True)]
        assert run_state(fixture, run_id) == (1, 'running')
        snap = await service.snapshot(fixture['token'], task_id)
        assert snap['actions'][0]['id'] == result.action_id
        assert snap['actions'][0]['status'] == 'applied'
        # The policy saw a bounded, detached request, not the raw caller object.
        seen = policy.requests[0]
        assert isinstance(seen, ToolRequest)
        assert seen.tool == REQUEST['tool']
        assert not hasattr(seen, 'call_id')
        assert seen.arguments == REQUEST['arguments']
    asyncio.run(check())


def test_seam_reads_exactly_one_sdk_snapshot_for_binding_and_claim(fixture, monkeypatch):
    async def check():
        service = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, service)
        snapshot = info(workflow_id=workflow_id)
        calls = []

        def counted():
            calls.append(1)
            return snapshot

        monkeypatch.setattr(work_temporal_activity, 'activity_info', counted)
        external = OwnedEffectService()
        policy = StaticPolicy(make_plan())
        result = await call(service, client, policy, external, TrustedVerifier(external))
        assert result.status == 'applied'
        # One snapshot supplies both the binding and the activity-scoped claim identity.
        assert calls == [1]
        assert claim_rows(fixture, run_id) == [
            (derive_claim_id(NAMESPACE, workflow_id, CURRENT_RUN_ID, ACTIVITY_ID), 1, True)]
    asyncio.run(check())


def test_policy_request_is_bounded_and_detached_from_the_caller(fixture, monkeypatch):
    async def check():
        service = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, service)
        current(monkeypatch, workflow_id)
        external = OwnedEffectService()
        raw = {'call_id': 'call-1', 'tool': 'fixture.record.update',
               'arguments': {'record': 'row-1', 'value': 'activity'}}
        expected_digest = hashlib.sha256(canonical(REQUEST['arguments'])[0]).hexdigest()
        policy = StaticPolicy(make_plan())
        await call(service, client, policy, external, TrustedVerifier(external), request=raw)
        seen = policy.requests[0]
        assert seen.digest == expected_digest
        # Mutating the caller's object after the call cannot change what the policy saw.
        raw['arguments']['value'] = 'changed-outside'
        assert seen.arguments == REQUEST['arguments']
    asyncio.run(check())


@pytest.mark.parametrize('activity_id', [None, '', 42, 'a' * 257])
def test_missing_or_malformed_activity_id_fails_before_policy(fixture, monkeypatch, activity_id):
    async def check():
        service = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, service)
        current(monkeypatch, workflow_id, activity_id=activity_id)
        external = OwnedEffectService()
        policy = StaticPolicy(make_plan())
        with pytest.raises(InvalidWork):
            await call(service, client, policy, external, TrustedVerifier(external))
        assert policy.requests == []
        assert client.handles == []
        assert external.applies == []
        assert run_state(fixture, run_id)[0] == 0
        assert claim_rows(fixture, run_id) == []
    asyncio.run(check())


@pytest.mark.parametrize('overrides,error', [
    ({'namespace': 'other-namespace'}, 'engine_namespace_mismatch'),
    ({'task_queue': 'other-queue'}, 'engine_queue_mismatch'),
    ({'workflow_type': 'OtherWorkflow'}, 'engine_workflow_type_mismatch'),
])
def test_wrong_activity_facts_fail_before_policy(fixture, monkeypatch, overrides, error):
    async def check():
        service = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, service)
        monkeypatch.setattr(work_temporal_activity, 'activity_info',
                            lambda: info(workflow_id=workflow_id, **overrides))
        external = OwnedEffectService()
        policy = StaticPolicy(make_plan())
        with pytest.raises(WorkConflict, match=error):
            await call(service, client, policy, external, TrustedVerifier(external))
        assert policy.requests == []
        assert client.handles == []
        assert external.applies == []
        assert claim_rows(fixture, run_id) == []
    asyncio.run(check())


def test_wrong_attempt_and_missing_history_fail_before_policy(fixture, monkeypatch):
    async def check():
        service = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, _ = await acknowledged(fixture, service)
        current(monkeypatch, workflow_id)
        external = OwnedEffectService()
        policy = StaticPolicy(make_plan())
        wrong = Client(history=History([started_event(workflow_id=workflow_id)]),
                       decoded=[{'taskId': task_id, 'runId': run_id, 'attemptId': 'f' * 32}])
        with pytest.raises(WorkConflict, match='handoff_attempt_changed'):
            await call(service, wrong, policy, external, TrustedVerifier(external))
        missing = Client(history=History(), decoded=None)
        with pytest.raises(WorkConflict, match='engine_start_history_unavailable'):
            await call(service, missing, policy, external, TrustedVerifier(external))
        assert policy.requests == []
        assert external.applies == []
        assert claim_rows(fixture, run_id) == []
    asyncio.run(check())


@pytest.mark.parametrize('bad_request', [
    {'call_id': 'call-1', 'tool': 'tool'},
    {'call_id': 'call-1', 'tool': 'tool', 'arguments': {}, 'extra': 1},
    {'call_id': '', 'tool': 'tool', 'arguments': {}},
    {'call_id': 'call-1', 'tool': 'tool', 'arguments': []},
    {'call_id': 'call-1', 'tool': 'tool', 'arguments': {'value': float('nan')}},
    {'call_id': 'call-1', 'tool': 'tool', 'arguments': {'value': 'x' * 20_000}},
])
def test_unbounded_or_wrong_shaped_request_is_refused_before_policy(fixture, monkeypatch,
                                                                    bad_request):
    async def check():
        service = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, service)
        current(monkeypatch, workflow_id)
        external = OwnedEffectService()
        policy = StaticPolicy(make_plan())
        with pytest.raises(InvalidWork):
            await call(service, client, policy, external, TrustedVerifier(external),
                       request=bad_request)
        assert policy.requests == []
        assert client.handles == []
        assert external.applies == []
        assert claim_rows(fixture, run_id) == []
    asyncio.run(check())


@pytest.mark.parametrize('policy_value,error', [
    (None, InvalidWork),
    (make_plan(action_key=REQUEST['call_id']), InvalidWork),
    (make_plan(intent=[]), InvalidWork),
    (make_plan(reserved_tokens=-1), InvalidWork),
    (make_plan(requires_approval='yes'), InvalidWork),
    (make_plan(expires_seconds=0), InvalidWork),
])
def test_invalid_plan_makes_no_claim_and_no_effect(fixture, monkeypatch, policy_value, error):
    async def check():
        service = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, service)
        current(monkeypatch, workflow_id)
        external = OwnedEffectService()
        policy = StaticPolicy(policy_value)
        with pytest.raises(error):
            await call(service, client, policy, external, TrustedVerifier(external))
        assert policy.requests  # the policy is consulted only after a successful binding
        assert external.applies == [] and external.lookups == []
        assert run_state(fixture, run_id)[0] == 0
        assert claim_rows(fixture, run_id) == []
    asyncio.run(check())


def test_throwing_policy_makes_no_claim_and_no_effect(fixture, monkeypatch):
    async def check():
        service = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, service)
        current(monkeypatch, workflow_id)
        external = OwnedEffectService()
        policy = StaticPolicy(error=RuntimeError('synthetic policy failure'))
        with pytest.raises(WorkConflict, match='action_plan_unavailable'):
            await call(service, client, policy, external, TrustedVerifier(external))
        assert policy.requests
        assert external.applies == []
        assert run_state(fixture, run_id)[0] == 0
        assert claim_rows(fixture, run_id) == []
    asyncio.run(check())


def test_pending_owner_approval_never_applies(fixture, monkeypatch):
    async def check():
        service = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, service)
        current(monkeypatch, workflow_id)
        external = OwnedEffectService()
        policy = StaticPolicy(make_plan(requires_approval=True))
        with pytest.raises(WorkConflict, match='action_not_authorized'):
            await call(service, client, policy, external, TrustedVerifier(external))
        assert external.applies == [] and external.lookups == []
        snap = await service.snapshot(fixture['token'], task_id)
        assert snap['actions'][0]['status'] == 'proposed'
        assert snap['actions'][0]['decision'] == 'pending'
        assert snap['attention'] == 'approval'
        assert snap['usage'] == {'tokenLimit': 10, 'reservedTokens': 0, 'spentTokens': 0}
    asyncio.run(check())


def test_retry_after_approval_uses_the_stable_policy_key(fixture, monkeypatch):
    async def check():
        service = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, service)
        current(monkeypatch, workflow_id)
        external = OwnedEffectService()
        policy = StaticPolicy(make_plan(requires_approval=True))
        with pytest.raises(WorkConflict, match='action_not_authorized'):
            await call(service, client, policy, external, TrustedVerifier(external))
        snap = await service.snapshot(fixture['token'], task_id)
        action = snap['actions'][0]
        assert action['decision'] == 'pending'
        await service.decide(fixture['token'], action['id'],
                             intent_digest=action['intentDigest'], approved=True)
        # A retry with a different tool call ID still addresses the same logical Action because
        # the trusted policy, not the model call ID, owns the stable key.
        retry_request = {**REQUEST, 'call_id': 'call-2'}
        result = await call(service, client, policy, external, TrustedVerifier(external),
                            request=retry_request)
        assert result.action_id == action['id']
        assert result.status == 'applied' and result.invoked_apply is True
        assert len(external.applies) == 1
        assert run_state(fixture, run_id) == (1, 'running')
        assert len(claim_rows(fixture, run_id)) == 1
        final = await service.snapshot(fixture['token'], task_id)
        assert final['actions'][0]['status'] == 'applied'
    asyncio.run(check())


def test_lost_response_then_retry_only_looks_up_and_never_reapplies(fixture, monkeypatch):
    async def check():
        service = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, service)
        current(monkeypatch, workflow_id, activity_id=ACTIVITY_ID)
        external = OwnedEffectService()
        external.lose_apply_response = True
        external.lookup_error = RuntimeError('synthetic lookup unavailable')
        policy = StaticPolicy(make_plan())
        first = await call(service, client, policy, external, TrustedVerifier(external))
        assert first.status == 'unknown' and first.invoked_apply is True
        assert len(external.applies) == 1 and len(external.lookups) == 1
        # The next Activity Execution in the same accepted Run gets a new Activity ID and fence;
        # the trusted policy keeps the same logical Action key, so no second apply is permitted.
        current(monkeypatch, workflow_id, activity_id='activity-2')
        external.lookup_error = None
        second = await call(service, client, policy, external, TrustedVerifier(external),
                            request={**REQUEST, 'call_id': 'call-2'})
        assert second.action_id == first.action_id
        assert second.invoked_apply is False and second.status == 'applied'
        assert len(external.applies) == 1
        assert external.lookups[-1] == first.action_id
        assert run_state(fixture, run_id) == (2, 'running')
        final = await service.snapshot(fixture['token'], task_id)
        assert final['actions'][0]['status'] == 'applied'
    asyncio.run(check())


def test_replay_after_admission_never_applies_again(fixture, monkeypatch):
    async def check():
        service = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, service)
        current(monkeypatch, workflow_id)
        external = OwnedEffectService()
        policy = StaticPolicy(make_plan())
        first = await call(service, client, policy, external, TrustedVerifier(external))
        assert first.status == 'applied' and len(external.applies) == 1
        second = await call(service, client, policy, external, TrustedVerifier(external),
                            request={**REQUEST, 'call_id': 'call-2'})
        assert second.action_id == first.action_id
        assert second.invoked_apply is False and second.status == 'applied'
        assert len(external.applies) == 1
        assert len(claim_rows(fixture, run_id)) == 1
    asyncio.run(check())


@pytest.mark.parametrize('close', ['cancel', 'revoke'])
def test_closed_task_fails_before_policy(fixture, monkeypatch, close):
    async def check():
        service = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, service)
        current(monkeypatch, workflow_id)
        await getattr(service, close)(fixture['token'], task_id)
        external = OwnedEffectService()
        policy = StaticPolicy(make_plan())
        with pytest.raises(WorkConflict, match='admission_closed'):
            await call(service, client, policy, external, TrustedVerifier(external))
        assert policy.requests == []
        assert external.applies == []
        assert run_state(fixture, run_id)[0] == 0
        assert claim_rows(fixture, run_id) == []
    asyncio.run(check())


@pytest.mark.parametrize('close', ['cancel', 'revoke'])
def test_closure_during_policy_mints_no_fence(fixture, monkeypatch, close):
    async def check():
        service = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, service)
        current(monkeypatch, workflow_id)

        class ClosingPolicy:
            async def plan(self, request):
                await getattr(service, close)(fixture['token'], task_id)
                return make_plan()

        external = OwnedEffectService()
        with pytest.raises(WorkConflict, match='admission_closed'):
            await call(service, client, ClosingPolicy(), external, TrustedVerifier(external))
        assert external.applies == []
        assert run_state(fixture, run_id)[0] == 0
        assert claim_rows(fixture, run_id) == []
    asyncio.run(check())
