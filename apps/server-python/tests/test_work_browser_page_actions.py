"""Real owned PG/HTTP/WS with synthetic page data; no live browser or paid model."""
import asyncio
import base64
from contextlib import asynccontextmanager
from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import psycopg
import pytest

from openbot_server.browser_protocol import Action
from openbot_server.work_browser_profiles import BrowserProfiles
from openbot_server.work_browser_page_actions import ProductWorkBrowserPages, page_observation
from openbot_server.work_corrections import CorrectionStore
from openbot_server.work_deferred import operation_key
from openbot_server.work_effects import execute_action, recover_action
from openbot_server.work_product_runtime import ProductWorkRuntime
from openbot_server.work_task_profiles import product_capabilities
from openbot_server.work_temporal_effect import ToolRequest
from openbot_server.work_values import WorkConflict, canonical
from test_browser_sessions import server, worker, opened, command, FRAME
from test_work_product_browser import configured, channel_task, row, PNG
from test_work_task_profiles import setup
from test_work_product_model import binding, SCOPE

ORIGIN='https://synthetic.invalid'
PAGE=dict(url=ORIGIN+'/form',title='Owned test',text='Synthetic form',truncated=False,snapshotId=1,
          elements=[dict(ref='e1',role='textbox',name='Name'),dict(ref='e2',role='button',name='Save')])


@asynccontextmanager
async def host(f, *, pages=True, hook=None):
    if pages:f.store.browser_profiles=BrowserProfiles(f.connections,routes={f.bot:f.seed['node']},page_origins={f.bot:[ORIGIN]})
    async def page(value):
        if hook is not None:await hook(value)
        return dict(frame=dict(FRAME,base64=base64.b64encode(PNG).decode()),page=deepcopy(PAGE))
    async with server(f.seed) as (service,registry,http,url):
        async with worker(f.seed,http,url,page_hook=page) as (calls,ws):
            view=await opened(http,f.seed)
            f.owner.worker_registry,f.owner.browser=registry,service
            f.pages=ProductWorkBrowserPages(f.store,object(),SCOPE,f.results,registry,service.gate)
            yield calls,http,view,registry


async def prepare(f,b,tool='read_browser',args=None,*,approved=True):
    args={} if args is None else args
    b.activity='page-'+uuid4().hex
    plan=await f.pages.prepare(b.context,ToolRequest(tool,args,canonical(args)[1]))
    fence=await f.pages.binding.claim(b.context)
    intent=dict(kind='deferred_tool',tool=tool,arguments=args,effect=plan.intent)
    key=operation_key(b.accepted,b.activity)
    identity=await f.store.propose(b.context.task_id,b.context.run_id,fence=fence,action_key=key,intent=intent,
        reserved_tokens=0,requires_approval=True,correction_context=b.context.correction_token)
    if approved is not None:await f.store.decide(f.token,identity,intent_digest=canonical(intent)[1],approved=approved)
    services=await f.pages.load(b.context,intent)
    async def execute():
        return await execute_action(f.store,task_id=b.context.task_id,run_id=b.context.run_id,fence=fence,
            action_key=key,intent=intent,reserved_tokens=0,requires_approval=True,adapter=services.adapter,
            verifier=services.verifier,correction_context=b.context.correction_token)
    return SimpleNamespace(id=identity,intent=intent,services=services,execute=execute)


def test_existing_task_does_not_gain_page_authority(configured):
    f=configured
    async def check():
        async with host(f,pages=False):
            old=await channel_task(f)
            f.store.browser_profiles.page_origins[f.bot]=[ORIGIN]
            with binding(old):
                with pytest.raises(WorkConflict,match='browser_page_scope_required'):await prepare(f,old)
            new=await channel_task(f)
            with binding(new):
                current=await prepare(f,new)
                assert (await current.execute()).status=='applied'
                runtime=ProductWorkRuntime(f.store,object(),SCOPE,f.owner,web=False)
                assert 'browser_page' in await runtime.capabilities(new.context)
            with binding(old):
                assert 'browser_page' not in await runtime.capabilities(old.context)
    asyncio.run(check())


def test_read_observation_binds_exact_unicode_input(configured):
    f=configured
    async def check():
        async with host(f) as (calls,http,view,_):
            b=await channel_task(f)
            with binding(b):
                read=await prepare(f,b);assert (await read.execute()).status=='applied'
                payload=await f.pages.load_result(b.context,await row(f,read.id))
                assert payload['page']==PAGE and payload['untrusted'] and not payload['externalEffectVerified']
                typed=await prepare(f,b,'type_browser',dict(observationId=read.id,ref='e1',text='输入 你好 🌏'))
                assert (await typed.execute()).status=='applied'
                operation=calls[-1]['action']['operation']
                assert operation['text']=='输入 你好 🌏' and operation['ref']=='e1'
                assert operation['expected']==dict(url=PAGE['url'],snapshotId=1,frameSha256=payload['frame']['sha256'])
                denied=await http.post(f"/api/v1/browser-sessions/{view['id']}/commands",json=dict(kind='agent',operation=dict(kind='read')))
                assert denied.status_code in (400,422)
    asyncio.run(check())


