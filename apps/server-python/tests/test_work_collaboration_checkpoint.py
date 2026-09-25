"""Real PG regression: segment checkpoints are distinct identities with semantic history."""
import asyncio
import os
from pathlib import Path
from dataclasses import replace
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
import pytest

from openbot_server.work_corrections import CorrectionStore, _digest
from openbot_server.work_effects import recover_action
from openbot_server.work_values import WorkConflict
from test_work_collaboration import seed,anyio_backend,harness


@pytest.fixture(autouse=True)
def candidate_module_identity():
    expected=os.environ.get('OPENBOT_TEST_EXPECTED_COLLABORATION_ADAPTER')
    if expected:
        import openbot_server.work_product_collaboration as module
        assert Path(module.__file__).resolve()==Path(expected).resolve()


async def joined(seed,tmp_path,*,nonempty=False):
    h=await harness(seed,tmp_path)
    if nonempty:
        await CorrectionStore(h.store).request(seed['token'],h.task['id'],run_id=h.run,
            instruction='Use the reviewed synthetic facts',request_key='correction-one',expected_sequence=0)
        frozen=await CorrectionStore(h.store).freeze(h.task['id'],h.run,'after-correction')
        h.correction['id']=frozen['id'];h.context=replace(h.context,correction_token=frozen['id'])
    start=await h.prepare(0);assert (await h.execute(start))['status']=='applied'
    child=(await h.relations())[0]
    wait=await h.prepare(1,'wait_for_task',dict(runId=child['child_source_run_id']))
    with psycopg.connect(seed['dsn']) as db:
        db.execute("UPDATE work_tasks SET status='completed',result_summary='Committed checkpoint evidence' WHERE id=%s",(child['child_task_id'],))
        db.execute("UPDATE work_runs SET status='completed' WHERE id=%s",(child['child_work_run_id'],))
    assert (await h.execute(wait))['status']=='applied'
    return h,start,wait


@pytest.mark.anyio
@pytest.mark.parametrize('nonempty',[False,True])
async def test_same_full_history_new_checkpoint_consumes_join(seed,tmp_path,nonempty):
    h,start,wait=await joined(seed,tmp_path,nonempty=nonempty)
    next_context=await CorrectionStore(h.store).freeze(h.task['id'],h.run,'next-segment')
    assert next_context['id']!=h.context.correction_token
    ctx=replace(h.context,correction_token=next_context['id'])
    assert await h.env.run(h.adapter.unconsumed_children,ctx)==()
    row=await h.row(wait)
    assert (await h.env.run(h.adapter.load_result,ctx,row))['result']=='Committed checkpoint evidence'
    collected=await h.env.run(h.adapter.collect_results,ctx)
    assert {item['actionId'] for item in collected}=={start,wait}
    async with h.store._transaction(trusted=True) as db:
        await h.store._task(db,ctx.task_id)
        with patch.object(h.store,'_transaction',side_effect=AssertionError('No nested transaction')):
            assert await h.adapter.unconsumed_in_transaction(db,ctx)==()
            assert await h.adapter.revalidate_in_transaction(db,ctx) is True


@pytest.mark.anyio
async def test_real_correction_requires_fresh_join_observation(seed,tmp_path):
    h,start,wait=await joined(seed,tmp_path)
    await CorrectionStore(h.store).request(seed['token'],h.task['id'],run_id=h.run,
        instruction='Reassess with new requirements',request_key='changed',expected_sequence=0)
    current=await CorrectionStore(h.store).freeze(h.task['id'],h.run,'corrected-segment')
    ctx=replace(h.context,correction_token=current['id'])
    assert await h.env.run(h.adapter.unconsumed_children,ctx)==(start,)
    async with h.store._transaction(trusted=True) as db:
        await h.store._task(db,ctx.task_id)
        with patch.object(h.store,'_transaction',side_effect=AssertionError('No nested transaction')):
            assert await h.adapter.unconsumed_in_transaction(db,ctx)==(start,)
            assert await h.adapter.revalidate_in_transaction(db,ctx) is True
    assert await h.env.run(h.adapter.collect_results,ctx)==()
    with pytest.raises(WorkConflict):await h.env.run(h.adapter.load_result,ctx,await h.row(wait))
    # Derive from the original immutable child; correction does not create another child.
    request=await h.env.run(h.adapter.join_request,ctx,start)
    h.correction['id']=current['id']
    fresh=await h.prepare(2,request.tool,request.arguments);assert (await h.execute(fresh))['status']=='applied'
    after=await CorrectionStore(h.store).freeze(h.task['id'],h.run,'next-after-corrected-join')
    assert await h.env.run(h.adapter.unconsumed_children,replace(ctx,correction_token=after['id']))==()
    assert len(await h.relations())==1


