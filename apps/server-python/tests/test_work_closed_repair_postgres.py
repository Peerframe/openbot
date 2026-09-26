"""Actual persisted commands after closure; model/effect execution is never reopened."""
import asyncio
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import pytest
pytest.importorskip('temporalio')
pytest.importorskip('pydantic_ai')
from test_work_deferred_postgres import harness, decide_http, PROPOSAL
from test_work_engine_binding_postgres import settings
from test_work_worker_postgres import setup
from openbot_server import work_closed_repair as repair
from openbot_server.work_engine_binding import assert_historical_workflow
from openbot_server.work_reconciliation import ReconciliationStore
from openbot_server.work_values import WorkConflict


async def prepared(fixture,tmp_path):
    a,s,t,e,_,_,current,stack=await harness(fixture,tmp_path)
    with stack:
        action=await a.prepare(PROPOSAL);decide_http(fixture,s,action);current['activity']='execute'
        e.lookup_error=TimeoutError();assert (await a.execute(action))['status']=='unknown'
    snapshot=await s.snapshot(fixture['token'],t['id']);row=snapshot['actions'][0]
    commands=ReconciliationStore(s)
    async def command(sequence):
        return await commands.request(fixture['token'],action,intent_digest=row['intentDigest'],
            request_key=f'repair-{action}-{sequence}',expected_sequence=sequence,reason='Inspect historical receipt')
    async def bind(*_args,**_kwargs):
        async with s._transaction(trusted=True) as db:
            _,stored=await s._action(db,action)
        return SimpleNamespace(task_id=t['id'],run_id=t['runs'][0]['id']),stored
    from test_work_effects_postgres import TrustedVerifier
    loader=AsyncMock(return_value=repair.LookupServices(e.lookup,TrustedVerifier(e)))
    activity=repair.ClosedRepairActivities(s,None,namespace='namespace',queue='queue',
                                          workflow_type='OpenBotWorkV1',load_lookup=loader)
    return activity,s,t,e,commands,command,bind,loader,dict(taskId=t['id'],runId=t['runs'][0]['id'],actionId=action)


@pytest.mark.parametrize('close',['cancel','revoke'])
def test_bad_then_good_cycle_keeps_budget_and_never_reexecutes_after_closure(fixture,tmp_path,close):
    async def check():
        a,s,t,e,commands,command,bind,loader,value=await prepared(fixture,tmp_path)
        await getattr(s,close)(fixture['token'],t['id'])
        first=await command(0);identity=value|dict(commandId=first['id'])
        await commands.acknowledge(first['id'],'original-delivery')
        with patch.object(repair,'bind_repair_activity',bind):
            assert await a.reconcile(identity)==dict(commandId=first['id'],outcome='unresolved')
            snap=await s.snapshot(fixture['token'],t['id'])
            assert snap['usage']['reservedTokens']==3 and snap['usage']['spentTokens']==0
            e.lookup_error=None
            second=await command(1);second_id=value|dict(commandId=second['id'])
            assert await a.reconcile(second_id)==dict(commandId=second['id'],outcome='resolved')
            count=loader.await_count;before=await s.snapshot(fixture['token'],t['id'])
            loader.side_effect=AssertionError('Finished command cannot load services')
            assert (await a.reconcile(identity))['outcome']=='unresolved'
            assert (await a.reconcile(second_id))['outcome']=='resolved'
            assert loader.await_count==count and await s.snapshot(fixture['token'],t['id'])==before
            assert not before['authorityActive'] and not before['artifacts']
            assert len(before['actions'])==1 and len(e.applies)==1 and before['usage']['reservedTokens']==0
            saved=await commands.read(first['id'],task_id=value['taskId'],run_id=value['runId'],action_id=value['actionId'])
            assert saved['delivery_reference']=='original-delivery'
    asyncio.run(check())


def test_historical_binding_keeps_all_provenance_after_cancel_and_revoke(fixture,tmp_path):
    async def check():
        s,t,_,_,_,facts,context,_,_=await setup(fixture,tmp_path)
        identity=dict(taskId=t['id'],runId=context.run_id)
        await s.cancel(fixture['token'],t['id'])
        before=await s.snapshot(fixture['token'],t['id'])
        assert (await assert_historical_workflow(s,identity,facts,**settings())).run_id==context.run_id
        for field,value in [('first_run_id','wrong'),('namespace','wrong'),('queue','wrong'),
             ('start_queue','wrong'),('workflow_type','wrong'),('start_input',identity|dict(attemptId='f'*32))]:
            with pytest.raises(WorkConflict):
                await assert_historical_workflow(s,identity,replace(facts,**{field:value}),**settings())
        assert await s.snapshot(fixture['token'],t['id'])==before
    asyncio.run(check())
