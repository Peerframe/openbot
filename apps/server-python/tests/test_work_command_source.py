"""Real channel submission/SQL/profile/SDK adapter tests; no Host or provider network."""
import asyncio
from copy import deepcopy
import json
import hashlib
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import httpx2
import psycopg
from psycopg.types.json import Jsonb
import pytest

from conftest import fixture
from test_work_product_model import bound, binding, product, selected, request, KEY, SCOPE
from test_work_product_reads import run_read
from openbot_server.control_errors import ControlError
from openbot_server.model_connections import ModelConnectionsService
from openbot_server.model_connections_cipher import ModelCredentialCipher
from openbot_server.model_settings import ModelSettingsService
from openbot_server.owner_files import OwnerFiles
from openbot_server.task_inputs import CreateMessageInput
from openbot_server.task_store import PostgresTaskStore
from openbot_server.work_command_contract import CommandContractError
from openbot_server.work_command_profiles import CommandProfiles
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_model_receipts import ModelReceipts
from openbot_server.work_product_binding import ProductWorkBinding
from openbot_server.work_product_reads import ProductWorkReads
from openbot_server.work_sources import WorkSourceAdmission
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_task_profiles import resolve_product_source, product_capabilities, _profile
from openbot_server.work_tool_results import ToolResults
from openbot_server.work_values import InvalidWork, WorkConflict


class Fixture(SimpleNamespace):
    def __repr__(self): return '<owned command source fixture>'


@pytest.fixture
def setup(fixture,tmp_path):
    bot,channel,node=[str(uuid4()) for _ in range(3)]
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("INSERT INTO bots(id,name,role,computer_profile) VALUES(%s,%s,'Researcher','none')",(bot,'Command '+bot))
        db.execute('INSERT INTO channels(id,name) VALUES(%s,%s)',(channel,'Command '+channel))
        db.execute('INSERT INTO channel_bots(channel_id,bot_id) VALUES(%s,%s)',(channel,bot))
        db.execute('INSERT INTO node_credentials(node_id,credential_digest,enrolled_at) VALUES(%s,%s,clock_timestamp())',(node,hashlib.sha256(node.encode()).hexdigest()))
    tmp_path=tmp_path.resolve();tmp_path.chmod(0o700)
    (tmp_path/'blobs').mkdir(mode=0o700);(tmp_path/'attachments').mkdir(mode=0o700)
    connections=ModelConnectionsService(fixture['dsn'],ModelCredentialCipher(bytes(range(32))))
    # Reuse the maintained command contract vector; no extra policy/identity contract.
    import test_work_command_store
    command=json.loads((Path(test_work_command_store.__file__).parent/'fixtures/work_command_vectors.json').read_text())['intent']['command']
    policy=dict(image=command['image'],limits=deepcopy(command['limits']))
    profiles=CommandProfiles(connections,policies={'offline-command':policy})
    store=PostgresWorkStore(fixture['dsn'],command_profiles=profiles)
    blobs=LocalWorkFiles(tmp_path/'blobs')
    route=dict(nodeId=node,providerId='linux-command',enforcementKeyId='enforcer-1',ledgerId=str(uuid4()))
    f=Fixture(**fixture,bot=bot,channel=channel,node=node,connections=connections,profiles=profiles,
        policy=policy,route=route,store=store,ids=[],calls=[],files=OwnerFiles(tmp_path/'attachments'),
        receipts=ModelReceipts(store,blobs),results=ToolResults(store,blobs),
        settings=ModelSettingsService(tmp_path/'settings',lambda r:httpx2.Response(200,json={'id':'fixture-model'})))
    f.sources=WorkSourceAdmission(store,token_limit=1_000_000,command_route=route,command_policy_id='offline-command')
    f.reads=ProductWorkReads(store,object(),SCOPE,f.files,f.results)
    yield f
    # The canonical suite shares its owned DB: remove only this case's rows and connections.
    with psycopg.connect(f.dsn) as db:
        query='(SELECT id FROM work_tasks WHERE bot_id=%s)'
        for table in ('work_tool_results','work_model_receipts','work_command_profiles','work_task_profiles',
                      'work_sources','work_actions','work_artifacts','work_correction_contexts','work_corrections','work_events'):
            db.execute(f'DELETE FROM {table} WHERE task_id IN '+query,(bot,))
        for table in ('work_claims','work_admissions'):
            db.execute(f'DELETE FROM {table} WHERE run_id IN (SELECT id FROM work_runs WHERE task_id IN '+query+')',(bot,))
        db.execute('DELETE FROM work_runs WHERE task_id IN '+query,(bot,))
        db.execute('DELETE FROM work_tasks WHERE bot_id=%s',(bot,))
        db.execute('DELETE FROM runs WHERE bot_id=%s',(bot,))
        db.execute('DELETE FROM run_events WHERE channel_id=%s OR bot_id=%s',(channel,bot))
        db.execute('DELETE FROM messages WHERE channel_id=%s',(channel,))
        db.execute('DELETE FROM channels WHERE id=%s',(channel,))
        db.execute('DELETE FROM bots WHERE id=%s',(bot,))
        db.execute('DELETE FROM model_connections WHERE id=ANY(%s)',(f.ids,))
        db.execute('DELETE FROM node_credentials WHERE node_id=%s',(node,))


