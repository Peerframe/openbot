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
from openbot_server.owner_files import OwnerFiles
from openbot_server.work_product_reads import ProductWorkReads
from openbot_server.work_product_media import ProductWorkMedia
from openbot_server.work_tool_results import ToolResults
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
from openbot_server.work_product_model import ProductWorkModel
from openbot_server.work_sources import WorkSourceAdmission
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_temporal_start import WorkRuntimeContext
from openbot_server.work_values import InvalidWork, WorkConflict

KEY='synthetic-product-key-never-real'
SCOPE=dict(expected_namespace='default',expected_queue='fixture-queue',expected_workflow_type='fixture-workflow')
CONFIG=dict(provider='openai',model='fixture-model',apiKey=KEY,revision=None,agentEnabled=True)

class FixtureState(SimpleNamespace):
    def __repr__(self): return '<synthetic media fixture>'

@pytest.fixture
def setup(fixture,tmp_path):
    bot,channel=str(uuid4()),str(uuid4())
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("INSERT INTO bots(id,name,role,computer_profile) VALUES(%s,%s,'assistant','none')",(bot,'Product model '+bot))
        db.execute("INSERT INTO channels(id,name,description) VALUES(%s,%s,'Synthetic only')",(channel,'Product model '+channel))
        db.execute('INSERT INTO channel_bots(channel_id,bot_id) VALUES(%s,%s)',(channel,bot))
    base=tmp_path.resolve();base.chmod(0o700);(base/'blobs').mkdir(mode=0o700)
    store=PostgresWorkStore(fixture['dsn'])
    receipts=ModelReceipts(store,LocalWorkFiles(base/'blobs'))
    settings=ModelSettingsService(base/'settings',lambda r:httpx2.Response(200,json={'id':'fixture-model','data':[{'id':'fixture-model'}]}))
    connections=ModelConnectionsService(fixture['dsn'],ModelCredentialCipher(bytes(range(32))))
    (base/'attachments').mkdir(mode=0o700)
    files=OwnerFiles(base/'attachments')
    results=ToolResults(store,receipts.files)
    reads=ProductWorkReads(store,object(),SCOPE,files,results)
    media=ProductWorkMedia(store,object(),SCOPE,files,receipts.files,reads)
    f=FixtureState(files=files,results=results,reads=reads,media=media,**fixture,bot=bot,channel=channel,store=store,receipts=receipts,settings=settings,connections=connections,ids=[],calls=[])
    f.sources=WorkSourceAdmission(store,token_limit=1_000_000)
    yield f
    with psycopg.connect(f.dsn) as db:
        db.execute('DELETE FROM work_tool_results WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(bot,))
        db.execute('DELETE FROM work_task_profiles WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(bot,))
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

async def bound(f,profile='none',connection=None,*,instruction='Synthetic model task'):
    with psycopg.connect(f.dsn) as db:
        db.execute('UPDATE bots SET computer_profile=%s,configuration=%s WHERE id=%s',(profile,Jsonb({'model':{'connectionId':connection['id'],'modelId':'queued-model'}} if connection else {}),f.bot))
    result=await PostgresTaskStore(f.dsn,files=f.files,model_connections=f.connections,work_sources=f.sources).submit(f.token,f.channel,
        CreateMessageInput(content=instruction,botId=f.bot))
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
        transport_factory=lambda:httpx2.MockTransport(send),media=f.media,**options)


@pytest.mark.parametrize('protocol',['responses-v1','chat-completions-v1','anthropic-messages-v1'])
def test_real_postgres_sdk_media_binding_and_historical_recovery(setup,protocol):
    from test_model_media import DATA, response as wire_response
    async def check():
        f=setup
        async with f.files.lock():
            items=[f.files.persist(f.channel,name,data) for name,_,data in DATA]
        instruction='Inspect '+''.join('[OpenBot attachment: '+item['id']+']' for item in items)
        connection=await selected(f) if protocol=='chat-completions-v1' else None
        if connection is None:
            await f.settings.save({**CONFIG,'provider':'anthropic' if protocol.startswith('anthropic') else 'openai'})
        b=await bound(f,'model' if connection else 'none',connection,instruction=instruction)
        def handler(req): return httpx2.Response(200,json=wire_response(json.loads(req.content),protocol))
        with binding(b):
            ref=await f.media.prepare(b.context)
            assert await f.media.prepare(b.context)==ref
            b.activity='model-2'
            result=await product(f,handler).call(b.context,request())
            assert result.text=='Observed'
            await f.media.revalidate(b.context)
            before=len(f.calls)
            with patch.object(f.media,'hydrate',side_effect=AssertionError('recovery hydrated')):
                assert (await product(f,handler).call(b.context,request())).text=='Observed'
            assert len(f.calls)==before==1
        snap=await f.store.snapshot(f.token,b.context.task_id)
        assert len(snap['actions'])==1
        action=snap['actions'][0]
        assert action['intent']['inputMedia']==ref and action['reservedTokens']>=3*8192+4096
        serialized=json.dumps(action['intent'])
        assert 'base64' not in serialized and '年度报告' not in serialized
        async with f.store._transaction(trusted=True) as db:
            events=await (await db.execute("SELECT payload FROM work_events WHERE task_id=%s AND kind='model.media_bound'",(b.context.task_id,))).fetchall()
        assert len(events)==1 and events[0]['payload']==dict(runId=b.context.run_id,inputMedia=ref)
        wire=json.loads(f.calls[0].content)
        assert '年度报告.pdf' in json.dumps(wire,ensure_ascii=False)
    asyncio.run(check())


async def media_task(f, *, data=None, name='Original.pdf', prepare=True):
    from test_model_media import PDF
    await f.settings.save(CONFIG)
    async with f.files.lock(): item=f.files.persist(f.channel,name,PDF if data is None else data)
    b=await bound(f,instruction='Inspect [OpenBot attachment: '+item['id']+']')
    with binding(b):
        if prepare: await f.media.prepare(b.context)
    b.activity='model-2'
    return b,item


@pytest.mark.parametrize('change',['deleted','metadata','original','membership','cancel','source','context'])
def test_current_authority_changes_prevent_new_send(setup,change):
    async def check():
        f=setup;b,item=await media_task(f)
        if change=='deleted':
            async with f.files.lock(): f.files.set_deleted(f.channel,item['id'],True)
        elif change=='metadata':
            async with f.files.lock():
                f.files._write(item['id']+'.json',json.dumps({**item,'name':'Changed.pdf'}).encode())
        elif change=='original':
            async with f.files.lock(): f.files._write(item['id']+'.bin',b'changed')
        elif change=='cancel': await f.store.cancel(f.token,b.context.task_id)
        elif change=='context': b.context=replace(b.context,objective='Forged')
        else:
            with psycopg.connect(f.dsn) as db:
                if change=='membership': db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(f.channel,f.bot))
                else: db.execute("UPDATE runs SET instruction='changed' WHERE id=%s",(b.source.id,))
        with binding(b),pytest.raises((WorkConflict,ProductModelError)):
            await product(f).call(b.context,request())
        assert not f.calls
    asyncio.run(check())


