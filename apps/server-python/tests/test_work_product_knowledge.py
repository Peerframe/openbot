"""Actual SQL, authority, private blobs and Owner mutations; only engine SDK/history is synthetic."""
import asyncio
from contextlib import contextmanager
from dataclasses import replace
import hashlib
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import psycopg
import pytest
pytest.importorskip('pydantic_ai',reason='Optional Worker SDK profile is required')
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'agent-runtime-python/src'))
from openbot_server.employee_knowledge import PostgresEmployeeKnowledge
from openbot_server.database import StoreUnavailable
from openbot_server.knowledge_runtime_values import KnowledgeUnavailable
from openbot_server.task_inputs import CreateMessageInput
from openbot_server.task_store import PostgresTaskStore
from openbot_server.work_corrections import CorrectionStore, CorrectionsChanged
from openbot_server.work_deferred import operation_key
from openbot_server.work_effects import execute_action,recover_action
from openbot_server.work_engine_binding import EngineActivityFacts
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_handoff import HandoffStore
from openbot_server.work_product_knowledge import ProductWorkKnowledge,knowledge_tool_descriptors
from openbot_server.work_sources import WorkSourceAdmission
from openbot_server.work_store import PostgresWorkStore
from openbot_server import work_temporal_activity as temporal
from openbot_server.work_temporal_effect import ToolRequest
from openbot_server.work_temporal_start import WorkRuntimeContext
from openbot_server.work_tool_results import ToolResults
from openbot_server.work_values import canonical,InvalidWork,WorkConflict

SCOPE=dict(expected_namespace='default',expected_queue='knowledge-test',expected_workflow_type='knowledge-workflow')
DRAFT=dict(kind='semantic',title='Source checks',content='Keep source timestamps with factual reports.')


def test_descriptors_use_released_catalog_and_no_private_inputs():
    from openbot_agent_runtime.catalog import ToolCatalog
    from openbot_agent_runtime.errors import RuntimeFailure
    descriptors=knowledge_tool_descriptors()
    catalog=ToolCatalog(descriptors,max_tools=4,max_bytes=16384)
    good={'knowledge_catalog':{},'read_skill':{'skillId':str(uuid4())},'read_employee_memory':{},'propose_memory':DRAFT}
    for name,args in good.items():
        assert catalog.validate_arguments(name,args)==args
        with pytest.raises(RuntimeFailure): catalog.validate_arguments(name,{**args,'receipt':{}})
    with pytest.raises(RuntimeFailure): catalog.validate_arguments('read_skill',{'skillId':'not-a-uuid'})
    descriptors[0].input_schema['properties']['receipt']={'type':'object'}
    assert 'receipt' not in knowledge_tool_descriptors()[0].input_schema['properties']