async def source(f,b,**kwargs):
    async with f.store._transaction(trusted=True) as db:
        task=await f.store._task(db,b.context.task_id,read=True)
        return await resolve_product_source(db,task,f.bot,command_profiles=kwargs.get('profiles',f.store.command_profiles))


async def check_binding(f,b):
    async with f.store._transaction(trusted=True) as db:
        return await ProductWorkBinding(f.store,object(),SCOPE).check(db,b.context,require_fence=False)


def change(f,kind):
    with psycopg.connect(f.dsn) as db:
        if kind=='credential': db.execute("UPDATE node_credentials SET credential_digest=%s WHERE node_id=%s",(hashlib.sha256(uuid4().bytes).hexdigest(),f.node))
        elif kind=='revoked': db.execute('UPDATE node_credentials SET revoked_at=clock_timestamp() WHERE node_id=%s',(f.node,))
        elif kind=='missing_node': db.execute('DELETE FROM node_credentials WHERE node_id=%s',(f.node,))
        elif kind=='membership': db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(f.channel,f.bot))
        elif kind=='profile': db.execute("UPDATE bots SET computer_profile='none' WHERE id=%s",(f.bot,))
        elif kind=='policy':
            policy=deepcopy(f.policy);policy['limits']['wallSeconds']-=1
            f.store.command_profiles=CommandProfiles(f.connections,policies={'offline-command':policy})
        elif kind=='missing_policy': f.store.command_profiles=CommandProfiles(f.connections,policies={'other':f.policy})
        elif kind=='missing_snapshot': db.execute('DELETE FROM work_command_profiles WHERE bot_id=%s',(f.bot,))
        elif kind=='wrong_composition': f.store.command_profiles=object()
        elif kind=='no_composition': f.store.command_profiles=None
        elif kind=='mixed_native':
            row=db.execute('SELECT task_id FROM work_sources WHERE legacy_run_id=(SELECT id FROM runs WHERE bot_id=%s LIMIT 1)',(f.bot,)).fetchone()
            _,digest=_profile(row[0],f.bot,'none',None)
            db.execute("INSERT INTO work_task_profiles(task_id,bot_id,execution_profile,model_selection,profile_digest) VALUES(%s,%s,'none',NULL,%s)",(row[0],f.bot,digest))
        else: raise AssertionError(kind)


@pytest.mark.parametrize('value',[object(),{},False])
def test_constructor_rejects_untrusted_profile_services(value):
    with pytest.raises(InvalidWork,match='invalid_command_profile_composition'):
        PostgresWorkStore('unused',command_profiles=value)


@pytest.mark.parametrize('options',[{}, {'command_route':{}}, {'command_policy_id':'offline-command'},
    {'command_route':{},'command_policy_id':[]}, {'command_route':{},'command_policy_id':'missing'}])
def test_opt_in_is_explicit_and_complete(setup,options):
    f=setup
    if not options:
        assert WorkSourceAdmission(f.store,token_limit=1000).command_route is None
    else:
        with pytest.raises((WorkConflict,CommandContractError)):
            WorkSourceAdmission(f.store,token_limit=1000,**options)


