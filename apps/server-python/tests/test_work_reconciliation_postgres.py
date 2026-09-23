"""Owner reconciliation commands against owned PostgreSQL; commands never grant execution."""
import asyncio
from contextlib import contextmanager
import hashlib
from uuid import uuid4

import psycopg
import pytest

from openbot_server.authority import AuthenticationRequired
from openbot_server.database import StoreUnavailable
from openbot_server.work_reconciliation import ReconciliationStore
from openbot_server.work_values import InvalidWork, WorkConflict
from test_auth_postgres import authentication
from test_work_postgres import action, admit, evidence, new, store


async def prepared(fixture, state='unknown'):
    service = store(fixture)
    task = await new(fixture, service)
    identity = await action(service, task)
    if state != 'proposed':
        await admit(service, identity)
    if state == 'unknown':
        await service.uncertain(identity)
    elif state in ('applied', 'not_applied'):
        await service.resolve(identity, applied=state == 'applied', actual_tokens=2, evidence=evidence())
    snapshot = await service.snapshot(fixture['token'], task['id'])
    return service, ReconciliationStore(service), snapshot, snapshot['actions'][0]


def arguments(value, **changes):
    result = dict(intent_digest=value['intentDigest'], request_key=str(uuid4()), expected_sequence=0,
                  reason='Look up the existing owned-service receipt')
    result.update(changes)
    return result


def scope(task, value):
    return dict(task_id=task['id'], run_id=value['runId'], action_id=value['id'])


def authority_facts(fixture, task_id):
    """Exclude only revisions/events and commands; every execution and billing fact stays fixed."""
    with psycopg.connect(fixture['dsn']) as db:
        task = db.execute('SELECT status,authority_active,cancel_requested,authority_generation,token_limit '
                          'FROM work_tasks WHERE id=%s', (task_id,)).fetchone()
        runs = db.execute('SELECT id,status,execution_epoch FROM work_runs WHERE task_id=%s ORDER BY id',
                          (task_id,)).fetchall()
        claims = db.execute('SELECT c.run_id,c.claim_id,c.epoch,c.expires_at FROM work_claims c '
                            'JOIN work_runs r ON r.id=c.run_id WHERE r.task_id=%s ORDER BY c.run_id,c.epoch',
                            (task_id,)).fetchall()
        actions = db.execute('SELECT id,status,decision,authority_generation,reserved_tokens,actual_tokens,evidence '
                             'FROM work_actions WHERE task_id=%s ORDER BY id', (task_id,)).fetchall()
    return task, runs, claims, actions


@contextmanager
def rejecting_audit(fixture):
    with psycopg.connect(fixture['dsn']) as db:
        db.execute('CREATE FUNCTION work_reconciliation_test_reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ '
                   "BEGIN RAISE EXCEPTION 'synthetic reconciliation audit failure'; END $$")
        db.execute('CREATE TRIGGER work_reconciliation_test_reject_event BEFORE INSERT ON work_events '
                   'FOR EACH ROW EXECUTE FUNCTION work_reconciliation_test_reject_event()')
    try:
        yield
    finally:
        with psycopg.connect(fixture['dsn']) as db:
            db.execute('DROP TRIGGER work_reconciliation_test_reject_event ON work_events')
            db.execute('DROP FUNCTION work_reconciliation_test_reject_event()')


def test_parallel_new_keys_coalesce_and_every_key_keeps_its_immutable_payload(fixture):
    async def check():
        service, commands, task, value = await prepared(fixture)
        before = authority_facts(fixture, task['id'])
        requests = [arguments(value) for _ in range(4)]
        results = await asyncio.gather(*(ReconciliationStore(store(fixture)).request(
            fixture['token'], value['id'], **request) for request in requests))
        command = results[0]
        assert all(result == command for result in results)
        assert set(command) == {'id', 'actionId', 'sequence', 'requestedBy', 'reason', 'createdAt', 'delivered', 'outcome'}
        assert command['actionId'] == value['id'] and command['sequence'] == 1
        assert command['requestedBy'] == 'owner' and command['reason'] == requests[0]['reason']
        assert isinstance(command['createdAt'], str) and command['createdAt']
        assert command['delivered'] is False and command['outcome'] is None
        for request in requests:
            assert await commands.request(fixture['token'], value['id'], **request) == command
            for changed in ({'reason': 'Changed reason'}, {'expected_sequence': 1}, {'intent_digest': '0' * 64}):
                with pytest.raises(WorkConflict):
                    await commands.request(fixture['token'], value['id'], **{**request, **changed})
        assert await commands.request(fixture['token'], value['id'], **arguments(value, expected_sequence=1)) == command
        snapshot = await service.snapshot(fixture['token'], task['id'])
        assert snapshot['actions'][0]['reconciliation'] == command
        assert snapshot['revision'] == task['revision'] + 1
        assert authority_facts(fixture, task['id']) == before
        await commands.finish(command['id'], **scope(task, value), outcome='unresolved')
    asyncio.run(check())


