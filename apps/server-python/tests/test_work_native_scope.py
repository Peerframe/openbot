"""Owned PostgreSQL/HTTP and actual SDK ActivityEnvironment; no external providers."""
import asyncio
from dataclasses import replace
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx2
import psycopg
from psycopg.types.json import Jsonb
import pytest
pytest.importorskip('pydantic_ai',reason='The locked Worker SDK profile is required')
from temporalio.converter import DataConverter
from temporalio.testing import ActivityEnvironment
from openbot_agent_runtime.catalog import ToolCatalog
from openbot_server.app import create_app
from openbot_server.attachment_processing import AttachmentProcessingService
from openbot_server.database import PostgresReadStore
from openbot_server.model_settings import ModelSettingsService
from openbot_server.product_control import OwnerProduct
from openbot_server.work_corrections import CorrectionStore
from openbot_server.work_deferred import DeferredActivities
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_handoff import HandoffStore
from openbot_server.work_model_receipts import ModelReceipts
from openbot_server.work_product_binding import ProductWorkBinding
from openbot_server.work_product_model import ProductWorkModel
from openbot_server.work_product_media import ProductWorkMedia
from openbot_server.work_product_reads import ProductWorkReads, tool_descriptors
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_task_profiles import WorkTaskProfiles,resolve_product_source,product_capabilities
from openbot_server.work_temporal_start import WorkRuntimeContext
from openbot_server.work_tool_results import ToolResults
from openbot_server.work_values import InvalidWork,WorkConflict
from test_work_product_model import CONFIG,request,response

SCOPE=dict(expected_namespace='default',expected_queue='native-scope',expected_workflow_type='OpenBotWorkV1')

class Fixture(SimpleNamespace):
    def __repr__(self):return '<owned native scope fixture>'

@pytest.fixture
def anyio_backend():return 'asyncio'

@pytest.fixture
def native(fixture,tmp_path):
    bot,peer=str(uuid4()),str(uuid4());base=tmp_path.resolve();base.chmod(0o700)
    (base/'attachments').mkdir(mode=0o700);(base/'blobs').mkdir(mode=0o700)
    with psycopg.connect(fixture['dsn']) as db:
        for identity in (bot,peer):db.execute("INSERT INTO bots(id,name,role,computer_profile) VALUES(%s,%s,'Analyst','none')",(identity,'Native '+identity))
    product=OwnerProduct(fixture['dsn'],object_root=base)
    files=LocalWorkFiles(base/'blobs')
    store=PostgresWorkStore(fixture['dsn'],files=files,task_profiles=WorkTaskProfiles(files=product.files))
    product.processing=AttachmentProcessingService(fixture['dsn'],files=product.files)
    f=Fixture(**fixture,bot=bot,peer=peer,bots=[bot,peer],product=product,store=store,files=product.files,results=ToolResults(store,files),
        receipts=ModelReceipts(store,files),settings=ModelSettingsService(base/'settings',lambda r:httpx2.Response(200,json={'id':'fixture-model'})))
    yield f
    with psycopg.connect(f.dsn) as db:
        ids=f.bots;query='(SELECT id FROM work_tasks WHERE bot_id=ANY(%s))'
        db.execute('DELETE FROM work_collaborations WHERE root_task_id IN '+query,(ids,))
        for table in ('work_tool_results','work_model_receipts','work_sources','work_task_profiles','work_actions','work_artifacts','work_correction_contexts','work_corrections','work_events'):
            db.execute('DELETE FROM '+table+' WHERE task_id IN '+query,(ids,))
        for table in ('work_claims','work_admissions'):
            db.execute('DELETE FROM '+table+' WHERE run_id IN (SELECT id FROM work_runs WHERE task_id IN '+query+')',(ids,))
        db.execute('DELETE FROM work_runs WHERE task_id IN '+query,(ids,));db.execute('DELETE FROM work_tasks WHERE bot_id=ANY(%s)',(ids,))
        db.execute('DELETE FROM bots WHERE id=ANY(%s)',(ids,))


def grant(f,assets=(),**changes):
    return dict(version=1,attachmentIds=list(assets),collaboratorBotIds=[],knowledge=False,plugins=False,web=False,**changes)


def args(f,**changes):
    return dict(bot_id=f.bot,objective='Read explicitly supplied synthetic evidence',token_limit=100000,request_key=str(uuid4()))|changes


def app(f):
    return create_app(PostgresReadStore(f.dsn),owner_name=f.ownerName,secure_cookies=False,allowed_origins=('http://control.test',),work=f.store,product=f.product)