@pytest.fixture
def setup(fixture,tmp_path):
    bot,channel=str(uuid4()),str(uuid4())
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("INSERT INTO bots(id,name,role,computer_profile) VALUES(%s,%s,'assistant','none')",(bot,'Work knowledge '+bot))
        db.execute("INSERT INTO channels(id,name,description) VALUES(%s,%s,'Synthetic only')",(channel,'Work knowledge '+channel))
        db.execute('INSERT INTO channel_bots(channel_id,bot_id) VALUES(%s,%s)',(channel,bot))
    directory=tmp_path.resolve();directory.chmod(0o700)
    store=PostgresWorkStore(fixture['dsn'],files=LocalWorkFiles(directory))
    results=ToolResults(store,store.files)
    f=SimpleNamespace(**fixture,bot=bot,channel=channel,store=store,results=results,skills=[],
        owner=PostgresEmployeeKnowledge(fixture['dsn']))
    f.service=ProductWorkKnowledge(store,object(),SCOPE,results)
    yield f
    with psycopg.connect(f.dsn) as db:
        for table in ('work_tool_results','work_sources','work_artifacts','work_actions','work_correction_contexts','work_corrections','work_events'):
            db.execute(f'DELETE FROM {table} WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(bot,))
        for table in ('work_claims','work_admissions'):
            db.execute(f'DELETE FROM {table} WHERE run_id IN (SELECT r.id FROM work_runs r JOIN work_tasks t ON t.id=r.task_id WHERE t.bot_id=%s)',(bot,))
        db.execute('DELETE FROM work_runs WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(bot,))
        db.execute('DELETE FROM work_tasks WHERE bot_id=%s',(bot,))
        db.execute('DELETE FROM runs WHERE bot_id=%s',(bot,))
        db.execute('DELETE FROM run_events WHERE channel_id=%s OR bot_id=%s',(channel,bot))
        db.execute('DELETE FROM channels WHERE id=%s',(channel,))
        db.execute('DELETE FROM bots WHERE id=%s',(bot,))
        db.execute('DELETE FROM skills WHERE id=ANY(%s)',(f.skills,))


async def bound(f):
    source=(await PostgresTaskStore(f.dsn,work_sources=WorkSourceAdmission(f.store,token_limit=10000)).submit(
        f.token,f.channel,CreateMessageInput(content='Use reviewed synthetic facts.',botId=f.bot))).run
    async with f.store._transaction(trusted=True) as db:
        tid=(await (await db.execute('SELECT task_id FROM work_sources WHERE legacy_run_id=%s',(source.id,))).fetchone())['task_id']
    task=await f.store.snapshot(f.token,tid);rid=task['runs'][0]['id']
    frozen=await CorrectionStore(f.store).freeze(tid,rid,'initial')
    context=WorkRuntimeContext(tid,rid,f.bot,task['objective'],10000,frozen['id'])
    accepted=SimpleNamespace(task_id=tid,run_id=rid,namespace='default',workflow_id='openbot-work-v1-'+rid,
                             engine_run_id='synthetic-engine',first_run_id='synthetic-engine')
    handoff=HandoffStore(f.store);reference='temporal:default:'+accepted.workflow_id
    reserved=await handoff.reserve_submission(tid,rid,reference)
    await handoff.acknowledge(tid,rid,reference,reserved.attempt_id,'synthetic-engine')
    facts=EngineActivityFacts('default',SCOPE['expected_queue'],SCOPE['expected_queue'],accepted.workflow_id,
        SCOPE['expected_workflow_type'],'synthetic-engine','synthetic-engine',dict(taskId=tid,runId=rid,attemptId=reserved.attempt_id))
    return SimpleNamespace(context=context,accepted=accepted,facts=facts,activity='prepare',source=source,step=0)


@contextmanager
def binding(b):
    async def inspect(*a,**kw): return b.facts
    with patch('openbot_server.work_temporal_activity.activity_info',lambda:SimpleNamespace(activity_id=b.activity)), \
            patch('openbot_server.work_temporal_activity.inspect_activity_start',inspect):
        yield


async def claim(f,b,name=None):
    b.activity=name or 'next-'+uuid4().hex
    return await temporal._claim_bound_activity(f.store,b.accepted,b.activity)


async def action(f,b,tool,args=None):
    args={} if args is None else args;b.step+=1;b.activity='prepare-'+str(b.step)
    plan=await f.service.prepare(b.context,ToolRequest(tool,args,canonical(args)[1]))
    intent=dict(kind='deferred_tool',tool=tool,arguments=args,effect=plan.intent)
    fence=await claim(f,b,'execute-'+str(b.step))
    services=await f.service.load(b.context,intent)
    outcome=await execute_action(f.store,task_id=b.context.task_id,run_id=b.context.run_id,fence=fence,
        action_key=operation_key(b.accepted,b.activity),intent=intent,reserved_tokens=0,requires_approval=False,
        adapter=services.adapter,verifier=services.verifier,correction_context=b.context.correction_token)
    async with f.store._transaction(trusted=True) as db:
        row=await (await db.execute('SELECT * FROM work_actions WHERE id=%s',(outcome.action_id,))).fetchone()
    return row,services


async def result(f,b,row):
    b.activity='result-'+row['id']
    return await f.service.load_result(b.context,row)


async def memory(f):
    return (await f.owner.create_memory(f.token,f.bot,dict(kind='semantic',title='Checked fact',content='Reviewed source fact.',
        sensitivity='internal',portability='never',modelUseEnabled=True)))['memory']


async def skill(f):
    slug='fixture-'+uuid4().hex
    item=(await f.owner.import_skill(f.token,f.bot,dict(markdown=f'---\nname: {slug}\ndescription: Review a factual report\n---\nKeep source timestamps.\n',
        version='1.0.0',reason='Fixture')))['skill'];f.skills.append(item['id'])
    await f.owner.set_skill_state(f.token,f.bot,item['id'],dict(state='verified',reason='Review',confidence=90,
        ownerReviewed=True,reviewedContentSha256=item['contentSha256']))
    return item


async def revalidate(f,b):
    await claim(f,b)
    async with f.store._transaction(trusted=True) as db:
        await f.store._task(db,b.context.task_id)
        return await asyncio.wait_for(f.service.revalidate_in_transaction(db,b.context),10)


async def terminal(db,f,b):
    # Root alone owns verified completion. This exact synthetic state transition tests the
    # integration callback boundary, not model quality or actual Temporal publication.
    await db.execute("UPDATE work_runs SET status='completed' WHERE id=%s",(b.context.run_id,))
    await db.execute("UPDATE work_tasks SET status='completed',authority_active=false,authority_generation=authority_generation+1,"
        "completion_digest=%s WHERE id=%s",(hashlib.sha256(b'verified synthetic completion').hexdigest(),b.context.task_id))


def test_catalog_skill_memory_public_only_and_cross_activity_revalidation(setup):
    async def check():
        f=setup;b=await bound(f);s=await skill(f);m=await memory(f)
        with binding(b):
            catalog,_=await action(f,b,'knowledge_catalog',{'query':'source report'})
            assert (await result(f,b,catalog))['skills'][0]['id']==s['id']
            read,_=await action(f,b,'read_skill',{'skillId':s['id']})
            assert (await result(f,b,read))['markdown']==s['skillMarkdown']
            memories,_=await action(f,b,'read_employee_memory')
            public=await result(f,b,memories)
            assert public['memories'][0]['id']==m['id'] and 'receipt' not in public
            assert await revalidate(f,b) is True
        observed=await f.results.load(memories['id'],task_id=b.context.task_id,run_id=b.context.run_id,intent_digest=memories['intent_digest'])
        assert observed.value['receipt']['target']['execution_epoch']<6
        assert observed.value['receipt']['memories'][0]['id']==m['id']
        with psycopg.connect(f.dsn) as db:
            assert db.execute('SELECT count(*) FROM knowledge_proposals WHERE bot_id=%s',(f.bot,)).fetchone()[0]==0
    asyncio.run(check())


@pytest.mark.parametrize('tool,args',[('read_employee_memory',{'receipt':{}}),('read_skill',{'skillId':'x','receipt':{}}),
    ('knowledge_catalog',{'target':{}}),('propose_memory',{**DRAFT,'approved':True})])
def test_model_cannot_supply_or_replace_receipt(setup,tool,args):
    async def check():
        f=setup;b=await bound(f)
        with binding(b),pytest.raises(InvalidWork):
            await f.service.prepare(b.context,ToolRequest(tool,args,canonical(args)[1]))
    asyncio.run(check())


@pytest.mark.parametrize('change',['disable','delete','edit','corrupt'])
def test_applied_memory_cannot_outlive_owner_changes(setup,change):
    async def check():
        f=setup;b=await bound(f);m=await memory(f)
        with binding(b): row,_=await action(f,b,'read_employee_memory');await result(f,b,row)
        if change=='delete': await f.owner.delete_memory(f.token,f.bot,m['id'],dict(expectedRevision=1,ownerReviewed=True))
        elif change in ('edit','disable'):
            await f.owner.update_memory(f.token,f.bot,m['id'],dict(expectedRevision=1,**({'content':'Changed fact'} if change=='edit' else {'modelUseEnabled':False})))
        else:
            with psycopg.connect(f.dsn) as db: db.execute("UPDATE employee_memories SET content='Unversioned corruption' WHERE id=%s",(m['id'],))
        with binding(b),pytest.raises(KnowledgeUnavailable,match='memory_changed'): await revalidate(f,b)
    asyncio.run(check())


@pytest.mark.parametrize('change',['suspend','revoke','delete'])
def test_skill_review_changes_revoke_consumption(setup,change):
    async def check():
        f=setup;b=await bound(f);s=await skill(f)
        with binding(b): await action(f,b,'knowledge_catalog');row,_=await action(f,b,'read_skill',{'skillId':s['id']})
        if change=='delete':
            with psycopg.connect(f.dsn) as db: db.execute('DELETE FROM employee_skills WHERE bot_id=%s AND skill_id=%s',(f.bot,s['id']))
        else: await f.owner.set_skill_state(f.token,f.bot,s['id'],dict(state='suspended' if change=='suspend' else 'revoked',reason='Review',ownerReviewed=True))
        with binding(b),pytest.raises(KnowledgeUnavailable,match='skills_changed'): await result(f,b,row)
    asyncio.run(check())


@pytest.mark.parametrize('change',['cancel','revoke','membership','source'])
def test_authority_or_source_loss_refuses(setup,change):
    async def check():
        f=setup;b=await bound(f);await memory(f)
        with binding(b): row,_=await action(f,b,'read_employee_memory')
        if change=='cancel': await f.store.cancel(f.token,b.context.task_id)
        elif change=='revoke': await f.store.revoke(f.token,b.context.task_id)
        else:
            with psycopg.connect(f.dsn) as db:
                if change=='source': db.execute('DELETE FROM work_sources WHERE task_id=%s',(b.context.task_id,))
                else: db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(f.channel,f.bot))
        with binding(b),pytest.raises((WorkConflict,KnowledgeUnavailable)): await result(f,b,row)
    asyncio.run(check())


def test_checkpoint_tokens_share_history_but_owner_correction_requires_reset(setup):
    async def check():
        f=setup;b=await bound(f);await memory(f)
        with binding(b): row,_=await action(f,b,'read_employee_memory');await result(f,b,row)
        frozen=await CorrectionStore(f.store).freeze(b.context.task_id,b.context.run_id,'same-generation')
        b.context=replace(b.context,correction_token=frozen['id'])
        with binding(b): assert await revalidate(f,b)
        await CorrectionStore(f.store).request(f.token,b.context.task_id,run_id=b.context.run_id,
            instruction='Use revised scope.',request_key='owner-correction',expected_sequence=0)
        frozen=await CorrectionStore(f.store).freeze(b.context.task_id,b.context.run_id,'new-generation')
        b.context=replace(b.context,correction_token=frozen['id'])
        with binding(b),pytest.raises(CorrectionsChanged): await revalidate(f,b)
        f.service=ProductWorkKnowledge(f.store,object(),SCOPE,f.results,history_reset_on_correction=True)
        with binding(b): assert await revalidate(f,b)
        with binding(b),pytest.raises(CorrectionsChanged): await result(f,b,row)
    asyncio.run(check())


def test_proposal_stays_draft_then_same_transaction_pending_once(setup):
    async def check():
        f=setup;b=await bound(f)
        with binding(b):
            row,_=await action(f,b,'propose_memory',DRAFT)
            assert await result(f,b,row)==dict(status='prepared',requiresOwnerReview=True,activeMemoryChanged=False)
            with psycopg.connect(f.dsn) as db:
                assert db.execute('SELECT count(*) FROM knowledge_proposals WHERE bot_id=%s',(f.bot,)).fetchone()[0]==0
            await claim(f,b,'completion')
            async with f.store._transaction(trusted=True) as db:
                await f.store._task(db,b.context.task_id)
                candidate=await f.service.prepare_completion(db,b.context)
                with pytest.raises(WorkConflict,match='not_verified'): await f.service.insert_completed(db,b.context,candidate)
                await terminal(db,f,b)
                first=await f.service.insert_completed(db,b.context,candidate)
                assert first==await f.service.insert_completed(db,b.context,candidate)
        with psycopg.connect(f.dsn) as db:
            assert db.execute('SELECT status,title FROM knowledge_proposals WHERE source_run_id=%s',(b.source.id,)).fetchall()==[('pending',DRAFT['title'])]
            assert db.execute('SELECT count(*) FROM employee_memories WHERE bot_id=%s',(f.bot,)).fetchone()[0]==0
            assert db.execute("SELECT count(*) FROM run_events WHERE run_id=%s AND type='KNOWLEDGE_PROPOSED'",(b.source.id,)).fetchone()[0]==1
    asyncio.run(check())


def test_completion_candidate_cannot_cross_transactions_or_rollback(setup):
    async def check():
        f=setup;b=await bound(f)
        with binding(b):
            await action(f,b,'propose_memory',DRAFT);await claim(f,b,'completion')
            with pytest.raises(RuntimeError):
                async with f.store._transaction(trusted=True) as db:
                    candidate=await f.service.prepare_completion(db,b.context)
                    await terminal(db,f,b);await f.service.insert_completed(db,b.context,candidate)
                    raise RuntimeError('Synthetic rollback')
            async with f.store._transaction(trusted=True) as db:
                with pytest.raises(WorkConflict,match='transaction_changed'): await f.service.insert_completed(db,b.context,candidate)
            with psycopg.connect(f.dsn) as db:
                assert db.execute('SELECT count(*) FROM knowledge_proposals WHERE bot_id=%s',(f.bot,)).fetchone()[0]==0
                assert db.execute('SELECT status FROM work_tasks WHERE id=%s',(b.context.task_id,)).fetchone()[0]=='open'
    asyncio.run(check())


@pytest.mark.parametrize('change',['bytes','metadata','missing','settlement'])
def test_corrupt_private_observation_is_never_returned(setup,change):
    async def check():
        f=setup;b=await bound(f);await memory(f)
        with binding(b): row,_=await action(f,b,'read_employee_memory')
        with psycopg.connect(f.dsn) as db:
            sha=db.execute('SELECT sha256 FROM work_tool_results WHERE action_id=%s',(row['id'],)).fetchone()[0]
            if change=='metadata': db.execute("UPDATE work_tool_results SET intent_digest=repeat('a',64) WHERE action_id=%s",(row['id'],))
            elif change=='missing': db.execute('DELETE FROM work_tool_results WHERE action_id=%s',(row['id'],))
            elif change=='settlement': db.execute("UPDATE work_actions SET actual_tokens=1 WHERE id=%s",(row['id'],))
        if change=='bytes': (f.store.files.directory/sha).write_bytes(b'{}')
        with binding(b),pytest.raises((WorkConflict,StoreUnavailable,KnowledgeUnavailable)): await result(f,b,row)
    asyncio.run(check())


def test_lost_ack_recovers_original_observation_without_another_read(setup):
    async def check():
        f=setup;b=await bound(f);await memory(f);original=f.results.save
        async def lost(*a,**kw): await original(*a,**kw);raise asyncio.CancelledError()
        with binding(b),patch.object(f.results,'save',lost),pytest.raises(asyncio.CancelledError):
            await action(f,b,'read_employee_memory')
        async with f.store._transaction(trusted=True) as db:
            row=await (await db.execute('SELECT * FROM work_actions WHERE task_id=%s',(b.context.task_id,))).fetchone()
        with binding(b):
            services=await f.service.load(b.context,row['intent'])
            with patch.object(f.service,'_invoke',side_effect=AssertionError('Recovery cannot reread')):
                outcome=await recover_action(f.store,task_id=b.context.task_id,run_id=b.context.run_id,action_id=row['id'],
                    adapter=services.adapter,verifier=services.verifier)
            assert outcome.status=='applied'
            public=await result(f,b,row)
            assert await f.service.load_result(b.context,row)==public
        with psycopg.connect(f.dsn) as db:
            assert db.execute("SELECT count(*) FROM run_events WHERE run_id=%s AND type='KNOWLEDGE_READ'",(b.source.id,)).fetchone()[0]==1
            db.execute("UPDATE work_claims SET expires_at=clock_timestamp()-interval '1 second' WHERE run_id=%s",(b.context.run_id,))
        with binding(b),pytest.raises(WorkConflict,match='claim_stale'): await f.service.load_result(b.context,row)
    asyncio.run(check())


def test_unrecorded_observation_stays_unknown_and_is_not_reinvoked(setup):
    async def check():
        f=setup;b=await bound(f);await memory(f)
        async def lost(*a,**kw): raise asyncio.CancelledError()
        with binding(b),patch.object(f.results,'save',lost),pytest.raises(asyncio.CancelledError):
            await action(f,b,'read_employee_memory')
        async with f.store._transaction(trusted=True) as db:
            row=await (await db.execute('SELECT * FROM work_actions WHERE task_id=%s',(b.context.task_id,))).fetchone()
        with binding(b):
            services=await f.service.load(b.context,row['intent'])
            with patch.object(f.service,'_invoke',side_effect=AssertionError('Unknown cannot reread')):
                for _ in range(2):
                    outcome=await recover_action(f.store,task_id=b.context.task_id,run_id=b.context.run_id,action_id=row['id'],
                        adapter=services.adapter,verifier=services.verifier)
                    assert outcome.status=='unknown'
    asyncio.run(check())


def test_pending_cap_skips_once_without_activating_or_undoing_completion(setup):
    async def check():
        f=setup;b=await bound(f)
        with psycopg.connect(f.dsn) as db:
            for _ in range(50):
                rid=str(uuid4())
                db.execute("INSERT INTO runs(id,channel_id,bot_id,title,instruction,status,execution_profile) VALUES(%s,%s,%s,'Synthetic completed source','Synthetic prior instruction','completed','none')",
                    (rid,f.channel,f.bot))
                db.execute('INSERT INTO knowledge_proposals(id,bot_id,source_run_id,kind,title,content) VALUES(%s,%s,%s,%s,%s,%s)',
                    (str(uuid4()),f.bot,rid,DRAFT['kind'],DRAFT['title'],DRAFT['content']))
        with binding(b):
            await action(f,b,'propose_memory',DRAFT);await claim(f,b,'completion')
            async with f.store._transaction(trusted=True) as db:
                candidate=await f.service.prepare_completion(db,b.context);await terminal(db,f,b)
                assert await f.service.insert_completed(db,b.context,candidate)==[]
                assert await f.service.insert_completed(db,b.context,candidate)==[]
        with psycopg.connect(f.dsn) as db:
            assert db.execute("SELECT count(*) FROM knowledge_proposals WHERE bot_id=%s AND status='pending'",(f.bot,)).fetchone()[0]==50
            assert db.execute("SELECT count(*) FROM run_events WHERE run_id=%s AND type='KNOWLEDGE_PROPOSAL_SKIPPED'",(b.source.id,)).fetchone()[0]==1
            assert db.execute('SELECT status FROM work_tasks WHERE id=%s',(b.context.task_id,)).fetchone()[0]=='completed'
    asyncio.run(check())


def test_forged_context_and_skill_without_applied_catalog_refuse(setup):
    async def check():
        f=setup;b=await bound(f);s=await skill(f)
        with binding(b):
            with pytest.raises(WorkConflict):
                await f.service.prepare(replace(b.context,bot_id=str(uuid4())),ToolRequest('knowledge_catalog',{},canonical({})[1]))
            row,_=await action(f,b,'read_skill',{'skillId':s['id']})
            assert row['status']=='unknown'
            assert not await f.results.load(row['id'],task_id=b.context.task_id,run_id=b.context.run_id,intent_digest=row['intent_digest'])
    asyncio.run(check())


def test_corrupt_intent_discriminator_cannot_hide_consumed_knowledge(setup):
    async def check():
        f=setup;b=await bound(f);await memory(f)
        with binding(b): row,_=await action(f,b,'read_employee_memory')
        with psycopg.connect(f.dsn) as db:
            db.execute("UPDATE work_actions SET intent=jsonb_set(jsonb_set(intent,'{tool}','\"other\"'),'{effect,kind}','\"other\"') WHERE id=%s",(row['id'],))
        with binding(b),pytest.raises(WorkConflict,match='action_changed'): await revalidate(f,b)
    asyncio.run(check())


def test_two_completions_serialize_the_fiftieth_pending_proposal(setup):
    from contextvars import ContextVar
    async def check():
        f=setup;first=await bound(f);second=await bound(f)
        for b in (first,second):
            with binding(b): await action(f,b,'propose_memory',DRAFT);await claim(f,b,'completion')
        with psycopg.connect(f.dsn) as db:
            for _ in range(49):
                rid=str(uuid4())
                db.execute("INSERT INTO runs(id,channel_id,bot_id,title,instruction,status,execution_profile) VALUES(%s,%s,%s,'Synthetic prior task','Synthetic instruction','completed','none')",(rid,f.channel,f.bot))
                db.execute('INSERT INTO knowledge_proposals(id,bot_id,source_run_id,kind,title,content) VALUES(%s,%s,%s,%s,%s,%s)',
                    (str(uuid4()),f.bot,rid,DRAFT['kind'],DRAFT['title'],DRAFT['content']))
        active=ContextVar('synthetic_activity')
        async def inspect(*a,**kw): return active.get().facts
        async def finish(b):
            token=active.set(b)
            try:
                async with f.store._transaction(trusted=True) as db:
                    candidate=await f.service.prepare_completion(db,b.context)
                    await terminal(db,f,b)
                    return await f.service.insert_completed(db,b.context,candidate)
            finally: active.reset(token)
        with patch('openbot_server.work_temporal_activity.activity_info',lambda:SimpleNamespace(activity_id=active.get().activity)), \
                patch('openbot_server.work_temporal_activity.inspect_activity_start',inspect):
            outputs=await asyncio.gather(finish(first),finish(second))
        assert sorted(map(len,outputs))==[0,1]
        with psycopg.connect(f.dsn) as db:
            assert db.execute("SELECT count(*) FROM knowledge_proposals WHERE bot_id=%s AND status='pending'",(f.bot,)).fetchone()[0]==50
            assert db.execute("SELECT count(*) FROM work_tasks WHERE bot_id=%s AND status='completed'",(f.bot,)).fetchone()[0]==2
    asyncio.run(check())
