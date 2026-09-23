"""One bounded handoff: fake handoff and fake engine prove reservation-before-start."""
import asyncio

import pytest

from openbot_server.work_dispatcher import (
    MAX_EXECUTION_TIMEOUT_SECONDS, DispatchResult, EngineAlreadyStarted, StartEvent,
    dispatch_one)
from openbot_server.work_values import InvalidWork, WorkConflict

MAX_TIMEOUT = MAX_EXECUTION_TIMEOUT_SECONDS

TASK = 'task-0001'
RUN = 'run-0001'
NAMESPACE = 'default'
QUEUE = 'openbot-work'
WORKFLOW_TYPE = 'WorkJourney'
TIMEOUT = 240
WORKFLOW_ID = 'openbot-work-v1-run-0001'
REFERENCE = 'temporal:default:openbot-work-v1-run-0001'
IDENTITY = {'taskId': TASK, 'runId': RUN}


class FakeEngine:
    """Trusted port double: records starts and returns one scripted immutable start event."""

    def __init__(self, history=None, collision=False, start_error=None, namespace=NAMESPACE):
        self.history = history
        self.collision = collision
        self.start_error = start_error
        self.namespace = namespace
        self.starts = []
        self.inspected = []

    async def start_workflow(self, workflow_id, workflow_type, queue, identity, execution_timeout):
        self.starts.append({'workflowId': workflow_id, 'workflowType': workflow_type,
                            'queue': queue, 'identity': identity,
                            'executionTimeout': execution_timeout})
        if self.start_error is not None:
            # The send happened; only the transport response was lost.
            raise self.start_error
        if self.collision:
            raise EngineAlreadyStarted()

    async def inspect_start(self, workflow_id):
        self.inspected.append(workflow_id)
        if isinstance(self.history, Exception):
            raise self.history
        return self.history


class FakeHandoff:
    """Handoff double; ``reservation``/``acknowledged`` may be a value or an exception."""

    def __init__(self, prior=None, reservation=True, acknowledged=True):
        self.prior = prior
        self.reservation = reservation
        self.acknowledged = acknowledged
        self.calls = []

    async def unconfirmed_for(self, task_id, run_id):
        self.calls.append(('unconfirmed_for', task_id, run_id))
        return self.prior

    async def reserve_submission(self, task_id, run_id, reference):
        self.calls.append(('reserve_submission', reference))
        if isinstance(self.reservation, Exception):
            raise self.reservation
        return self.reservation

    async def acknowledge(self, task_id, run_id, reference):
        self.calls.append(('acknowledge', reference))
        if isinstance(self.acknowledged, Exception):
            raise self.acknowledged
        return self.acknowledged


def run(handoff, engine, **overrides):
    values = dict(task_id=TASK, run_id=RUN, namespace=NAMESPACE, queue=QUEUE,
                  workflow_type=WORKFLOW_TYPE, execution_timeout=TIMEOUT,
                  handoff=handoff, engine=engine)
    values.update(overrides)
    return asyncio.run(dispatch_one(**values))


def calls(handoff):
    return [call[0] for call in handoff.calls]


def start_event(workflow_type=WORKFLOW_TYPE, queue=QUEUE, identity=None):
    return StartEvent(workflow_type=workflow_type, task_queue=queue,
                      input=dict(IDENTITY if identity is None else identity))


def test_fresh_handoff_reserves_before_start_verifies_and_acknowledges():
    handoff = FakeHandoff()
    engine = FakeEngine(history=start_event())
    result = run(handoff, engine)
    assert result == DispatchResult(True, start_requested=True, reason='acknowledged')
    assert engine.starts == [{'workflowId': WORKFLOW_ID, 'workflowType': WORKFLOW_TYPE,
                              'queue': QUEUE, 'identity': IDENTITY,
                              'executionTimeout': TIMEOUT}]
    assert engine.inspected == [WORKFLOW_ID]
    assert calls(handoff) == ['unconfirmed_for', 'reserve_submission', 'acknowledge']
    assert handoff.calls[1][1] == REFERENCE and handoff.calls[2][1] == REFERENCE


def test_prior_recorded_attempt_is_inspected_without_starting():
    handoff = FakeHandoff(prior={'taskId': TASK, 'runId': RUN, 'engineReference': REFERENCE})
    engine = FakeEngine(history=start_event())
    result = run(handoff, engine)
    assert result == DispatchResult(True, start_requested=False, reason='acknowledged')
    assert engine.starts == []
    assert engine.inspected == [WORKFLOW_ID]
    assert calls(handoff) == ['unconfirmed_for', 'acknowledge']


def test_missing_history_stays_unacknowledged_after_one_start():
    handoff = FakeHandoff()
    engine = FakeEngine(history=None)
    result = run(handoff, engine)
    assert result == DispatchResult(False, start_requested=True, reason='unconfirmed_missing_history')
    assert len(engine.starts) == 1
    assert 'acknowledge' not in calls(handoff)