def test_global_request_key_cannot_bind_two_actions_even_under_concurrent_inserts(fixture):
    async def check():
        first = await prepared(fixture)
        second = await prepared(fixture)
        key = str(uuid4())
        requests = [arguments(item[3], request_key=key) for item in (first, second)]
        outcomes = await asyncio.gather(*(item[1].request(fixture['token'], item[3]['id'], **request)
            for item, request in zip((first, second), requests)), return_exceptions=True)
        assert sum(isinstance(result, dict) for result in outcomes) == 1
        assert sum(isinstance(result, WorkConflict) for result in outcomes) == 1
        winner = next(index for index, result in enumerate(outcomes) if isinstance(result, dict))
        for index, (service, commands, task, value) in enumerate((first, second)):
            snapshot = await service.snapshot(fixture['token'], task['id'])
            assert snapshot['actions'][0]['reconciliation'] == (outcomes[index] if index == winner else None)
            assert snapshot['usage'] == task['usage']
        _, commands, task, value = (first, second)[winner]
        await commands.finish(outcomes[winner]['id'], **scope(task, value), outcome='unresolved')
    asyncio.run(check())


def test_finished_cycle_requires_current_sequence_and_old_keys_never_open_another_cycle(fixture):
    async def check():
        service, commands, task, value = await prepared(fixture)
        original = arguments(value)
        coalesced = arguments(value)
        first = await commands.request(fixture['token'], value['id'], **original)
        assert await commands.request(fixture['token'], value['id'], **coalesced) == first
        finished = await commands.finish(first['id'], **scope(task, value), outcome='unresolved')
        with pytest.raises(WorkConflict):
            await commands.request(fixture['token'], value['id'], **arguments(value))
        second = await commands.request(fixture['token'], value['id'], **arguments(value, expected_sequence=1))
        assert second['sequence'] == 2 and second['id'] != first['id']
        for request in (original, coalesced):
            assert await commands.request(fixture['token'], value['id'], **request) == finished
        with pytest.raises(WorkConflict):
            await commands.request(fixture['token'], value['id'], **arguments(value, expected_sequence=0))
        with pytest.raises(WorkConflict):
            await commands.request(fixture['token'], value['id'], **arguments(value, expected_sequence=3))
        assert (await service.snapshot(fixture['token'], task['id']))['actions'][0]['reconciliation'] == second
        await commands.finish(second['id'], **scope(task, value), outcome='unresolved')
    asyncio.run(check())


@pytest.mark.parametrize('state', ['proposed', 'admitted', 'applied', 'not_applied'])
def test_new_request_requires_unknown_action(fixture, state):
    async def check():
        service, commands, task, value = await prepared(fixture, state)
        with pytest.raises(WorkConflict):
            await commands.request(fixture['token'], value['id'], **arguments(value))
        assert await service.snapshot(fixture['token'], task['id']) == task
    asyncio.run(check())


