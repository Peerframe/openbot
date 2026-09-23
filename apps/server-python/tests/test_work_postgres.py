"""Work authority and recovery facts against the owned PostgreSQL fixture, without a dispatcher."""
import asyncio
import hashlib
from uuid import uuid4

from fastapi.testclient import TestClient
import psycopg
import pytest

from openbot_server.app import create_app
from openbot_server.authority import AuthenticationRequired
from openbot_server.database import PostgresReadStore, StoreUnavailable
from openbot_server.work_models import WorkSnapshot
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_values import InvalidWork, WorkConflict


def store(fixture):
    return PostgresWorkStore(fixture['dsn'])


def submission(fixture, **overrides):
    return dict(bot_id=fixture['expected']['/api/v1/bots']['bots'][0]['id'],
                objective='Correct the synthetic CSV and verify the result', token_limit=10,
                request_key=str(uuid4()), **overrides)


async def new(fixture, service, limit=10):
    args = submission(fixture)
    args['token_limit'] = limit
    return await service.create(fixture['token'], **args)


async def action(service, task, key='write', amount=6, approval=False):
    return await service.propose(task['id'], task['runs'][0]['id'], action_key=key,
        intent={'operation': 'fixture.record.update', 'record': 'row-1', 'value': key},
        reserved_tokens=amount, requires_approval=approval)


def evidence(label='fixture-receipt'):
    return {'source': 'owned-fixture', 'reference': label, 'sha256': hashlib.sha256(label.encode()).hexdigest()}


def test_concurrent_submission_is_one_task_run_and_handoff_and_no_chat_write(fixture):
    async def check():
        service = store(fixture); args = submission(fixture)
        first, second = await asyncio.gather(service.create(fixture['token'], **args),
                                             service.create(fixture['token'], **args))
        assert first == second
        assert first['status'] == 'queued' and first['runs'][0]['status'] == 'queued'
        assert first['revision'] == 1 and first['usage']['reservedTokens'] == 0
        WorkSnapshot.model_validate(first)
        with pytest.raises(WorkConflict, match='idempotency_content_changed'):
            await service.create(fixture['token'], **{**args, 'objective': 'changed'})
        with psycopg.connect(fixture['dsn']) as db:
            assert db.execute('SELECT count(*) FROM work_runs WHERE task_id=%s', (first['id'],)).fetchone()[0] == 1
            assert db.execute('SELECT state FROM work_admissions WHERE run_id=%s', (first['runs'][0]['id'],)).fetchone() == ('pending',)
            assert db.execute('SELECT count(*) FROM runs WHERE id=%s', (first['runs'][0]['id'],)).fetchone()[0] == 0
            assert db.execute('SELECT count(*) FROM work_events WHERE task_id=%s', (first['id'],)).fetchone()[0] == 1
    asyncio.run(check())


def test_task_handoff_failure_rolls_back_identity_and_idempotency_key(fixture):
    service = store(fixture); args = submission(fixture)
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("CREATE FUNCTION work_test_reject_handoff() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private'; END $$")
        db.execute('CREATE TRIGGER work_test_reject_handoff BEFORE INSERT ON work_admissions FOR EACH ROW EXECUTE FUNCTION work_test_reject_handoff()')
    try:
        with pytest.raises(StoreUnavailable):
            asyncio.run(service.create(fixture['token'], **args))
        with psycopg.connect(fixture['dsn']) as db:
            assert db.execute('SELECT count(*) FROM work_tasks WHERE request_key=%s', (args['request_key'],)).fetchone()[0] == 0
    finally:
        with psycopg.connect(fixture['dsn']) as db:
            db.execute('DROP TRIGGER work_test_reject_handoff ON work_admissions')
            db.execute('DROP FUNCTION work_test_reject_handoff()')
    assert asyncio.run(service.create(fixture['token'], **args))['status'] == 'queued'