def test_fresh_before_send_revocation_and_unknown_never_resends(setup):
    async def check():
        f=setup;b,item=await media_task(f)
        async def revoke():
            async with f.files.lock(): f.files.set_deleted(f.channel,item['id'],True)
        with binding(b):
            with pytest.raises(WorkConflict,match='model_observation_unknown'):
                await product(f).call(b.context,request(),before_send=revoke)
            with patch.object(f.media,'hydrate',side_effect=AssertionError('unknown must never hydrate')):
                with pytest.raises(WorkConflict,match='model_observation_unknown'):
                    await product(f).call(b.context,request())
        snap=await f.store.snapshot(f.token,b.context.task_id)
        assert len(snap['actions'])==1 and snap['actions'][0]['status']=='unknown' and not f.calls
    asyncio.run(check())


def test_post_response_revocation_keeps_receipt_but_denies_consumption(setup):
    async def check():
        f=setup;b,item=await media_task(f)
        with binding(b):
            assert (await product(f).call(b.context,request())).text=='Checked answer'
            async with f.files.lock(): f.files.set_deleted(f.channel,item['id'],True)
            # Receipt recovery is historical and deliberately does not hydrate. Root must
            # perform revalidate before AND after consuming it in live Runtime history.
            assert (await product(f).call(b.context,request())).text=='Checked answer'
            with pytest.raises(WorkConflict): await f.media.revalidate(b.context)
        assert len(f.calls)==1
    asyncio.run(check())


def test_unbound_old_run_cannot_gain_media_at_model_step(setup):
    async def check():
        f=setup;b,_=await media_task(f,prepare=False)
        with binding(b),pytest.raises(WorkConflict,match='model_media_binding_required'):
            await product(f).call(b.context,request())
        assert not f.calls
    asyncio.run(check())