@pytest.mark.parametrize('applied', [True, False])
def test_resolution_finish_late_delivery_and_original_request_retry_are_independent(fixture, applied):
    async def check():
        service, commands, task, value = await prepared(fixture)
        request = arguments(value)
        command = await commands.request(fixture['token'], value['id'], **request)
        coalesced = arguments(value)
        assert await commands.request(fixture['token'], value['id'], **coalesced) == command
        with pytest.raises(WorkConflict):
            await commands.finish(command['id'], **scope(task, value), outcome='resolved')
        resolved = await service.resolve(value['id'], applied=applied, actual_tokens=3, evidence=evidence())
        assert resolved['actions'][0]['reconciliation']['outcome'] == 'resolved'
        assert len([e for e in resolved['events'] if e['kind']=='reconciliation.finished']) == 1
        with pytest.raises(WorkConflict):
            await commands.finish(command['id'], **scope(task, value), outcome='unresolved')
        finished = await commands.finish(command['id'], **scope(task, value), outcome='resolved')
        assert finished['outcome'] == 'resolved' and finished['delivered'] is False
        assert await commands.finish(command['id'], **scope(task, value), outcome='resolved') == finished
        assert await commands.request(fixture['token'], value['id'], **request) == finished
        assert await commands.request(fixture['token'], value['id'], **coalesced) == finished
        assert all(row['commandId'] != command['id'] for row in await commands.pending())
        with pytest.raises(WorkConflict):
            await commands.request(fixture['token'], value['id'], **arguments(value, expected_sequence=1))
        reference = 'temporal:default:owned-workflow:owned-run'
        assert await commands.acknowledge(command['id'], reference) is True
        assert await commands.acknowledge(command['id'], reference) is False
        with pytest.raises(WorkConflict):
            await commands.acknowledge(command['id'], reference + '-different')
        snapshot = await service.snapshot(fixture['token'], task['id'])
        final = snapshot['actions'][0]['reconciliation']
        assert final == {**finished, 'delivered': True}
        assert await commands.request(fixture['token'], value['id'], **request) == final
        assert await commands.request(fixture['token'], value['id'], **coalesced) == final
        assert snapshot['actions'][0]['status'] == ('applied' if applied else 'not_applied')
        assert snapshot['usage'] == {'tokenLimit': 10, 'reservedTokens': 0, 'spentTokens': 3}
    asyncio.run(check())


def test_delivery_is_durable_bounded_and_does_not_finish_or_mutate_authority(fixture):
    async def check():
        service, commands, task, value = await prepared(fixture)
        before = authority_facts(fixture, task['id'])
        command = await commands.request(fixture['token'], value['id'], **arguments(value))
        expected = {'commandId': command['id'], 'taskId': task['id'], 'runId': value['runId'], 'actionId': value['id']}
        restarted = ReconciliationStore(store(fixture))
        pending = await restarted.pending()
        assert expected in pending
        assert len(await restarted.pending(limit=1)) == 1
        assert await restarted.pending(limit=1) == pending[:1]
        assert await restarted.acknowledge(command['id'], 'owned-engine-run') is True
        assert await commands.acknowledge(command['id'], 'owned-engine-run') is False
        assert expected in await restarted.pending()  # Accepted hints can be lost by engine restore.
        snapshot = await service.snapshot(fixture['token'], task['id'])
        assert snapshot['actions'][0]['reconciliation'] == {**command, 'delivered': True}
        assert authority_facts(fixture, task['id']) == before
        finished = await restarted.finish(command['id'], **scope(task, value), outcome='unresolved')
        assert finished['outcome'] == 'unresolved'
        assert await commands.finish(command['id'], **scope(task, value), outcome='unresolved') == finished
        with pytest.raises(WorkConflict):
            await commands.finish(command['id'], **scope(task, value), outcome='resolved')
        assert authority_facts(fixture, task['id']) == before
    asyncio.run(check())


@pytest.mark.parametrize('field', ['task_id', 'run_id', 'action_id'])
def test_read_and_finish_reject_wrong_scope_even_for_finished_replay(fixture, field):
    async def check():
        _, commands, task, value = await prepared(fixture)
        command = await commands.request(fixture['token'], value['id'], **arguments(value))
        correct = scope(task, value)
        wrong = {**correct, field: str(uuid4())}
        assert (await commands.read(command['id'], **correct))['id'] == command['id']
        with pytest.raises(WorkConflict):
            await commands.read(command['id'], **wrong)
        with pytest.raises(WorkConflict):
            await commands.finish(command['id'], **wrong, outcome='unresolved')
        await commands.finish(command['id'], **correct, outcome='unresolved')
        with pytest.raises(WorkConflict):
            await commands.finish(command['id'], **wrong, outcome='unresolved')
    asyncio.run(check())


