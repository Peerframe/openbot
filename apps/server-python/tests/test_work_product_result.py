"""Real SQL/settings/provider SDK; synthetic HTTP and the current engine's SDK/history seam."""
import asyncio
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx2
import psycopg
from psycopg.types.json import Jsonb
import pytest
pytest.importorskip('pydantic_ai',reason='Optional Worker SDK profile is required')
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'agent-runtime-python/src'))
from pydantic_ai.messages import ModelRequest, UserPromptPart
from openbot_agent_runtime.contracts import ModelStepRequest
from openbot_server.control_errors import ControlError
from openbot_server.model_connections import ModelConnectionsService
from openbot_server.model_connections_cipher import ModelCredentialCipher
from openbot_server.model_settings import ModelSettingsService
from openbot_server.product_model import ProductModelError
from openbot_server.task_inputs import CreateMessageInput
from openbot_server.task_store import PostgresTaskStore
from openbot_server.work_corrections import CorrectionStore
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_engine_binding import EngineActivityFacts
from openbot_server.work_handoff import HandoffStore
from openbot_server.work_model_receipts import ModelReceipts
import openbot_server
openbot_server.__path__.insert(0,str(Path(__file__).resolve().parents[1]/'src/openbot_server'))
from openbot_server.work_product_model import ProductWorkModel
from openbot_server.work_sources import WorkSourceAdmission
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_temporal_start import WorkRuntimeContext
from openbot_server.work_values import InvalidWork, WorkConflict

KEY='synthetic-product-key-never-real'
SCOPE=dict(expected_namespace='default',expected_queue='fixture-queue',expected_workflow_type='fixture-workflow')
class FixtureState(SimpleNamespace):
    def __repr__(self): return '<owned synthetic fixture>'

CONFIG=dict(provider='openai',model='fixture-model',apiKey=KEY,revision=None,agentEnabled=True)