@pytest.mark.anyio
@pytest.mark.parametrize('corruption',['missing_context','digest','same_generation_different_full_history','row_generation'])
async def test_forged_historical_semantics_cannot_mark_child_consumed(seed,tmp_path,corruption):
    h,_,wait=await joined(seed,tmp_path,nonempty=True)
    next_context=await CorrectionStore(h.store).freeze(h.task['id'],h.run,'new-segment')
    ctx=replace(h.context,correction_token=next_context['id'])
    with psycopg.connect(seed['dsn']) as db:
        if corruption=='missing_context':
            # Foreign-task/nonexistent tokens are never accepted merely because generation matches.
            db.execute('UPDATE work_actions SET correction_context_id=NULL WHERE id=%s',(wait,))
        elif corruption=='row_generation':
            db.execute('UPDATE work_actions SET authority_generation=authority_generation-1 WHERE id=%s',(wait,))
        else:
            row=db.execute('SELECT generation,corrections FROM work_correction_contexts WHERE id=%s',(h.context.correction_token,)).fetchone()
            values=row[1]
            if corruption=='digest':
                db.execute("UPDATE work_correction_contexts SET content_digest=repeat('0',64) WHERE id=%s",(h.context.correction_token,))
            else:
                # Even a self-consistent record with matching generation/instruction but a
                # different correction identity is not equivalent to full trusted history.
                values[0]['id']=str(uuid4())
                digest=_digest(h.task['id'],h.run,row[0],values)
                db.execute('UPDATE work_correction_contexts SET corrections=%s,content_digest=%s WHERE id=%s',
                    (Jsonb(values),digest,h.context.correction_token))
    with pytest.raises(WorkConflict):await h.env.run(h.adapter.unconsumed_children,ctx)
    async with h.store._transaction(trusted=True) as db:
        with pytest.raises(WorkConflict):await h.adapter.revalidate_in_transaction(db,ctx)


@pytest.mark.anyio
async def test_transaction_barrier_fresh_authority_and_no_tool_writes(seed,tmp_path):
    h,start,wait=await joined(seed,tmp_path)
    before=await h.store.snapshot(seed['token'],h.task['id'])
    async with h.store._transaction(trusted=True) as db:
        await h.store._task(db,h.context.task_id)
        with patch.object(h.store,'_transaction',side_effect=AssertionError('No new connection')),patch.object(h.results,'save',side_effect=AssertionError('No writes')):
            assert await h.adapter.unconsumed_in_transaction(db,h.context)==()
            await db.execute('UPDATE work_tasks SET authority_active=false WHERE id=%s',(h.task['id'],))
            with pytest.raises(WorkConflict):await h.adapter.unconsumed_in_transaction(db,h.context)
            await db.execute('UPDATE work_tasks SET authority_active=true WHERE id=%s',(h.task['id'],))
    after=await h.store.snapshot(seed['token'],h.task['id'])
    assert before==after


@pytest.mark.anyio
async def test_closed_original_sql_receipt_services_only_restore_without_authority(seed,tmp_path):
    h=await harness(seed,tmp_path);identity=await h.prepare(0)
    with patch.object(h.results,'save',side_effect=asyncio.CancelledError()),pytest.raises(asyncio.CancelledError):await h.execute(identity)
    assert len(await h.relations())==1
    await h.store.cancel(seed['token'],h.task['id'])
    row=await h.row(identity)
    # Construction and recovery deliberately do not require a live SDK scope. Neither may
    # invoke, admit or recreate the original child after authority has closed.
    with patch.object(h.adapter,'invoke',side_effect=AssertionError('No apply')),patch.object(h.store,'admit',side_effect=AssertionError('No admission')):
        services=await h.adapter.load(h.context,row['intent'])
        outcome=await recover_action(h.store,task_id=h.task['id'],run_id=h.run,action_id=identity,adapter=services.adapter,verifier=services.verifier)
        assert outcome.status=='applied'
    assert len(await h.relations())==1
    assert not (await h.store.snapshot(seed['token'],h.task['id']))['authorityActive']
    with pytest.raises(WorkConflict):await h.env.run(h.adapter.invoke,h.context,identity,row['intent'])