@pytest.mark.parametrize('restriction', ['cancel', 'revoke'])
def test_repair_after_cancel_or_revoke_does_not_regrant_or_refund_unknown_work(fixture, restriction):
    async def check():
        service, commands, task, value = await prepared(fixture)
        await getattr(service, restriction)(fixture['token'], task['id'])
        with psycopg.connect(fixture['dsn']) as db:
            db.execute("UPDATE work_claims SET expires_at=clock_timestamp()-interval '1 second' WHERE run_id=%s", (value['runId'],))
            db.execute("UPDATE work_actions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=%s", (value['id'],))
        before = authority_facts(fixture, task['id'])
        first = await commands.request(fixture['token'], value['id'], **arguments(value))
        assert await commands.acknowledge(first['id'], 'owned-engine-run') is True
        unfinished = await commands.finish(first['id'], **scope(task, value), outcome='unresolved')
        assert authority_facts(fixture, task['id']) == before
        second = await commands.request(fixture['token'], value['id'], **arguments(value, expected_sequence=1))
        assert authority_facts(fixture, task['id']) == before
        await service.resolve(value['id'], applied=True, actual_tokens=3, evidence=evidence())
        # Replaying a finished lookup records no new outcome, even after independent resolution.
        assert await commands.finish(first['id'], **scope(task, value), outcome='unresolved') == unfinished
        await commands.finish(second['id'], **scope(task, value), outcome='resolved')
        snapshot = await service.snapshot(fixture['token'], task['id'])
        assert not snapshot['authorityActive'] and snapshot['cancelRequested'] == (restriction == 'cancel')
        assert snapshot['usage'] == {'tokenLimit': 10, 'reservedTokens': 0, 'spentTokens': 3}
        assert snapshot['status'] == ('cancelled' if restriction == 'cancel' else 'open')
    asyncio.run(check())


@pytest.mark.parametrize('operation', ['request', 'acknowledge', 'finish'])
def test_audit_failure_rolls_back_command_delivery_finish_and_revision(fixture, operation):
    async def check():
        service, commands, task, value = await prepared(fixture)
        request = arguments(value)
        command = None if operation == 'request' else await commands.request(fixture['token'], value['id'], **request)
        before = await service.snapshot(fixture['token'], task['id'])
        facts = authority_facts(fixture, task['id'])
        async def invoke():
            if operation == 'request':
                return await commands.request(fixture['token'], value['id'], **request)
            if operation == 'acknowledge':
                return await commands.acknowledge(command['id'], 'owned-engine-run')
            return await commands.finish(command['id'], **scope(task, value), outcome='unresolved')
        with rejecting_audit(fixture):
            with pytest.raises(StoreUnavailable):
                await invoke()
        assert await service.snapshot(fixture['token'], task['id']) == before
        assert authority_facts(fixture, task['id']) == facts
        result = await invoke()
        if operation == 'request':
            command = result
            assert command['sequence'] == 1
        elif operation == 'acknowledge':
            assert result is True
        if operation != 'finish':
            await commands.finish(command['id'], **scope(task, value), outcome='unresolved')
    asyncio.run(check())


@pytest.mark.parametrize('change', ["revoked_at=clock_timestamp()", "expires_at=clock_timestamp()-interval '1 second'"])
def test_revoked_or_expired_owner_cannot_retry_an_existing_key(fixture, change):
    async def check():
        service, commands, task, value = await prepared(fixture)
        issued = await authentication(fixture).login(fixture['ownerPassword'], '192.0.2.91')
        request = arguments(value)
        command = await commands.request(issued.token, value['id'], **request)
        before = await service.snapshot(fixture['token'], task['id'])
        digest = hashlib.sha256(issued.token.encode()).hexdigest()
        with psycopg.connect(fixture['dsn']) as db:
            db.execute('UPDATE auth_sessions SET ' + change + ' WHERE token_digest=%s', (digest,))
        with pytest.raises(AuthenticationRequired):
            await commands.request(issued.token, value['id'], **request)
        assert await service.snapshot(fixture['token'], task['id']) == before
        await commands.finish(command['id'], **scope(task, value), outcome='unresolved')
    asyncio.run(check())


async def wait_for_owner_lock(observer, relation):
    for _ in range(70):
        cursor = await observer.execute("SELECT count(*) FROM pg_stat_activity WHERE application_name='openbot-work-owner' "
                                        "AND wait_event_type='Lock' AND query LIKE %s", ('%' + relation + '%',))
        if (await cursor.fetchone())[0]:
            return
        await asyncio.sleep(0.01)
    pytest.fail('Reconciliation request did not reach the expected authority lock')


