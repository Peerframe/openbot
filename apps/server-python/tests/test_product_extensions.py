"""Actual composed Owner API, without provider traffic or physical Worker effects."""
import asyncio
import secrets
from uuid import uuid4

from fastapi.testclient import TestClient

from openbot_server.app import create_app
from openbot_server.conversations import PostgresConversationStore
from openbot_server.database import PostgresReadStore
from openbot_server.identity_store import PostgresIdentityStore
from openbot_server.model_connections import ModelConnectionsService
from openbot_server.model_connections_cipher import ModelCredentialCipher
from openbot_server.plugin_service import PluginService
from openbot_server.product_control import OwnerProduct
from openbot_server.run_command_store import PostgresRunCommandStore
from openbot_server.task_store import PostgresTaskStore
from openbot_server.worker_host_identity import PostgresWorkerHostIdentity
from openbot_server.worker_host_registry import WorkerHostRegistry
from openbot_server.work_sources import WorkSourceAdmission
from openbot_server.work_store import PostgresWorkStore


def test_owner_extensions_and_queued_model_selection_are_real_transactions(fixture,tmp_path):
    tmp_path.chmod(0o700)
    (tmp_path/'attachments').mkdir(mode=0o700)
    dsn=fixture['dsn']; token=fixture['token']
    connections=ModelConnectionsService(dsn,ModelCredentialCipher(secrets.token_bytes(32)))
    identity=PostgresWorkerHostIdentity(dsn); registry=WorkerHostRegistry(identity)
    plugins=PluginService(dsn,tmp_path/'plugins'/'state.json')
    product=OwnerProduct(dsn,object_root=tmp_path,plugins=plugins,model_connections=connections,
        worker_identity=identity,worker_registry=registry,nodes=registry.list)
    work=PostgresWorkStore(dsn);sources=WorkSourceAdmission(work,token_limit=10000)
    app=create_app(PostgresReadStore(dsn),owner_name='Owner',secure_cookies=False,
        allowed_origins=('http://testserver',),product=product,work=work,
        identity=PostgresIdentityStore(dsn,model_connections=connections),
        conversations=PostgresConversationStore(dsn),
        tasks=PostgresTaskStore(dsn,work_sources=sources,model_connections=connections),
        run_commands=PostgresRunCommandStore(dsn,work_sources=sources))
    origin={'Origin':'http://testserver'}
    with TestClient(app,client=('127.0.0.1',50000)) as api:
        assert api.get('/api/v1/plugins').status_code==401
        api.cookies.set('openbot_session',token)
        assert api.get('/api/v1/plugins').json()=={'plugins':[],'pendingCalls':[]}
        assert api.get('/api/v1/nodes').json()=={'nodes':[]}
        assert len(api.get('/api/v1/model-services').json()['presets'])==12
        connection=api.post('/api/v1/model-connections',json={'name':'Fixture '+str(uuid4()),
            'presetId':'kimi','baseUrl':'https://api.moonshot.cn/v1','apiKey':'synthetic-key'},headers=origin)
        assert connection.status_code==201,connection.text
        connection_id=connection.json()['connection']['id']
        selected={'connectionId':connection_id,'modelId':'kimi-k3'}
        created=api.post('/api/v1/bots',json={'name':'Model '+str(uuid4()),'role':'Fixture',
            'computerProfile':'model','model':selected},headers=origin)
        assert created.status_code==201,created.text
        bot=created.json()['bot'];assert bot['model']==selected
        assert next(b for b in api.get('/api/v1/bots').json()['bots'] if b['id']==bot['id'])['model']==selected
        workspace = api.get('/api/v1/workspace')
        assert workspace.status_code == 200, workspace.text
        assert next(b for b in workspace.json()['bots'] if b['id']==bot['id'])['model']==selected
        channel=api.post('/api/v1/channels',json={'name':'Model '+str(uuid4()),'botIds':[bot['id']]},headers=origin)
        assert channel.status_code==201,channel.text
        channel_id=channel.json()['channel']['id']
        submitted=api.post('/api/v1/channels/'+channel_id+'/messages',json={'content':'Owned fixture','botId':bot['id']},headers=origin)
        assert submitted.status_code==201,submitted.text
        run=submitted.json()['run']
        async def snapshot():
            async with work._transaction(trusted=True) as db:
                return await (await db.execute('SELECT r.model_selection,s.task_id FROM runs r '
                    'JOIN work_sources s ON s.legacy_run_id=r.id WHERE r.id=%s',(run['id'],))).fetchone()
        queued=asyncio.run(snapshot());assert queued['model_selection']==selected
        change=api.patch('/api/v1/bots/'+bot['id']+'/model',json={'expectedRevision':1,
            'model':{'connectionId':connection_id,'modelId':'moonshot-v1-8k'}},headers=origin)
        assert change.status_code==200,change.text
        assert asyncio.run(snapshot())['model_selection']==selected
        cancelled=api.post('/api/v1/runs/'+run['id']+'/cancel',json={},headers=origin)
        assert cancelled.status_code==200,cancelled.text
        assert api.get('/api/v1/tasks/'+queued['task_id']).json()['status']=='cancelled'
        node='fixture-'+str(uuid4())
        issued=api.post('/api/v1/nodes/enrollment-tokens',json={'nodeId':node},headers=origin)
        assert issued.status_code==201,issued.text
        api.cookies.clear()
        exchange=api.post('/api/v1/nodes/enroll',json={'nodeId':node,'token':issued.json()['token']})
        assert exchange.status_code==201,exchange.text
        assert 'credential' in exchange.json()
        api.cookies.set('openbot_session',token)
        assert api.post('/api/v1/nodes/'+node+'/revoke',headers=origin).status_code==204
        assert 'security' not in app.openapi()['paths']['/api/v1/nodes/enroll']['post']
