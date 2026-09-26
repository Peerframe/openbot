"""Unit tests for the read-only product loader: no DB fixture, no SDK, no writes.

A fake store and a fake binding seam stand in for Postgres and Temporal. The tests pin four
boundaries: only the exact ``handoff_not_acknowledged`` conflict becomes ``WorkStartPending``;
every other binding failure propagates without touching the store; the load re-checks authority
under the Task SHARE lock so cancellation/revocation and closed/missing Runs refuse; and each
distinct Task loads its own persisted scalars with bounded validation.
"""
import asyncio
from contextlib import asynccontextmanager

import pytest

from openbot_server import work_temporal_start
from openbot_server.work_engine_binding import AcceptedWorkflow
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_temporal_start import (WorkRuntimeContext, WorkStartPending,
                                                load_current_activity_task)
from openbot_server.work_values import InvalidWork, WorkConflict, WorkNotFound

NAMESPACE = 'openbot-namespace'
QUEUE = 'openbot-work'
WORKFLOW_TYPE = 'WorkJourney'
TASK_ID = 'task-1'
RUN_ID = 'run-1'
BOT_ID = 'bot-1'
OBJECTIVE = 'Load the synthetic task context'
TOKEN_LIMIT = 10
SETTINGS = dict(expected_namespace=NAMESPACE, expected_queue=QUEUE,
                expected_workflow_type=WORKFLOW_TYPE)


def accepted(task_id=TASK_ID, run_id=RUN_ID):
    """The bounded correlation record the existing binding gate returns."""
    return AcceptedWorkflow(
        task_id=task_id, run_id=run_id, namespace=NAMESPACE, queue=QUEUE,
        workflow_id='openbot-work-v1-' + run_id, workflow_type=WORKFLOW_TYPE,
        engine_run_id='engine-run-1', first_run_id='engine-run-1')


def task_row(task_id=TASK_ID, *, bot_id=BOT_ID, objective=OBJECTIVE, token_limit=TOKEN_LIMIT,
             active=True, cancel_requested=False, status='queued'):
    return dict(id=task_id, bot_id=bot_id, objective=objective, token_limit=token_limit,
                authority_active=active, cancel_requested=cancel_requested, status=status)


class Cursor:
    def __init__(self, row):
        self.row = row

    async def fetchone(self):
        return self.row


class Connection:
    """Records every statement so a test can prove the loader writes nothing."""

    def __init__(self, run, statements):
        self.run = run
        self.statements = statements

    async def execute(self, statement, parameters):
        self.statements.append((statement, parameters))
        return Cursor(self.run)


_DEFAULT_RUN = object()


class Store:
    """Minimal fake of the existing PostgresWorkStore read surface used by the loader."""

    def __init__(self, *, task=None, run=_DEFAULT_RUN, missing_task=False):
        self.task = task if task is not None else task_row()
        # ``run=None`` deliberately models a missing Run row; the sentinel means "use a queued one".
        self.run = dict(id=RUN_ID, status='queued') if run is _DEFAULT_RUN else run
        self.missing_task = missing_task
        self.task_reads = []
        self.active_checks = 0
        self.statements = []
        self.transactions = 0

    @asynccontextmanager
    async def _transaction(self, *, trusted=False):
        assert trusted is True
        self.transactions += 1
        yield Connection(self.run, self.statements)

    async def _task(self, connection, task_id, *, read=False):
        self.task_reads.append((task_id, read))
        if self.missing_task:
            raise WorkNotFound()
        return self.task

    def _active(self, task):
        self.active_checks += 1
        PostgresWorkStore._active(task)


def install_binding(monkeypatch, *, result=None, error=None, calls=None):
    """Replace the existing binding gate; the loader must call it with only trusted settings."""
    async def fake(store, client, **kwargs):
        if calls is not None:
            calls.append((store, client, kwargs))
        if error is not None:
            raise error
        return result
    monkeypatch.setattr(work_temporal_start, 'bind_current_activity', fake)


def load(store, client=None):
    return asyncio.run(load_current_activity_task(store, client or object(), **SETTINGS))


def test_success_returns_persisted_detached_context_and_forwards_only_routing(monkeypatch):
    store = Store()
    client = object()
    calls = []
    install_binding(monkeypatch, result=accepted(), calls=calls)

    context = load(store, client)

    assert context == WorkRuntimeContext(TASK_ID, RUN_ID, BOT_ID, OBJECTIVE, TOKEN_LIMIT)
    assert type(context) is WorkRuntimeContext
    # Exactly one binding call, with only trusted routing settings and the caller's client. No
    # Task/Run identity and no SDK context override are accepted by this API.
    assert len(calls) == 1
    bound_store, bound_client, kwargs = calls[0]
    assert bound_store is store and bound_client is client
    assert kwargs == SETTINGS
    # The Task is read once under the SHARE lock, authority is re-checked, and the only statement
    # is a read of the exact Run.
    assert store.task_reads == [(TASK_ID, True)]
    assert store.active_checks == 1
    assert store.transactions == 1
    assert len(store.statements) == 1
    statement, parameters = store.statements[0]
    assert statement.lstrip().upper().startswith('SELECT')
    assert 'work_runs' in statement
    assert parameters == (TASK_ID, RUN_ID)


@pytest.mark.parametrize('run_status', ['queued', 'running'])
def test_queued_and_running_runs_load(monkeypatch, run_status):
    store = Store(run=dict(id=RUN_ID, status=run_status))
    install_binding(monkeypatch, result=accepted())
    assert load(store) == WorkRuntimeContext(TASK_ID, RUN_ID, BOT_ID, OBJECTIVE, TOKEN_LIMIT)