@pytest.mark.parametrize('change', ['expire', 'revoke'])
def test_owner_change_during_lock_contention_cannot_commit_a_command(fixture, change):
    async def check():
        service, commands, task, value = await prepared(fixture)
        issued = await authentication(fixture).login(fixture['ownerPassword'], '192.0.2.92')
        digest = hashlib.sha256(issued.token.encode()).hexdigest()
        request = arguments(value)
        async with await psycopg.AsyncConnection.connect(fixture['dsn'], autocommit=True) as observer:
            if change == 'expire':
                await observer.execute("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '400 milliseconds' "
                                       'WHERE token_digest=%s', (digest,))
            async with await psycopg.AsyncConnection.connect(fixture['dsn']) as blocker:
                if change == 'expire':
                    await blocker.execute('SELECT id FROM work_tasks WHERE id=%s FOR UPDATE', (task['id'],))
                else:
                    await blocker.execute('SELECT id FROM auth_sessions WHERE token_digest=%s FOR UPDATE', (digest,))
                pending = asyncio.create_task(commands.request(issued.token, value['id'], **request))
                try:
                    await wait_for_owner_lock(observer, 'work_tasks' if change == 'expire' else 'auth_sessions')
                    if change == 'expire':
                        for _ in range(70):
                            cursor = await observer.execute('SELECT expires_at<=clock_timestamp() FROM auth_sessions '
                                                            'WHERE token_digest=%s', (digest,))
                            if (await cursor.fetchone())[0]:
                                break
                            await asyncio.sleep(0.01)
                        else:
                            pytest.fail('Synthetic Owner session did not expire')
                    else:
                        await blocker.execute('UPDATE auth_sessions SET revoked_at=clock_timestamp() '
                                              'WHERE token_digest=%s', (digest,))
                    await blocker.commit()
                    with pytest.raises(AuthenticationRequired):
                        await pending
                finally:
                    if not pending.done():
                        pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)
        assert await service.snapshot(fixture['token'], task['id']) == task
        command = await commands.request(fixture['token'], value['id'], **request)
        assert command['sequence'] == 1
        await commands.finish(command['id'], **scope(task, value), outcome='unresolved')
    asyncio.run(check())


@pytest.mark.parametrize('changes', [
    {'intent_digest': 'A' * 64}, {'intent_digest': '0' * 63}, {'intent_digest': 'g' * 64},
    {'request_key': ''}, {'request_key': ' '}, {'request_key': 'a\x00b'}, {'request_key': 'é' * 65},
    {'reason': ''}, {'reason': ' '}, {'reason': 'a\x00b'}, {'reason': 'é' * 257},
    {'expected_sequence': True}, {'expected_sequence': False}, {'expected_sequence': 0.0},
    {'expected_sequence': '0'}, {'expected_sequence': -1}, {'expected_sequence': 65},
])
def test_request_input_is_bounded_before_action_lookup(fixture, changes):
    async def check():
        commands = ReconciliationStore(store(fixture))
        with pytest.raises(InvalidWork):
            await commands.request(fixture['token'], str(uuid4()), **arguments({'intentDigest': '0' * 64}, **changes))
    asyncio.run(check())


def test_exact_utf8_bounds_are_accepted_and_unknown_digest_is_not_authority(fixture):
    async def check():
        service, commands, task, value = await prepared(fixture)
        with pytest.raises(WorkConflict):
            await commands.request(fixture['token'], value['id'], **arguments(value, intent_digest='0' * 64))
        assert await service.snapshot(fixture['token'], task['id']) == task
        command = await commands.request(fixture['token'], value['id'], **arguments(
            value, request_key='é' * 48 + uuid4().hex, reason='é' * 256))
        assert command['reason'] == 'é' * 256
        await commands.finish(command['id'], **scope(task, value), outcome='unresolved')
    asyncio.run(check())


