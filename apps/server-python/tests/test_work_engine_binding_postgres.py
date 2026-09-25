"""Read-only activity binding against the owned PostgreSQL fixture; no engine, no authority.

The gate is exercised at the exact accepted/reserved/unreserved boundary and against mismatched
activity facts, including same-ID/same-first-Run history that carries a different immutable
attempt ID. Every refusal is checked to leave the Task revision and admission untouched.
"""
import asyncio
from uuid import uuid4

import psycopg
import pytest

from openbot_server.work_engine_binding import (
    AcceptedWorkflow, EngineActivityFacts, assert_accepted_workflow)
from openbot_server.work_handoff import HandoffStore
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_values import InvalidWork, WorkConflict, WorkNotFound

NAMESPACE = 'fixture-namespace'
QUEUE = 'fixture-queue'
WORKFLOW_TYPE = 'OpenBotWork'
FIRST_RUN_ID = 'engine-first-run-1'
# A syntactically valid attempt identifier that no reservation produced.
OTHER_ATTEMPT_ID = 'f' * 32


async def new(fixture, store):
    return await store.create(
        fixture['token'], bot_id=fixture['expected']['/api/v1/bots']['bots'][0]['id'],
        objective='Verify the synthetic engine binding', token_limit=10, request_key=str(uuid4()))


def settings():
    return dict(expected_namespace=NAMESPACE, expected_queue=QUEUE,
                expected_workflow_type=WORKFLOW_TYPE)


def facts(task_id, run_id, attempt_id, **overrides):
    values = dict(namespace=NAMESPACE, queue=QUEUE, start_queue=QUEUE,
                  workflow_id='openbot-work-v1-' + run_id, workflow_type=WORKFLOW_TYPE,
                  engine_run_id='engine-run-' + run_id, first_run_id=FIRST_RUN_ID,
                  start_input={'taskId': task_id, 'runId': run_id, 'attemptId': attempt_id})
    values.update(overrides)
    return EngineActivityFacts(**values)


def reference(run_id):
    return 'temporal:' + NAMESPACE + ':openbot-work-v1-' + run_id


def test_accepted_binding_reuses_the_callers_locked_transaction(fixture):
    from openbot_server.work_engine_binding import assert_accepted_workflow_in_transaction
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task = await new(fixture, store)
        run = task['runs'][0]['id']
        attempt = await acknowledge(fixture,store,task,reference(run))
        identity = dict(taskId=task['id'],runId=run)
        async with asyncio.timeout(3), store._transaction(trusted=True) as db:
            await store._task(db,task['id'])
            accepted = await assert_accepted_workflow_in_transaction(store,db,identity,
                facts(task['id'],run,attempt),**settings())
            assert accepted.run_id == run
            with pytest.raises(WorkConflict,match='handoff_attempt_changed'):
                await assert_accepted_workflow_in_transaction(store,db,identity,
                    facts(task['id'],run,OTHER_ATTEMPT_ID),**settings())
        assert recorded(fixture,task)[3] == 3
    asyncio.run(check())


def recorded(fixture, task):
    with psycopg.connect(fixture['dsn']) as db:
        return db.execute(
            'SELECT a.state,a.engine_reference,a.submission_reference,t.revision '
            'FROM work_admissions a JOIN work_runs r ON r.id=a.run_id '
            'JOIN work_tasks t ON t.id=r.task_id WHERE t.id=%s AND r.id=%s',
            (task['id'], task['runs'][0]['id'])).fetchone()


async def acknowledge(fixture, store, task, accepted):
    handoffs = HandoffStore(store)
    task_id, run_id = task['id'], task['runs'][0]['id']
    reservation = await handoffs.reserve_submission(task_id, run_id, accepted)
    assert reservation.should_start is True
    assert await handoffs.acknowledge(task_id, run_id, accepted,
                                      reservation.attempt_id, FIRST_RUN_ID) is True
    return reservation.attempt_id


