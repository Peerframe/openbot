"""Actual Owner ASGI routes and canonical PG; no model, Host or command execution."""
import asyncio
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4
from fastapi.testclient import TestClient
import psycopg
from pydantic import ValidationError
import pytest
from openbot_server.app import create_app
from openbot_server.database import PostgresReadStore
from openbot_server.identity_inputs import CreateBotInput
from openbot_server.identity_store import PostgresIdentityStore
from openbot_server.model_connections import ModelConnectionsService
from openbot_server.model_connections_cipher import ModelCredentialCipher
from openbot_server.product_control import OwnerProduct
from openbot_server.employee_knowledge import PostgresEmployeeKnowledge
from openbot_server.task_inputs import CreateMessageInput
from openbot_server.task_store import PostgresTaskStore
from openbot_server.work_command_profiles import CommandProfiles
from openbot_server.work_sources import WorkSourceAdmission
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_values import WorkConflict
ORIGIN={'Origin':'http://testserver'}
class PrivateFixture(dict):
    def __repr__(self):return '<owned synthetic database>'
@pytest.fixture
def owned():
    path=os.environ.get('OPENBOT_CONTROL_TEST_FIXTURE')
    if not path:pytest.skip('Requires the owned canonical control fixture')
    value=PrivateFixture(json.loads(Path(path).read_text()))
    assert '@127.0.0.1:' in value['dsn'] and '/openbot_control_test_' in value['dsn']
    value.created = {name: [] for name in ('bots', 'channels', 'connections', 'nodes')}
    try:
        yield value
    finally:
        # Explicitly recorded fixture IDs only; never truncate or delete a before/after difference.
        rows = value.created
        with psycopg.connect(value['dsn']) as db:
            # Both source cases reject in the original transaction. Unexpected durable Work
            # must be diagnosed rather than erased by a generic cascade cleanup helper.
            assert db.execute('SELECT count(*) FROM work_tasks WHERE bot_id=ANY(%s)', (rows['bots'],)).fetchone()[0] == 0
            assert db.execute('SELECT count(*) FROM runs WHERE bot_id=ANY(%s)', (rows['bots'],)).fetchone()[0] == 0
            db.execute('DELETE FROM run_events WHERE bot_id=ANY(%s) OR channel_id=ANY(%s) OR '
                "(type IN ('MODEL_CONNECTION_CREATED','MODEL_CONNECTION_UPDATED') AND payload->>'id'=ANY(%s))",
                (rows['bots'], rows['channels'], rows['connections']))
            db.execute('DELETE FROM employee_evolution_events WHERE bot_id=ANY(%s)', (rows['bots'],))
            db.execute('DELETE FROM channel_bots WHERE channel_id=ANY(%s)', (rows['channels'],))
            db.execute('DELETE FROM channels WHERE id=ANY(%s)', (rows['channels'],))
            db.execute('DELETE FROM bots WHERE id=ANY(%s)', (rows['bots'],))
            db.execute('DELETE FROM model_connections WHERE id=ANY(%s)', (rows['connections'],))
            db.execute('DELETE FROM node_credentials WHERE node_id=ANY(%s)', (rows['nodes'],))
@contextmanager
def api_for(owned,tmp_path):
    root=tmp_path.resolve();root.chmod(0o700)
    connection=ModelConnectionsService(owned['dsn'],ModelCredentialCipher(bytes(range(32))))
    identity=PostgresIdentityStore(owned['dsn'],model_connections=connection)
    work=PostgresWorkStore(owned['dsn']);source=WorkSourceAdmission(work,token_limit=1000)
    tasks=PostgresTaskStore(owned['dsn'],work_sources=source,model_connections=connection)
    product=OwnerProduct(owned['dsn'],object_root=root,model_connections=connection,knowledge=PostgresEmployeeKnowledge(owned['dsn']))
    app=create_app(PostgresReadStore(owned['dsn']),owner_name='Owner',secure_cookies=False,
        allowed_origins=('http://testserver',),identity=identity,product=product,work=work,tasks=tasks)
    with TestClient(app,client=('127.0.0.1',50000)) as api:
        api._owned_rows = owned.created
        api.cookies.set('openbot_session',owned['token']);yield api,connection,tasks

