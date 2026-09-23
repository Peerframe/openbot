"""Activity binding unit tests: only the pinned SDK context supplies the current Run facts.

Every fact here comes from a fake SDK activity context and a fake pinned client. The adapter
must fail closed on a missing current Run ID, absent or malformed history and every mismatch
with trusted settings, and must never fall back to a latest-Run handle.
"""
import asyncio
import re
from types import SimpleNamespace
from uuid import uuid4

import psycopg
import pytest

pytest.importorskip('temporalio')

from openbot_server import work_claims, work_temporal_activity
from openbot_server.work_engine_binding import EngineActivityFacts
from openbot_server.work_handoff import HandoffStore
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_temporal_activity import (claim_current_activity, derive_claim_id,
                                                   inspect_activity_start)
from openbot_server.work_values import InvalidWork, WorkConflict

NAMESPACE = 'openbot-namespace'
QUEUE = 'openbot-work'
WORKFLOW_TYPE = 'WorkJourney'
WORKFLOW_ID = 'openbot-work-v1-run-1'
CURRENT_RUN_ID = 'engine-run-current'
FIRST_RUN_ID = 'engine-run-first'
TASK_ID = 'task-1'
RUN_ID = 'run-1'
ATTEMPT_ID = '1' * 32
START_INPUT = {'taskId': TASK_ID, 'runId': RUN_ID, 'attemptId': ATTEMPT_ID}


def info(**overrides):
    values = dict(namespace=NAMESPACE, task_queue=QUEUE, workflow_id=WORKFLOW_ID,
                  workflow_type=WORKFLOW_TYPE, workflow_run_id=CURRENT_RUN_ID)
    values.update(overrides)
    return SimpleNamespace(**values)


class History:
    """Fake pinned history page: yields the first event or raises a scripted error."""

    def __init__(self, events=(), error=None):
        self.events = events
        self.error = error

    async def fetch_history_events(self, *, page_size):
        assert page_size == 1
        if self.error:
            raise self.error
        for event in self.events:
            yield event


class Converter:
    def __init__(self, decoded):
        self.decoded = decoded

    async def decode(self, payloads, types):
        assert payloads == ['payload'] and types == [dict]
        return self.decoded


class Client:
    """Fake pinned client: records the exact handle binding and serves scripted history."""

    namespace = NAMESPACE

    def __init__(self, history=None, decoded=None):
        self.history = history if history is not None else History()
        self.data_converter = Converter(decoded)
        self.handles = []

    def get_workflow_handle(self, workflow_id, run_id=None):
        self.handles.append((workflow_id, run_id))
        return self.history


def started_event(*, workflow_id=WORKFLOW_ID, first_run_id=FIRST_RUN_ID,
                  workflow_type=WORKFLOW_TYPE, task_queue=QUEUE):
    attributes = SimpleNamespace(
        workflow_type=SimpleNamespace(name=workflow_type),
        task_queue=SimpleNamespace(name=task_queue),
        input=SimpleNamespace(payloads=['payload']),
        workflow_id=workflow_id,
        first_execution_run_id=first_run_id,
    )
    return SimpleNamespace(
        HasField=lambda field: field == 'workflow_execution_started_event_attributes',
        workflow_execution_started_event_attributes=attributes,
    )


def settings():
    return dict(expected_namespace=NAMESPACE, expected_queue=QUEUE,
                expected_workflow_type=WORKFLOW_TYPE)


def test_exact_current_run_binds_history_and_returns_immutable_start_facts():
    client = Client(history=History([started_event()]), decoded=[START_INPUT])
    result = asyncio.run(inspect_activity_start(client, info(), **settings()))
    assert result == EngineActivityFacts(
        namespace=NAMESPACE, queue=QUEUE, start_queue=QUEUE, workflow_id=WORKFLOW_ID,
        workflow_type=WORKFLOW_TYPE, engine_run_id=CURRENT_RUN_ID, first_run_id=FIRST_RUN_ID,
        start_input=START_INPUT)
    # The handle is bound to the activity's exact current Run, never the latest Run.
    assert client.handles == [(WORKFLOW_ID, CURRENT_RUN_ID)]


