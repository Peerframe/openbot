"""Engine acceptance facts against the owned PostgreSQL fixture, without a dispatcher."""
import asyncio
from uuid import uuid4

import psycopg
import pytest

from openbot_server.database import StoreUnavailable
from openbot_server.work_handoff import HandoffStore
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_values import InvalidWork, WorkConflict, WorkNotFound


async def new(fixture, store):
    return await store.create(
        fixture['token'], bot_id=fixture['expected']['/api/v1/bots']['bots'][0]['id'],
        objective='Verify the synthetic engine handoff', token_limit=10, request_key=str(uuid4()))


def recorded(fixture, task):
    with psycopg.connect(fixture['dsn']) as db:
        return db.execute(
            'SELECT a.state,a.engine_reference,t.revision FROM work_admissions a '
            'JOIN work_runs r ON r.id=a.run_id JOIN work_tasks t ON t.id=r.task_id '
            'WHERE t.id=%s AND r.id=%s', (task['id'], task['runs'][0]['id'])).fetchone()


def acknowledgements(fixture, task_id):
    with psycopg.connect(fixture['dsn']) as db:
        return db.execute(
            "SELECT payload FROM work_events WHERE task_id=%s AND kind='handoff.acknowledged' "
            'ORDER BY revision', (task_id,)).fetchall()


def test_pending_is_bounded_stable_and_contains_only_active_obligations(fixture):
    async def check():
        store = PostgresWorkStore(fixture['dsn']); handoffs = HandoffStore(store)
        cases = [
            ('queued', 'queued', True, False, 'pending', True),
            ('queued', 'running', True, False, 'pending', True),
            ('open', 'queued', True, False, 'pending', True),
            ('open', 'running', True, False, 'pending', True),
            ('queued', 'queued', False, False, 'pending', False),
            ('open', 'running', True, True, 'pending', False),
            ('completed', 'queued', True, False, 'pending', False),
            ('cancelled', 'queued', True, False, 'pending', False),
            ('failed', 'queued', True, False, 'pending', False),
            ('queued', 'completed', True, False, 'pending', False),
            ('queued', 'cancelled', True, False, 'pending', False),
            ('queued', 'failed', True, False, 'pending', False),
            ('queued', 'queued', True, False, 'acknowledged', False),
        ]
        tasks = [await new(fixture, store) for _ in cases]
        expected = []
        with psycopg.connect(fixture['dsn']) as db:
            for task, (task_status, run_status, active, cancelled, state, visible) in zip(tasks, cases):
                task_id, run_id = task['id'], task['runs'][0]['id']
                db.execute('UPDATE work_tasks SET status=%s,authority_active=%s,cancel_requested=%s WHERE id=%s',
                           (task_status, active, cancelled, task_id))
                db.execute('UPDATE work_runs SET status=%s WHERE id=%s', (run_status, run_id))
                db.execute('UPDATE work_admissions SET state=%s,engine_reference=%s WHERE run_id=%s',
                           (state, 'fixture-already-accepted' if state == 'acknowledged' else None, run_id))
                if visible:
                    expected.append((task_id, 1, run_id))
            sibling_id = str(uuid4())
            db.execute('INSERT INTO work_runs(id,task_id,ordinal) VALUES (%s,%s,2)',
                       (sibling_id, tasks[0]['id']))
            db.execute('INSERT INTO work_admissions(run_id) VALUES (%s)', (sibling_id,))
            expected.append((tasks[0]['id'], 2, sibling_id))
            owned_ids = [task['id'] for task in tasks]
            # Put only this test's synthetic rows first; preserve every other test's evidence.
            db.execute("UPDATE work_tasks SET created_at=(SELECT min(created_at)-interval '1 day' "
                       'FROM work_tasks) WHERE id=ANY(%s)', (owned_ids,))
        expected = [{'taskId': task_id, 'runId': run_id} for task_id, _, run_id in sorted(expected)]
        assert (await handoffs.pending())[:len(expected)] == expected
        assert await handoffs.pending(1) == expected[:1]
        assert await handoffs.pending(len(expected)) == expected
        maximum = await handoffs.pending(128)
        assert len(maximum) <= 128
        assert [row for row in maximum if row['taskId'] in owned_ids] == expected
        assert await handoffs.pending(len(expected)) == expected
        with psycopg.connect(fixture['dsn']) as db:
            assert db.execute('SELECT count(*) FROM work_tasks WHERE id=ANY(%s) AND revision<>1',
                              (owned_ids,)).fetchone() == (0,)
            assert db.execute('SELECT count(*) FROM work_claims c JOIN work_runs r ON r.id=c.run_id '
                              'WHERE r.task_id=ANY(%s)', (owned_ids,)).fetchone() == (0,)
    asyncio.run(check())