def test_unsupported_provider_and_same_task_budget_refuse_before_http(setup):
    async def check():
        f=setup;b,_=await media_task(f)
        current=await f.settings.active()
        await f.settings.save({**CONFIG,'provider':'deepseek','revision':current['revision']})
        with binding(b),pytest.raises(WorkConflict,match='attachment_model_unsupported'):
            await product(f).call(b.context,request())
        assert not f.calls
        current=await f.settings.active()
        await f.settings.save({**CONFIG,'revision':current['revision']})
        with psycopg.connect(f.dsn) as db:
            db.execute('UPDATE work_tasks SET token_limit=10000 WHERE id=%s',(b.context.task_id,))
        b.context=replace(b.context,token_limit=10000)
        with binding(b),pytest.raises(WorkConflict): await product(f).call(b.context,request())
        assert not f.calls
    asyncio.run(check())


def test_complete_ordered_source_set_and_derived_digest_are_immutable(setup):
    async def check():
        f=setup;b,item=await media_task(f)
        async with f.files.lock():
            processing=dict(operation='extract',characters=9,truncated=False,processedAt='2026-09-25T00:00:00.000Z')
            f.files._write(item['id']+'.text.json',json.dumps(dict(text='Extracted',truncated=False,
                sha256=item['sha256'],operation='extract',processedAt=processing['processedAt'])).encode())
            f.files._write(item['id']+'.json',json.dumps({**item,'processing':processing}).encode())
        with binding(b),pytest.raises(WorkConflict,match='attachment_unavailable'):
            await product(f).call(b.context,request())
        assert not f.calls
    asyncio.run(check())


def test_native_task_has_no_attachment_authority(setup):
    async def check():
        from openbot_server.work_product_binding import ProductWorkBinding
        f=setup
        from openbot_server.work_task_profiles import WorkTaskProfiles
        f.store.task_profiles=WorkTaskProfiles()
        # Existing native snapshot contract is used; no fabricated channel mapping is made.
        for objective,denied in [('Plain native task',False),('Read [OpenBot attachment: '+str(uuid4())+']',True)]:
            task=await f.store.create(f.token,bot_id=f.bot,objective=objective,token_limit=100000,request_key=uuid4().hex)
            task=await f.store.snapshot(f.token,task['id'])
            rid=task['runs'][0]['id']; correction=await CorrectionStore(f.store).freeze(task['id'],rid,'initial')
            ctx=WorkRuntimeContext(task['id'],rid,f.bot,objective,100000,correction['id'])
            workflow='openbot-work-v1-'+rid; handoff=HandoffStore(f.store); ref='temporal:default:'+workflow
            reservation=await handoff.reserve_submission(task['id'],rid,ref)
            await handoff.acknowledge(task['id'],rid,ref,reservation.attempt_id,'synthetic-engine')
            facts=EngineActivityFacts(namespace='default',queue=SCOPE['expected_queue'],start_queue=SCOPE['expected_queue'],
                workflow_id=workflow,workflow_type=SCOPE['expected_workflow_type'],engine_run_id='synthetic-engine',
                first_run_id='synthetic-engine',start_input=dict(taskId=task['id'],runId=rid,attemptId=reservation.attempt_id))
            b=SimpleNamespace(context=ctx,facts=facts,activity='bootstrap')
            with binding(b):
                if denied:
                    with pytest.raises(WorkConflict,match='attachment_outside_task'): await f.media.prepare(ctx)
                else:
                    assert await f.media.prepare(ctx) is None and await f.media.binding(ctx) is None
    asyncio.run(check())


@pytest.mark.parametrize('with_media',[True,False])
def test_independent_reviewer_requires_same_original_binary(setup,with_media):
    from openbot_server.work_product_binding import ProductWorkBinding
    from openbot_server.work_product_result import ProductWorkResultVerifier, EvidenceBundle
    async def check():
        f=setup;b,_=await media_task(f)
        def handler(req):
            body=response(req)
            if len(f.calls)==2:
                body['output'][0]['content'][0]['text']='{"accepted":true,"reason":"Supported by the original media"}'
            return httpx2.Response(200,json=body)
        model=product(f,handler)
        async def collect(*_): return EvidenceBundle()
        async def validate(*_): return True
        verifier=ProductWorkResultVerifier(f.store,object(),SCOPE,model,f.receipts,f.results,
            collect_evidence=collect,validate_current=validate,media=f.media if with_media else None)
        with binding(b):
            summary=(await model.call(b.context,request())).text
            b.activity='publication-3'
            await ProductWorkBinding(f.store,object(),SCOPE).claim(b.context)
            if not with_media:
                with pytest.raises(WorkConflict,match='result_media_not_read'): await verifier.verify(b.context,summary)
                assert len(f.calls)==1
                return
            verified=await verifier.verify(b.context,summary)
            assert verified.observed_revision is not None
            # Same publish operation reads its original independent review receipt without
            # another model request, regardless of new SDK Python object identities.
            again=await verifier.verify(b.context,summary)
            assert again.verification==verified.verification
        assert len(f.calls)==2
        payloads=[json.loads(c.content) for c in f.calls]
        pdfs=[[p for m in body['input'] for p in m.get('content',[]) if type(p) is dict and p['type']=='input_file'] for body in payloads]
        assert pdfs[0]==pdfs[1] and len(pdfs[0])==1
    asyncio.run(check())


