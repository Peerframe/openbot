"""Real durable report observations, bounded drafts and current-generation publication."""
import asyncio
from dataclasses import replace
from uuid import uuid4

import psycopg
import pytest
pytest.importorskip('temporalio', reason='optional Worker SDK profile')
from openbot_server.work_corrections import CorrectionStore
from openbot_server.work_effects import execute_action
from openbot_server.work_product_artifacts import ProductWorkArtifacts, report
from openbot_server.work_temporal_effect import ToolRequest
from openbot_server.work_tool_results import ToolResults
from openbot_server.work_values import InvalidWork, WorkConflict, canonical
from test_work_product_model import setup, bound, binding, SCOPE


@pytest.fixture
def prepared(setup):
    setup.store.files=setup.receipts.files
    yield setup
    with psycopg.connect(setup.dsn) as db:
        db.execute('DELETE FROM work_tool_results WHERE task_id IN (SELECT id FROM work_tasks WHERE bot_id=%s)',(setup.bot,))


async def execute(f,b,service,name='结果.md',markdown='Checked content',key='report-one'):
    arguments=dict(name=name,markdown=markdown)
    proposal=ToolRequest('write_report',arguments,canonical(arguments,max_bytes=65536)[1])
    plan=await service.prepare(b.context,proposal)
    intent=dict(kind='deferred_tool',tool='write_report',arguments=plan.prepared_arguments,
                effect=plan.intent,proposalSha256=proposal.digest)
    fence=await service.binding.claim(b.context)
    effect=await service.load(b.context,intent)
    return await execute_action(f.store,task_id=b.context.task_id,run_id=b.context.run_id,
        fence=fence,action_key='tool-activity-v1-'+key,intent=intent,reserved_tokens=0,
        requires_approval=False,adapter=effect.adapter,verifier=effect.verifier,
        correction_context=b.context.correction_token)


@pytest.mark.parametrize('value',[dict(name='../report.md',markdown='x'),dict(name='_report.md',markdown='x'),
    dict(name='report.html',markdown='x'),dict(name='report.md',markdown='x'*24577),
    dict(name='report.md',markdown='中'*9000),dict(name='report.md',markdown='\0'),
    dict(name='report.md',markdown=''),dict(name='report.md',markdown='x',path='/tmp')])
def test_report_bounds_preserve_plain_markdown_only(value):
    with pytest.raises(InvalidWork): report(value)


def test_durable_report_roundtrip_before_atomic_publication(prepared):
    async def check():
        f=prepared;b=await bound(f)
        service=ProductWorkArtifacts(f.store,object(),SCOPE,ToolResults(f.store,f.store.files))
        with binding(b):
            result=await execute(f,b,service)
            assert result.status=='applied'
            async with f.store._transaction(trusted=True) as db:
                row=await (await db.execute('SELECT * FROM work_actions WHERE id=%s',(result.action_id,))).fetchone()
                assert not await (await db.execute('SELECT 1 FROM work_artifacts WHERE task_id=%s',(b.context.task_id,))).fetchone()
            b.activity='read-result'
            assert await service.load_result(b.context,row)==dict(name='结果.md',status='prepared',publishedOnTaskCompletion=True)
            b.activity='publication'
            await service.binding.claim(b.context)
            artifacts=await service.artifacts(b.context)
            assert artifacts==({'key':result.action_id,'name':'结果.md','mediaType':'text/markdown','data':b'Checked content'},)
            with pytest.raises(WorkConflict,match='report_limit'):
                await execute(f,b,service,key='duplicate')
    asyncio.run(check())


def test_current_activity_fence_and_membership_refuse_stale_readback(prepared):
    async def check():
        f=prepared;b=await bound(f)
        service=ProductWorkArtifacts(f.store,object(),SCOPE,ToolResults(f.store,f.store.files))
        with binding(b):
            await execute(f,b,service)
            b.activity='next-without-claim'
            with pytest.raises(WorkConflict,match='execution_claim_required'):
                await service.artifacts(b.context)
            with psycopg.connect(f.dsn) as db:
                db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(f.channel,f.bot))
            with pytest.raises(WorkConflict,match='product_model_scope_changed'):
                await execute(f,b,service,name='other.md',key='other')
    asyncio.run(check())


def test_corrupt_draft_is_not_published(prepared):
    async def check():
        f=prepared;b=await bound(f)
        service=ProductWorkArtifacts(f.store,object(),SCOPE,ToolResults(f.store,f.store.files))
        with binding(b):
            result=await execute(f,b,service)
            with psycopg.connect(f.dsn) as db:
                digest=db.execute('SELECT sha256 FROM work_tool_results WHERE action_id=%s',(result.action_id,)).fetchone()[0]
            (f.store.files.directory/digest).write_bytes(b'corrupt')
            with pytest.raises(Exception): await service.artifacts(b.context)
    asyncio.run(check())


def test_owner_correction_drops_old_unpublished_drafts_and_preserves_receipts(prepared):
    async def check():
        f=prepared;b=await bound(f)
        service=ProductWorkArtifacts(f.store,object(),SCOPE,ToolResults(f.store,f.store.files))
        with binding(b):
            old=await execute(f,b,service)
            corrections=CorrectionStore(f.store)
            await corrections.request(f.token,b.context.task_id,run_id=b.context.run_id,
                instruction='Use the corrected evidence',request_key=str(uuid4()),expected_sequence=0)
            frozen=await corrections.freeze(b.context.task_id,b.context.run_id,'corrected-report')
            b.context=replace(b.context,correction_token=frozen['id']);b.activity='corrected-draft'
            fresh=await execute(f,b,service,markdown='Corrected content',key='report-two')
            b.activity='corrected-publication';await service.binding.claim(b.context)
            artifacts=await service.artifacts(b.context)
            assert len(artifacts)==1 and artifacts[0]['data']==b'Corrected content'
            assert artifacts[0]['key']==fresh.action_id
            snapshot=await f.store.snapshot(f.token,b.context.task_id)
            assert {row['id'] for row in snapshot['actions'] if row['status']=='applied'}=={old.action_id,fresh.action_id}
    asyncio.run(check())


@pytest.mark.parametrize('markdown',['x'*24000,'中'*8192,'\n'*24000])
def test_full_report_contract_uses_small_immutable_action_and_exact_blob(prepared,markdown):
    async def check():
        f=prepared;b=await bound(f)
        service=ProductWorkArtifacts(f.store,object(),SCOPE,ToolResults(f.store,f.store.files))
        with binding(b):
            result=await execute(f,b,service,markdown=markdown)
            async with f.store._transaction(trusted=True) as db:
                row=await (await db.execute('SELECT * FROM work_actions WHERE id=%s',(result.action_id,))).fetchone()
            assert len(canonical(row['intent'])[0])<1024
            assert row['intent']['proposalSha256']==canonical(dict(name='结果.md',markdown=markdown),max_bytes=65536)[1]
            assert (await service.artifacts(b.context))[0]['data']==markdown.encode('utf-8')
            blob=row['intent']['arguments']['markdownBlob']
            (f.store.files.directory/blob['sha256']).write_bytes(b'corrupt')
            from openbot_server.database import StoreUnavailable
            with pytest.raises(StoreUnavailable): await service.artifacts(b.context)
    asyncio.run(check())