@pytest.fixture
def setup(fixture,tmp_path):
    bot,channel=str(uuid4()),str(uuid4())
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("INSERT INTO bots(id,name,role,computer_profile) VALUES(%s,%s,'assistant','none')",(bot,'Product model '+bot))
        db.execute("INSERT INTO channels(id,name,description) VALUES(%s,%s,'Synthetic only')",(channel,'Product model '+channel))
        db.execute('INSERT INTO channel_bots(channel_id,bot_id) VALUES(%s,%s)',(channel,bot))
    base=tmp_path.resolve();base.chmod(0o700);(base/'blobs').mkdir(mode=0o700)
    store=PostgresWorkStore(fixture['dsn'],files=LocalWorkFiles(base/'blobs'))
    receipts=ModelReceipts(store,LocalWorkFiles(base/'blobs'))
    settings=ModelSettingsService(base/'settings',lambda r:httpx2.Response(200,json={'id':'fixture-model'}))
    connections=ModelConnectionsService(fixture['dsn'],ModelCredentialCipher(bytes(range(32))))
    f=FixtureState(**fixture,bot=bot,channel=channel,store=store,receipts=receipts,settings=settings,connections=connections,ids=[],calls=[])
    f.sources=WorkSourceAdmission(store,token_limit=1_000_000)
    yield f
    with psycopg.connect(f.dsn) as db:
        db.execute('DELETE FROM work_tool_results WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(bot,))
        db.execute('DELETE FROM work_model_receipts WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(bot,))
        db.execute('DELETE FROM work_sources WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(bot,))
        for table in ('work_actions','work_artifacts','work_correction_contexts','work_corrections','work_events'):
            db.execute(f'DELETE FROM {table} WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(bot,))
        for table in ('work_claims','work_admissions'):
            db.execute(f'DELETE FROM {table} WHERE run_id IN (SELECT r.id FROM work_runs r JOIN work_tasks t ON t.id=r.task_id WHERE t.bot_id=%s)',(bot,))
        db.execute('DELETE FROM work_runs WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(bot,))
        db.execute('DELETE FROM work_tasks WHERE bot_id=%s',(bot,))
        db.execute('DELETE FROM runs WHERE bot_id=%s',(bot,))
        db.execute('DELETE FROM run_events WHERE channel_id=%s OR bot_id=%s',(channel,bot))
        db.execute('DELETE FROM channels WHERE id=%s',(channel,))
        db.execute('DELETE FROM bots WHERE id=%s',(bot,))
        db.execute('DELETE FROM model_connections WHERE id=ANY(%s)',(f.ids,))

async def selected(f):
    item=await f.connections.create(f.token,dict(name='Synthetic '+uuid4().hex,presetId='openai',baseUrl='https://api.openai.com/v1',apiKey=KEY))
    f.ids.append(item['id'])
    return item

async def bound(f,profile='none',connection=None):
    with psycopg.connect(f.dsn) as db:
        db.execute('UPDATE bots SET computer_profile=%s,configuration=%s WHERE id=%s',(profile,Jsonb({'model':{'connectionId':connection['id'],'modelId':'queued-model'}} if connection else {}),f.bot))
    result=await PostgresTaskStore(f.dsn,model_connections=f.connections,work_sources=f.sources).submit(f.token,f.channel,
        CreateMessageInput(content='Synthetic model task',botId=f.bot))
    async with f.store._transaction(trusted=True) as db:
        row=await (await db.execute('SELECT task_id FROM work_sources WHERE legacy_run_id=%s',(result.run.id,))).fetchone()
    task=await f.store.snapshot(f.token,row['task_id'])
    rid=task['runs'][0]['id']
    correction=await CorrectionStore(f.store).freeze(task['id'],rid,'initial')
    context=WorkRuntimeContext(task['id'],rid,f.bot,task['objective'],task['usage']['tokenLimit'],correction['id'])
    accepted=SimpleNamespace(task_id=task['id'],run_id=rid,namespace='default',workflow_id='openbot-work-v1-'+rid,
        engine_run_id='synthetic-engine',first_run_id='synthetic-engine')
    handoff=HandoffStore(f.store);reference='temporal:default:'+accepted.workflow_id
    reservation=await handoff.reserve_submission(task['id'],rid,reference)
    await handoff.acknowledge(task['id'],rid,reference,reservation.attempt_id,'synthetic-engine')
    facts=EngineActivityFacts(namespace='default',queue=SCOPE['expected_queue'],start_queue=SCOPE['expected_queue'],
        workflow_id=accepted.workflow_id,workflow_type=SCOPE['expected_workflow_type'],engine_run_id='synthetic-engine',
        first_run_id='synthetic-engine',start_input=dict(taskId=task['id'],runId=rid,attemptId=reservation.attempt_id))
    return SimpleNamespace(context=context,accepted=accepted,facts=facts,source=result.run,activity='model-1')

@contextmanager
def binding(b):
    async def inspect(*args,**kwargs): return b.facts
    with patch('openbot_server.work_temporal_activity.activity_info',lambda:SimpleNamespace(activity_id=b.activity)), \
            patch('openbot_server.work_temporal_activity.inspect_activity_start',inspect):
        yield

def request(text='Synthetic prompt',step=1):
    return ModelStepRequest(step=step,messages=[ModelRequest(parts=[UserPromptPart(
        text,timestamp=datetime(2026,9,25,tzinfo=timezone.utc))])],tools=())

def response(req):
    body=json.loads(req.content);model=body['model']
    if req.url.path.endswith('/responses'):
        return {'id':'response-fixture','object':'response','created_at':1,'model':model,'status':'completed',
            'output':[{'id':'message-fixture','type':'message','role':'assistant','status':'completed',
                'content':[{'type':'output_text','text':'Checked answer','annotations':[]}]}],
            'usage':{'input_tokens':10,'output_tokens':4,'total_tokens':14}}
    return {'id':'chat-fixture','object':'chat.completion','created':1,'model':model,
        'choices':[{'index':0,'finish_reason':'stop','message':{'role':'assistant','content':'Checked answer'}}],
        'usage':{'prompt_tokens':10,'completion_tokens':4,'total_tokens':14}}

def product(f,handler=None,**options):
    def send(req):
        f.calls.append(req)
        return handler(req) if handler else httpx2.Response(200,json=response(req))
    return ProductWorkModel(f.store,object(),SCOPE,f.settings,f.connections,f.receipts,
        transport_factory=lambda:httpx2.MockTransport(send),**options)


from contextlib import asynccontextmanager
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from openbot_server import work_temporal_activity as temporal
from openbot_server.work_corrections import CorrectionsChanged
from openbot_server.work_effects import execute_action
from openbot_server.work_deferred import operation_key as tool_key
from openbot_server.work_model_activity import operation_key as model_key
from openbot_server.work_product_artifacts import ProductWorkArtifacts
from openbot_server.work_product_result import ProductWorkResultVerifier, EvidenceBundle, ToolEvidence, _verdict, _public
from openbot_server.work_temporal_effect import ToolRequest
from openbot_server.work_tool_results import ToolResults, ToolResponseAdapter, ToolResponseVerifier
from openbot_server.work_values import canonical

SUMMARY='The supplied records contain three open items.'
ACCEPT='{"accepted":true,"reason":"The answer accurately reports the supplied evidence."}'


async def prepared(f):
    await f.settings.save(CONFIG)
    b=await bound(f)
    f.next_text=SUMMARY
    f.hook=None
    def send(req):
        if f.hook: f.hook(req)
        value=response(req)
        value['output'][0]['content'][0]['text']=f.next_text
        return httpx2.Response(200,json=value)
    f.port=product(f,send)
    f.results=ToolResults(f.store,f.store.files)
    f.artifact=ProductWorkArtifacts(f.store,object(),SCOPE,f.results)
    f.allowed=True;f.scope_depth=0;f.collect_override=None;f.gates=0
    @asynccontextmanager
    async def scope(context):
        assert f.scope_depth==0
        f.scope_depth+=1
        try: yield
        finally: f.scope_depth-=1
    async def validate(db,context):
        assert f.scope_depth==1
        f.gates+=1
        return f.allowed
    async def collect(context,summary):
        async with f.store._transaction(trusted=True) as db:
            rows=await (await db.execute("SELECT * FROM work_actions WHERE task_id=%s AND run_id=%s "
                "AND authority_generation=(SELECT authority_generation FROM work_tasks WHERE id=%s) "
                "AND status='applied' AND intent->>'kind'='deferred_tool' ORDER BY id",
                (context.task_id,context.run_id,context.task_id))).fetchall()
        values=[]
        for row in rows:
            item=await f.results.load(row['id'],task_id=context.task_id,run_id=context.run_id,intent_digest=row['intent_digest'])
            values.append(ToolEvidence(row['id'],_public(item.value,row['intent'])))
        value=EvidenceBundle(tuple(values),await f.artifact.artifacts(context))
        return f.collect_override(value) if f.collect_override else value
    f.verifier=ProductWorkResultVerifier(f.store,object(),SCOPE,f.port,f.receipts,f.results,
        collect_evidence=collect,validate_current=validate,validation_scope=scope)
    return b


async def tool(f,b,tool_name='read_fixture',payload=None,*,report=None,effect=None,approval=False):
    b.activity='tool-'+uuid4().hex
    fence=await temporal._claim_bound_activity(f.store,b.accepted,b.activity)
    if report is not None:
        args=dict(name='summary.md',markdown=report)
        plan=await f.artifact.prepare(b.context,ToolRequest('write_report',args,canonical(args,max_bytes=65536)[1]))
        intent=dict(kind='deferred_tool',tool='write_report',arguments=args,effect=plan.intent)
        if plan.prepared_arguments is not None:
            intent['arguments']=plan.prepared_arguments
            intent['proposalSha256']=canonical(args,max_bytes=65536)[1]
        services=await f.artifact.load(b.context,intent)
        adapter,verifier=services.adapter,services.verifier
    else:
        intent=dict(kind='deferred_tool',tool=tool_name,arguments={},effect=effect or {'kind':'synthetic_read'})
        async def invoke(*args): return payload if payload is not None else {'openItems':3}
        adapter=ToolResponseAdapter(f.results,invoke,task_id=b.context.task_id,run_id=b.context.run_id,intent_digest=canonical(intent)[1])
        verifier=ToolResponseVerifier(f.results)
    if approval:
        action_id=await f.store.propose(b.context.task_id,b.context.run_id,fence=fence,
            action_key=tool_key(b.accepted,b.activity),intent=intent,reserved_tokens=0,requires_approval=True,
            correction_context=b.context.correction_token)
        await f.store.decide(f.token,action_id,intent_digest=canonical(intent)[1],approved=True)
    result=await execute_action(f.store,task_id=b.context.task_id,run_id=b.context.run_id,fence=fence,
        action_key=tool_key(b.accepted,b.activity),intent=intent,reserved_tokens=0,requires_approval=approval,
        adapter=adapter,verifier=verifier,correction_context=b.context.correction_token)
    return result.action_id


async def producer(f,b,summary=SUMMARY):
    b.activity='producer-'+uuid4().hex
    f.next_text=summary
    await f.port.call(b.context,request())
    async with f.store._transaction(trusted=True) as db:
        return await (await db.execute('SELECT * FROM work_actions WHERE run_id=%s AND action_key=%s',
            (b.context.run_id,model_key(b.accepted,b.activity)))).fetchone()


async def publication(f,b):
    b.activity='publish-current'
    fence=await temporal._claim_bound_activity(f.store,b.accepted,b.activity)
    f.next_text=ACCEPT
    return fence


def test_real_sdk_pg_review_retry_and_exact_publication(setup):
    async def check():
        f=setup;b=await prepared(f)
        with binding(b):
            await tool(f,b);await tool(f,b,report='# Summary\nThree open items.')
            prod=await producer(f,b);fence=await publication(f,b)
            before=await f.store.snapshot(f.token,b.context.task_id)
            result=await f.verifier.verify(b.context,SUMMARY)
            retry=await f.verifier.verify(b.context,SUMMARY)
            assert result==retry and len(f.calls)==2 and result.verification['reference']!=prod['id']
            assert result.observed_revision==before['revision']+3
            assert f.gates>=8 and f.scope_depth==0
            body=json.loads(f.calls[-1].content)
            assert not body.get('tools') and 'Three open items' in json.dumps(body)
            assert 'receipt' not in json.dumps(body).lower()
            final=await f.store.complete(b.context.task_id,b.context.run_id,fence=fence,
                expected_revision=result.observed_revision,summary=SUMMARY,artifacts=result.artifacts,
                verification=result.verification,correction_context=b.context.correction_token)
            assert final['status']=='completed' and len(final['artifacts'])==1
    asyncio.run(check())


@pytest.mark.parametrize('value',[
    '{"accepted":false,"reason":"The evidence contradicts the answer."}',
    '{"accepted":true,"reason":"ok","extra":1}', '{"accepted":1,"reason":"ok"}',
    '{"accepted":true,"accepted":false,"reason":"ok"}', '```json\n{"accepted":true,"reason":"ok"}\n```',
    '{"accepted":true,"reason":""}', '{"accepted":true,"reason":NaN}',
])
def test_strict_verdict_no_format_retry(setup,value):
    async def check():
        f=setup;b=await prepared(f)
        with binding(b):
            await producer(f,b);await publication(f,b);f.next_text=value
            with pytest.raises(WorkConflict,match='result_review_'): await f.verifier.verify(b.context,SUMMARY)
            with pytest.raises(WorkConflict,match='result_review_'): await f.verifier.verify(b.context,SUMMARY)
            assert len(f.calls)==2
    asyncio.run(check())


@pytest.mark.parametrize('change',['summary','no_producer','later_tool','missing_model','corrupt_model','unresolved'])
def test_deterministic_producer_required_before_review(setup,change):
    async def check():
        f=setup;b=await prepared(f)
        with binding(b):
            prod=await producer(f,b) if change!='no_producer' else None
            if change=='later_tool':await tool(f,b)
            if change=='unresolved':
                await f.store.propose(b.context.task_id,b.context.run_id,fence=await temporal._claim_bound_activity(f.store,b.accepted,b.activity),action_key='unresolved',intent={'kind':'test'},
                    reserved_tokens=0,requires_approval=False,correction_context=b.context.correction_token)
            if change in ('missing_model','corrupt_model'):
                with psycopg.connect(f.dsn) as db:
                    if change=='missing_model':db.execute('DELETE FROM work_model_receipts WHERE action_id=%s',(prod['id'],))
                    else:db.execute("UPDATE work_model_receipts SET sha256=%s WHERE action_id=%s",('0'*64,prod['id']))
            await publication(f,b);calls=len(f.calls)
            with pytest.raises(Exception):await f.verifier.verify(b.context,'Forged completed!' if change=='summary' else SUMMARY)
            assert len(f.calls)==calls
    asyncio.run(check())


@pytest.mark.parametrize('change',['omitted','altered','foreign','report_bytes'])
def test_collector_cannot_forge_evidence(setup,change):
    async def check():
        f=setup;b=await prepared(f)
        with binding(b):
            await tool(f,b)
            if change=='report_bytes':await tool(f,b,report='# True report')
            await producer(f,b);await publication(f,b)
            def mutate(value):
                if change=='omitted':return EvidenceBundle((),value.artifacts)
                if change=='altered':return EvidenceBundle((ToolEvidence(value.tools[0].action_id,{'openItems':99}),),value.artifacts)
                if change=='foreign':return EvidenceBundle((ToolEvidence(str(uuid4()),{}),),value.artifacts)
                return EvidenceBundle(value.tools,({**value.artifacts[0],'data':b'false'},))
            f.collect_override=mutate
            with pytest.raises(WorkConflict):await f.verifier.verify(b.context,SUMMARY)
            assert len(f.calls)==1
    asyncio.run(check())


def test_mcp_errors_remain_observations_and_private_knowledge_not_sent(setup):
    async def check():
        f=setup;b=await prepared(f)
        with binding(b):
            await tool(f,b,'call_plugin',{'isError':True,'content':[{'type':'text','text':'Failed to read source'}]},
                effect={'kind':'product_plugin','selection':{'mode':'read'}})
            await tool(f,b,'read_employee_memory',{'schema':'openbot.work-knowledge-result/v1',
                'payload':{'memories':[]},'receipt':{'secret_marker':'must-not-leak'},'proposal':None,'operation':'read_employee_memory'})
            await producer(f,b);await publication(f,b)
            # Synthetic reviewer tests transport/prompt wiring, not real model judgment.
            f.next_text='{"accepted":false,"reason":"Required source returned isError."}'
            with pytest.raises(WorkConflict,match='result_review_refused'):await f.verifier.verify(b.context,SUMMARY)
            body=f.calls[-1].content.decode()
            assert 'isError' in body and 'must-not-leak' not in body and 'response_observed_only' in body
    asyncio.run(check())


def test_confirm_observation_without_owner_approval_is_rejected_before_reviewer(setup):
    async def check():
        f=setup;b=await prepared(f)
        with binding(b):
            await tool(f,b,'call_plugin',{'isError':False,'result':'sent'},effect={'kind':'product_plugin','selection':{'mode':'confirm'}})
            await producer(f,b);await publication(f,b)
            with pytest.raises(WorkConflict,match='plugin_approval_missing'):await f.verifier.verify(b.context,SUMMARY)
            assert len(f.calls)==1
    asyncio.run(check())


@pytest.mark.parametrize('accepted',[True,False])
def test_approved_plugin_result_is_only_observation_evidence_for_review(setup,accepted):
    async def check():
        f=setup;b=await prepared(f)
        summary='The approved tool reported receipt of the request. External completion was not independently verified.'
        with binding(b):
            await tool(f,b,'call_plugin',{'isError':False,'content':[{'type':'text','text':'Request received'}]},
                effect={'kind':'product_plugin','selection':{'mode':'confirm'}},approval=True)
            await producer(f,b,summary);await publication(f,b)
            f.next_text=json.dumps(dict(accepted=accepted,reason='Synthetic observation-scope verdict.'))
            if accepted:
                assert await f.verifier.verify(b.context,summary)
            else:
                with pytest.raises(WorkConflict,match='result_review_refused'):
                    await f.verifier.verify(b.context,summary)
            body=f.calls[-1].content.decode()
            assert 'pluginMode' in body and 'confirm' in body and 'response_observed_only' in body
            assert 'never silently downgrade' in body and 'isError' in body
    asyncio.run(check())


@pytest.mark.parametrize('change',['event','revision_only','cancel','correction','permission','membership'])
def test_changes_during_review_never_gain_observed_revision(setup,change):
    async def check():
        f=setup;b=await prepared(f)
        with binding(b):
            await producer(f,b);await publication(f,b)
            def mutate(req):
                assert f.scope_depth==0
                if change=='permission':f.allowed=False;return
                with psycopg.connect(f.dsn) as db:
                    if change=='membership':db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(f.channel,f.bot))
                    elif change=='revision_only':db.execute('UPDATE work_tasks SET revision=revision+1 WHERE id=%s',(b.context.task_id,))
                    elif change=='cancel':db.execute('UPDATE work_tasks SET cancel_requested=true WHERE id=%s',(b.context.task_id,))
                    elif change=='correction':db.execute('UPDATE work_tasks SET authority_generation=authority_generation+1 WHERE id=%s',(b.context.task_id,))
                    else:
                        rev=db.execute('UPDATE work_tasks SET revision=revision+1 WHERE id=%s RETURNING revision',(b.context.task_id,)).fetchone()[0]
                        db.execute("INSERT INTO work_events(task_id,revision,kind,payload) VALUES(%s,%s,'unexpected.audit','{}')",(b.context.task_id,rev))
            f.hook=mutate
            with pytest.raises(WorkConflict):await f.verifier.verify(b.context,SUMMARY)
            assert len(f.calls)==2
    asyncio.run(check())


def test_review_unknown_is_never_resent(setup):
    async def check():
        f=setup;b=await prepared(f)
        with binding(b):
            await producer(f,b);await publication(f,b)
            def fail(req):raise RuntimeError('synthetic response lost')
            f.hook=fail
            with pytest.raises(Exception):await f.verifier.verify(b.context,SUMMARY)
            f.hook=None
            with pytest.raises(WorkConflict,match='model_observation_unknown'):await f.verifier.verify(b.context,SUMMARY)
            assert len(f.calls)==2
    asyncio.run(check())


def test_expired_publication_claim_cannot_reuse_review_as_authority(setup):
    async def check():
        f=setup;b=await prepared(f)
        with binding(b):
            await producer(f,b);await publication(f,b);await f.verifier.verify(b.context,SUMMARY)
            with psycopg.connect(f.dsn) as db:
                db.execute("UPDATE work_claims SET expires_at=clock_timestamp()-interval '1 second' WHERE run_id=%s",(b.context.run_id,))
            with pytest.raises(WorkConflict,match='claim_stale'):await f.verifier.verify(b.context,SUMMARY)
            assert len(f.calls)==2
    asyncio.run(check())


def test_all_corrections_and_superseded_unadmitted_proposal(setup):
    async def check():
        f=setup;b=await prepared(f)
        with binding(b):
            old=await producer(f,b)
            fence=await temporal._claim_bound_activity(f.store,b.accepted,b.activity)
            await f.store.propose(b.context.task_id,b.context.run_id,fence=fence,action_key='old-proposal',
                intent={'kind':'test'},reserved_tokens=0,requires_approval=False,correction_context=b.context.correction_token)
            for i,content in enumerate(('Include the source date.','Use a concise Markdown summary.')):
                await CorrectionStore(f.store).request(f.token,b.context.task_id,run_id=b.context.run_id,
                    instruction=content,request_key='correction-'+str(i),expected_sequence=i)
            correction=await CorrectionStore(f.store).freeze(b.context.task_id,b.context.run_id,'corrected')
            b.context=replace(b.context,correction_token=correction['id'])
            latest=await producer(f,b);await publication(f,b)
            result=await f.verifier.verify(b.context,SUMMARY)
            assert result.verification['reference'] not in (old['id'],latest['id'])
            body=f.calls[-1].content.decode()
            assert 'Include the source date.' in body and 'Use a concise Markdown summary.' in body
    asyncio.run(check())


def test_old_generation_producer_cannot_satisfy_new_correction(setup):
    async def check():
        f=setup;b=await prepared(f)
        with binding(b):
            await producer(f,b)
            await CorrectionStore(f.store).request(f.token,b.context.task_id,run_id=b.context.run_id,
                instruction='Update the figures.',request_key='update',expected_sequence=0)
            correction=await CorrectionStore(f.store).freeze(b.context.task_id,b.context.run_id,'corrected')
            b.context=replace(b.context,correction_token=correction['id']);await publication(f,b)
            with pytest.raises(WorkConflict,match='producer_missing'):await f.verifier.verify(b.context,SUMMARY)
            assert len(f.calls)==1
    asyncio.run(check())


def test_same_activity_as_producer_is_not_an_independent_review(setup):
    async def check():
        f=setup;b=await prepared(f)
        with binding(b):
            await producer(f,b)
            with pytest.raises(WorkConflict,match='producer_missing'):await f.verifier.verify(b.context,SUMMARY)
            assert len(f.calls)==1
    asyncio.run(check())


def test_large_original_report_body_is_reviewed_not_just_hash(setup):
    async def check():
        f=setup;b=await prepared(f)
        with binding(b):
            content='A'*19000+'\nActual end of the report.'
            await tool(f,b,report=content);await producer(f,b);await publication(f,b)
            result=await f.verifier.verify(b.context,SUMMARY)
            assert result.artifacts[0]['data']==content.encode()
            assert 'Actual end of the report.' in f.calls[-1].content.decode()
    asyncio.run(check())


def test_audit_after_review_changes_retry_request_without_resending(setup):
    async def check():
        f=setup;b=await prepared(f)
        with binding(b):
            await producer(f,b);await publication(f,b);await f.verifier.verify(b.context,SUMMARY)
            async with f.store._transaction(trusted=True) as db:
                await f.store._task(db,b.context.task_id)
                await f.store._event(db,b.context.task_id,'unexpected.after-review',{})
            with pytest.raises(WorkConflict,match='model_operation_changed'):await f.verifier.verify(b.context,SUMMARY)
            assert len(f.calls)==2
    asyncio.run(check())


def test_data_revocation_before_send_blocks_http(setup):
    async def check():
        f=setup;b=await prepared(f)
        with binding(b):
            await tool(f,b);await producer(f,b);await publication(f,b)
            def revoke(value):f.allowed=False;return value
            f.collect_override=revoke
            with pytest.raises(WorkConflict,match='current_validation_refused'):await f.verifier.verify(b.context,SUMMARY)
            assert len(f.calls)==1
    asyncio.run(check())


@pytest.mark.parametrize('change',['missing_receipt','corrupt_blob','private_unknown'])
def test_tool_evidence_corruption_fails_before_review(setup,change):
    async def check():
        f=setup;b=await prepared(f)
        with binding(b):
            aid=await tool(f,b,payload={'schema':'openbot.unknown/v1','receipt':{'secret':'secret'}} if change=='private_unknown' else None)
            await producer(f,b);await publication(f,b)
            with psycopg.connect(f.dsn) as db:
                if change=='missing_receipt':db.execute('DELETE FROM work_tool_results WHERE action_id=%s',(aid,))
                elif change=='corrupt_blob':db.execute('UPDATE work_tool_results SET sha256=%s WHERE action_id=%s',('0'*64,aid))
            with pytest.raises(WorkConflict):await f.verifier.verify(b.context,SUMMARY)
            assert len(f.calls)==1
    asyncio.run(check())


def test_verdict_with_tool_request_never_accepted():
    with pytest.raises(WorkConflict,match='review_invalid'):
        _verdict(ModelResponse(parts=[TextPart(ACCEPT),ToolCallPart('publish',{})]))


def test_producer_blob_deleted_during_review_is_not_durable_proof(setup):
    async def check():
        f=setup;b=await prepared(f)
        with binding(b):
            prod=await producer(f,b);await publication(f,b)
            observed=await f.receipts.load(prod['id'],task_id=b.context.task_id,run_id=b.context.run_id,intent_digest=prod['intent_digest'])
            def corrupt(req):
                (f.receipts.files.directory/observed.metadata['sha256']).write_bytes(b'corrupt synthetic receipt')
            f.hook=corrupt
            from openbot_server.database import StoreUnavailable
            with pytest.raises(StoreUnavailable,match='work_file_integrity'):await f.verifier.verify(b.context,SUMMARY)
            assert len(f.calls)==2
    asyncio.run(check())


def test_actual_sdk_wrong_task_binding_cannot_review(setup):
    async def check():
        f=setup;b=await prepared(f)
        with binding(b):
            await producer(f,b);await publication(f,b)
            b.context=replace(b.context,task_id=str(uuid4()))
            with pytest.raises(WorkConflict):await f.verifier.verify(b.context,SUMMARY)
            assert len(f.calls)==1
    asyncio.run(check())


def test_reads_private_envelope_public_projection():
    pytest.importorskip('openbot_server.work_product_reads')
    intent={'tool':'read_task_status','effect':{'source':{'internal':'private-source'},'attachment':None}}
    value={'kind':'work_reads','version':1,'operation':'read_task_status',
        'result':[{'title':'Task','status':'open'}], 'receipt':{'source':intent['effect']['source'],'attachment':None}}
    assert _public(value,intent)==value['result']
    with pytest.raises(WorkConflict):_public({**value,'receipt':{}},intent)


def test_truncated_model_verdict_not_accepted():
    with pytest.raises(WorkConflict,match='review_invalid'):
        _verdict(ModelResponse(parts=[TextPart(ACCEPT)],finish_reason='length'))