def test_sixty_four_unresolved_cycles_preserve_reservation_and_refuse_cycle_sixty_five(fixture):
    async def check():
        service, commands, task, value = await prepared(fixture)
        before = authority_facts(fixture, task['id'])
        for previous in range(64):
            command = await commands.request(fixture['token'], value['id'], **arguments(value, expected_sequence=previous))
            assert command['sequence'] == previous + 1
            await commands.finish(command['id'], **scope(task, value), outcome='unresolved')
        with pytest.raises(WorkConflict):
            await commands.request(fixture['token'], value['id'], **arguments(value, expected_sequence=64))
        snapshot = await service.snapshot(fixture['token'], task['id'])
        assert snapshot['actions'][0]['reconciliation']['sequence'] == 64
        assert snapshot['actions'][0]['reconciliation']['outcome'] == 'unresolved'
        assert snapshot['usage'] == task['usage']
        assert authority_facts(fixture, task['id']) == before
    asyncio.run(check())


def test_public_repair_requires_owner_origin_and_never_accepts_asserted_outcomes(fixture):
    from fastapi.testclient import TestClient
    from openbot_server.app import create_app
    from openbot_server.database import PostgresReadStore
    service, commands, task, value = asyncio.run(prepared(fixture))
    app = create_app(PostgresReadStore(fixture['dsn']), owner_name=fixture['ownerName'],
                     secure_cookies=False, allowed_origins=('http://control.test',), work=service)
    path = '/api/v1/actions/' + value['id'] + '/reconcile'
    body = {'intentDigest': value['intentDigest'], 'requestKey': str(uuid4()),
            'expectedSequence': 0, 'reason': 'Human assertion: nothing happened and cost was zero'}
    before = authority_facts(fixture, task['id'])
    with TestClient(app, base_url='http://control.test') as client:
        client.headers['Origin'] = 'http://control.test'
        assert client.post(path, json=body).status_code == 401
        client.cookies.set('openbot_session', fixture['token'])
        assert client.post(path, json=body, headers={'Origin':'https://foreign.test'}).status_code == 403
        for addition in ({'applied':False}, {'actualTokens':0}, {'evidence':evidence()},
                         {'requestedBy':'owner'}, {'expectedSequence':True}):
            assert client.post(path, json={**body, **addition}).status_code == 422
        assert client.get('/api/v1/tasks/' + task['id']).json() == task
        response = client.post(path, json=body)
        assert response.status_code == 202, response.text
        command = response.json()
        assert command['reason'] == body['reason'] and command['outcome'] is None
        snapshot = client.get('/api/v1/tasks/' + task['id']).json()
        assert snapshot['actions'][0]['reconciliation'] == command
        assert snapshot['actions'][0]['status'] == 'unknown' and snapshot['usage'] == task['usage']
        assert authority_facts(fixture, task['id']) == before
        assert client.get('/openapi.json').json()['paths']['/api/v1/actions/{action_id}/reconcile']['post']['security'] == [{'OwnerSession':[]}]
        asyncio.run(commands.finish(command['id'], **scope(task, value), outcome='unresolved'))


def test_automatic_resolution_races_owner_requests_without_stranding_command(fixture):
    async def check():
        service, commands, task, value = await prepared(fixture)
        results = await asyncio.gather(
            service.resolve(value['id'], applied=True, actual_tokens=3, evidence=evidence()),
            *(commands.request(fixture['token'], value['id'], **arguments(value)) for _ in range(4)),
            return_exceptions=True)
        assert not isinstance(results[0], BaseException)
        assert all(not isinstance(r, BaseException) or isinstance(r, WorkConflict) for r in results)
        final = await service.snapshot(fixture['token'], task['id'])
        command = final['actions'][0]['reconciliation']
        assert command is None or command['outcome']=='resolved'
        assert all(r['actionId']!=value['id'] for r in await commands.pending())
        assert final['usage']=={'tokenLimit':10,'reservedTokens':0,'spentTokens':3}
        assert len([e for e in final['events'] if e['kind']=='action.resolved'])==1
    asyncio.run(check())


def test_resolution_and_command_finish_roll_back_together_on_audit_failure(fixture):
    async def check():
        service, commands, task, value = await prepared(fixture)
        await commands.request(fixture['token'], value['id'], **arguments(value))
        before = await service.snapshot(fixture['token'], task['id'])
        with rejecting_audit(fixture), pytest.raises(StoreUnavailable):
            await service.resolve(value['id'], applied=True, actual_tokens=3, evidence=evidence())
        assert await service.snapshot(fixture['token'], task['id'])==before
        final = await service.resolve(value['id'], applied=True, actual_tokens=3, evidence=evidence())
        assert final['actions'][0]['reconciliation']['outcome']=='resolved'
    asyncio.run(check())