def test_only_acknowledged_admission_admits_the_running_activity(fixture):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task = await new(fixture, store)
        task_id, run_id = task['id'], task['runs'][0]['id']
        handoffs = HandoffStore(store)
        identity = {'taskId': task_id, 'runId': run_id}
        accepted = reference(run_id)

        # No reservation: the durable row exists, but nothing was submitted to the engine.
        with pytest.raises(WorkConflict, match='handoff_not_acknowledged'):
            await assert_accepted_workflow(store, identity, facts(task_id, run_id, OTHER_ATTEMPT_ID),
                                           **settings())
        assert recorded(fixture, task) == ('pending', None, None, 1)

        # Reserved but not yet acknowledged: a start attempt alone is not acceptance.
        reservation = await handoffs.reserve_submission(task_id, run_id, accepted)
        assert reservation.should_start is True
        with pytest.raises(WorkConflict, match='handoff_not_acknowledged'):
            await assert_accepted_workflow(
                store, identity, facts(task_id, run_id, reservation.attempt_id), **settings())
        assert recorded(fixture, task) == ('pending', None, accepted, 2)

        # Only the acknowledged engine reference admits; the gate adds no event or revision.
        assert await handoffs.acknowledge(task_id, run_id, accepted,
                                          reservation.attempt_id, FIRST_RUN_ID) is True
        activity = facts(task_id, run_id, reservation.attempt_id)
        assert await assert_accepted_workflow(store, identity, activity, **settings()) == \
            AcceptedWorkflow(task_id=task_id, run_id=run_id, namespace=NAMESPACE, queue=QUEUE,
                             workflow_id='openbot-work-v1-' + run_id, workflow_type=WORKFLOW_TYPE,
                             engine_run_id=activity.engine_run_id, first_run_id=FIRST_RUN_ID)
        assert recorded(fixture, task) == ('acknowledged', accepted, accepted, 3)

        # A restarted control process reaches the same read-only decision.
        restarted = PostgresWorkStore(fixture['dsn'])
        assert (await assert_accepted_workflow(restarted, identity, activity, **settings())).run_id \
            == run_id
        assert recorded(fixture, task) == ('acknowledged', accepted, accepted, 3)
    asyncio.run(check())


def test_legacy_acknowledgement_without_verified_chain_stays_closed(fixture):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task = await new(fixture, store)
        task_id, run_id = task['id'], task['runs'][0]['id']
        accepted = reference(run_id)
        attempt = await acknowledge(fixture, store, task, accepted)
        with psycopg.connect(fixture['dsn']) as db:
            db.execute('UPDATE work_admissions SET engine_first_run_id=NULL WHERE run_id=%s',
                       (run_id,))
        identity = {'taskId': task_id, 'runId': run_id}
        with pytest.raises(WorkConflict, match='handoff_engine_run_unbound'):
            await assert_accepted_workflow(store, identity, facts(task_id, run_id, attempt),
                                           **settings())
        assert recorded(fixture, task) == ('acknowledged', accepted, accepted, 3)
        # Same-ID history after retention might belong to a different chain.
        # Neither the gate nor ordinary redelivery may backfill a missing first Run ID.
        with pytest.raises(WorkConflict, match='handoff_engine_run_unbound'):
            await HandoffStore(store).acknowledge(task_id, run_id, accepted, attempt, FIRST_RUN_ID)
        assert recorded(fixture, task) == ('acknowledged', accepted, accepted, 3)
    asyncio.run(check())


def test_legacy_acknowledgement_without_attempt_provenance_stays_closed(fixture):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task = await new(fixture, store)
        task_id, run_id = task['id'], task['runs'][0]['id']
        accepted = reference(run_id)
        await acknowledge(fixture, store, task, accepted)
        with psycopg.connect(fixture['dsn']) as db:
            db.execute('UPDATE work_admissions SET submission_attempt_id=NULL WHERE run_id=%s',
                       (run_id,))
        before = recorded(fixture, task)
        # An acknowledgement without attempt provenance cannot prove which start it accepted.
        with pytest.raises(WorkConflict, match='handoff_attempt_unbound'):
            await assert_accepted_workflow(store, {'taskId': task_id, 'runId': run_id},
                                           facts(task_id, run_id, OTHER_ATTEMPT_ID), **settings())
        assert recorded(fixture, task) == before
    asyncio.run(check())


def test_same_id_history_with_a_different_immutable_attempt_is_refused(fixture):
    """Acknowledged same-ID/same-first-Run fixture from a different submission stays closed."""
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task = await new(fixture, store)
        task_id, run_id = task['id'], task['runs'][0]['id']
        accepted = reference(run_id)
        await acknowledge(fixture, store, task, accepted)
        before = recorded(fixture, task)
        # Same Task, same Run, same acknowledged first engine Run, but the immutable start input
        # carries another attempt ID: this is not the accepted submission.
        with pytest.raises(WorkConflict, match='handoff_attempt_changed'):
            await assert_accepted_workflow(
                store, {'taskId': task_id, 'runId': run_id},
                facts(task_id, run_id, OTHER_ATTEMPT_ID), **settings())
        assert recorded(fixture, task) == before
    asyncio.run(check())