def test_changed_generation_and_stale_claim_deny_consumption(setup):
    from openbot_server.work_product_binding import ProductWorkBinding
    async def check():
        f=setup;b,_=await media_task(f)
        with binding(b):
            await product(f).call(b.context,request())
            old=b.activity;b.activity='another-activity'
            await ProductWorkBinding(f.store,object(),SCOPE).claim(b.context)
            b.activity=old
            with pytest.raises(WorkConflict): await f.media.revalidate(b.context)
        with psycopg.connect(f.dsn) as db:
            db.execute('UPDATE work_tasks SET authority_generation=authority_generation+1 WHERE id=%s',(b.context.task_id,))
        with binding(b),pytest.raises(WorkConflict): await f.media.revalidate(b.context)
    asyncio.run(check())


def test_empty_derived_content_never_falls_back_to_original_pdf(setup):
    async def check():
        f=setup;b,item=await media_task(f,prepare=False)
        processing=dict(operation='extract',characters=0,truncated=False,processedAt='2026-09-25T00:00:00.000Z')
        async with f.files.lock():
            f.files._write(item['id']+'.text.json',json.dumps(dict(text='',truncated=False,
                sha256=item['sha256'],operation='extract',processedAt=processing['processedAt'])).encode())
            f.files._write(item['id']+'.json',json.dumps({**item,'processing':processing}).encode())
        with binding(b),pytest.raises(WorkConflict,match='attachment_unavailable'): await f.media.prepare(b.context)
        assert not f.calls
    asyncio.run(check())


def test_owner_correction_requires_fresh_context_but_keeps_original_attachment_set(setup):
    from openbot_server.work_corrections import CorrectionsChanged
    from openbot_server.work_product_binding import ProductWorkBinding
    async def check():
        f=setup;b,item=await media_task(f)
        with binding(b):
            ref=await f.media.binding(b.context)
            await product(f).call(b.context,request())
        await CorrectionStore(f.store).request(f.token,b.context.task_id,run_id=b.context.run_id,
            instruction='Focus on risks. [OpenBot attachment: '+str(uuid4())+']',request_key=uuid4().hex,expected_sequence=0)
        with binding(b),pytest.raises(CorrectionsChanged): await f.media.binding(b.context)
        fresh=await CorrectionStore(f.store).freeze(b.context.task_id,b.context.run_id,'after-correction')
        b.context=replace(b.context,correction_token=fresh['id']);b.activity='new-generation-model'
        with binding(b):
            assert await f.media.binding(b.context)==ref
            await ProductWorkBinding(f.store,object(),SCOPE).claim(b.context)
            assert (await f.media.describe(b.context))['attachments'][0]['id']==item['id']
            assert (await product(f).call(b.context,request('Apply the Owner correction'))).text=='Checked answer'
        assert len(f.calls)==2
    asyncio.run(check())


def test_manifest_anchor_conflict_and_forged_reference_cannot_hydrate(setup):
    async def check():
        f=setup;b,_=await media_task(f)
        with binding(b):
            ref=await f.media.binding(b.context)
            with pytest.raises(WorkConflict):
                await f.media.hydrate(b.context,{**ref,'sha256':'b'*64},{'provider':'openai','protocol':'responses-v1'})
            async with f.store._transaction(trusted=True) as db:
                await f.store._task(db,b.context.task_id)
                await f.store._event(db,b.context.task_id,'model.media_bound',dict(runId=b.context.run_id,inputMedia=ref))
            with pytest.raises(WorkConflict,match='model_media_binding_changed'):
                await product(f).call(b.context,request())
        assert not f.calls
    asyncio.run(check())
