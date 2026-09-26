"""Deferred approval uses the original Action, actual HTTP decisions and real control transactions."""
import asyncio
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import psycopg
import pytest
pytest.importorskip('temporalio', reason='optional Worker SDK profile')
pytest.importorskip('pydantic_ai', reason='optional Worker SDK profile')
from test_work_worker_postgres import setup
from test_work_effects_postgres import OwnedEffectService, TrustedVerifier
from openbot_server import work_deferred as deferred
from openbot_server.work_runtime_ports import WorkRuntimeDeps
from openbot_server.work_values import WorkConflict, InvalidWork
from openbot_server.work_reconciliation import ReconciliationStore
from openbot_agent_runtime.catalog import ToolCatalog
from openbot_agent_runtime.contracts import ToolDescriptor
from fastapi.testclient import TestClient
from openbot_server.app import create_app
from openbot_server.database import PostgresReadStore

PROPOSAL = dict(call_id='model-correlation', tool='update', arguments={'value':'exact'})
CATALOG = ToolCatalog((ToolDescriptor('update','Reviewed update',{'type':'object','properties':{'value':{'const':'exact'}},
                       'required':['value'],'additionalProperties':False}),), max_tools=8, max_bytes=4096)


async def harness(fixture,tmp_path):
    service,task,host,_,_,engine_facts,context,_,_=await setup(fixture,tmp_path)
    host.ports.deferred_catalog=AsyncMock(return_value=CATALOG)
    effect=OwnedEffectService(); verifier=TrustedVerifier(effect)
    planner=AsyncMock(return_value=deferred.DeferredPlan({'operation':'write','value':'exact'},3))
    loader=AsyncMock(return_value=deferred.EffectServices(effect,verifier))
    activities=deferred.DeferredActivities(host,planner,loader)
    accepted=SimpleNamespace(task_id=context.task_id,run_id=context.run_id,namespace='fixture',
        workflow_id='openbot-work-v1-'+context.run_id,engine_run_id='engine',first_run_id='engine')
    current={'activity':'prepare'}
    async def bind(*args,**kwargs):return accepted,current['activity']
    async def claim(store,identity,activity_id,**kwargs):return await store.claim(identity.task_id,identity.run_id,activity_id)
    stack=ExitStack()
    stack.enter_context(patch.object(deferred,'_bind_activity_identity',bind))
    stack.enter_context(patch.object(deferred,'_claim_bound_activity',claim))
    stack.enter_context(patch.object(activities,'_context',AsyncMock(return_value=context)))
    async def failed_binding(*args,**kwargs):
        from openbot_server.work_engine_binding import assert_failed_workflow
        from test_work_engine_binding_postgres import settings
        return await assert_failed_workflow(service,dict(taskId=context.task_id,runId=context.run_id),
                                            engine_facts,**settings())
    stack.enter_context(patch.object(deferred,'bind_failed_activity',failed_binding))
    return activities,service,task,effect,planner,loader,current,stack


def test_bounded_prepared_arguments_recover_original_proposal_without_replanning(fixture,tmp_path):
    async def check():
        a,s,t,e,p,l,current,stack=await harness(fixture,tmp_path)
        a.host.large_tool_arguments=True
        a.host.ports.deferred_catalog=AsyncMock(return_value=ToolCatalog((ToolDescriptor('update','Prepared input',
            dict(type='object',properties=dict(value={'type':'string'}),required=['value'],additionalProperties=False)),),
            max_tools=8,max_bytes=4096))
        p.return_value=deferred.DeferredPlan({'operation':'write'},0,False,prepared_arguments={'blob':'control-descriptor'})
        proposal=dict(call_id='c',tool='update',arguments={'value':'x'*24000})
        with stack:
            identity=await a.prepare(proposal)
            snapshot=await s.snapshot(fixture['token'],t['id'])
            from openbot_server.work_values import canonical
            with psycopg.connect(fixture['dsn']) as db:
                intent=db.execute('SELECT intent FROM work_actions WHERE id=%s',(identity,)).fetchone()[0]
            assert canonical(intent)[1]==snapshot['actions'][0]['intentDigest']
            assert intent['proposalSha256']==canonical(proposal['arguments'],max_bytes=65536)[1]
            assert intent['arguments']=={'blob':'control-descriptor'}
            p.side_effect=AssertionError('original proposal must not be repacked')
            assert await a.prepare(proposal)==identity
            with pytest.raises(WorkConflict,match='action_content_changed'):
                await a.prepare({**proposal,'arguments':{'value':'y'*24000}})
            assert p.await_count==1
    asyncio.run(check())