def test_exact_approval_is_idempotent_and_conflicting_decisions_cannot_both_commit(fixture):
    async def check():
        service = store(fixture); task = await new(fixture, service)
        identity = await action(service, task, approval=True)
        snap = await service.snapshot(fixture['token'], task['id']); digest = snap['actions'][0]['intentDigest']
        with pytest.raises(WorkConflict):
            await service.admit(identity)
        with pytest.raises(WorkConflict, match='approval_stale'):
            await service.decide(fixture['token'], identity, intent_digest='0'*64, approved=True)
        decisions = await asyncio.gather(*(service.decide(fixture['token'], identity, intent_digest=digest, approved=v)
                                           for v in (True, False)), return_exceptions=True)
        assert sum(isinstance(v, dict) for v in decisions) == 1
        assert sum(isinstance(v, WorkConflict) for v in decisions) == 1
        snap = await service.snapshot(fixture['token'], task['id'])
        approved = snap['actions'][0]['decision'] == 'approved'
        assert await service.decide(fixture['token'], identity, intent_digest=digest, approved=approved) == snap
        with pytest.raises(WorkConflict, match='action_content_changed'):
            await service.propose(task['id'], task['runs'][0]['id'], action_key='write', intent={'different':True}, reserved_tokens=6)
    asyncio.run(check())


def test_expired_or_revoked_approval_cannot_admit(fixture):
    async def check():
        service = store(fixture)
        for mode in ('expired', 'revoked'):
            task = await new(fixture, service); identity = await action(service, task, approval=True)
            snap = await service.snapshot(fixture['token'], task['id'])
            await service.decide(fixture['token'], identity, intent_digest=snap['actions'][0]['intentDigest'], approved=True)
            if mode == 'expired':
                with psycopg.connect(fixture['dsn']) as db:
                    db.execute("UPDATE work_actions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=%s", (identity,))
            else:
                await service.revoke(fixture['token'], task['id'])
            with pytest.raises(WorkConflict):
                await service.admit(identity)
            assert (await service.snapshot(fixture['token'], task['id']))['usage']['reservedTokens'] == 0
    asyncio.run(check())


def test_sibling_runs_share_reservations_and_unknown_billing_does_not_refund(fixture):
    async def check():
        service = store(fixture); task = await new(fixture, service)
        first = await action(service, task)
        # A second trusted Run fixture exercises Task-scoped budget locking, not just one Run.
        run_id = str(uuid4())
        with psycopg.connect(fixture['dsn']) as db:
            db.execute('INSERT INTO work_runs(id,task_id,ordinal) VALUES (%s,%s,2)', (run_id, task['id']))
        second = await service.propose(task['id'], run_id, action_key='sibling', intent={'record':'row-2'},
                                       reserved_tokens=6, requires_approval=False)
        outcomes = await asyncio.gather(service.admit(first), service.admit(second), return_exceptions=True)
        assert outcomes.count(True) == 1
        assert sum(isinstance(v, WorkConflict) for v in outcomes) == 1
        admitted, waiting = (first, second) if outcomes[0] is True else (second, first)
        assert await service.admit(admitted) is False
        await service.uncertain(admitted)
        snap = await service.snapshot(fixture['token'], task['id'])
        assert snap['attention'] == 'reconciliation' and snap['usage']['reservedTokens'] == 6
        with pytest.raises(WorkConflict, match='token_budget_exhausted'):
            await service.admit(waiting)
        await service.resolve(admitted, applied=False, actual_tokens=2, evidence=evidence())
        assert await service.admit(waiting) is True
        snap = await service.snapshot(fixture['token'], task['id'])
        assert snap['usage'] == {'tokenLimit':10, 'reservedTokens':6, 'spentTokens':2}
    asyncio.run(check())


def test_cancel_retains_unknown_outcome_until_reconciliation_without_regranting(fixture):
    async def check():
        service = store(fixture); task = await new(fixture, service); identity = await action(service, task)
        assert await service.admit(identity)
        snap = await service.cancel(fixture['token'], task['id'])
        assert snap['cancelRequested'] and not snap['authorityActive']
        assert snap['status'] == 'open' and snap['attention'] == 'reconciliation'
        assert snap['usage']['reservedTokens'] == 6
        with pytest.raises(WorkConflict, match='admission_closed'):
            await service.admit(identity)
        await service.uncertain(identity)
        resolved = await service.resolve(identity, applied=True, actual_tokens=4, evidence=evidence())
        assert resolved['status'] == 'cancelled' and resolved['actions'][0]['status'] == 'applied'
        assert resolved['usage'] == {'tokenLimit':10,'reservedTokens':0,'spentTokens':4}
        assert await service.resolve(identity, applied=True, actual_tokens=4, evidence=evidence()) == resolved
        with pytest.raises(WorkConflict, match='outcome_already_recorded'):
            await service.resolve(identity, applied=False, actual_tokens=0, evidence=evidence('changed'))
    asyncio.run(check())


