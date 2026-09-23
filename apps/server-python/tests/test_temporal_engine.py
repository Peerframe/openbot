"""The optional Temporal transport preserves the control handoff's engine facts."""
import asyncio
from datetime import timedelta
from types import SimpleNamespace

import pytest

pytest.importorskip('temporalio')

from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from openbot_server.temporal_engine import TemporalEnginePort
from openbot_server.work_dispatcher import EngineAlreadyStarted, StartEvent


class History:
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
    namespace = 'openbot-namespace'

    def __init__(self, history=None, decoded=None, start_error=None):
        self.history = history or History()
        self.data_converter = Converter(decoded)
        self.start_error = start_error
        self.starts = []

    def get_workflow_handle(self, workflow_id):
        assert workflow_id == 'workflow-1'
        return self.history

    async def start_workflow(self, workflow_type, identity, **kwargs):
        self.starts.append((workflow_type, identity, kwargs))
        if self.start_error:
            raise self.start_error


def started_event():
    attributes = SimpleNamespace(
        workflow_type=SimpleNamespace(name='WorkJourney'),
        task_queue=SimpleNamespace(name='work-queue'),
        input=SimpleNamespace(payloads=['payload']),
    )
    return SimpleNamespace(
        HasField=lambda field: field == 'workflow_execution_started_event_attributes',
        workflow_execution_started_event_attributes=attributes,
    )


def test_start_uses_reject_duplicate_with_exact_identity_and_timeout():
    client = Client()
    port = TemporalEnginePort(client)
    identity = {'taskId': 'task-1', 'runId': 'run-1'}
    asyncio.run(port.start_workflow('workflow-1', 'WorkJourney', 'work-queue', identity, 240))
    assert port.namespace == 'openbot-namespace'
    assert client.starts == [('WorkJourney', identity, {
        'id': 'workflow-1', 'task_queue': 'work-queue',
        'execution_timeout': timedelta(seconds=240),
        'id_reuse_policy': WorkflowIDReusePolicy.REJECT_DUPLICATE,
    })]


def test_duplicate_start_is_only_a_collision_not_an_acceptance():
    client = Client(start_error=WorkflowAlreadyStartedError('workflow-1', 'WorkJourney'))
    with pytest.raises(EngineAlreadyStarted):
        asyncio.run(TemporalEnginePort(client).start_workflow(
            'workflow-1', 'WorkJourney', 'work-queue', {}, 240))
    assert len(client.starts) == 1


def test_history_decodes_only_immutable_start_event():
    identity = {'taskId': 'task-1', 'runId': 'run-1'}
    client = Client(history=History([started_event()]), decoded=[identity])
    assert asyncio.run(TemporalEnginePort(client).inspect_start('workflow-1')) == StartEvent(
        'WorkJourney', 'work-queue', identity)


@pytest.mark.parametrize('history,decoded', [
    (History(), None),
    (History([started_event()]), []),
    (History([started_event()]), [{'taskId': 'one'}, {'runId': 'two'}]),
    (History([started_event()]), [['not-a-dict']]),
])
def test_missing_or_malformed_history_never_supplies_acceptance(history, decoded):
    client = Client(history=history, decoded=decoded)
    if history.events:
        with pytest.raises(ValueError, match='Invalid engine start input'):
            asyncio.run(TemporalEnginePort(client).inspect_start('workflow-1'))
    else:
        assert asyncio.run(TemporalEnginePort(client).inspect_start('workflow-1')) is None


def test_not_found_is_unconfirmed_but_transport_failure_propagates():
    absent = Client(history=History(error=RPCError('expired', RPCStatusCode.NOT_FOUND, b'')))
    assert asyncio.run(TemporalEnginePort(absent).inspect_start('workflow-1')) is None
    unavailable = Client(history=History(error=RPCError('offline', RPCStatusCode.UNAVAILABLE, b'')))
    with pytest.raises(RPCError) as error:
        asyncio.run(TemporalEnginePort(unavailable).inspect_start('workflow-1'))
    assert error.value.status == RPCStatusCode.UNAVAILABLE


def test_decoder_failure_is_not_mistaken_for_missing_history():
    client = Client(history=History([started_event()]))

    async def bad_decode(_payloads, _types):
        raise RPCError('decoder failed', RPCStatusCode.NOT_FOUND, b'')

    client.data_converter.decode = bad_decode
    with pytest.raises(RPCError, match='decoder failed'):
        asyncio.run(TemporalEnginePort(client).inspect_start('workflow-1'))