def decide_http(fixture,service,action_id,approved=True):
    app=create_app(PostgresReadStore(fixture['dsn']),owner_name=fixture['ownerName'],secure_cookies=False,
                   allowed_origins=('http://control.test',),work=service)
    with TestClient(app,base_url='http://control.test') as client:
        path='/api/v1/actions/'+action_id+'/decision'
        client.headers['Origin']='http://control.test'
        assert client.post(path,json={'intentDigest':'0'*64,'approved':True}).status_code==401
        client.headers['Origin']='http://control.test';client.cookies.set('openbot_session',fixture['token'])
        assert client.post(path,json={'intentDigest':'0'*64,'approved':True}).status_code==409
        with psycopg.connect(fixture['dsn']) as db:
            digest=db.execute('SELECT intent_digest FROM work_actions WHERE id=%s',(action_id,)).fetchone()[0]
        assert client.post(path,json={'intentDigest':digest,'approved':approved,'grant':True}).status_code==422
        answer=client.post(path,json={'intentDigest':digest,'approved':approved})
        assert answer.status_code==200,answer.text
        assert client.post('/api/v1/actions/'+action_id+'/resolve',json={'applied':True}).status_code==405


def test_prepare_replay_and_approved_execution_never_replan(fixture,tmp_path):
    async def check():
        a,s,t,e,p,l,current,stack=await harness(fixture,tmp_path)
        with stack:
            identity=await a.prepare(PROPOSAL)
            with pytest.raises(WorkConflict,match='action_not_authorized'):await a.execute(identity)
            with psycopg.connect(fixture['dsn']) as db:
                db.execute("UPDATE work_claims SET expires_at=clock_timestamp()-interval '1 second' WHERE run_id=%s",(t['runs'][0]['id'],))
            p.side_effect=AssertionError('replanning forbidden')
            assert await a.prepare({**PROPOSAL,'call_id':'new-correlation'})==identity
            with pytest.raises(WorkConflict,match='action_content_changed'):
                await a.prepare({**PROPOSAL,'arguments':{'value':'other'}})
            decide_http(fixture,s,identity)
            current['activity']='execute'
            assert await a.execute(identity)==dict(actionId=identity,status='applied')
            assert await a.execute(identity)==dict(actionId=identity,status='applied')
            assert p.await_count==1 and len(e.applies)==1 and len(e.lookups)==1
    asyncio.run(check())


def test_pending_readiness_does_not_admit_claim_or_load_effect(fixture,tmp_path):
    async def check():
        a,s,t,e,p,l,current,stack=await harness(fixture,tmp_path)
        a.readiness=AsyncMock(return_value='pending')
        with stack:
            identity=await a.prepare(PROPOSAL)
            assert (await a.state(identity))['status']=='pending'
            assert a.readiness.await_count==0  # Owner approval still takes precedence.
            decide_http(fixture,s,identity)
            before=await s.snapshot(fixture['token'],t['id'])
            current['activity']='waiting'
            assert (await a.state(identity))['status']=='pending'
            assert (await a.execute(identity))['status']=='pending'
            assert await s.snapshot(fixture['token'],t['id'])==before
            assert not e.applies and l.await_count==0
            a.readiness.return_value='ready';current['activity']='execute-ready'
            assert (await a.state(identity))['status']=='approved'
            assert (await a.execute(identity))['status']=='applied'
            a.readiness.side_effect=AssertionError('An applied operation must only read its recorded result')
            assert (await a.execute(identity))['status']=='applied'
            assert len(e.applies)==1
    asyncio.run(check())


@pytest.mark.parametrize('closure',['cancel','revoke','expire','deny'])
def test_no_write_after_pending_authority_or_decision_refusal(fixture,tmp_path,closure):
    async def check():
        a,s,t,e,p,l,current,stack=await harness(fixture,tmp_path)
        with stack:
            identity=await a.prepare(PROPOSAL)
            if closure=='deny':decide_http(fixture,s,identity,False)
            elif closure=='expire':
                decide_http(fixture,s,identity)
                with psycopg.connect(fixture['dsn']) as db:
                    db.execute("UPDATE work_actions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=%s",(identity,))
            else:await getattr(s,closure)(fixture['token'],t['id'])
            current['activity']='execute'
            with pytest.raises(WorkConflict):await a.execute(identity)
            assert not e.applies and l.await_count==0
            if closure in ('expire','deny'):
                expected='expired' if closure=='expire' else 'denied'
                stopped=await a.stop(identity)
                assert stopped==dict(taskId=t['id'],status='failed',reason=expected)
                assert await a.stop(identity)==stopped
                snap=await s.snapshot(fixture['token'],t['id'])
                assert not snap['authorityActive'] and sum(e['kind']=='task.failed' for e in snap['events'])==1
    asyncio.run(check())


def test_unknown_owner_command_records_delivery_and_verified_resolution_without_reapply(fixture,tmp_path):
    async def check():
        a,s,t,e,p,l,current,stack=await harness(fixture,tmp_path)
        with stack:
            identity=await a.prepare(PROPOSAL);decide_http(fixture,s,identity);current['activity']='execute'
            e.lose_apply_response=True;e.lookup_error=TimeoutError('unobservable')
            assert (await a.execute(identity))['status']=='unknown'
            snap=await s.snapshot(fixture['token'],t['id']);row=snap['actions'][0]
            assert snap['usage']['reservedTokens']==3 and snap['usage']['spentTokens']==0
            commands=ReconciliationStore(s)
            command=await commands.request(fixture['token'],identity,intent_digest=row['intentDigest'],
                request_key='deferred-repair-'+identity,expected_sequence=0,reason='Inspect original effect')
            assert not command['delivered'] and command['outcome'] is None
            assert (await a.state(identity))['commandId']==command['id']
            current['activity']='repair';e.lookup_error=None
            result=await a.reconcile(dict(actionId=identity,commandId=command['id']))
            assert result['status']=='applied' and len(e.applies)==1
            state=await commands.read(command['id'],task_id=t['id'],run_id=t['runs'][0]['id'],action_id=identity)
            assert state['delivered_at'] is not None and state['outcome']=='resolved'
            before=len(e.lookups);assert await a.reconcile(dict(actionId=identity,commandId=command['id']))==result
            assert len(e.lookups)==before and p.await_count==1
    asyncio.run(check())