@pytest.mark.parametrize('limit', [0, -1, 129, True, 1.5, '1', None])
def test_pending_rejects_invalid_bounds(fixture, limit):
    with pytest.raises(InvalidWork, match='invalid_handoff_limit'):
        asyncio.run(HandoffStore(PostgresWorkStore(fixture['dsn'])).pending(limit))
    with pytest.raises(InvalidWork, match='invalid_handoff_limit'):
        asyncio.run(HandoffStore(PostgresWorkStore(fixture['dsn'])).unconfirmed(limit))


def test_submission_attempt_is_durable_and_never_returns_as_unsent(fixture):
    async def check():
        store = PostgresWorkStore(fixture['dsn']); task = await new(fixture, store)
        task_id, run_id = task['id'], task['runs'][0]['id']
        handoffs = HandoffStore(store)
        assert {'taskId': task_id, 'runId': run_id} in await handoffs.pending(128)
        with pytest.raises(WorkConflict, match='handoff_not_reserved'):
            await handoffs.acknowledge(task_id, run_id, 'same-workflow')
        assert await handoffs.reserve_submission(task_id, run_id, 'same-workflow') is True
        restarted = HandoffStore(PostgresWorkStore(fixture['dsn']))
        assert await restarted.reserve_submission(task_id, run_id, 'same-workflow') is False
        with pytest.raises(WorkConflict, match='handoff_reference_changed'):
            await restarted.reserve_submission(task_id, run_id, 'replacement-workflow')
        assert {'taskId': task_id, 'runId': run_id} not in await restarted.pending(128)
        assert {'taskId': task_id, 'runId': run_id, 'engineReference': 'same-workflow'} \
            in await restarted.unconfirmed(128)
        assert await restarted.unconfirmed_for(task_id, run_id) == {
            'taskId': task_id, 'runId': run_id, 'engineReference': 'same-workflow'}
        assert await restarted.unconfirmed_for(task_id, 'another-run') is None
        assert recorded(fixture, task) == ('pending', None, 2)
        with psycopg.connect(fixture['dsn']) as db:
            row = db.execute('SELECT submission_reference,submission_attempted_at '
                             'FROM work_admissions WHERE run_id=%s', (run_id,)).fetchone()
            assert row[0] == 'same-workflow' and row[1] is not None
            assert db.execute('SELECT count(*) FROM work_events WHERE task_id=%s '
                              "AND kind='handoff.submission_attempted'", (task_id,)).fetchone() == (1,)
    asyncio.run(check())


def test_concurrent_submission_reservations_grant_one_send(fixture):
    async def check():
        store = PostgresWorkStore(fixture['dsn']); task = await new(fixture, store)
        task_id, run_id = task['id'], task['runs'][0]['id']
        results = await asyncio.gather(*(
            HandoffStore(PostgresWorkStore(fixture['dsn'])).reserve_submission(
                task_id, run_id, 'one-workflow') for _ in range(2)))
        assert sorted(results) == [False, True]
        assert recorded(fixture, task) == ('pending', None, 2)
    asyncio.run(check())


def test_cancellation_before_submission_cannot_grant_a_send(fixture):
    async def check():
        store = PostgresWorkStore(fixture['dsn']); task = await new(fixture, store)
        task_id, run_id = task['id'], task['runs'][0]['id']
        await store.cancel(fixture['token'], task_id)
        handoffs = HandoffStore(store)
        with pytest.raises(WorkConflict, match='admission_closed'):
            await handoffs.reserve_submission(task_id, run_id, 'too-late')
        assert not any(row['runId'] == run_id for row in await handoffs.unconfirmed(128))
        with psycopg.connect(fixture['dsn']) as db:
            assert db.execute('SELECT submission_reference FROM work_admissions WHERE run_id=%s',
                              (run_id,)).fetchone() == (None,)
    asyncio.run(check())