def test_real_submit_freezes_snapshot_and_concurrent_repeat_never_recaptures(setup):
    async def check():
        f=setup;conn=await selected(f);b=await bound(f,'docker-linux',conn)
        original=await source(f,b)
        assert original['model_selection']==dict(connectionId=conn['id'],modelId='queued-model')
        assert set(product_capabilities(original))=={'model','report','result_review','channel_reads','attachments','command'}
        assert 'credentialDigest' not in json.dumps(original)
        with psycopg.connect(f.dsn) as db:
            assert db.execute('SELECT model_selection,node_id FROM runs WHERE id=%s',(b.source.id,)).fetchone()==(None,None)
            assert db.execute('SELECT count(*) FROM work_task_profiles WHERE task_id=%s',(b.context.task_id,)).fetchone()[0]==0
            assert db.execute('SELECT corrections_enabled FROM work_runs WHERE id=%s',(b.context.run_id,)).fetchone()[0] is True
        second=await selected(f)
        with psycopg.connect(f.dsn) as db:
            db.execute('UPDATE bots SET configuration=%s WHERE id=%s',(Jsonb({'model':{'connectionId':second['id'],'modelId':'not-the-original'}}),f.bot))
        async def repeat():
            async with f.store._transaction(trusted=True) as db: return await f.sources.admit(db,b.source)
        async with asyncio.timeout(6): results=await asyncio.gather(repeat(),repeat())
        assert all(item['id']==b.context.task_id for item in results)
        assert await source(f,b)==original
        with psycopg.connect(f.dsn) as db:
            assert db.execute('SELECT count(*) FROM work_command_profiles WHERE task_id=%s',(b.context.task_id,)).fetchone()[0]==1
            assert db.execute("SELECT count(*) FROM work_events WHERE task_id=%s AND kind='source.admitted'",(b.context.task_id,)).fetchone()[0]==1
        with binding(b): assert await check_binding(f,b)==original
    asyncio.run(check())


@pytest.mark.parametrize('failure',['default_off','missing_node','revoked','disabled','invalid_selection'])
def test_real_source_submit_refusal_rolls_back_every_row(setup,failure):
    async def check():
        f=setup;conn=await selected(f)
        if failure=='default_off': f.sources=WorkSourceAdmission(f.store,token_limit=1000)
        if failure in ('missing_node','revoked'): change(f,failure)
        if failure=='disabled': await f.connections.update(f.token,conn['id'],dict(expectedRevision=1,enabled=False))
        with psycopg.connect(f.dsn) as db:
            db.execute("UPDATE bots SET computer_profile='docker-linux',configuration=%s WHERE id=%s",(Jsonb({'model':None if failure=='invalid_selection' else {'connectionId':conn['id'],'modelId':'queued-model'}}),f.bot))
        with pytest.raises((WorkConflict,ControlError,CommandContractError)):
            await PostgresTaskStore(f.dsn,model_connections=f.connections,work_sources=f.sources).submit(f.token,f.channel,
                CreateMessageInput(content='Synthetic command source',botId=f.bot))
        with psycopg.connect(f.dsn) as db:
            for table,column,identity in [('messages','channel_id',f.channel),('runs','bot_id',f.bot),('work_tasks','bot_id',f.bot),('work_command_profiles','bot_id',f.bot)]:
                assert db.execute(f'SELECT count(*) FROM {table} WHERE {column}=%s',(identity,)).fetchone()[0]==0
    asyncio.run(check())


@pytest.mark.parametrize('failure',['credential','revoked','missing_node','membership','profile','policy','missing_policy',
    'missing_snapshot','wrong_composition','no_composition','mixed_native','disabled'])
def test_current_authority_is_rechecked_by_binding_model_and_reads(setup,failure):
    async def check():
        f=setup;conn=await selected(f);b=await bound(f,'docker-linux',conn)
        if failure=='disabled': await f.connections.update(f.token,conn['id'],dict(expectedRevision=1,enabled=False))
        else: change(f,failure)
        with binding(b):
            for operation in (lambda:check_binding(f,b),lambda:product(f).call(b.context,request()),lambda:f.reads.read_prompt(b.context)):
                with pytest.raises((WorkConflict,ControlError)): await operation()
        assert not f.calls
        with psycopg.connect(f.dsn) as db:
            assert db.execute('SELECT count(*) FROM work_actions WHERE task_id=%s',(b.context.task_id,)).fetchone()[0]==0
    asyncio.run(check())