def create_connection(api):
    result=api.post('/api/v1/model-connections',headers=ORIGIN,json=dict(name='Synthetic '+uuid4().hex,
        presetId='kimi',baseUrl='https://api.moonshot.cn/v1',apiKey='synthetic-owner-model-key'))
    assert result.status_code==201
    connection=result.json()['connection']
    api._owned_rows['connections'].append(connection['id'])
    return connection

def create_bot(api,profile,model=None):
    body=dict(name='Owner '+uuid4().hex,role='Fixture',computerProfile=profile)
    if model is not None:body['model']=model
    result=api.post('/api/v1/bots',headers=ORIGIN,json=body)
    if result.status_code==201:api._owned_rows['bots'].append(result.json()['bot']['id'])
    return result

def create_channel(api,bot_id):
    result=api.post('/api/v1/channels',headers=ORIGIN,json=dict(name='Owned '+uuid4().hex,botIds=[bot_id]))
    assert result.status_code==201
    identity=result.json()['channel']['id'];api._owned_rows['channels'].append(identity)
    return identity

@pytest.mark.parametrize('profile',['model','docker-linux'])
def test_actual_owner_create_project_edit_cas_revoke(owned,tmp_path,profile):
    with api_for(owned,tmp_path) as (api,connections,_tasks):
        connection=create_connection(api);selection=dict(connectionId=connection['id'],modelId='kimi-k3')
        made=create_bot(api,profile,selection);assert made.status_code==201
        bot=made.json()['bot'];identity=bot['id'];assert bot['model']==selection
        assert next(b for b in api.get('/api/v1/bots').json()['bots'] if b['id']==identity)['model']==selection
        assert next(b for b in api.get('/api/v1/workspace').json()['bots'] if b['id']==identity)['model']==selection
        state=api.get('/api/v1/bots/'+identity+'/profile');assert state.status_code==200
        assert state.json()['profile']['configuration']['model']==selection
        async def legacy_selection():
            async with connections._transactions.transaction(owned['token']) as db:
                return await connections.in_transaction(db,identity)
        assert asyncio.run(legacy_selection())==(selection if profile=='model' else None)
        selected=dict(selection,modelId='changed-model');route='/api/v1/bots/'+identity+'/model'
        edited=api.patch(route,headers=ORIGIN,json=dict(expectedRevision=1,model=selected))
        assert edited.status_code==200 and edited.json()['employee']['model']==selected
        assert edited.json()['details']['revision']==2
        assert api.patch(route,headers=ORIGIN,json=dict(expectedRevision=1,model=None)).status_code==409
        api.cookies.clear()
        assert api.patch(route,headers=ORIGIN,json=dict(expectedRevision=2,model=None)).status_code==401
        api.cookies.set('openbot_session',owned['token'])
        removed=api.patch(route,headers=ORIGIN,json=dict(expectedRevision=2,model=None))
        assert removed.status_code==200 and 'model' not in removed.json()['employee']
        assert removed.json()['details']['revision']==3
        assert 'model' not in api.get('/api/v1/bots/'+identity+'/profile').json()['profile']['configuration']
        with psycopg.connect(owned['dsn']) as db:
            events=db.execute("SELECT payload FROM run_events WHERE bot_id=%s AND type='EMPLOYEE_MODEL_UPDATED'",(identity,)).fetchall()
            assert len(events)==2 and {row[0]['revision'] for row in events}=={2,3}
            assert 'synthetic-owner-model-key' not in json.dumps(events)

@pytest.mark.parametrize('profile',['none','macos-cua','lume-vm','coder'])
def test_other_profiles_still_refuse_creation_and_update(owned,tmp_path,profile):
    with api_for(owned,tmp_path) as (api,_connections,_tasks):
        connection=create_connection(api);selection=dict(connectionId=connection['id'],modelId='kimi-k3')
        assert create_bot(api,profile,selection).status_code==422
        plain=create_bot(api,profile);assert plain.status_code==201
        result=api.patch('/api/v1/bots/'+plain.json()['bot']['id']+'/model',headers=ORIGIN,json=dict(expectedRevision=1,model=selection))
        assert result.status_code==422 and result.json()['error']=='employee_model_profile_required'