def test_failed_submission_audit_rolls_back_the_send_slot(fixture):
    async def check():
        store = PostgresWorkStore(fixture['dsn']); task = await new(fixture, store)
        handoffs = HandoffStore(store); task_id, run_id = task['id'], task['runs'][0]['id']
        with psycopg.connect(fixture['dsn']) as db:
            db.execute("CREATE FUNCTION work_reject_submission() RETURNS trigger LANGUAGE plpgsql AS $$ "
                       "BEGIN IF NEW.kind='handoff.submission_attempted' THEN RAISE EXCEPTION 'private'; END IF; "
                       'RETURN NEW; END $$')
            db.execute('CREATE TRIGGER work_reject_submission BEFORE INSERT ON work_events '
                       'FOR EACH ROW EXECUTE FUNCTION work_reject_submission()')
        try:
            with pytest.raises(StoreUnavailable, match='work_storage_unavailable'):
                await handoffs.reserve_submission(task_id, run_id, 'one-workflow')
            assert recorded(fixture, task) == ('pending', None, 1)
            assert {'taskId': task_id, 'runId': run_id} in await handoffs.pending(128)
            assert not any(row['runId'] == run_id for row in await handoffs.unconfirmed(128))
        finally:
            with psycopg.connect(fixture['dsn']) as db:
                db.execute('DROP TRIGGER work_reject_submission ON work_events')
                db.execute('DROP FUNCTION work_reject_submission()')
        assert await handoffs.reserve_submission(task_id, run_id, 'one-workflow') is True
    asyncio.run(check())


def test_acknowledgement_is_durable_idempotent_and_does_not_start_execution(fixture):
    async def check():
        store = PostgresWorkStore(fixture['dsn']); task = await new(fixture, store)
        task_id, run_id = task['id'], task['runs'][0]['id']
        reference = 'é' * 128
        assert await HandoffStore(store).reserve_submission(task_id, run_id, reference) is True
        assert await HandoffStore(store).acknowledge(task_id, run_id, reference) is True
        restarted = HandoffStore(PostgresWorkStore(fixture['dsn']))
        assert await restarted.acknowledge(task_id, run_id, reference) is False
        with pytest.raises(WorkConflict, match='handoff_reference_changed'):
            await restarted.acknowledge(task_id, run_id, 'different-engine-execution')
        assert recorded(fixture, task) == ('acknowledged', reference, 3)
        assert acknowledgements(fixture, task_id) == [({'runId': run_id, 'engineReference': reference},)]
        snap = await store.snapshot(fixture['token'], task_id)
        assert snap['status'] == 'queued' and snap['runs'][0]['status'] == 'queued'
        assert snap['authorityActive'] and not snap['cancelRequested'] and snap['actions'] == []
        with psycopg.connect(fixture['dsn']) as db:
            assert db.execute('SELECT execution_epoch FROM work_runs WHERE id=%s', (run_id,)).fetchone() == (0,)
            assert db.execute('SELECT count(*) FROM work_claims WHERE run_id=%s', (run_id,)).fetchone() == (0,)
    asyncio.run(check())


@pytest.mark.parametrize('reference', ['', ' ', None, 42, 'a\0b', 'a' * 257, 'é' * 129, '\ud800'])
def test_engine_reference_is_nonempty_bounded_utf8(fixture, reference):
    with pytest.raises(InvalidWork):
        asyncio.run(HandoffStore(PostgresWorkStore(fixture['dsn'])).acknowledge(
            str(uuid4()), str(uuid4()), reference))


def test_acknowledgement_after_cancellation_records_truth_without_restoring_authority(fixture):
    async def check():
        store = PostgresWorkStore(fixture['dsn']); task = await new(fixture, store)
        task_id, run_id = task['id'], task['runs'][0]['id']
        assert await HandoffStore(store).reserve_submission(task_id, run_id, 'accepted-before-cancel') is True
        fence = await store.claim(task_id, run_id, 'accepted-before-cancel')
        cancelled = await store.cancel(fixture['token'], task_id)
        assert {'taskId': task_id, 'runId': run_id, 'engineReference': 'accepted-before-cancel'} \
            in await HandoffStore(store).unconfirmed()
        assert await HandoffStore(store).acknowledge(task_id, run_id, 'accepted-before-cancel') is True
        snap = await store.snapshot(fixture['token'], task_id)
        assert snap['status'] == 'cancelled' and snap['runs'][0]['status'] == 'cancelled'
        assert not snap['authorityActive'] and snap['cancelRequested'] and snap['actions'] == []
        assert snap['revision'] == cancelled['revision'] + 1
        assert snap['usage'] == cancelled['usage']
        with pytest.raises(WorkConflict, match='admission_closed'):
            await store.claim(task_id, run_id, 'new-attempt')
        with pytest.raises(WorkConflict, match='admission_closed'):
            await store.propose(task_id, run_id, fence=fence, action_key='late', intent={'late': True},
                                reserved_tokens=0, requires_approval=False)
        assert await HandoffStore(store).acknowledge(task_id, run_id, 'accepted-before-cancel') is False
        assert len(acknowledgements(fixture, task_id)) == 1
    asyncio.run(check())