def test_workflow_id_must_derive_from_the_start_input_run():
    client = Client(history=History([started_event(workflow_id='openbot-work-v1-run-2')]),
                    decoded=[START_INPUT])
    with pytest.raises(WorkConflict, match='engine_workflow_id_mismatch'):
        asyncio.run(inspect_activity_start(
            client, info(workflow_id='openbot-work-v1-run-2'), **settings()))


@pytest.mark.parametrize('run_id', ['', '   ', None, 42, 'a\0b', 'a' * 257, '\ud800'])
def test_missing_or_invalid_current_run_id_fails_closed_without_a_handle(run_id):
    client = Client(history=History([started_event()]), decoded=[START_INPUT])
    with pytest.raises(InvalidWork):
        asyncio.run(inspect_activity_start(client, info(workflow_run_id=run_id), **settings()))
    # No current Run ID means no history lookup at all: there is no latest-Run fallback.
    assert client.handles == []


@pytest.mark.parametrize('overrides,error', [
    ({'namespace': 'other-namespace'}, 'engine_namespace_mismatch'),
    ({'task_queue': 'other-queue'}, 'engine_queue_mismatch'),
    ({'workflow_type': 'OtherWorkflow'}, 'engine_workflow_type_mismatch'),
])
def test_wrong_activity_facts_are_refused_before_history_lookup(overrides, error):
    client = Client(history=History([started_event()]), decoded=[START_INPUT])
    with pytest.raises(WorkConflict, match=error):
        asyncio.run(inspect_activity_start(client, info(**overrides), **settings()))
    assert client.handles == []


def test_connected_client_namespace_must_match_the_activity_namespace():
    client = Client(history=History([started_event()]), decoded=[START_INPUT])
    client.namespace = 'other-namespace'
    with pytest.raises(WorkConflict, match='engine_namespace_mismatch'):
        asyncio.run(inspect_activity_start(client, info(), **settings()))
    assert client.handles == []


def test_workflow_start_queue_is_a_separate_fact_from_the_activity_queue():
    client = Client(history=History([started_event(task_queue='other-queue')]),
                    decoded=[START_INPUT])
    with pytest.raises(WorkConflict, match='engine_start_queue_mismatch'):
        asyncio.run(inspect_activity_start(client, info(), **settings()))


def test_workflow_start_type_must_match_the_trusted_type():
    client = Client(history=History([started_event(workflow_type='OtherWorkflow')]),
                    decoded=[START_INPUT])
    with pytest.raises(WorkConflict, match='engine_workflow_type_mismatch'):
        asyncio.run(inspect_activity_start(client, info(), **settings()))


def test_absent_start_history_fails_closed():
    client = Client(history=History(), decoded=None)
    with pytest.raises(WorkConflict, match='engine_start_history_unavailable'):
        asyncio.run(inspect_activity_start(client, info(), **settings()))


def test_event_without_started_attributes_fails_closed():
    event = SimpleNamespace(HasField=lambda field: False,
                            workflow_execution_started_event_attributes=None)
    client = Client(history=History([event]), decoded=None)
    with pytest.raises(WorkConflict, match='engine_start_history_unavailable'):
        asyncio.run(inspect_activity_start(client, info(), **settings()))


@pytest.mark.parametrize('history,decoded', [
    (History([started_event()]), []),
    (History([started_event()]), [{'taskId': 'one'}, {'runId': 'two'}]),
    (History([started_event()]), [['not-a-dict']]),
    (History([started_event(workflow_id='other-workflow')]), [START_INPUT]),
    (History([started_event(first_run_id='')]), [START_INPUT]),
])
def test_malformed_start_event_fails_closed(history, decoded):
    client = Client(history=history, decoded=decoded)
    with pytest.raises(WorkConflict, match='engine_start_event_invalid'):
        asyncio.run(inspect_activity_start(client, info(), **settings()))