def test_start_input_must_match_the_accepted_task_run(fixture):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task = await new(fixture, store)
        task_id, run_id = task['id'], task['runs'][0]['id']
        accepted = reference(run_id)
        attempt = await acknowledge(fixture, store, task, accepted)
        before = recorded(fixture, task)
        wrong = {'taskId': str(uuid4()), 'runId': run_id, 'attemptId': attempt}
        with pytest.raises(WorkConflict, match='handoff_start_input_changed'):
            await assert_accepted_workflow(
                store, {'taskId': task_id, 'runId': run_id},
                facts(task_id, run_id, attempt, start_input=wrong), **settings())
        assert recorded(fixture, task) == before
    asyncio.run(check())


@pytest.mark.parametrize('start_input', [
    None, [], 'input', {},
    {'taskId': 'a', 'runId': 'b'},
    {'taskId': 'a', 'runId': 'b', 'attemptId': 'c', 'extra': 'd'},
    {'taskId': 'a', 'runId': 'b', 'attemptId': ''},
    {'taskId': 'a', 'runId': 'b', 'attemptId': 'A' * 32},
    {'taskId': 'a', 'runId': 'b', 'attemptId': 'a' * 31},
    {'taskId': '', 'runId': 'b', 'attemptId': 'a' * 32},
    {'taskId': 'a', 'runId': ' ', 'attemptId': 'a' * 32},
    {'taskId': 1, 'runId': 'b', 'attemptId': 'a' * 32},
    {'taskId': 'a\0b', 'runId': 'b', 'attemptId': 'a' * 32},
])
def test_malformed_start_input_is_refused(fixture, start_input):
    run_id = str(uuid4())
    with pytest.raises(InvalidWork):
        asyncio.run(assert_accepted_workflow(
            PostgresWorkStore(fixture['dsn']), {'taskId': str(uuid4()), 'runId': run_id},
            facts(str(uuid4()), run_id, '0' * 32, start_input=start_input), **settings()))


def test_each_run_requires_its_own_acknowledged_start(fixture):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task = await new(fixture, store)
        task_id, first_run = task['id'], task['runs'][0]['id']
        second_run = str(uuid4())
        with psycopg.connect(fixture['dsn']) as db:
            db.execute('INSERT INTO work_runs(id,task_id,ordinal) VALUES (%s,%s,2)',
                       (second_run, task_id))
            db.execute('INSERT INTO work_admissions(run_id) VALUES (%s)', (second_run,))
        first_attempt = await acknowledge(fixture, store, task, reference(first_run))

        assert (await assert_accepted_workflow(
            store, {'taskId': task_id, 'runId': first_run},
            facts(task_id, first_run, first_attempt), **settings())).run_id == first_run
        # A sibling Run of the same Task is not admitted by the first Run's acceptance.
        with pytest.raises(WorkConflict, match='handoff_not_acknowledged'):
            await assert_accepted_workflow(
                store, {'taskId': task_id, 'runId': second_run},
                facts(task_id, second_run, OTHER_ATTEMPT_ID), **settings())
        second = await HandoffStore(store).reserve_submission(
            task_id, second_run, reference(second_run))
        assert second.should_start is True
        assert await HandoffStore(store).acknowledge(
            task_id, second_run, reference(second_run), second.attempt_id, FIRST_RUN_ID) is True
        assert (await assert_accepted_workflow(
            store, {'taskId': task_id, 'runId': second_run},
            facts(task_id, second_run, second.attempt_id), **settings())).run_id == second_run
    asyncio.run(check())


@pytest.mark.parametrize('overrides,error', [
    ({'namespace': 'other-namespace'}, 'engine_namespace_mismatch'),
    ({'queue': 'other-queue'}, 'engine_queue_mismatch'),
    ({'start_queue': 'other-queue'}, 'engine_start_queue_mismatch'),
    ({'workflow_type': 'other-workflow'}, 'engine_workflow_type_mismatch'),
    ({'workflow_id': 'openbot-work-v1-00000000-0000-0000-0000-000000000000'},
     'engine_workflow_id_mismatch'),
    ({'first_run_id': 'another-engine-chain'}, 'handoff_engine_run_changed'),
])
def test_mismatched_activity_facts_are_refused_without_mutation(fixture, overrides, error):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task = await new(fixture, store)
        task_id, run_id = task['id'], task['runs'][0]['id']
        accepted = reference(run_id)
        attempt = await acknowledge(fixture, store, task, accepted)
        before = recorded(fixture, task)
        with pytest.raises(WorkConflict, match=error):
            await assert_accepted_workflow(store, {'taskId': task_id, 'runId': run_id},
                                           facts(task_id, run_id, attempt, **overrides),
                                           **settings())
        assert recorded(fixture, task) == before
    asyncio.run(check())