def authenticated(f):
    client=TestClient(app(f),base_url='http://control.test')
    client.cookies.set('openbot_session',f.token);client.headers['Origin']='http://control.test'
    return client


async def harness(f,scope=None,*,objective=None,existing=None):
    task=await f.store.snapshot(f.token,existing) if existing else await f.store.create(f.token,**args(f,scope=scope,**({'objective':objective} if objective else {})))
    run=task['runs'][0]['id'];frozen=await CorrectionStore(f.store).freeze(task['id'],run,'initial')
    context=WorkRuntimeContext(task['id'],run,task['botId'],task['objective'],task['usage']['tokenLimit'],frozen['id'])
    workflow='openbot-work-v1-'+run;handoff=HandoffStore(f.store);ref='temporal:default:'+workflow
    reservation=await handoff.reserve_submission(task['id'],run,ref);await handoff.acknowledge(task['id'],run,ref,reservation.attempt_id,'native-engine')
    converter=DataConverter.default
    payloads=await converter.encode([dict(taskId=task['id'],runId=run,attemptId=reservation.attempt_id)])
    start=SimpleNamespace(workflow_id=workflow,first_execution_run_id='native-engine',task_queue=SimpleNamespace(name=SCOPE['expected_queue']),
        workflow_type=SimpleNamespace(name=SCOPE['expected_workflow_type']),input=SimpleNamespace(payloads=payloads))
    event=SimpleNamespace(HasField=lambda n:n=='workflow_execution_started_event_attributes',workflow_execution_started_event_attributes=start)
    async def history(*,page_size):assert page_size==1;yield event
    def handle(identity,*,run_id):
        assert identity==workflow and run_id=='native-engine';return SimpleNamespace(fetch_history_events=history)
    client=SimpleNamespace(namespace='default',data_converter=converter,get_workflow_handle=handle)
    env=ActivityEnvironment();env.info=replace(env.info,namespace='default',task_queue=SCOPE['expected_queue'],workflow_id=workflow,
        workflow_run_id='native-engine',workflow_type=SCOPE['expected_workflow_type'],activity_id='native-prepare')
    reads=ProductWorkReads(f.store,client,SCOPE,f.files,f.results,history_reset_on_correction=True)
    media=ProductWorkMedia(f.store,client,SCOPE,f.files,f.store.files,reads)
    async def catalog(_):return ToolCatalog(tool_descriptors(),max_tools=8,max_bytes=16000)
    host=SimpleNamespace(store=f.store,client=client,scope=SCOPE,ports=SimpleNamespace(deferred_catalog=catalog),load_tool_result=reads.load_result)
    activities=DeferredActivities(host,reads.prepare,reads.load)
    async def prepare(identity,tool='read_attachment'):
        return await env.run(activities.prepare_request,dict(call_id='untrusted',tool=tool,arguments={'attachmentId':identity} if tool=='read_attachment' else {}),context.correction_token)
    async def execute(identity):
        env.info=replace(env.info,activity_id='native-execute')
        return await env.run(activities.execute,identity)
    return Fixture(**locals())


def test_http_upload_scope_create_and_no_channel_semantics(native):
    f=native
    with authenticated(f) as client:
        upload=client.post('/api/v1/task-attachments',content=b'name,value\nalpha,3\n',headers={'Content-Type':'application/octet-stream','X-OpenBot-Filename':'evidence.csv'})
        assert upload.status_code==201
        item=upload.json()['attachment'];assert item['scopeKind']=='owner' and item['ownerId']=='owner' and 'channelId' not in item
        scope=grant(f,[item['id']])|dict(collaboratorBotIds=[f.peer],knowledge=True,plugins=True,web=True)
        body=dict(botId=f.bot,objective='Check synthetic evidence',tokenLimit=100000,requestKey=str(uuid4()),scope=scope)
        from openbot_server.work_models import CreateTask
        assert CreateTask.model_validate(body).scope is not None
        created=client.post('/api/v1/tasks',json=body);assert created.status_code==202,created.text
        task=created.json();view=client.get('/api/v1/tasks/'+task['id']+'/scope').json()['scope']
        assert view['attachmentIds']==[item['id']] and view['attachments'][0]['sha256']==item['sha256']
        assert view['collaboratorBotIds']==[f.peer]
        assert client.post('/api/v1/tasks',json=body).json()==task
        assert client.post('/api/v1/tasks',json=body|{'scope':scope|{'web':False}}).status_code==409
        assert client.get('/api/v1/task-attachments/'+item['id']+'/content').content==b'name,value\nalpha,3\n'
        assert client.request('DELETE','/api/v1/task-attachments/'+item['id'],json={}).status_code==200
        assert client.get('/api/v1/task-attachments/'+item['id']+'/content').status_code==404
        assert client.post('/api/v1/tasks',json=body).json()==task # no recapture on replay
        assert client.post('/api/v1/task-attachments/'+item['id']+'/restore',json={}).status_code==200
    with psycopg.connect(f.dsn) as db:
        assert db.execute('SELECT count(*) FROM work_sources WHERE task_id=%s',(task['id'],)).fetchone()[0]==0
        assert db.execute('SELECT count(*) FROM runs WHERE bot_id=%s',(f.bot,)).fetchone()[0]==0
        assert db.execute('SELECT count(*) FROM channel_bots WHERE bot_id=%s',(f.bot,)).fetchone()[0]==0