def test_schema_refusal_and_planning_cancel_leave_no_action(fixture,tmp_path):
    async def check():
        a,s,t,e,p,l,current,stack=await harness(fixture,tmp_path)
        with stack:
            from openbot_agent_runtime.errors import RuntimeFailure
            with pytest.raises(RuntimeFailure):await a.prepare({**PROPOSAL,'arguments':{'value':'wrong'}})
            assert p.await_count==0
            async def cancelled(*args):
                await s.cancel(fixture['token'],t['id'])
                return deferred.DeferredPlan({'operation':'write'},3)
            p.side_effect=cancelled
            with pytest.raises(WorkConflict):await a.prepare(PROPOSAL)
            assert not (await s.snapshot(fixture['token'],t['id']))['actions'] and not e.applies
    asyncio.run(check())


def test_recovery_after_cancel_during_lookup_records_truth_without_authority(fixture,tmp_path):
    async def check():
        a,s,t,e,p,l,current,stack=await harness(fixture,tmp_path)
        with stack:
            identity=await a.prepare(PROPOSAL);decide_http(fixture,s,identity);current['activity']='execute'
            e.lookup_error=TimeoutError();assert (await a.execute(identity))['status']=='unknown';e.lookup_error=None
            original=e.lookup
            async def close_then_lookup(action_id):
                await s.cancel(fixture['token'],t['id'])
                return await original(action_id)
            e.lookup=close_then_lookup;current['activity']='recover'
            assert (await a.execute(identity))['status']=='applied'
            snap=await s.snapshot(fixture['token'],t['id'])
            assert snap['status']=='cancelled' and snap['cancelRequested'] and not snap['authorityActive']
            assert len(e.applies)==1
    asyncio.run(check())


def test_planner_input_mutation_does_not_change_original_proposal(fixture,tmp_path):
    async def check():
        a,s,t,e,p,l,current,stack=await harness(fixture,tmp_path)
        with stack:
            def mutate(context,request):
                request.arguments['value']='changed by trusted planner'
                return deferred.DeferredPlan({'operation':'normalized'},3)
            p.side_effect=mutate
            identity=await a.prepare(PROPOSAL)
            assert await a.prepare(PROPOSAL)==identity
            snap=await s.snapshot(fixture['token'],t['id'])
            assert snap['actions'][0]['intent']['arguments']==PROPOSAL['arguments'] and p.await_count==1
    asyncio.run(check())


@pytest.mark.parametrize('task_status,run_status',[('open','failed'),('failed','running'),
                                                 ('cancelled','failed'),('failed','cancelled')])
def test_failed_readback_requires_both_original_terminal_states(fixture,tmp_path,task_status,run_status):
    async def check():
        from dataclasses import replace
        from openbot_server.work_engine_binding import assert_failed_workflow
        from test_work_engine_binding_postgres import settings
        s,t,_,_,_,facts,context,_,_=await setup(fixture,tmp_path)
        identity=dict(taskId=context.task_id,runId=context.run_id)
        with psycopg.connect(fixture['dsn']) as db:
            db.execute('UPDATE work_tasks SET status=%s,authority_active=false WHERE id=%s',(task_status,t['id']))
            db.execute('UPDATE work_runs SET status=%s WHERE id=%s',(run_status,context.run_id))
        before=await s.snapshot(fixture['token'],t['id'])
        with pytest.raises(WorkConflict,match='failure_not_recorded'):
            await assert_failed_workflow(s,identity,facts,**settings())
        assert await s.snapshot(fixture['token'],t['id'])==before
        with psycopg.connect(fixture['dsn']) as db:
            db.execute("UPDATE work_tasks SET status='failed' WHERE id=%s",(t['id'],))
            db.execute("UPDATE work_runs SET status='failed' WHERE id=%s",(context.run_id,))
        assert (await assert_failed_workflow(s,identity,facts,**settings())).run_id==context.run_id
        before=await s.snapshot(fixture['token'],t['id'])
        for field,value in [('first_run_id','different'),('queue','different'),('workflow_type','different'),
                            ('start_input',identity|dict(attemptId='f'*32))]:
            with pytest.raises(WorkConflict):
                await assert_failed_workflow(s,identity,replace(facts,**{field:value}),**settings())
        assert await s.snapshot(fixture['token'],t['id'])==before
    asyncio.run(check())
