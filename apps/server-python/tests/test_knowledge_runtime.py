"""Real Work/Owner authority, row locks, freshness and bounded JS-format parity."""
import asyncio
from dataclasses import asdict, replace
import hashlib
import json
import subprocess
from pathlib import Path
import openbot_server
from types import SimpleNamespace
from uuid import uuid4
import psycopg
import pytest
from openbot_server.conversation_interactions import PostgresConversationInteractions
from openbot_server.employee_knowledge import PostgresEmployeeKnowledge
from openbot_server.knowledge_runtime import PostgresKnowledgeRuntime
from openbot_server.knowledge_runtime_values import KnowledgeContext, KnowledgeUnavailable, byte_size
from openbot_server.task_inputs import CreateMessageInput
from openbot_server.task_store import PostgresTaskStore
from openbot_server.work_claims import check_fence
from openbot_server.work_corrections import CorrectionStore, check_context
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_sources import WorkSourceAdmission
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_values import WorkConflict

@pytest.fixture
def setup(fixture,tmp_path):
    bot,channel=str(uuid4()),str(uuid4())
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("INSERT INTO bots(id,name,role,computer_profile) VALUES(%s,%s,'assistant','none')",(bot,'Knowledge '+bot))
        db.execute("INSERT INTO channels(id,name,description) VALUES(%s,%s,'Synthetic only')",(channel,'Knowledge '+channel))
        db.execute('INSERT INTO channel_bots(channel_id,bot_id) VALUES(%s,%s)',(channel,bot))
    tmp_path.chmod(0o700)
    store=PostgresWorkStore(fixture['dsn'],files=LocalWorkFiles(tmp_path))
    f=SimpleNamespace(**fixture,bot=bot,channel=channel,store=store,owner=PostgresEmployeeKnowledge(fixture['dsn']),skills=[])
    f.sources=WorkSourceAdmission(store,token_limit=10000)
    yield f
    with psycopg.connect(f.dsn) as db:
        db.execute('DELETE FROM work_sources WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(bot,))
        for table in ('work_artifacts','work_actions','work_correction_contexts','work_corrections','work_events'):
            db.execute(f'DELETE FROM {table} WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(bot,))
        for table in ('work_claims','work_admissions'):
            db.execute(f'DELETE FROM {table} WHERE run_id IN (SELECT r.id FROM work_runs r JOIN work_tasks t ON t.id=r.task_id WHERE t.bot_id=%s)',(bot,))
        db.execute('DELETE FROM work_runs WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(bot,))
        db.execute('DELETE FROM work_tasks WHERE bot_id=%s',(bot,))
        db.execute('DELETE FROM runs WHERE bot_id=%s',(bot,))
        db.execute('DELETE FROM run_events WHERE channel_id=%s',(channel,))
        db.execute('DELETE FROM channels WHERE id=%s',(channel,))
        db.execute('DELETE FROM bots WHERE id=%s',(bot,))
        db.execute('DELETE FROM skills WHERE id=ANY(%s)',(f.skills,))

async def bound(f):
    source=(await PostgresTaskStore(f.dsn,work_sources=f.sources).submit(f.token,f.channel,
        CreateMessageInput(content='Use the checked synthetic facts.',botId=f.bot))).run
    async with f.store._transaction(trusted=True) as db:
        row=await (await db.execute('SELECT task_id FROM work_sources WHERE legacy_run_id=%s',(source.id,))).fetchone()
    task=await f.store.snapshot(f.token,row['task_id'])
    ctx=KnowledgeContext(task['id'],task['runs'][0]['id'],f.bot,f.channel)
    fence=await f.store.claim(ctx.task_id,ctx.run_id,str(uuid4()),expires_seconds=300)
    correction=await CorrectionStore(f.store).freeze(ctx.task_id,ctx.run_id,str(uuid4()))
    async def gate(db,context):
        assert context==ctx
        await check_fence(db,ctx.run_id,fence)
        current=await (await db.execute('SELECT * FROM work_tasks WHERE id=%s',(ctx.task_id,))).fetchone()
        await check_context(db,current,ctx.run_id,correction['id'])
        return True
    return SimpleNamespace(context=ctx,fence=fence,correction=correction,source=source,
        runtime=PostgresKnowledgeRuntime(f.dsn,binding_gate=gate))

async def memory(f,**changes):
    value=dict(kind='semantic',title='Checked fact',content='Fixture reviewed fact.',sensitivity='internal',portability='never',modelUseEnabled=True)
    value.update(changes)
    return (await f.owner.create_memory(f.token,f.bot,value))['memory']


def test_explicit_receipt_transfer_revalidates_next_activity_and_rejects_old_gate(setup):
    async def check():
        f=setup;b=await bound(f);await memory(f)
        observed=await b.runtime.read_employee_memory(b.context)
        draft=await b.runtime.propose_memory(b.context,dict(kind='semantic',title='Checked lesson',content='Reviewed synthetic lesson.'))
        current_fence=await f.store.claim(b.context.task_id,b.context.run_id,'next-activity')
        async def gate(db,ctx):
            await check_fence(db,ctx.run_id,current_fence)
            task=await (await db.execute('SELECT * FROM work_tasks WHERE id=%s',(ctx.task_id,))).fetchone()
            await check_context(db,task,ctx.run_id,b.correction['id'])
            return True
        current=PostgresKnowledgeRuntime(f.dsn,binding_gate=gate)
        async with f.store._transaction(trusted=True) as db:
            with pytest.raises(KnowledgeUnavailable):
                await current.revalidate_in_transaction(db,b.context,(observed.receipt,))
            with pytest.raises(WorkConflict,match='execution_claim_stale'):
                await b.runtime.carry_in_transaction(db,b.context,(observed.receipt,))
            carried=await current.carry_in_transaction(db,b.context,(observed.receipt,))
            assert carried[0].target.execution_epoch==current_fence.epoch
            candidate=await current.carry_proposal_for_completion_in_transaction(db,b.context,draft)
            assert candidate['sourceRunId']==b.source.id
            assert candidate['content']==draft.content
        await f.owner.update_memory(f.token,f.bot,observed.receipt.memories[0].id,
            dict(expectedRevision=1,content='Changed after observation'))
        async with f.store._transaction(trusted=True) as db:
            with pytest.raises(KnowledgeUnavailable,match='memory_changed'):
                await current.carry_in_transaction(db,b.context,(observed.receipt,))
    asyncio.run(check())

async def skill(f,verified=True):
    slug='fixture-'+uuid4().hex
    document=f'---\nname: {slug}\ndescription: Prepare a checked source report\n---\nRead sources and state uncertainty.\n'
    item=(await f.owner.import_skill(f.token,f.bot,dict(markdown=document,version='1.0.0',reason='Fixture')))['skill']
    f.skills.append(item['id'])
    if verified:
        await f.owner.set_skill_state(f.token,f.bot,item['id'],dict(state='verified',reason='Review',confidence=90,ownerReviewed=True,reviewedContentSha256=item['contentSha256']))
    return item

async def complete(f,b):
    current=await f.store.snapshot(f.token,b.context.task_id)
    return await f.store.complete(b.context.task_id,b.context.run_id,fence=b.fence,expected_revision=current['revision'],
        summary='Checked synthetic result',artifacts=[],verification=dict(source='knowledge-test',reference='fixture',sha256=hashlib.sha256(b'fixture').hexdigest()),
        correction_context=b.correction['id'])

def test_owner_opt_in_scope_and_content_free_audit(setup):
    async def check():
        f=setup;b=await bound(f);m=await memory(f)
        await memory(f,modelUseEnabled=False)
        await memory(f,sensitivity='confidential',modelUseEnabled=False)
        await memory(f,kind='secret-reference',sensitivity='restricted',modelUseEnabled=False)
        read=await b.runtime.read_employee_memory(b.context)
        assert [v['id'] for v in read.payload['memories']]==[m['id']]
        await b.runtime.revalidate(b.context,(read.receipt,))
        for key in ('bot_id','channel_id','task_id','run_id'):
            with pytest.raises(KnowledgeUnavailable):
                await b.runtime.read_employee_memory(replace(b.context,**{key:str(uuid4())}))
        with psycopg.connect(f.dsn) as db:
            events=db.execute("SELECT payload FROM run_events WHERE run_id=%s AND type='KNOWLEDGE_READ'",(b.source.id,)).fetchall()
        assert len(events)==1 and events[0][0]['memories']==[{'id':m['id'],'revision':1}]
        assert m['content'] not in json.dumps(events)
    asyncio.run(check())

@pytest.mark.parametrize('gate',[None,lambda db,ctx:True])
def test_context_does_not_grant_authority(setup,gate):
    async def check():
        f=setup;b=await bound(f)
        with pytest.raises(KnowledgeUnavailable,match='knowledge_binding_required'):
            await PostgresKnowledgeRuntime(f.dsn,binding_gate=gate).candidates(b.context)
        async def refuse(db,ctx): return False
        with pytest.raises(KnowledgeUnavailable):
            await PostgresKnowledgeRuntime(f.dsn,binding_gate=refuse).read_employee_memory(b.context)
    asyncio.run(check())

def test_unmapped_work_not_authorized(setup):
    async def check():
        f=setup;t=await f.store.create(f.token,bot_id=f.bot,objective='Standalone',token_limit=10,request_key=str(uuid4()))
        await f.store.claim(t['id'],t['runs'][0]['id'],'fixture')
        async def gate(db,ctx): raise AssertionError('Must reject before gate')
        with pytest.raises(KnowledgeUnavailable):
            await PostgresKnowledgeRuntime(f.dsn,binding_gate=gate).candidates(KnowledgeContext(t['id'],t['runs'][0]['id'],f.bot,f.channel))
    asyncio.run(check())

@pytest.mark.parametrize('mutation',['disable_resume','delete','revision','content','provenance'])
def test_consumed_memory_revalidated(setup,mutation):
    async def check():
        f=setup;b=await bound(f);m=await memory(f);receipt=(await b.runtime.read_employee_memory(b.context)).receipt
        if mutation=='disable_resume':
            await f.owner.update_memory(f.token,f.bot,m['id'],dict(expectedRevision=1,modelUseEnabled=False))
            await f.owner.update_memory(f.token,f.bot,m['id'],dict(expectedRevision=2,modelUseEnabled=True))
        elif mutation=='delete':
            await f.owner.delete_memory(f.token,f.bot,m['id'],dict(expectedRevision=1,ownerReviewed=True))
        elif mutation=='revision':
            await f.owner.update_memory(f.token,f.bot,m['id'],dict(expectedRevision=1,content='Changed fact'))
        else:
            with psycopg.connect(f.dsn) as db:
                if mutation=='content': db.execute("UPDATE employee_memories SET content='Integrity change' WHERE id=%s",(m['id'],))
                else: db.execute("UPDATE employee_memories SET provenance=provenance || '{\"fixture\":\"change\"}'::jsonb WHERE id=%s",(m['id'],))
        with pytest.raises(KnowledgeUnavailable,match='memory_changed'): await b.runtime.revalidate(b.context,(receipt,))
    asyncio.run(check())

@pytest.mark.parametrize('change',['attempt','correction'])
def test_audit_revision_retained_authority_generation_or_attempt_revokes(setup,change):
    async def check():
        f=setup;b=await bound(f);await memory(f);receipt=(await b.runtime.read_employee_memory(b.context)).receipt
        async with f.store._transaction(trusted=True) as db:
            await f.store._task(db,b.context.task_id); await f.store._event(db,b.context.task_id,'fixture.audit',{})
        await b.runtime.revalidate(b.context,(receipt,))
        if change=='attempt': await f.store.claim(b.context.task_id,b.context.run_id,str(uuid4()))
        else: await CorrectionStore(f.store).request(f.token,b.context.task_id,run_id=b.context.run_id,instruction='Corrected facts',request_key='correction',expected_sequence=0)
        with pytest.raises(WorkConflict): await b.runtime.revalidate(b.context,(receipt,))
    asyncio.run(check())

@pytest.mark.parametrize('mutation',['suspend_resume','revoke','digest','document','metadata','capability','delete'])
def test_skill_current_review_content_and_revision(setup,mutation):
    async def check():
        f=setup;b=await bound(f);s=await skill(f);await skill(f,False)
        catalog=await b.runtime.candidates(b.context,'source report');assert len(catalog.payload['skills'])==1
        read=await b.runtime.read_skill(b.context,catalog.receipt,s['id']);assert read.payload['markdown']==s['skillMarkdown']
        if mutation in ('suspend_resume','revoke'):
            await f.owner.set_skill_state(f.token,f.bot,s['id'],dict(state='suspended' if mutation=='suspend_resume' else 'revoked',reason='Review',ownerReviewed=True))
            if mutation=='suspend_resume': await f.owner.set_skill_state(f.token,f.bot,s['id'],dict(state='verified',reason='Resume',confidence=90,ownerReviewed=True,reviewedContentSha256=s['contentSha256']))
        else:
            with psycopg.connect(f.dsn) as db:
                sql={'digest':"UPDATE skills SET content_sha256=repeat('a',64) WHERE id=%s",'document':"UPDATE skills SET skill_markdown=skill_markdown || 'Changed' WHERE id=%s",'metadata':"UPDATE skills SET description='Changed' WHERE id=%s",'capability':"UPDATE skills SET required_capabilities='[\"shell\"]'::jsonb WHERE id=%s",'delete':'DELETE FROM employee_skills WHERE skill_id=%s'}[mutation]
                db.execute(sql,(s['id'],))
        with pytest.raises(KnowledgeUnavailable,match='skills_changed'): await b.runtime.revalidate(b.context,(read.receipt,))
    asyncio.run(check())

def test_catalog_and_consumption_caps(setup):
    async def check():
        f=setup;b=await bound(f)
        for _ in range(9): await skill(f)
        catalog=await b.runtime.candidates(b.context)
        assert len(catalog.payload['skills'])==8 and catalog.payload['truncated'] and byte_size(catalog.payload['skills'])<=4096
        reads=[(await b.runtime.read_skill(b.context,catalog.receipt,s['id'])).receipt for s in catalog.payload['skills'][:3]]
        await b.runtime.revalidate(b.context,reads[:2])
        with pytest.raises(KnowledgeUnavailable,match='knowledge_read_limit'): await b.runtime.revalidate(b.context,reads)
        with pytest.raises(KnowledgeUnavailable): await b.runtime.read_skill(b.context,asdict(catalog.receipt),reads[0].skills[0].id)
        with pytest.raises(KnowledgeUnavailable): await b.runtime.read_skill(b.context,catalog.receipt,str(uuid4()))
        with pytest.raises(KnowledgeUnavailable): await b.runtime.candidates(b.context,'中'*171)
    asyncio.run(check())

def test_utf8_bounds_and_javascript_projection(setup):
    async def check():
        f=setup;b=await bound(f)
        for index in range(9): await memory(f,title='事实'+str(index),content='中😀'+str(index)*3500)
        result=await b.runtime.read_employee_memory(b.context)
        assert result.payload['truncated'] and byte_size(result.payload['memories'])<=10240
        assert all(m['truncated'] and len(m['content'].encode())<=2000 for m in result.payload['memories'])
        with psycopg.connect(f.dsn) as db:
            rows=db.execute('SELECT row_to_json(m) FROM (SELECT * FROM employee_memories WHERE bot_id=%s ORDER BY updated_at DESC,id DESC LIMIT 9) m',(f.bot,)).fetchall()
        script=r'''import {readFileSync} from 'node:fs';
const {boundedKnowledgeText:bound}=await import(process.argv[1]);
const rows=JSON.parse(readFileSync(0,'utf8'));
let memories=[],truncated=rows.length>8;for(const r of rows.slice(0,8)){
const m={id:r.id,revision:r.revision,kind:r.kind,title:bound(r.title,640),content:bound(r.content,2000),truncated:Buffer.byteLength(r.content)>2000};
if(Buffer.byteLength(JSON.stringify([...memories,m]))>10240){truncated=true;break;}memories.push(m);}process.stdout.write(JSON.stringify({memories,truncated}));'''
        root=Path(openbot_server.__file__).resolve().parents[4]
        oracle=subprocess.run(['node','--import','tsx','--input-type=module','-e',script,(root/'tests/oracles/legacy-server/src/agent-knowledge.ts').as_uri()],cwd=root,input=json.dumps([r[0] for r in rows]),text=True,capture_output=True,check=True)
        assert json.loads(oracle.stdout)==result.payload
    asyncio.run(check())

def test_corrupt_sensitive_memory_not_exposed(setup):
    async def check():
        f=setup;b=await bound(f);m=await memory(f);marker='ghp_'+'a'*24
        with psycopg.connect(f.dsn) as db: db.execute('UPDATE employee_memories SET content=%s WHERE id=%s',(marker,m['id']))
        assert (await b.runtime.read_employee_memory(b.context)).payload=={'memories':[],'truncated':True}
        with psycopg.connect(f.dsn) as db: events=db.execute('SELECT payload FROM run_events WHERE run_id=%s',(b.source.id,)).fetchall()
        assert marker not in json.dumps(events)
    asyncio.run(check())

@pytest.mark.parametrize('revoke',['memory','membership'])
def test_same_transaction_locks_serialize_revocation(setup,revoke):
    async def check():
        f=setup;b=await bound(f);m=await memory(f);receipt=(await b.runtime.read_employee_memory(b.context)).receipt
        async with f.store._transaction(trusted=True) as db:
            await b.runtime.revalidate_in_transaction(db,b.context,(receipt,))
            action=(f.owner.update_memory(f.token,f.bot,m['id'],dict(expectedRevision=1,modelUseEnabled=False)) if revoke=='memory' else
                PostgresConversationInteractions(f.dsn,work_sources=f.sources).remove_member(f.token,f.channel,f.bot))
            worker=asyncio.create_task(action);await asyncio.sleep(.08);assert not worker.done()
        await worker
        with pytest.raises(KnowledgeUnavailable): await b.runtime.revalidate(b.context,(receipt,))
    asyncio.run(check())

def test_proposal_callback_real_completion_owner_review_and_source_deletion(setup):
    async def check():
        f=setup;b=await bound(f)
        proposal=await b.runtime.propose_memory(b.context,dict(kind='procedural',title='Checked method',content='Use checked source facts.'))
        assert proposal.payload==dict(status='prepared',requiresOwnerReview=True,activeMemoryChanged=False)
        assert await f.owner.proposals(f.token,f.bot)==[]
        async with f.store._transaction(trusted=True) as db:
            prepared=await b.runtime.proposal_for_completion_in_transaction(db,b.context,proposal)
            assert prepared['sourceRunId']==b.source.id
        await complete(f,b)
        # Parent owns atomic completion insertion. This test explicitly supplies the pending-row
        # callback result after actual completion; it does not claim the adapter owns publication.
        identity=str(uuid4())
        with psycopg.connect(f.dsn) as db:
            db.execute('INSERT INTO knowledge_proposals(id,bot_id,source_run_id,kind,title,content) VALUES(%s,%s,%s,%s,%s,%s)',
                (identity,prepared['botId'],prepared['sourceRunId'],prepared['kind'],prepared['title'],prepared['content']))
        accepted=await f.owner.review_proposal(f.token,f.bot,identity,dict(decision='accept',ownerReviewed=True,title=prepared['title'],content=prepared['content'],modelUseEnabled=True))
        target=await bound(f);read=await target.runtime.read_employee_memory(target.context)
        assert [m['id'] for m in read.payload['memories']]==[accepted['memoryId']]
        assert read.payload['memories'][0]['sourceRunId']==b.source.id
        with psycopg.connect(f.dsn) as db:
            assert db.execute('SELECT status FROM runs WHERE id=%s',(b.source.id,)).fetchone()[0]=='queued'
            db.execute('DELETE FROM knowledge_proposals WHERE id=%s',(identity,))
        with pytest.raises(KnowledgeUnavailable,match='memory_changed'): await target.runtime.revalidate(target.context,(read.receipt,))
        assert (await target.runtime.read_employee_memory(target.context)).payload['memories']==[]
    asyncio.run(check())

def test_proposal_sensitive_mutated_or_closed_refuses(setup):
    async def check():
        f=setup;b=await bound(f)
        with pytest.raises(ValueError): await b.runtime.propose_memory(b.context,dict(kind='semantic',title='Fixture',content='Bearer abcdefghijklmn'))
        proposal=await b.runtime.propose_memory(b.context,dict(kind='semantic',title='Fixture',content='Checked text'))
        async with f.store._transaction(trusted=True) as db:
            with pytest.raises(KnowledgeUnavailable): await b.runtime.proposal_for_completion_in_transaction(db,b.context,replace(proposal,content='Changed'))
        await complete(f,b)
        async with f.store._transaction(trusted=True) as db:
            with pytest.raises(KnowledgeUnavailable): await b.runtime.proposal_for_completion_in_transaction(db,b.context,proposal)
    asyncio.run(check())


def test_receipt_identity_and_limits_are_not_public_claims(setup):
    async def check():
        f=setup;b=await bound(f);await memory(f)
        read=await b.runtime.read_employee_memory(b.context)
        invalid=(asdict(read.receipt),replace(read.receipt,purpose='catalog'),
                 replace(read.receipt,memories=read.receipt.memories*2),replace(read.receipt,query_sha256='wrong'))
        for value in invalid:
            with pytest.raises(KnowledgeUnavailable): await b.runtime.revalidate(b.context,(value,))
        other=await bound(f)
        with pytest.raises(KnowledgeUnavailable,match='knowledge_binding_changed'):
            await other.runtime.revalidate(other.context,(read.receipt,))
    asyncio.run(check())


def test_pending_proposal_never_becomes_model_memory(setup):
    async def check():
        f=setup;b=await bound(f)
        p=await b.runtime.propose_memory(b.context,dict(kind='semantic',title='Fixture',content='Reviewed only after Owner action'))
        async with f.store._transaction(trusted=True) as db:
            await b.runtime.proposal_for_completion_in_transaction(db,b.context,p)
        assert (await b.runtime.read_employee_memory(b.context)).payload['memories']==[]
        assert await f.owner.proposals(f.token,f.bot)==[]
    asyncio.run(check())