@pytest.mark.parametrize('start_input', [
    None, [], 'input', {},
    {'taskId': TASK_ID, 'runId': RUN_ID},
    {'taskId': TASK_ID, 'runId': RUN_ID, 'attemptId': ATTEMPT_ID, 'extra': 'x'},
    {'taskId': TASK_ID, 'runId': RUN_ID, 'attemptId': ''},
    {'taskId': TASK_ID, 'runId': RUN_ID, 'attemptId': 'A' * 32},
    {'taskId': TASK_ID, 'runId': RUN_ID, 'attemptId': 'a' * 31},
])
def test_malformed_start_input_fails_closed(start_input):
    client = Client(history=History([started_event()]), decoded=[start_input])
    with pytest.raises(WorkConflict, match='engine_start_event_invalid'):
        asyncio.run(inspect_activity_start(client, info(), **settings()))


def test_bind_current_activity_correlates_the_exact_accepted_run(fixture, monkeypatch):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task = await store.create(
            fixture['token'], bot_id=fixture['expected']['/api/v1/bots']['bots'][0]['id'],
            objective='Bind the synthetic activity', token_limit=10, request_key=str(uuid4()))
        task_id, run_id = task['id'], task['runs'][0]['id']
        workflow_id = 'openbot-work-v1-' + run_id
        accepted = 'temporal:' + NAMESPACE + ':' + workflow_id
        handoffs = HandoffStore(store)
        reservation = await handoffs.reserve_submission(task_id, run_id, accepted)
        assert reservation.should_start is True
        assert await handoffs.acknowledge(task_id, run_id, accepted,
                                          reservation.attempt_id, FIRST_RUN_ID) is True

        monkeypatch.setattr(work_temporal_activity, 'activity_info', lambda: info(
            workflow_id=workflow_id, workflow_run_id=CURRENT_RUN_ID))
        client = Client(history=History([started_event(workflow_id=workflow_id)]),
                        decoded=[{'taskId': task_id, 'runId': run_id,
                                  'attemptId': reservation.attempt_id}])
        result = await work_temporal_activity.bind_current_activity(store, client, **settings())
        assert result.task_id == task_id
        assert result.run_id == run_id
        assert result.first_run_id == FIRST_RUN_ID
        assert client.handles == [(workflow_id, CURRENT_RUN_ID)]

        # A same-ID history whose immutable start input carries another attempt is refused.
        wrong = Client(history=History([started_event(workflow_id=workflow_id)]),
                       decoded=[{'taskId': task_id, 'runId': run_id,
                                 'attemptId': 'f' * 32}])
        with pytest.raises(WorkConflict, match='handoff_attempt_changed'):
            await work_temporal_activity.bind_current_activity(store, wrong, **settings())
    asyncio.run(check())


# --- claim_current_activity: the only boundary that turns an accepted binding into a fence ---

def run_state(fixture, run_id):
    with psycopg.connect(fixture['dsn']) as db:
        epoch, status = db.execute(
            'SELECT execution_epoch,status FROM work_runs WHERE id=%s', (run_id,)).fetchone()
    return epoch, status


def claim_rows(fixture, run_id):
    with psycopg.connect(fixture['dsn']) as db:
        return db.execute('SELECT claim_id,epoch,expires_at>clock_timestamp() FROM work_claims '
                          'WHERE run_id=%s ORDER BY epoch', (run_id,)).fetchall()


def current(monkeypatch, workflow_id, engine_run_id=CURRENT_RUN_ID):
    """Pin the actual SDK activity context to one exact current engine Run."""
    monkeypatch.setattr(work_temporal_activity, 'activity_info',
                        lambda: info(workflow_id=workflow_id, workflow_run_id=engine_run_id))


async def acknowledged(fixture, store):
    """Create one acknowledged Task/Run plus the fake client that proves its exact start."""
    task = await store.create(
        fixture['token'], bot_id=fixture['expected']['/api/v1/bots']['bots'][0]['id'],
        objective='Claim the synthetic activity', token_limit=10, request_key=str(uuid4()))
    task_id, run_id = task['id'], task['runs'][0]['id']
    workflow_id = 'openbot-work-v1-' + run_id
    accepted = 'temporal:' + NAMESPACE + ':' + workflow_id
    handoffs = HandoffStore(store)
    reservation = await handoffs.reserve_submission(task_id, run_id, accepted)
    assert reservation.should_start is True
    assert await handoffs.acknowledge(task_id, run_id, accepted,
                                      reservation.attempt_id, FIRST_RUN_ID) is True
    client = Client(history=History([started_event(workflow_id=workflow_id)]),
                    decoded=[{'taskId': task_id, 'runId': run_id,
                              'attemptId': reservation.attempt_id}])
    return task_id, run_id, workflow_id, client