@pytest.mark.parametrize('engine_run_id', ['', '   ', None, 42, 'a\0b', 'a' * 257, '\ud800'])
def test_engine_run_id_must_be_nonempty_bounded_utf8(fixture, engine_run_id):
    async def check():
        run_id = str(uuid4())
        with pytest.raises(InvalidWork):
            await assert_accepted_workflow(
                PostgresWorkStore(fixture['dsn']), {'taskId': str(uuid4()), 'runId': run_id},
                facts(str(uuid4()), run_id, '0' * 32, engine_run_id=engine_run_id), **settings())
    asyncio.run(check())


@pytest.mark.parametrize('first_run_id', ['', '   ', None, 42, 'a\0b', 'a' * 257, '\ud800'])
def test_first_run_id_must_be_nonempty_bounded_utf8(fixture, first_run_id):
    run_id = str(uuid4())
    with pytest.raises(InvalidWork):
        asyncio.run(assert_accepted_workflow(
            PostgresWorkStore(fixture['dsn']), {'taskId': str(uuid4()), 'runId': run_id},
            facts(str(uuid4()), run_id, '0' * 32, first_run_id=first_run_id), **settings()))


@pytest.mark.parametrize('identity', [
    None, [], 'task', {},
    {'taskId': 'only'}, {'runId': 'only'},
    {'taskId': 'a', 'runId': 'b', 'extra': 'c'},
    {'taskId': '', 'runId': 'b'}, {'taskId': 'a', 'runId': ' '},
    {'taskId': 1, 'runId': 'b'}, {'taskId': 'a', 'runId': None},
    {'taskId': 'a\0b', 'runId': 'b'}, {'taskId': 'a' * 129, 'runId': 'b'},
])
def test_identity_must_be_exactly_bounded_task_run(fixture, identity):
    run_id = str(uuid4())
    with pytest.raises(InvalidWork):
        asyncio.run(assert_accepted_workflow(
            PostgresWorkStore(fixture['dsn']), identity,
            facts(str(uuid4()), run_id, '0' * 32), **settings()))


@pytest.mark.parametrize('override', [
    {'expected_namespace': ''}, {'expected_namespace': None}, {'expected_namespace': 'n' * 65},
    {'expected_queue': ' '}, {'expected_queue': 'q' * 257},
    {'expected_workflow_type': 42}, {'expected_workflow_type': 'w' * 257},
])
def test_trusted_settings_must_be_nonempty_bounded(fixture, override):
    run_id = str(uuid4())
    values = settings()
    values.update(override)
    with pytest.raises(InvalidWork):
        asyncio.run(assert_accepted_workflow(
            PostgresWorkStore(fixture['dsn']), {'taskId': str(uuid4()), 'runId': run_id},
            facts(str(uuid4()), run_id, '0' * 32), **values))


def test_facts_must_be_the_trusted_activity_dataclass(fixture):
    run_id = str(uuid4())
    for value in [None, {}, {'namespace': NAMESPACE, 'queue': QUEUE,
                             'workflow_id': 'openbot-work-v1-' + run_id,
                             'workflow_type': WORKFLOW_TYPE, 'engine_run_id': 'engine'}]:
        with pytest.raises(InvalidWork, match='invalid_engine_facts'):
            asyncio.run(assert_accepted_workflow(
                PostgresWorkStore(fixture['dsn']), {'taskId': str(uuid4()), 'runId': run_id},
                value, **settings()))


def test_exact_task_run_relation_is_required(fixture):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        first, second = await new(fixture, store), await new(fixture, store)
        other_run = second['runs'][0]['id']
        for task_id, run_id in [
            (first['id'], other_run),
            (str(uuid4()), other_run),
            (first['id'], str(uuid4())),
        ]:
            with pytest.raises(WorkNotFound):
                await assert_accepted_workflow(store, {'taskId': task_id, 'runId': run_id},
                                               facts(task_id, run_id, '0' * 32), **settings())
        assert recorded(fixture, first) == ('pending', None, None, 1)
        assert recorded(fixture, second) == ('pending', None, None, 1)
    asyncio.run(check())