def test_only_the_exact_unacknowledged_conflict_becomes_pending(monkeypatch):
    store = Store()
    install_binding(monkeypatch, error=WorkConflict('handoff_not_acknowledged'))

    with pytest.raises(WorkStartPending) as pending:
        load(store)

    # Fixed message, chained from None: the loader does not retry and does not leak the conflict.
    assert str(pending.value) == 'handoff_not_acknowledged'
    assert pending.value.__cause__ is None
    assert store.transactions == 0
    assert store.task_reads == []


@pytest.mark.parametrize('message', [
    'handoff_not_acknowledged_extra', 'handoff-not-acknowledged', ' handoff_not_acknowledged',
    'HANDOFF_NOT_ACKNOWLEDGED', '',
])
def test_near_match_conflicts_are_not_translated(monkeypatch, message):
    store = Store()
    install_binding(monkeypatch, error=WorkConflict(message))
    with pytest.raises(WorkConflict):
        load(store)
    assert store.transactions == 0


@pytest.mark.parametrize('error', [
    WorkConflict('handoff_attempt_changed'), WorkConflict('admission_closed'),
    WorkConflict('run_closed'), WorkConflict('engine_namespace_mismatch'),
    InvalidWork('invalid_text'), ValueError('transport'), RuntimeError('engine unavailable'),
])
def test_binding_mismatches_and_transport_errors_propagate_without_store_reads(monkeypatch,
                                                                              error):
    store = Store()
    install_binding(monkeypatch, error=error)
    with pytest.raises(type(error)) as raised:
        load(store)
    assert raised.value is error
    # A failed binding never opens a transaction, takes a lock or reads a Run.
    assert store.transactions == 0
    assert store.task_reads == []
    assert store.active_checks == 0
    assert store.statements == []


@pytest.mark.parametrize('closed_task', [
    task_row(cancel_requested=True), task_row(active=False),
])
def test_cancellation_or_revocation_between_binding_and_load_refuses(monkeypatch, closed_task):
    store = Store(task=closed_task)
    install_binding(monkeypatch, result=accepted())

    with pytest.raises(WorkConflict, match='admission_closed'):
        load(store)

    # The repeated _active under the Task SHARE lock is the refusal; the Run is never loaded.
    assert store.task_reads == [(TASK_ID, True)]
    assert store.active_checks == 1
    assert store.statements == []


@pytest.mark.parametrize('run_status', ['completed', 'cancelled', 'failed'])
def test_closed_run_is_refused(monkeypatch, run_status):
    store = Store(run=dict(id=RUN_ID, status=run_status))
    install_binding(monkeypatch, result=accepted())
    with pytest.raises(WorkConflict, match='run_closed'):
        load(store)
    assert store.task_reads == [(TASK_ID, True)]


def test_missing_run_is_not_found(monkeypatch):
    store = Store(run=None)
    install_binding(monkeypatch, result=accepted())
    with pytest.raises(WorkNotFound):
        load(store)


def test_missing_task_is_not_found(monkeypatch):
    store = Store(missing_task=True)
    install_binding(monkeypatch, result=accepted())
    with pytest.raises(WorkNotFound):
        load(store)


def test_two_distinct_tasks_load_independently(monkeypatch):
    first = Store(task=task_row('task-1'), run=dict(id='run-1', status='queued'))
    second = Store(task=task_row('task-2', bot_id='bot-2', objective='Second objective',
                                 token_limit=99),
                   run=dict(id='run-2', status='running'))

    async def by_store(store, client, **kwargs):
        return accepted(task_id=store.task['id'], run_id=store.run['id'])

    monkeypatch.setattr(work_temporal_start, 'bind_current_activity', by_store)

    assert load(first) == WorkRuntimeContext('task-1', 'run-1', 'bot-1', OBJECTIVE, TOKEN_LIMIT)
    assert load(second) == WorkRuntimeContext('task-2', 'run-2', 'bot-2', 'Second objective', 99)
    assert first.task_reads == [('task-1', True)]
    assert second.task_reads == [('task-2', True)]
    assert first.statements[0][1] == ('task-1', 'run-1')
    assert second.statements[0][1] == ('task-2', 'run-2')


@pytest.mark.parametrize('objective', [
    'x' * 16385,
    'x' * 32768,
    '中' * 10922 + 'xx',
    '😀' * 8192,
])
def test_persisted_source_objective_accepts_the_utf8_byte_limit(monkeypatch, objective):
    # Source Runs retain up to 8000 Unicode code points; their persisted loader has a
    # 32768-byte bound. This does not enlarge the separate native Task admission limit.
    assert len(objective.encode('utf-8')) in (16385, 32768)
    store = Store(task=task_row(objective=objective))
    install_binding(monkeypatch, result=accepted())
    assert load(store).objective == objective
    assert store.active_checks == 1
    assert store.task_reads == [(TASK_ID, True)]


@pytest.mark.parametrize('task', [
    task_row(objective='x' * 32769),
    task_row(objective='中' * 10922 + 'xxx'),
    task_row(objective='😀' * 8192 + 'x'),
    task_row(objective='   '),
    task_row(bot_id='b' * 129),
    task_row(bot_id=None),
    task_row(token_limit=-1),
    task_row(token_limit=True),
    task_row(token_limit=1_000_000_001),
])
def test_persisted_context_is_bounded_before_return(monkeypatch, task):
    store = Store(task=task)
    install_binding(monkeypatch, result=accepted())
    with pytest.raises(InvalidWork):
        load(store)