def test_disabled_connection_refuses_creation_update_and_default_source_never_executes(owned,tmp_path):
    with api_for(owned,tmp_path) as (api,connections,tasks):
        connection=create_connection(api);selection=dict(connectionId=connection['id'],modelId='kimi-k3')
        bot=create_bot(api,'docker-linux',selection).json()['bot']
        channel=create_channel(api,bot['id'])
        with pytest.raises(WorkConflict,match='isolated_execution_unqualified'):
            asyncio.run(tasks.submit(owned['token'],channel,CreateMessageInput(content='Synthetic command',botId=bot['id'])))
        off=api.patch('/api/v1/model-connections/'+connection['id'],headers=ORIGIN,json=dict(expectedRevision=1,enabled=False));assert off.status_code==200
        assert create_bot(api,'docker-linux',selection).status_code==422
        changed=api.patch('/api/v1/bots/'+bot['id']+'/model',headers=ORIGIN,json=dict(expectedRevision=1,model=dict(selection,modelId='different')))
        assert changed.status_code==422 and changed.json()['error']=='model_connection_disabled'
        with psycopg.connect(owned['dsn']) as db:
            assert db.execute('SELECT count(*) FROM runs WHERE bot_id=%s',(bot['id'],)).fetchone()[0]==0
            assert db.execute('SELECT count(*) FROM work_tasks WHERE bot_id=%s',(bot['id'],)).fetchone()[0]==0
            assert db.execute('SELECT profile_revision FROM bots WHERE id=%s',(bot['id'],)).fetchone()[0]==1

def test_revoked_selection_cannot_capture_a_command_profile(owned,tmp_path):
    with api_for(owned,tmp_path) as (api,connections,_tasks):
        connection=create_connection(api);selection=dict(connectionId=connection['id'],modelId='kimi-k3')
        bot=create_bot(api,'docker-linux',selection).json()['bot']
        channel=create_channel(api,bot['id'])
        assert api.patch('/api/v1/bots/'+bot['id']+'/model',headers=ORIGIN,json=dict(expectedRevision=1,model=None)).status_code==200
        import test_work_command_store
        command=json.loads((Path(test_work_command_store.__file__).parent/'fixtures/work_command_vectors.json').read_text())['intent']['command']
        profiles=CommandProfiles(connections,policies={'policy':dict(image=command['image'],limits=command['limits'])})
        work=PostgresWorkStore(owned['dsn'],command_profiles=profiles);node='synthetic-'+uuid4().hex
        with psycopg.connect(owned['dsn']) as db:
            db.execute('INSERT INTO node_credentials(node_id,credential_digest,enrolled_at) VALUES(%s,%s,clock_timestamp())',(node,hashlib.sha256(node.encode()).hexdigest()))
        api._owned_rows['nodes'].append(node)
        source=WorkSourceAdmission(work,token_limit=1000,command_route=dict(nodeId=node,providerId='linux-command',enforcementKeyId='enforcer',ledgerId=str(uuid4())),command_policy_id='policy')
        tasks=PostgresTaskStore(owned['dsn'],work_sources=source,model_connections=connections)
        with pytest.raises(WorkConflict,match='command_profile_invalid'):
            asyncio.run(tasks.submit(owned['token'],channel,CreateMessageInput(content='Synthetic command',botId=bot['id'])))
        with psycopg.connect(owned['dsn']) as db:
            assert db.execute('SELECT count(*) FROM work_command_profiles WHERE bot_id=%s',(bot['id'],)).fetchone()[0]==0
            assert db.execute('SELECT count(*) FROM runs WHERE bot_id=%s',(bot['id'],)).fetchone()[0]==0

@pytest.mark.parametrize('profile',['none','macos-cua','lume-vm','coder','model','docker-linux'])
def test_explicit_null_creation_is_never_an_implicit_default(profile):
    with pytest.raises(ValidationError):CreateBotInput(name='Fixture',role='Fixture',computerProfile=profile,model=None)