def test_model_uses_original_selection_with_current_legal_owner_revision(setup,monkeypatch):
    async def check():
        f=setup;first=await selected(f);second=await selected(f);b=await bound(f,'docker-linux',first)
        with psycopg.connect(f.dsn) as db:
            db.execute('UPDATE bots SET configuration=%s WHERE id=%s',(Jsonb({'model':{'connectionId':second['id'],'modelId':'replacement'}}),f.bot))
        await f.connections.update(f.token,first['id'],dict(expectedRevision=1,apiKey='synthetic-new-owner-key'))
        monkeypatch.setenv('OPENAI_API_KEY','synthetic-ambient-must-not-use')
        monkeypatch.setenv('OPENAI_MODEL','ambient-model')
        with binding(b): reply=await product(f).call(b.context,request())
        assert reply.text=='Checked answer' and len(f.calls)==1
        assert json.loads(f.calls[0].content)['model']=='queued-model'
        assert f.calls[0].headers['authorization']=='Bearer synthetic-new-owner-key'
        action=(await f.store.snapshot(f.token,b.context.task_id))['actions'][0]
        assert action['intent']['configuration']['connectionId']==first['id']
        assert action['intent']['configuration']['revision']==2
        assert action['status']=='applied'
        assert (await source(f,b))['command_profile_digest']
    asyncio.run(check())


@pytest.mark.parametrize('failure',['key','credential','membership','policy'])
def test_awaited_before_send_change_leaves_unknown_and_never_sends(setup,failure):
    async def check():
        f=setup;conn=await selected(f);b=await bound(f,'docker-linux',conn)
        async def before():
            if failure=='key': await f.connections.update(f.token,conn['id'],dict(expectedRevision=1,apiKey='synthetic-new-owner-key'))
            else: change(f,failure)
        with binding(b),pytest.raises(WorkConflict,match='model_observation_unknown'):
            await product(f).call(b.context,request(),before_send=before)
        assert not f.calls
        assert (await f.store.snapshot(f.token,b.context.task_id))['actions'][0]['status']=='unknown'
    asyncio.run(check())


def test_applied_read_and_publication_barrier_recheck_original_profile(setup):
    async def check():
        f=setup;conn=await selected(f);b=await bound(f,'docker-linux',conn)
        with binding(b):
            prompt=await f.reads.read_prompt(b.context)
            outcome,row,_=await run_read(f,b,'read_channel_context')
            assert outcome.status=='applied'
            payload=await f.reads.load_result(b.context,row)
            assert any(item['content']=='Synthetic model task' for item in payload)
            assert row['intent']['effect']['source']['commandProfileSha256']==prompt['source']['commandProfileSha256']
            async with f.files.lock():
                async with f.store._transaction(trusted=True) as db:
                    assert await f.reads.revalidate_in_transaction(db,b.context) is True
            change(f,'credential')
            with pytest.raises(WorkConflict): await f.reads.load_result(b.context,row)
            async with f.files.lock():
                async with f.store._transaction(trusted=True) as db:
                    with pytest.raises(WorkConflict): await f.reads.revalidate_in_transaction(db,b.context)
            final=await f.store.snapshot(f.token,b.context.task_id)
            assert len(final['actions'])==1 and final['actions'][0]['status']=='applied'
    asyncio.run(check())


def test_command_attachment_read_preserves_original_reference_scope(setup):
    from test_work_task_profiles import bound as bind_task
    async def check():
        f=setup;conn=await selected(f)
        async with f.files.lock():
            item=f.files.persist(f.channel,'input.txt',b'Synthetic attachment facts')
            other=f.files.persist(f.channel,'unselected.txt',b'Must not expose')
        with psycopg.connect(f.dsn) as db:
            db.execute("UPDATE bots SET computer_profile='docker-linux',configuration=%s WHERE id=%s",
                (Jsonb({'model':{'connectionId':conn['id'],'modelId':'queued-model'}}),f.bot))
        submit=await PostgresTaskStore(f.dsn,files=f.files,model_connections=f.connections,work_sources=f.sources).submit(
            f.token,f.channel,CreateMessageInput(content='Use [OpenBot attachment: '+item['id']+']',botId=f.bot))
        with psycopg.connect(f.dsn) as db:
            task_id=db.execute('SELECT task_id FROM work_sources WHERE legacy_run_id=%s',(submit.run.id,)).fetchone()[0]
        b=await bind_task(f,await f.store.snapshot(f.token,task_id))
        with binding(b):
            prompt=await f.reads.read_prompt(b.context)
            assert [x['id'] for x in prompt['attachments']]==[item['id']]
            outcome,row,_=await run_read(f,b,'read_attachment',dict(attachmentId=item['id'],offset=0,limit=9))
            assert outcome.status=='applied'
            value=await f.reads.load_result(b.context,row)
            assert value['text']=='Synthetic' and value['nextOffset']==9
            b.activity='attachment-outside-source'
            with pytest.raises(WorkConflict,match='attachment_outside_task'):
                await run_read(f,b,'read_attachment',dict(attachmentId=other['id']))
    asyncio.run(check())