def test_claim_id_is_stable_bounded_and_domain_separated():
    first = derive_claim_id(NAMESPACE, WORKFLOW_ID, CURRENT_RUN_ID)
    assert first == derive_claim_id(NAMESPACE, WORKFLOW_ID, CURRENT_RUN_ID)
    assert re.fullmatch(r'work-claim-v1-[0-9a-f]{64}', first)
    assert len(first.encode('utf-8')) <= 128
    assert first != derive_claim_id('other-namespace', WORKFLOW_ID, CURRENT_RUN_ID)
    assert first != derive_claim_id(NAMESPACE, 'openbot-work-v1-run-2', CURRENT_RUN_ID)
    assert first != derive_claim_id(NAMESPACE, WORKFLOW_ID, 'engine-run-next')
    for bad in ['', '   ', None, 42, 'a\0b', 'a' * 257, '\ud800']:
        with pytest.raises(InvalidWork):
            derive_claim_id(NAMESPACE, WORKFLOW_ID, bad)


def test_claim_current_activity_grants_the_control_fence_for_the_accepted_run(fixture, monkeypatch):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, store)
        current(monkeypatch, workflow_id)
        fence = await claim_current_activity(store, client, **settings())
        assert fence == work_claims.WorkFence(
            run_id, derive_claim_id(NAMESPACE, workflow_id, CURRENT_RUN_ID), 1)
        assert run_state(fixture, run_id) == (1, 'running')
        assert claim_rows(fixture, run_id) == [(fence.claim_id, 1, True)]
        # The returned value is the existing control-owned fence type, not a new authority.
        assert isinstance(fence, work_claims.WorkFence)
    asyncio.run(check())


def test_same_live_engine_run_redelivery_returns_the_original_fence(fixture, monkeypatch):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, store)
        current(monkeypatch, workflow_id)
        first = await claim_current_activity(store, client, **settings())
        restarted = PostgresWorkStore(fixture['dsn'])
        again = await claim_current_activity(restarted, client, **settings())
        assert again == first
        # Redelivery never advances the epoch and never mints a second claim row.
        assert run_state(fixture, run_id) == (1, 'running')
        assert claim_rows(fixture, run_id) == [(first.claim_id, 1, True)]
    asyncio.run(check())


def test_new_current_run_in_the_accepted_chain_advances_and_stales_the_old_fence(fixture,
                                                                                monkeypatch):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, store)
        current(monkeypatch, workflow_id)
        first = await claim_current_activity(store, client, **settings())
        # Same accepted first engine Run chain, newer current Run: the binding still admits it.
        current(monkeypatch, workflow_id, 'engine-run-next')
        second = await claim_current_activity(store, client, **settings())
        assert second.run_id == first.run_id
        assert second.claim_id != first.claim_id
        assert second.epoch == first.epoch + 1
        assert run_state(fixture, run_id) == (2, 'running')
        assert sorted(row[0] for row in claim_rows(fixture, run_id)) == sorted(
            [first.claim_id, second.claim_id])
        # The older fence is stale once the newer current Run advanced the epoch.
        with pytest.raises(WorkConflict, match='execution_claim_stale'):
            await work_claims.claim(store, task_id, run_id, first.claim_id)
    asyncio.run(check())


def test_wrong_attempt_is_refused_before_any_claim(fixture, monkeypatch):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, _ = await acknowledged(fixture, store)
        current(monkeypatch, workflow_id)
        # Same Task/Run/chain, but the immutable start carries another submission's attempt.
        wrong = Client(history=History([started_event(workflow_id=workflow_id)]),
                       decoded=[{'taskId': task_id, 'runId': run_id, 'attemptId': 'f' * 32}])
        with pytest.raises(WorkConflict, match='handoff_attempt_changed'):
            await claim_current_activity(store, wrong, **settings())
        assert run_state(fixture, run_id)[0] == 0
        assert claim_rows(fixture, run_id) == []
    asyncio.run(check())