def test_new_checkpoint_retains_observation_but_owner_correction_invalidates_it(configured):
    f=configured
    async def check():
        async with host(f) as (calls,_,_,_):
            b=await channel_task(f)
            corrections=CorrectionStore(f.store)
            with binding(b):
                read=await prepare(f,b);assert (await read.execute()).status=='applied'
                old=b.context.correction_token
                fresh=await corrections.freeze(b.context.task_id,b.context.run_id,'next-tool')
                assert fresh['id']!=old
                b.context=replace(b.context,correction_token=fresh['id'])
                typed=await prepare(f,b,'type_browser',dict(observationId=read.id,ref='e1',text='新检查点'))
                assert (await typed.execute()).status=='applied'
                await corrections.request(f.token,b.context.task_id,run_id=b.context.run_id,
                    instruction='Stop using the old page.',request_key='changed-page',expected_sequence=0)
                changed=await corrections.freeze(b.context.task_id,b.context.run_id,'corrected-tool')
                b.context=replace(b.context,correction_token=changed['id'])
                before=len(calls)
                with pytest.raises(WorkConflict):
                    await prepare(f,b,'click_browser',dict(observationId=typed.id,ref='e2'))
                assert len(calls)==before
    asyncio.run(check())


@pytest.mark.parametrize('approved',[None,False])
def test_unapproved_page_read_never_reaches_worker(configured,approved):
    f=configured
    async def check():
        async with host(f) as (calls,_,_,_):
            b=await channel_task(f)
            with binding(b):
                action=await prepare(f,b,approved=approved);before=len(calls)
                with pytest.raises(WorkConflict):await action.execute()
                assert len(calls)==before
    asyncio.run(check())


@pytest.mark.parametrize('change',['origin','member','connection','takeover','cancel'])
def test_changed_authority_prevents_dispatch(configured,change):
    f=configured
    async def check():
        async with host(f) as (calls,http,view,registry):
            b=await channel_task(f)
            with binding(b):
                action=await prepare(f,b)
                if change=='origin':f.store.browser_profiles.page_origins[f.bot]=['https://other.invalid']
                elif change=='connection':registry._nodes[f.seed['node']].connection_id=str(uuid4())
                elif change=='takeover':await command(http,view,'take')
                elif change=='member':
                    with psycopg.connect(f.dsn) as db:db.execute('DELETE FROM channel_bots WHERE bot_id=%s',(f.bot,))
                else:await f.store.cancel(f.token,b.context.task_id)
                before=len(calls)
                try:outcome=await action.execute()
                except WorkConflict:pass
                else:assert outcome.status!='applied'
                assert len(calls)==before
    asyncio.run(check())


def test_lost_acknowledgement_recovers_original_page_without_resend(configured):
    f=configured
    async def check():
        async with host(f) as (calls,_,_,registry):
            b=await channel_task(f)
            with binding(b):
                action=await prepare(f,b)
                with patch.object(action.services.adapter,'lookup',side_effect=RuntimeError('lost acknowledgement')):
                    assert (await action.execute()).status=='unknown'
                before=len(calls)
                fresh=await f.pages.load(b.context,action.intent)
                registry._nodes[f.seed['node']].connection_id=str(uuid4())
                result=await recover_action(f.store,task_id=b.context.task_id,run_id=b.context.run_id,
                    action_id=action.id,adapter=fresh.adapter,verifier=fresh.verifier)
                assert result.status=='applied' and len(calls)==before
                original=await row(f,action.id)
                value=await f.results.load(action.id,task_id=b.context.task_id,run_id=b.context.run_id,intent_digest=original['intent_digest'])
                assert page_observation(f.store.files,original,value.value)['page']==PAGE
                value.value['payload']['observationId']=str(uuid4())
                with pytest.raises(WorkConflict):page_observation(f.store.files,original,value.value)
    asyncio.run(check())


def test_ref_scope_control_revision_and_origin_are_frozen(configured):
    f=configured
    async def check():
        async with host(f) as (_,http,view,_):
            b=await channel_task(f)
            with binding(b):
                read=await prepare(f,b);assert (await read.execute()).status=='applied'
                for args in (dict(observationId=str(uuid4()),ref='e1'),dict(observationId=read.id,ref='e99')):
                    with pytest.raises(WorkConflict):await prepare(f,b,'click_browser',args)
                with pytest.raises(WorkConflict):await prepare(f,b,'navigate_browser',dict(url='https://synthetic.invalid.attacker.test/'))
                await command(http,view,'take');await command(http,view,'release')
                with pytest.raises(WorkConflict):await prepare(f,b,'click_browser',dict(observationId=read.id,ref='e2'))
    asyncio.run(check())


def test_page_budget_counts_original_attempts(configured):
    f=configured
    async def check():
        async with host(f) as (calls,_,_,_):
            b=await channel_task(f)
            with binding(b):
                for _ in range(16):assert (await (await prepare(f,b)).execute()).status=='applied'
                before=len(calls)
                with pytest.raises(WorkConflict,match='browser_page_limit'):await prepare(f,b)
                assert len(calls)==before
    asyncio.run(check())


@pytest.mark.parametrize('phase',['dispatch','reply'])
def test_page_cancellation_is_checked_at_actual_send_and_receipt(configured,phase):
    f=configured
    b=None
    async def cancelled(_):
        if phase=='reply':await f.store.cancel(f.token,b.context.task_id)
    async def check():
        nonlocal b
        async with host(f,hook=cancelled) as (calls,_,_,registry):
            b=await channel_task(f)
            with binding(b):
                action=await prepare(f,b)
                original=registry.browser_command
                async def before_send(*args,**kwargs):
                    await f.store.cancel(f.token,b.context.task_id)
                    return await original(*args,**kwargs)
                if phase=='dispatch':registry.browser_command=before_send
                try:outcome=await action.execute()
                except WorkConflict:pass
                else:assert outcome.status!='applied'
                assert len(calls)==(0 if phase=='dispatch' else 1)
                assert await f.results.load(action.id,task_id=b.context.task_id,run_id=b.context.run_id,
                    intent_digest=canonical(action.intent)[1]) is None
    asyncio.run(check())
