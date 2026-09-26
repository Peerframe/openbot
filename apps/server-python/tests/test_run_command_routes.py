"""Owner authentication, body contracts and lifecycle error translation before store effects."""
from unittest.mock import AsyncMock
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from openbot_server.app import create_app
from openbot_server.authority import AuthenticationRequired
from openbot_server.database import StoreUnavailable
from openbot_server.run_commands import SteeringInstruction
from openbot_server.run_command_store import (CancelledRuns, RunCommandNotFound, RunCommandConflict,
                                             InvalidRunCommand, SteeringAttachmentRefused)
from openbot_server.task_models import Run
from test_app import Store, TOKEN

RUN_ID = str(uuid4())


@pytest.fixture
def api():
    writer = AsyncMock()
    writer.cancel.return_value = CancelledRuns(Run(id=RUN_ID,channelId='c',botId='b',executionProfile='none',
        instruction='task',title='task',status='cancelled',createdAt='2030-01-01T00:00:00.000Z',updatedAt='2030-01-01T00:00:00.000Z'),())
    writer.steer.return_value = SteeringInstruction(id='s',runId=RUN_ID,channelId='c',botId='b',instruction='change',createdAt='2030-01-01T00:00:00.000Z')
    with TestClient(create_app(Store(),owner_name='Owner',allowed_origins=('https://control.test',),run_commands=writer),base_url='https://control.test') as client:
        client.headers['Origin'] = 'https://control.test'
        client.cookies.set('__Host-openbot_session',TOKEN)
        yield writer,client


def test_optional_command_routes_are_explicit_and_declare_exact_security(api):
    writer,client = api
    assert client.post(f'/api/v1/runs/{RUN_ID}/cancel',json={}).json()['run']['status'] == 'cancelled'
    assert client.post(f'/api/v1/runs/{RUN_ID}/steer',json={'instruction':' change '}).status_code == 202
    writer.steer.assert_awaited_once_with(TOKEN,RUN_ID,'change')
    assert client.get('/health').json()['phase'] == 's2b-task-reference'
    paths = client.get('/openapi.json').json()['paths']
    for route in ('cancel','steer'):
        operation = paths['/api/v1/runs/{run_id}/'+route]['post']
        assert operation['security'] == [{'OwnerSession':[]}]
        assert operation['requestBody']['content']['application/json']['schema']['additionalProperties'] is False
    with TestClient(create_app(Store(),owner_name='Owner')) as readonly:
        assert readonly.post(f'/api/v1/runs/{RUN_ID}/cancel',json={}).status_code == 405
        assert readonly.post(f'/api/v1/runs/{RUN_ID}/steer',json={'instruction':'change'}).status_code == 405


@pytest.mark.parametrize('route,body',[('cancel',{'force':True}),('cancel',None),('cancel',[]),
    ('steer',{}),('steer',{'instruction':None}),('steer',{'instruction':'x','grant':True}),('steer',{'instruction':' '}),
    ('steer',{'instruction':'x'*4001})])
def test_invalid_commands_never_reach_store(api,route,body):
    writer,client = api
    assert client.post(f'/api/v1/runs/{RUN_ID}/{route}',json=body).status_code == 422
    writer.cancel.assert_not_called()
    writer.steer.assert_not_called()


@pytest.mark.parametrize('route,limit',[('cancel',128),('steer',18000)])
def test_authentication_origin_and_transport_bounds_precede_store(api,route,limit):
    writer,client = api
    path = f'/api/v1/runs/{RUN_ID}/{route}'
    assert client.post(path,content='{}',headers={'Origin':'null'}).status_code == 403
    assert client.post(path,content=b'x'*(limit+1),headers={'Content-Type':'application/json'}).status_code == 413
    assert client.post(path,content=b'{broken',headers={'Content-Type':'application/json'}).status_code == 422
    client.cookies.clear()
    assert client.post(path,content='bad input').status_code == 401
    writer.cancel.assert_not_called()
    writer.steer.assert_not_called()


def test_steering_uuid_and_attachment_refusal_precede_store(api):
    writer,client = api
    assert client.post('/api/v1/runs/not-uuid/steer',json={'instruction':'change'}).status_code == 422
    for count in (1,9):
        markers = ' '.join(f'[openbot ATTACHMENT: {uuid4()}]' for _ in range(count))
        assert client.post(f'/api/v1/runs/{RUN_ID}/steer',json={'instruction':markers}).status_code == 400
    writer.steer.assert_not_called()


@pytest.mark.parametrize('error,status',[(AuthenticationRequired(),401),(RunCommandNotFound(),404),
    (RunCommandConflict('This task has already ended.'),409),(InvalidRunCommand(),422),
    (SteeringAttachmentRefused(),400),(StoreUnavailable('PRIVATE'),503)])
def test_command_errors_never_become_success_or_leak_private_storage(api,error,status):
    writer,client = api
    writer.cancel.side_effect = error
    response = client.post(f'/api/v1/runs/{RUN_ID}/cancel',json={})
    assert response.status_code == status and 'PRIVATE' not in response.text
