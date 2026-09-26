"""Real SDK subprocess + owned PostgreSQL authority + real retained bytes, deterministic model."""
import asyncio
from pathlib import Path

import psycopg
import pytest

from openbot_server.execution_completion import PendingSteering
from openbot_server.execution_store import PostgresExecutionStore
from openbot_server.run_command_store import PostgresRunCommandStore
from openbot_server.runtime_host import RuntimeHost
from openbot_server.runtime_ports import ModelIdentity, ModelStep, RuntimeBudget, RuntimeDenied, RuntimePorts, RuntimeTool
from test_execution_postgres import artifact, counts, events, evidence, execution, read, running
from test_runtime_sdk_integration import PYTHON, run as run_sdk

pytestmark = pytest.mark.skipif(not PYTHON.exists(),reason='Bootstrap the separately installed SDK worker')


async def host(fixture, target, generate, tools=()):
    store=PostgresExecutionStore(fixture['dsn'])
    async def corrections():
        return [{key:item[key] for key in ('id','instruction')} for item in await store.steering(target)]
    ports=RuntimePorts(ModelIdentity('deepseek','fixture'),generate,lambda:store.assert_active(target),corrections,
        lambda value:store.usage(target,value),lambda stage,text:store.progress(target,stage,text),tools)
    history=await store.context(target)
    return RuntimeHost(ports,instructions='Check evidence before delivery.',
        messages=[{'role':'user','content':item['content']} for item in history],budget=RuntimeBudget())


def test_real_sdk_report_uses_persisted_authority_usage_correction_and_full_completion(execution):
    fixture=execution
    target,_=running(fixture,'SDK full delivery')
    memory,skill=evidence(fixture,target)
    async def check():
        store=PostgresExecutionStore(fixture['dsn'])
        correction=await PostgresRunCommandStore(fixture['dsn']).steer(fixture['token'],target.id,'Separate evidence from inference.')
        records,calls=[],[]
        async def validate(value):
            if value!={'content':'# Evidence\nVerified locally.\n'}: raise RuntimeDenied('invalid_target')
            return value
        async def write(value,context):
            await store.assert_active(target)
            records.append(artifact(fixture,target,value['content']))
            return records[-1]['artifact']
        tool=RuntimeTool('write_report','Persist the checked Markdown report.',
            {'type':'object','properties':{'content':{'type':'string'}},'required':['content'],'additionalProperties':False},
            validate,write,False,4096)
        async def generate(request,emit):
            calls.append(request)
            assert 'Separate evidence from inference.' in request.messages[-1]['content']
            if len(calls)==1:
                return ModelStep('',[{'id':'report-1','name':'write_report','arguments':{'content':'# Evidence\nVerified locally.\n'}}],
                    'tool-calls',None,1)
            assert request.messages[-2]['content'][0]['output']['value']==records[0]['artifact']
            return ModelStep('Delivered checked evidence.',[],'stop',8,2)
        result=await run_sdk(await host(fixture,target,generate,(tool,)))
        assert result['appliedCorrectionIds']==[correction.id] and len(records)==1
        committed=await store.complete(target,result['text'],artifacts=records,references=[memory],skill_references=[skill],
            proposal={'kind':'procedural','title':'Source separation','content':'Keep evidence and inference separate.'},
            applied_steering_ids=result['appliedCorrectionIds'])
        assert committed.run.status=='completed' and counts(fixture,target.id)==(1,1,1)
        assert committed.run.modelUsage.steps==2 and committed.run.modelUsage.inputTokens is None
        assert committed.run.modelUsage.outputTokens==3
        assert (Path(fixture['artifactDirectory'])/records[0]['storageKey']).read_text()=='# Evidence\nVerified locally.\n'
    asyncio.run(check())


@pytest.mark.parametrize('revocation',['membership','cancel'])
def test_real_sdk_late_model_result_after_persisted_revocation_cannot_run_tools_or_publish(execution,revocation):
    fixture=execution
    target,_=running(fixture,'SDK revoked '+revocation)
    async def check():
        effects=[]
        async def validate(value): return value
        async def effect(value,context): effects.append(value);return {'ok':True}
        tool=RuntimeTool('effect','Fixture-only effect.',{'type':'object','properties':{},'additionalProperties':False},validate,effect,False,1024)
        async def generate(request,emit):
            if revocation=='cancel':
                await PostgresRunCommandStore(fixture['dsn']).cancel(fixture['token'],target.id)
            else:
                async with await psycopg.AsyncConnection.connect(fixture['dsn']) as connection:
                    await connection.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(target.channelId,target.botId))
            return ModelStep('Late.',[{'id':'late','name':'effect','arguments':{}}],'tool-calls',10,2)
        with pytest.raises(RuntimeDenied) as denied:
            await run_sdk(await host(fixture,target,generate,(tool,)))
        assert denied.value.code==('scope_revoked' if revocation=='membership' else 'conflict')
        assert not effects and counts(fixture,target.id)==(0,0,0)
        assert read(fixture,target.id).modelUsage is None
        assert not any(kind=='RUN_COMPLETED' for kind,_ in events(fixture,target.id))
    asyncio.run(check())


def test_correction_committed_after_real_sdk_finish_requires_new_model_turn_before_publish(execution):
    fixture=execution
    target,_=running(fixture,'SDK final correction')
    async def check():
        async def generate(request,emit): return ModelStep('First answer.',[],'stop',1,1)
        result=await run_sdk(await host(fixture,target,generate))
        await PostgresRunCommandStore(fixture['dsn']).steer(fixture['token'],target.id,'Check the last fact.')
        with pytest.raises(PendingSteering):
            await PostgresExecutionStore(fixture['dsn']).complete(target,result['text'],applied_steering_ids=result['appliedCorrectionIds'])
        assert counts(fixture,target.id)==(0,0,0) and read(fixture,target.id).status=='running'
    asyncio.run(check())
