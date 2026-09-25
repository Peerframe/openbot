"""Real SQL/Host/crypto product adapter; SDK history, socket and Native are explicit fixtures."""
import asyncio
from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from test_work_command_store import fixture, sdk, SCOPE
from test_work_command_channel import connected
from openbot_agent_runtime.catalog import ToolCatalog
from openbot_server.work_deferred import DeferredActivities
from openbot_server.work_effects import EffectOutcome
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_product_commands import ProductWorkCommands, COMMAND_TOOL
from openbot_server.work_command_contract import CommandContractError
from openbot_server.work_command_v2_contract import TimingPolicy
from openbot_server.work_product_result import ProductWorkResultVerifier, EvidenceBundle, ToolEvidence
from openbot_server.work_tool_results import ToolResults
from openbot_server.work_values import canonical, WorkConflict, InvalidWork


async def product(f):
    path=f.filebase/'private-work';path.mkdir(mode=0o700)
    f.store.files=LocalWorkFiles(path);f.store.command_profiles=f.profiles
    f.results=ToolResults(f.store,f.store.files)
    f.commands=ProductWorkCommands(f.store,f.adapter.client,SCOPE,f.results,f.driver)
    catalog=ToolCatalog((COMMAND_TOOL,),max_tools=8,max_bytes=8192)
    host=SimpleNamespace(store=f.store,client=f.adapter.client,scope=SCOPE,large_tool_arguments=True,
        ports=SimpleNamespace(deferred_catalog=AsyncMock(return_value=catalog)),load_tool_result=f.commands.load_result)
    f.activities=DeferredActivities(host,f.commands.prepare,f.commands.load)
    f.activities._context=AsyncMock(return_value=f.context)
    f.arguments=dict(argv=['python3','-c','synthetic fixture'],
        output=dict(name='result.csv',mediaType='text/csv',maxBytes=65536))
    f.action=await f.activities.prepare_request(dict(call_id='model-proposal',tool='run_command',arguments=f.arguments),
        correction_context=f.context.correction_token)
    async with f.store._transaction(trusted=True) as db:
        _,f.action_row=await f.store._action(db,f.action)
    f.intent=f.action_row['intent']
    # Real Temporal preparation and execution have distinct Activity identities. Reusing the
    # bootstrap fixture's long claim would hide a production claim-budget mismatch.
    f.activity='product-execute-'+f.action


async def decide(f):
    await f.store.decide(f.token,f.action,intent_digest=canonical(f.intent)[1],approved=True)


async def action(f):
    async with f.store._transaction(trusted=True) as db:return (await f.store._action(db,f.action))[1]


def test_original_approval_executes_once_and_full_private_output_reaches_review(fixture):
    async def run():
        data=('类别,金额\n甲,25\n'*1500).encode()
        async with connected(fixture,approved=False,data=data) as f:
            with sdk(f):
                await product(f)
                description=await f.commands.describe(f.context)
                assert description['inputs'][0]['path']=='/input/input-01'
                assert description['inputs'][0]['attachmentId']==f.attachment['id']
                assert f.intent['effect']['command']['inputManifest'][0]['path']=='input-01'
                assert f.intent['effect']['command']['image']==f.policy['image']
                assert not f.wire.sent
                with pytest.raises(WorkConflict,match='action_not_authorized'):await f.activities.execute(f.action)
                await decide(f)
                assert await f.activities.execute(f.action)==dict(actionId=f.action,status='applied')
                before=deepcopy(f.wire.sent)
                assert await f.activities.execute(f.action)==dict(actionId=f.action,status='applied')
                assert f.wire.sent==before and f.native.calls.count('execute')==1
                current=await action(f)
                output=await f.activities.result(f.action)
                assert output['result']['truncated'] is True and output['result']['untrusted'] is True
                assert 'token' not in output['result'] and 'receipt' not in output['result']
                artifacts=await f.commands.artifacts(f.context)
                assert artifacts[0]['data']==data and artifacts[0]['name']=='result.csv'
                observed=await f.results.load(f.action,task_id=f.tid,run_id=f.rid,intent_digest=current['intent_digest'])
                assert f.store.files.read(**dict(digest=observed.value['output']['sha256'],size=len(data)))==data
                reviewer=object.__new__(ProductWorkResultVerifier);reviewer.store=f.store
                reviewer.collect_evidence=AsyncMock(return_value=EvidenceBundle(
                    (ToolEvidence(f.action,output['result']),),artifacts))
                collected,evidence=await reviewer._collect(f.context,'Synthetic result',
                    dict(actions=[current],tools={f.action:observed}))
                assert collected==artifacts and evidence['artifacts'][0]['text'].encode()==data
                assert 'token' not in evidence['tools'][0]['payload']
    asyncio.run(run())


@pytest.mark.parametrize('mutation',['profile','input','policy','node','membership'])
def test_changed_scope_between_approval_and_execution_never_prepares(fixture,mutation):
    async def run():
        async with connected(fixture,approved=False) as f:
            with sdk(f):
                await product(f);await decide(f)
                async with f.store._transaction(trusted=True) as db:
                    if mutation=='profile':await db.execute("UPDATE bots SET computer_profile='none' WHERE id=%s",(f.bot,))
                    elif mutation=='node':await db.execute('UPDATE node_credentials SET revoked_at=clock_timestamp() WHERE node_id=%s',(f.node,))
                    elif mutation=='membership':await db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(f.channel,f.bot))
                if mutation=='policy':f.profiles.policies['offline-command']=('0'*64,f.policy)
                if mutation=='input':
                    with patch.object(f.files,'read',side_effect=WorkConflict('synthetic deleted input')):
                        with pytest.raises(WorkConflict):await f.activities.execute(f.action)
                else:
                    with pytest.raises(WorkConflict):await f.activities.execute(f.action)
                assert not f.wire.sent and not f.native.calls and (await action(f))['status']=='proposed'
    asyncio.run(run())