def test_native_upload_requires_owner_origin_and_rejects_scope_spoof(native):
    f=native
    with TestClient(app(f),base_url='http://control.test') as client:
        headers={'Content-Type':'application/octet-stream','X-OpenBot-Filename':'test.txt','Origin':'http://control.test'}
        assert client.post('/api/v1/task-attachments',content=b'synthetic',headers=headers).status_code==401
        client.cookies.set('openbot_session',f.token)
        assert client.post('/api/v1/task-attachments',content=b'synthetic',headers=headers|{'Origin':'https://wrong.test'}).status_code==403
        assert client.post('/api/v1/task-attachments',json={'ownerId':'other'},headers={'Origin':'http://control.test'}).status_code==415


@pytest.mark.anyio
async def test_absent_scope_and_explicit_empty_scope_do_not_expand(native):
    for scope in (None,grant(native)):
        h=await harness(native,scope)
        async with native.store._transaction(trusted=True) as db:
            task=await native.store._task(db,h.task['id']);source=await resolve_product_source(db,task,native.bot)
            assert product_capabilities(source)==frozenset(('model','report','result_review'))
        with pytest.raises(WorkConflict):await h.prepare(str(uuid4()))


@pytest.mark.anyio
@pytest.mark.parametrize('change',['unknown','duplicate','self','bool_version','extra','unavailable_peer','channel_asset'])
async def test_invalid_scope_has_no_partial_task(native,change):
    f=native;scope=grant(f);key=str(uuid4())
    if change=='unknown':scope['attachmentIds']=[str(uuid4())]
    elif change=='duplicate':scope['collaboratorBotIds']=[f.peer,f.peer]
    elif change=='self':scope['collaboratorBotIds']=[f.bot]
    elif change=='bool_version':scope['version']=True
    elif change=='extra':scope['channelId']=str(uuid4())
    elif change=='unavailable_peer':scope['collaboratorBotIds']=[str(uuid4())]
    else:scope['attachmentIds']=[f.files.persist(str(uuid4()),'channel.txt',b'channel-only')['id']]
    with pytest.raises((InvalidWork,WorkConflict)):await f.store.create(f.token,**args(f,request_key=key,scope=scope))
    with psycopg.connect(f.dsn) as db:assert db.execute('SELECT count(*) FROM work_tasks WHERE request_key=%s',(key,)).fetchone()[0]==0


@pytest.mark.anyio
async def test_concurrent_scope_capture_is_unique_and_changed_inputs_are_not_rebound(native):
    f=native;item=f.files.owner_persist('input.txt',b'original');scope=grant(f,[item['id']]);values=args(f,scope=scope)
    one,two=await asyncio.gather(f.store.create(f.token,**values),f.store.create(f.token,**values));assert one==two
    f.files.owner_set_deleted(item['id'],True)
    assert await f.store.create(f.token,**values)==one
    with pytest.raises(WorkConflict):await f.store.create(f.token,**(values|dict(scope=scope|{'knowledge':True})))


@pytest.mark.anyio
async def test_actual_sdk_read_receipt_recovery_without_second_read(native):
    f=native;item=f.files.owner_persist('input.txt','A😀B synthetic'.encode());h=await harness(f,grant(f,[item['id']]))
    action=await h.prepare(item['id']);assert (await h.execute(action))['status']=='applied'
    with patch.object(h.reads,'_invoke',side_effect=AssertionError('Never resend')):
        assert (await h.execute(action))['status']=='applied'
    result=await h.env.run(h.activities.result,action)
    assert result['result']['text']=='A😀B synthetic' and 'receipt' not in result['result']