def test_acknowledgement_rejects_cross_task_runs_and_missing_obligations(fixture):
    async def check():
        store = PostgresWorkStore(fixture['dsn']); handoffs = HandoffStore(store)
        first, second = await new(fixture, store), await new(fixture, store)
        missing_admission_run = str(uuid4())
        with psycopg.connect(fixture['dsn']) as db:
            db.execute('INSERT INTO work_runs(id,task_id,ordinal) VALUES (%s,%s,2)',
                       (missing_admission_run, first['id']))
        for task_id, run_id in [
            (first['id'], second['runs'][0]['id']),
            (first['id'], missing_admission_run),
            (first['id'], str(uuid4())),
            (str(uuid4()), second['runs'][0]['id']),
        ]:
            with pytest.raises(WorkNotFound):
                await handoffs.acknowledge(task_id, run_id, 'must-not-attach')
        assert recorded(fixture, first) == ('pending', None, 1)
        assert recorded(fixture, second) == ('pending', None, 1)
        assert acknowledgements(fixture, first['id']) == acknowledgements(fixture, second['id']) == []
    asyncio.run(check())


def test_failed_audit_rolls_back_acceptance_and_revision(fixture):
    async def check():
        store = PostgresWorkStore(fixture['dsn']); task = await new(fixture, store)
        handoffs = HandoffStore(store); task_id, run_id = task['id'], task['runs'][0]['id']
        assert await handoffs.reserve_submission(task_id, run_id, 'fixture-receipt') is True
        with psycopg.connect(fixture['dsn']) as db:
            db.execute("CREATE FUNCTION work_reject_acknowledgement() RETURNS trigger LANGUAGE plpgsql AS $$ "
                       "BEGIN IF NEW.kind='handoff.acknowledged' THEN RAISE EXCEPTION 'private'; END IF; "
                       'RETURN NEW; END $$')
            db.execute('CREATE TRIGGER work_reject_acknowledgement BEFORE INSERT ON work_events '
                       'FOR EACH ROW EXECUTE FUNCTION work_reject_acknowledgement()')
        try:
            with pytest.raises(StoreUnavailable, match='work_storage_unavailable'):
                await handoffs.acknowledge(task_id, run_id, 'fixture-receipt')
            assert recorded(fixture, task) == ('pending', None, 2)
            assert acknowledgements(fixture, task_id) == []
        finally:
            with psycopg.connect(fixture['dsn']) as db:
                db.execute('DROP TRIGGER work_reject_acknowledgement ON work_events')
                db.execute('DROP FUNCTION work_reject_acknowledgement()')
        assert await handoffs.acknowledge(task_id, run_id, 'fixture-receipt') is True
        assert recorded(fixture, task) == ('acknowledged', 'fixture-receipt', 3)
    asyncio.run(check())


@pytest.mark.parametrize('same_reference', [True, False])
def test_concurrent_acknowledgements_commit_one_fact(fixture, same_reference):
    async def check():
        store = PostgresWorkStore(fixture['dsn']); task = await new(fixture, store)
        task_id, run_id = task['id'], task['runs'][0]['id']
        assert await HandoffStore(store).reserve_submission(task_id, run_id, 'engine-one') is True
        references = ['engine-one', 'engine-one' if same_reference else 'engine-two']
        outcomes = await asyncio.gather(*(
            HandoffStore(PostgresWorkStore(fixture['dsn'])).acknowledge(task_id, run_id, reference)
            for reference in references), return_exceptions=True)
        assert sum(value is True for value in outcomes) == 1
        if same_reference:
            assert sum(value is False for value in outcomes) == 1
        else:
            assert sum(isinstance(value, WorkConflict) for value in outcomes) == 1
            assert str(next(value for value in outcomes if isinstance(value, WorkConflict))) == 'handoff_reference_changed'
        winner = references[next(index for index, value in enumerate(outcomes) if value is True)]
        assert recorded(fixture, task) == ('acknowledged', winner, 3)
        assert acknowledgements(fixture, task_id) == [({'runId': run_id, 'engineReference': winner},)]
    asyncio.run(check())