def test_unacknowledged_submission_mints_no_claim(fixture, monkeypatch):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task = await store.create(
            fixture['token'], bot_id=fixture['expected']['/api/v1/bots']['bots'][0]['id'],
            objective='Reserved but not acknowledged', token_limit=10, request_key=str(uuid4()))
        task_id, run_id = task['id'], task['runs'][0]['id']
        workflow_id = 'openbot-work-v1-' + run_id
        accepted = 'temporal:' + NAMESPACE + ':' + workflow_id
        reservation = await HandoffStore(store).reserve_submission(task_id, run_id, accepted)
        assert reservation.should_start is True
        current(monkeypatch, workflow_id)
        client = Client(history=History([started_event(workflow_id=workflow_id)]),
                        decoded=[{'taskId': task_id, 'runId': run_id,
                                  'attemptId': reservation.attempt_id}])
        with pytest.raises(WorkConflict, match='handoff_not_acknowledged'):
            await claim_current_activity(store, client, **settings())
        assert run_state(fixture, run_id)[0] == 0
        assert claim_rows(fixture, run_id) == []
    asyncio.run(check())


def test_closed_run_mints_no_claim(fixture, monkeypatch):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, store)
        current(monkeypatch, workflow_id)
        with psycopg.connect(fixture['dsn']) as db:
            db.execute("UPDATE work_runs SET status='completed' WHERE id=%s", (run_id,))
        with pytest.raises(WorkConflict, match='run_closed'):
            await claim_current_activity(store, client, **settings())
        assert run_state(fixture, run_id)[0] == 0
        assert claim_rows(fixture, run_id) == []
    asyncio.run(check())


def test_cancelled_task_mints_no_claim(fixture, monkeypatch):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, store)
        current(monkeypatch, workflow_id)
        await store.cancel(fixture['token'], task_id)
        with pytest.raises(WorkConflict, match='admission_closed'):
            await claim_current_activity(store, client, **settings())
        assert run_state(fixture, run_id)[0] == 0
        assert claim_rows(fixture, run_id) == []
    asyncio.run(check())


def test_revoked_task_mints_no_claim(fixture, monkeypatch):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, store)
        current(monkeypatch, workflow_id)
        await store.revoke(fixture['token'], task_id)
        with pytest.raises(WorkConflict, match='admission_closed'):
            await claim_current_activity(store, client, **settings())
        assert run_state(fixture, run_id)[0] == 0
        assert claim_rows(fixture, run_id) == []
    asyncio.run(check())


def test_expired_same_run_claim_is_not_renewed(fixture, monkeypatch):
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, store)
        current(monkeypatch, workflow_id)
        fence = await claim_current_activity(store, client, **settings())
        with psycopg.connect(fixture['dsn']) as db:
            db.execute("UPDATE work_claims SET expires_at=clock_timestamp()-interval '1 second' "
                       'WHERE run_id=%s', (run_id,))
        with pytest.raises(WorkConflict, match='execution_claim_stale'):
            await claim_current_activity(store, client, **settings())
        # Expiry never advances the epoch and never mints a replacement claim.
        assert run_state(fixture, run_id)[0] == fence.epoch
        assert claim_rows(fixture, run_id) == [(fence.claim_id, fence.epoch, False)]
    asyncio.run(check())


@pytest.mark.parametrize('close', ['cancel', 'revoke'])
def test_control_closure_between_binding_and_claim_mints_no_fence(fixture, monkeypatch, close):
    """The claim transaction must recheck authority after the read-only binding releases its lock."""
    async def check():
        store = PostgresWorkStore(fixture['dsn'])
        task_id, run_id, workflow_id, client = await acknowledged(fixture, store)
        current(monkeypatch, workflow_id)
        original = work_temporal_activity.bind_current_activity

        async def close_after_binding(*args, **kwargs):
            accepted = await original(*args, **kwargs)
            await getattr(store, close)(fixture['token'], task_id)
            return accepted

        monkeypatch.setattr(work_temporal_activity, 'bind_current_activity', close_after_binding)
        with pytest.raises(WorkConflict, match='admission_closed'):
            await claim_current_activity(store, client, **settings())
        assert run_state(fixture, run_id)[0] == 0
        assert claim_rows(fixture, run_id) == []
    asyncio.run(check())