def test_historical_result_requires_current_scope_and_immutable_blob(fixture):
    async def run():
        async with connected(fixture,approved=False) as f:
            with sdk(f):
                await product(f);await decide(f);await f.activities.execute(f.action)
                current=await action(f)
                async with f.files.lock():
                    async with f.store._transaction(trusted=True) as db:
                        assert await f.commands.revalidate_in_transaction(db,f.context) is True
                with patch.object(f.store.files,'read',side_effect=WorkConflict('synthetic corrupt blob')):
                    with pytest.raises(WorkConflict):await f.commands.load_result(f.context,current)
                async with f.store._transaction(trusted=True) as db:
                    await db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(f.channel,f.bot))
                with pytest.raises(WorkConflict):await f.commands.load_result(f.context,current)
                assert f.native.calls.count('execute')==1
    asyncio.run(run())


def test_lookup_recovers_lost_delivery_ack_without_another_execution(fixture):
    async def run():
        async with connected(fixture,approved=False) as f:
            with sdk(f):
                await product(f);await decide(f)
                original=f.driver.execute
                async def lost(*args,**kwargs):
                    await original(*args,**kwargs)
                    raise OSError('synthetic ACK loss')
                with patch.object(f.driver,'execute',lost):
                    assert (await f.activities.execute(f.action))['status']=='applied'
                assert f.native.calls.count('execute')==1
                assert sum(x['type']=='work.command.prepare_open' for x in f.wire.sent)==1
    asyncio.run(run())


def test_product_output_limit_is_narrower_than_host_contract(fixture):
    async def run():
        async with connected(fixture,approved=False) as f:
            with sdk(f):
                await product(f)
                args=deepcopy(f.arguments);args['output']['maxBytes']=65537
                request=SimpleNamespace(tool='run_command',arguments=args,digest=canonical(args)[1])
                with pytest.raises(InvalidWork,match='command_product_output_limit'):
                    await f.commands.prepare(f.context,request)
                assert not f.wire.sent
    asyncio.run(run())


@pytest.mark.parametrize('seconds',[60,120,True,301])
def test_new_sdk_execution_claim_must_contain_original_command_timing(fixture,seconds):
    async def run():
        async with connected(fixture,approved=False) as f:
            policy=TimingPolicy.model_validate({**f.adapter.timing_policy.model_dump(),
                'prepareBudgetMs':30000,'runtimeMaxMs':50000})
            f.adapter.timing_policy=policy
            f.host_protocol.book.policy=policy
            f.host_protocol.config=replace(f.host_protocol.config,policy=policy.model_dump())
            with sdk(f):
                await product(f);await decide(f)
                original=f.activities.load_effect
                async def load(context,intent):
                    return replace(await original(context,intent),claim_seconds=seconds)
                f.activities.load_effect=load
                if seconds==120:
                    assert await f.activities.execute(f.action)==dict(actionId=f.action,status='applied')
                    assert f.native.calls.count('execute')==1
                else:
                    error=CommandContractError if type(seconds) is int and seconds==60 else InvalidWork
                    with pytest.raises(error):await f.activities.execute(f.action)
                    assert not f.wire.sent and not f.native.calls
                    assert (await action(f))['status']=='proposed'
    asyncio.run(run())


def test_execution_callback_cannot_report_success_without_durable_admission(fixture):
    async def run():
        async with connected(fixture,approved=False) as f:
            with sdk(f):
                await product(f);await decide(f)
                original=f.activities.load_effect
                async def load(context,intent):
                    services=await original(context,intent)
                    return replace(services,execute=AsyncMock(return_value=
                        EffectOutcome(f.action,'applied',True,True,'synthetic fabricated result')))
                f.activities.load_effect=load
                with pytest.raises(WorkConflict,match='effect_execution_mismatch'):
                    await f.activities.execute(f.action)
                assert (await action(f))['status']=='proposed' and not f.wire.sent
    asyncio.run(run())


def test_running_observations_wait_for_original_output_without_reexecution(fixture):
    async def run():
        async with connected(fixture,approved=False) as f:
            with sdk(f):
                await product(f);await decide(f)
                original=f.native.lookup
                count=0
                def lookup(*args,**kwargs):
                    nonlocal count
                    count+=1
                    value,data=original(*args,**kwargs)
                    return ({**value,'phase':'running','outputs':[],'exitCode':None},None) if count<3 else (value,data)
                async def sleep(seconds):f.clock.now+=int(seconds*1000000)
                with patch.object(f.native,'lookup',lookup),patch('openbot_server.work_product_commands.asyncio.sleep',sleep):
                    assert (await f.activities.execute(f.action))['status']=='applied'
                assert count==3 and f.native.calls.count('execute')==1
                assert sum(x['type']=='work.command.consume_result' for x in f.wire.sent)==1
    asyncio.run(run())