def test_closed_run_is_refused_even_when_admission_acknowledged(fixture):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task = await new(fixture, store)
        task_id, run_id = task['id'], task['runs'][0]['id']
        accepted = reference(run_id)
        attempt = await acknowledge(fixture, store, task, accepted)
        with psycopg.connect(fixture['dsn']) as db:
            db.execute("UPDATE work_runs SET status='completed' WHERE id=%s", (run_id,))
        with pytest.raises(WorkConflict, match='run_closed'):
            await assert_accepted_workflow(store, {'taskId': task_id, 'runId': run_id},
                                           facts(task_id, run_id, attempt), **settings())
        assert recorded(fixture, task) == ('acknowledged', accepted, accepted, 3)
    asyncio.run(check())


def test_cancellation_and_revocation_close_an_acknowledged_activity(fixture):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task = await new(fixture, store)
        task_id, run_id = task['id'], task['runs'][0]['id']
        accepted = reference(run_id)
        handoffs = HandoffStore(store)
        attempt = await acknowledge(fixture, store, task, accepted)
        identity = {'taskId': task_id, 'runId': run_id}
        activity = facts(task_id, run_id, attempt)
        assert (await assert_accepted_workflow(store, identity, activity, **settings())).run_id \
            == run_id

        await store.revoke(fixture['token'], task_id)
        with pytest.raises(WorkConflict, match='admission_closed'):
            await assert_accepted_workflow(store, identity, activity, **settings())

        await store.cancel(fixture['token'], task_id)
        with pytest.raises(WorkConflict, match='admission_closed'):
            await assert_accepted_workflow(store, identity, activity, **settings())
        # The historical acceptance stays recorded and never reopens the closed Run.
        assert await handoffs.acknowledge(task_id, run_id, accepted, attempt, FIRST_RUN_ID) is False
        with pytest.raises(WorkConflict, match='admission_closed'):
            await assert_accepted_workflow(store, identity, activity, **settings())
        assert recorded(fixture, task) == ('acknowledged', accepted, accepted, 5)
    asyncio.run(check())


@pytest.mark.parametrize('closing', ['cancel', 'revoke'])
def test_start_context_rechecks_actual_task_after_binding(fixture, monkeypatch, closing):
    from openbot_server import work_temporal_start as startup
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task = await new(fixture, store)
        task_id, run_id = task['id'], task['runs'][0]['id']
        attempt = await acknowledge(fixture, store, task, reference(run_id))
        async def bound(_store, _client, **routing):
            accepted = await assert_accepted_workflow(store,
                {'taskId': task_id, 'runId': run_id}, facts(task_id, run_id, attempt), **routing)
            await getattr(store, closing)(fixture['token'], task_id)
            return accepted
        monkeypatch.setattr(startup, 'bind_current_activity', bound)
        with pytest.raises(WorkConflict, match='admission_closed'):
            await startup.load_current_activity_task(store, object(), **settings())
        final = await store.snapshot(fixture['token'], task_id)
        assert final['actions'] == [] and final['artifacts'] == []
        assert final['usage'] == task['usage']
    asyncio.run(check())


def test_start_context_pending_is_unproven_then_requires_full_binding(fixture, monkeypatch):
    from openbot_server import work_temporal_start as startup
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task = await new(fixture, store)
        task_id, run_id = task['id'], task['runs'][0]['id']
        evidence = facts(task_id, run_id, OTHER_ATTEMPT_ID)
        async def bound(_store, _client, **routing):
            return await assert_accepted_workflow(store,
                {'taskId': task_id, 'runId': run_id}, evidence, **routing)
        monkeypatch.setattr(startup, 'bind_current_activity', bound)
        # No reservation and a wrong attempt can still be pending: no context/grant escapes.
        before = recorded(fixture, task)
        with pytest.raises(startup.WorkStartPending):
            await startup.load_current_activity_task(store, object(), **settings())
        assert recorded(fixture, task) == before
        attempt = await acknowledge(fixture, store, task, reference(run_id))
        with pytest.raises(WorkConflict, match='handoff_attempt_changed'):
            await startup.load_current_activity_task(store, object(), **settings())
        evidence = facts(task_id, run_id, attempt)
        before = await store.snapshot(fixture['token'], task_id)
        context = await startup.load_current_activity_task(store, object(), **settings())
        assert (context.task_id, context.run_id, context.bot_id, context.objective, context.token_limit) == (
            task_id, run_id, task['botId'], task['objective'], task['usage']['tokenLimit'])
        assert await store.snapshot(fixture['token'], task_id) == before
    asyncio.run(check())