def test_lost_start_response_is_not_retried_and_later_inspection_acknowledges():
    """The recorded attempt is sent once; a later delivery inspects it and never starts again.

    This models a second dispatcher delivery after a lost transport response,
    distinct from Temporal retrying a model or tool activity.
    """
    handoff = FakeHandoff()
    engine = FakeEngine(history=None, start_error=TimeoutError('start response lost'))
    with pytest.raises(TimeoutError):
        run(handoff, engine)
    assert len(engine.starts) == 1
    assert 'acknowledge' not in calls(handoff)

    # The durable reservation recorded the attempt, so the later call must inspect only.
    handoff.prior = {'taskId': TASK, 'runId': RUN, 'engineReference': REFERENCE}
    engine.start_error = None
    engine.history = start_event()

    result = run(handoff, engine)
    assert result == DispatchResult(True, start_requested=False, reason='acknowledged')
    assert len(engine.starts) == 1
    assert engine.inspected == [WORKFLOW_ID]
    assert calls(handoff) == ['unconfirmed_for', 'reserve_submission',
                              'unconfirmed_for', 'acknowledge']


@pytest.mark.parametrize('history', [
    start_event(workflow_type='OtherWorkflow'),
    start_event(queue='other-queue'),
    start_event(identity={'taskId': 'other-task', 'runId': RUN}),
])
def test_unrelated_collision_is_inspected_and_not_acknowledged(history):
    handoff = FakeHandoff()
    engine = FakeEngine(history=history, collision=True)
    result = run(handoff, engine)
    assert result == DispatchResult(False, start_requested=True, reason='unconfirmed_start_event_mismatch')
    assert len(engine.starts) == 1
    assert 'acknowledge' not in calls(handoff)


def test_matching_collision_history_is_proof_not_the_identifier_itself():
    handoff = FakeHandoff()
    engine = FakeEngine(history=start_event(), collision=True)
    result = run(handoff, engine)
    assert result == DispatchResult(True, start_requested=True, reason='acknowledged')
    assert engine.inspected == [WORKFLOW_ID]
    assert handoff.calls[-1][0] == 'acknowledge'


def test_lost_reservation_race_inspects_without_starting():
    handoff = FakeHandoff(reservation=False)
    engine = FakeEngine(history=start_event())
    result = run(handoff, engine)
    assert result == DispatchResult(True, start_requested=False, reason='acknowledged')
    assert engine.starts == []
    assert calls(handoff) == ['unconfirmed_for', 'reserve_submission', 'acknowledge']


def test_failure_before_reservation_never_contacts_the_engine():
    handoff = FakeHandoff(reservation=WorkConflict('task_inactive'))
    engine = FakeEngine(history=start_event())
    with pytest.raises(WorkConflict):
        run(handoff, engine)
    assert engine.starts == [] and engine.inspected == []


def test_changed_prior_reference_fails_closed_without_engine_contact():
    handoff = FakeHandoff(prior={'taskId': TASK, 'runId': RUN,
                                 'engineReference': 'temporal:other:' + WORKFLOW_ID})
    engine = FakeEngine(history=start_event())
    with pytest.raises(WorkConflict):
        run(handoff, engine)
    assert engine.starts == [] and engine.inspected == []


def test_engine_client_namespace_must_match_the_durable_reference():
    handoff = FakeHandoff()
    engine = FakeEngine(history=start_event(), namespace='other-namespace')
    with pytest.raises(InvalidWork, match='engine_namespace_mismatch'):
        run(handoff, engine)
    assert handoff.calls == [] and engine.starts == [] and engine.inspected == []


def test_inspection_failure_stays_unacknowledged_without_another_start():
    handoff = FakeHandoff()
    engine = FakeEngine(history=RuntimeError('engine unavailable'))
    with pytest.raises(RuntimeError, match='engine unavailable'):
        run(handoff, engine)
    assert len(engine.starts) == 1
    assert 'acknowledge' not in calls(handoff)


def test_identical_late_replay_records_the_past_fact_without_granting_work():
    handoff = FakeHandoff(prior={'taskId': TASK, 'runId': RUN, 'engineReference': REFERENCE},
                          acknowledged=False)
    engine = FakeEngine(history=start_event())
    result = run(handoff, engine)
    assert result == DispatchResult(True, start_requested=False, reason='already_acknowledged')
    assert engine.starts == []
    assert calls(handoff) == ['unconfirmed_for', 'acknowledge']


@pytest.mark.parametrize('wrong', [
    {'taskId': RUN, 'runId': TASK},
    {'taskId': TASK, 'runId': RUN, 'namespace': NAMESPACE},
    {'taskId': TASK},
])
def test_scope_binding_requires_the_exact_task_run_input(wrong):
    handoff = FakeHandoff()
    engine = FakeEngine(history=start_event(identity=wrong))
    result = run(handoff, engine)
    assert result == DispatchResult(False, start_requested=True, reason='unconfirmed_start_event_mismatch')
    assert 'acknowledge' not in calls(handoff)


@pytest.mark.parametrize('overrides', [
    {'execution_timeout': 0},
    {'execution_timeout': MAX_TIMEOUT + 1},
    {'execution_timeout': True},
    {'execution_timeout': 240.0},
    {'run_id': 'r' * 129},
    {'namespace': ' '},
    {'queue': ''},
    {'workflow_type': 't' * 257},
])
def test_explicit_choices_are_bounded_before_handoff_or_engine_contact(overrides):
    handoff = FakeHandoff()
    engine = FakeEngine(history=start_event())
    with pytest.raises(InvalidWork):
        run(handoff, engine, **overrides)
    assert handoff.calls == [] and engine.starts == [] and engine.inspected == []
