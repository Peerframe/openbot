"""Integrated product ports, actual SQL/receipts and synthetic provider responses."""
import asyncio
from dataclasses import replace
import json
from types import SimpleNamespace

import httpx2
import psycopg
import pytest
pytest.importorskip('temporalio',reason='optional Worker SDK profile')
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.testing import ActivityEnvironment

from openbot_server.owner_files import OwnerFiles
from openbot_server.work_product_runtime import ProductWorkRuntime
from openbot_server.work_sources import WorkSourceAdmission
from openbot_server.work_worker import WorkActivities, TYPE
from openbot_server.work_values import WorkConflict
from test_work_product_model import setup, bound, binding, product, request, response, CONFIG, SCOPE
from test_work_task_profiles import setup as native_setup, bound as native_bound


@pytest.fixture
def configured(setup,tmp_path):
    f=setup
    f.store.files=f.receipts.files
    files=tmp_path/'attachments';files.mkdir(mode=0o700)
    f.owner=SimpleNamespace(files=OwnerFiles(files),model=f.settings,model_connections=f.connections,plugins=None)
    yield f
    with psycopg.connect(f.dsn) as db:
        db.execute('DELETE FROM work_tool_results WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(f.bot,))


def test_initial_product_load_freezes_context_before_prompt_and_catalog(configured):
    async def check():
        f=configured;b=await bound(f)
        scope={**SCOPE,'expected_workflow_type':TYPE}
        b.facts=replace(b.facts,workflow_type=TYPE)
        client=SimpleNamespace(namespace='default',config=lambda:dict(plugins=[PydanticAIPlugin()]))
        runtime=ProductWorkRuntime(f.store,client,scope,f.owner,model=product(f),
            sources=WorkSourceAdmission(f.store,token_limit=1000))
        host=WorkActivities(f.store,client,namespace='default',queue=SCOPE['expected_queue'],
                            **{k:v for k,v in runtime.options().items() if k!='load_lookup'})
        with binding(b):
            result=await ActivityEnvironment().run(host.load_task,dict(taskId=b.context.task_id,runId=b.context.run_id))
        assert result['correctionProtocol']==result['correctionHistoryProtocol']==1
        assert result['largeToolArgumentsProtocol']==result['toolResultProtocol']==1
        assert result['collaborationProtocol']==1
        assert 'Current Owner task:' in result['prompt'] and b.context.objective in result['prompt']
        assert {'write_report','read_attachment','knowledge_catalog'}<={tool['name'] for tool in result['deferredTools']}
        assert {'start_task','wait_for_task','delegate_task'}<={tool['name'] for tool in result['deferredTools']}
        assert 'call_plugin' not in {tool['name'] for tool in result['deferredTools']}
        assert 'fetch' in {tool['name'] for tool in result['deferredTools']}
        assert 'web_search' not in {tool['name'] for tool in result['deferredTools']}
        assert not f.calls
    asyncio.run(check())


def test_product_model_review_and_atomic_channel_publication(configured):
    async def check():
        f=configured;await f.settings.save(CONFIG);b=await bound(f)
        def provider(req):
            answer=response(req)
            if len(f.calls)>1:
                answer['output'][0]['content'][0]['text']=json.dumps(dict(accepted=True,reason='Answer is supported.'))
            return httpx2.Response(200,json=answer)
        model=product(f,provider)
        runtime=ProductWorkRuntime(f.store,object(),SCOPE,f.owner,model=model,web=False)
        with binding(b):
            services=await runtime.load_services(b.context)
            answer=await services.model_step(request())
            assert answer.text=='Checked answer'
            b.activity='publication'
            fence=await runtime.binding.claim(b.context)
            result=await runtime.verifier.verify(b.context,answer.text)
            async with runtime.validation_scope(b.context):
                completed=await f.store.complete(b.context.task_id,b.context.run_id,fence=fence,
                    expected_revision=result.observed_revision,summary=answer.text,artifacts=result.artifacts,
                    verification=result.verification,correction_context=b.context.correction_token,
                    publication=lambda db:runtime.publication(b.context,db))
            assert completed['status']=='completed' and len(f.calls)==2
        with psycopg.connect(f.dsn) as db:
            assert db.execute("SELECT count(*) FROM messages WHERE id=%s AND content='Checked answer'",
                ('work-result:'+b.context.task_id,)).fetchone()[0]==1
            assert db.execute("SELECT count(*) FROM work_actions WHERE task_id=%s AND status='applied'",
                (b.context.task_id,)).fetchone()[0]==2
    asyncio.run(check())


def test_product_validation_never_accepts_an_expired_outer_scope(configured):
    async def check():
        f=configured;b=await bound(f)
        runtime=ProductWorkRuntime(f.store,object(),SCOPE,f.owner,model=product(f),web=False)
        with binding(b):
            await runtime.binding.claim(b.context)
            async with runtime.validation_scope(b.context):
                async with f.store._transaction(trusted=True) as db:
                    assert await runtime.validate_current(db,b.context) is True
            async with f.store._transaction(trusted=True) as db:
                with pytest.raises(WorkConflict,match='validation_scope_required'):
                    await runtime.validate_current(db,b.context)
    asyncio.run(check())


def test_native_runtime_uses_own_profile_and_completes_without_channel_tools(native_setup,tmp_path):
    async def check():
        f=native_setup;await f.settings.save(CONFIG);b=await native_bound(f)
        attachments=tmp_path/'unused-attachments';attachments.mkdir(mode=0o700)
        owner=SimpleNamespace(files=OwnerFiles(attachments),model=f.settings,model_connections=f.connections,plugins=None)
        def provider(req):
            answer=response(req)
            if len(f.calls)>1:
                answer['output'][0]['content'][0]['text']=json.dumps(dict(accepted=True,reason='Supplied facts match.'))
            return httpx2.Response(200,json=answer)
        scope={**SCOPE,'expected_workflow_type':TYPE};b.facts=replace(b.facts,workflow_type=TYPE)
        client=SimpleNamespace(namespace='default',config=lambda:dict(plugins=[PydanticAIPlugin()]))
        model=product(f,provider);model.scope=scope
        runtime=ProductWorkRuntime(f.store,client,scope,owner,model=model)
        host=WorkActivities(f.store,client,namespace='default',queue=SCOPE['expected_queue'],
            **{k:v for k,v in runtime.options().items() if k!='load_lookup'})
        with binding(b):
            initial=await host.load_task(dict(taskId=b.context.task_id,runId=b.context.run_id))
            assert [t['name'] for t in initial['deferredTools']]==['write_report']
            assert '"kind":"task"' in initial['prompt']
            services=await runtime.load_services(b.context)
            answer=await services.model_step(request())
            b.activity='native-publication'
            completed=await host.publish_result(answer.text,b.context.correction_token)
            assert completed['status']=='completed' and len(f.calls)==2
        with psycopg.connect(f.dsn) as db:
            assert db.execute('SELECT count(*) FROM work_sources WHERE task_id=%s',(b.context.task_id,)).fetchone()[0]==0
            assert db.execute('SELECT count(*) FROM runs WHERE bot_id=%s',(f.bot,)).fetchone()[0]==0
            assert db.execute('SELECT count(*) FROM messages WHERE channel_id=%s',(f.channel,)).fetchone()[0]==0
    asyncio.run(check())


def test_explicit_host_search_preserves_private_key_and_rotation_identity(configured):
    async def check():
        f=configured;b=await bound(f)
        runtime=ProductWorkRuntime(f.store,object(),SCOPE,f.owner,model=product(f),tavily_key='synthetic-search-first')
        with binding(b):
            catalog=await runtime.web.catalog(b.context)
            assert catalog['searchProvider']=='tavily'
            prompt=await runtime.load_prompt(b.context)
            assert 'synthetic-search-first' not in prompt
            one=await runtime.search_configuration(None,b.context)
            other=ProductWorkRuntime(f.store,object(),SCOPE,f.owner,model=product(f),tavily_key='synthetic-search-second')
            two=await other.search_configuration(None,b.context)
            assert one.snapshot()!=two.snapshot()
            assert 'synthetic-search-first' not in repr(one)
            assert not f.calls
    asyncio.run(check())