def test_usage_overrun_is_recorded_as_truth_and_blocks_fresh_admission(fixture):
    async def check():
        service = store(fixture); task = await new(fixture, service); identity = await action(service, task)
        await service.admit(identity)
        snap = await service.resolve(identity, applied=True, actual_tokens=11, evidence=evidence())
        assert snap['usage']['spentTokens'] == 11 and snap['attention'] == 'budget'
        later = await action(service, task, 'later', amount=0)
        with pytest.raises(WorkConflict, match='token_budget_exhausted'):
            await service.admit(later)
    asyncio.run(check())


@pytest.mark.parametrize('kind', ['action.admitted', 'action.resolved'])
def test_audit_failure_cannot_leave_a_partial_reservation_or_resolution(fixture, kind):
    async def setup():
        service = store(fixture); task = await new(fixture, service); identity = await action(service, task)
        if kind == 'action.resolved':
            await service.admit(identity); await service.uncertain(identity)
        return service, task, identity
    service, task, identity = asyncio.run(setup())
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("CREATE FUNCTION work_test_reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
                   "IF NEW.kind = TG_ARGV[0] THEN RAISE EXCEPTION 'private'; END IF; RETURN NEW; END $$")
        # Trigger argument is one of the two literals in the parameterization, never user text.
        db.execute("CREATE TRIGGER work_test_reject_event BEFORE INSERT ON work_events FOR EACH ROW "
                   "EXECUTE FUNCTION work_test_reject_event('"+kind+"')")
    try:
        with pytest.raises(StoreUnavailable):
            asyncio.run(service.admit(identity) if kind == 'action.admitted' else
                        service.resolve(identity, applied=True, actual_tokens=4, evidence=evidence()))
        snap = asyncio.run(service.snapshot(fixture['token'], task['id']))
        assert snap['actions'][0]['status'] == ('proposed' if kind == 'action.admitted' else 'unknown')
        assert snap['usage']['reservedTokens'] == (0 if kind == 'action.admitted' else 6)
        assert snap['usage']['spentTokens'] == 0
    finally:
        with psycopg.connect(fixture['dsn']) as db:
            db.execute('DROP TRIGGER work_test_reject_event ON work_events'); db.execute('DROP FUNCTION work_test_reject_event()')


def test_public_api_auth_exact_decision_and_reconnect_projection(fixture):
    service = store(fixture)
    def app():
        return create_app(PostgresReadStore(fixture['dsn']), owner_name=fixture['ownerName'],
                          secure_cookies=False, allowed_origins=('http://control.test',), work=service)
    with TestClient(app(), base_url='http://control.test') as client:
        client.headers['Origin'] = 'http://control.test'; client.cookies.set('openbot_session', fixture['token'])
        body = {'botId':submission(fixture)['bot_id'], 'objective':'A durable task without a channel', 'tokenLimit':10,'requestKey':str(uuid4())}
        assert client.post('/api/v1/tasks', json={**body,'grant':True}).status_code == 422
        response = client.post('/api/v1/tasks', json=body)
        assert response.status_code == 202, response.text
        task = response.json(); identity = asyncio.run(action(service, task, approval=True))
        snap = client.get('/api/v1/tasks/'+task['id']).json()
        assert snap['attention'] == 'approval'
        approved = client.post(f'/api/v1/actions/{identity}/decision', json={'intentDigest':snap['actions'][0]['intentDigest'],'approved':True})
        assert approved.status_code == 200
        revision = approved.json()['revision']
        assert client.post(f'/api/v1/actions/{identity}/resolve', json={'applied':True}).status_code == 405
        assert client.post('/api/v1/tasks', json=body, headers={'Origin':'https://foreign.test'}).status_code == 403
        security = client.get('/openapi.json').json()['paths']['/api/v1/tasks']['post']['security']
        assert security == [{'OwnerSession':[]}]
        assert client.get('/health').json()['phase'] == 's3-work-admission-reference'
    # Closing the first client has no lifecycle effect. A new app reads the same committed view.
    with TestClient(app(), base_url='http://control.test') as client:
        assert client.get('/api/v1/tasks/'+task['id']).status_code == 401
        client.cookies.set('openbot_session', fixture['token'])
        reopened = client.get('/api/v1/tasks/'+task['id']).json()
        assert reopened['revision'] == revision and reopened['actions'][0]['decision'] == 'approved'
        assert client.post('/api/v1/tasks/'+task['id']+'/cancel', json={}, headers={'Origin':'http://control.test'}).json()['status'] == 'cancelled'