@pytest.mark.anyio
@pytest.mark.parametrize('change',['delete','bytes','metadata','scope','cancel','correction','wrong_sdk'])
async def test_native_consumption_refuses_revoked_or_changed_inputs(native,change):
    f=native;item=f.files.owner_persist('input.txt',b'reviewed');h=await harness(f,grant(f,[item['id']]))
    action=await h.prepare(item['id']);assert (await h.execute(action))['status']=='applied'
    if change=='delete':f.files.owner_set_deleted(item['id'],True)
    elif change=='bytes':f.files._write(item['id']+'.bin',b'tampered')
    elif change=='metadata':
        current=f.files.owner_metadata(item['id']);current['name']='changed.txt';f.files._write(item['id']+'.json',json.dumps(current).encode())
    elif change=='scope':
        with psycopg.connect(f.dsn) as db:db.execute("UPDATE work_task_scopes SET scope_digest=repeat('0',64) WHERE task_id=%s",(h.task['id'],))
    elif change=='cancel':await f.store.cancel(f.token,h.task['id'])
    elif change=='correction':await CorrectionStore(f.store).request(f.token,h.task['id'],run_id=h.run,instruction='Changed',request_key='change',expected_sequence=0)
    else:h.env.info=replace(h.env.info,task_queue='other-queue')
    with pytest.raises((WorkConflict,InvalidWork)):await h.env.run(h.activities.result,action)


@pytest.mark.anyio
async def test_native_task_cannot_read_channel_or_ungranted_asset(native):
    f=native;item=f.files.owner_persist('input.txt',b'granted');other=f.files.owner_persist('other.txt',b'ungranted')
    h=await harness(f,grant(f,[item['id']]))
    with pytest.raises(WorkConflict):await h.prepare(other['id'])
    for tool in ('read_channel_context','read_task_status','list_channel_bots'):
        with pytest.raises(WorkConflict):await h.prepare(item['id'],tool)


@pytest.mark.anyio
async def test_native_pdf_actual_sdk_provider_and_historical_receipt(native):
    f=native;item=f.files.owner_persist('report.pdf',b'%PDF-1.7\nSynthetic\n%%EOF')
    h=await harness(f,grant(f,[item['id']]))
    await f.settings.save(CONFIG);calls=[]
    def send(req):calls.append(req);return httpx2.Response(200,json=response(req))
    model=ProductWorkModel(f.store,h.client,SCOPE,f.settings,None,f.receipts,media=h.media,transport_factory=lambda:httpx2.MockTransport(send))
    await h.env.run(h.media.prepare,h.context)
    h.env.info=replace(h.env.info,activity_id='native-model')
    value=await h.env.run(model.call,h.context,request())
    assert value.text=='Checked answer' and len(calls)==1
    wire=json.loads(calls[0].content)
    assert 'report.pdf' in json.dumps(wire) and 'input_file' in json.dumps(wire)
    f.files.owner_set_deleted(item['id'],True)
    # Historical receipt lookup grants no current authority and must not emit another HTTP request.
    await h.env.run(model.call,h.context,request())
    assert len(calls)==1
    with pytest.raises(WorkConflict):await h.env.run(h.media.revalidate,h.context)


@pytest.mark.anyio
async def test_objective_marker_is_not_scope_authority(native):
    f=native;item=f.files.owner_persist('input.txt',b'private')
    h=await harness(f,objective='[openbot attachment:'+item['id']+']')
    with pytest.raises(WorkConflict):await h.env.run(h.media.prepare,h.context)


@pytest.mark.anyio
async def test_owner_processing_reuses_parser_and_pins_derived_bytes(native):
    f=native;item=f.files.owner_persist('report.pdf',b'%PDF-1.7\nSynthetic\n%%EOF')
    class Parser:
        async def parse(self,data,extension,command,**kwargs):
            assert data.startswith(b'%PDF') and extension=='pdf' and command.operation=='extract'
            return dict(text='Synthetic extracted fact',truncated=False)
    f.product.processing.parser=Parser()
    result=await f.product.processing.process_owner(f.token,item['id'],dict(operation='extract'))
    assert result['processing']['operation']=='extract' and 'channelId' not in result
    h=await harness(f,grant(f,[item['id']]))
    action=await h.prepare(item['id']);assert (await h.execute(action))['status']=='applied'
    assert (await h.env.run(h.activities.result,action))['result']['text']=='Synthetic extracted fact'
    f.files._write(item['id']+'.text.json',b'{}')
    with pytest.raises(WorkConflict):await h.env.run(h.activities.result,action)
