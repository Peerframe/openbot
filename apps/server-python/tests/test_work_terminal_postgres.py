"""Real owned PostgreSQL, original stores/locks and actual SDK protobuf/converter boundary."""
import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb
import pytest
pytest.importorskip('temporalio', reason='optional Worker SDK profile')

from openbot_server import work_terminal as terminal
from openbot_server.database import StoreUnavailable
from openbot_server.work_values import WorkConflict
from test_work_collaboration import seed
from test_work_failure import harness as failure_harness
from terminal_fixtures import SCOPE, engine


async def harness(seed, *, state='TERMINATED', task=None, store=None):
    h=await failure_harness(seed,task=task,store=store)
    async with h.store._transaction(trusted=True) as db:
        row=await (await db.execute('SELECT t.created_at,a.engine_first_run_id,a.submission_attempt_id FROM work_tasks t '
            'JOIN work_runs r ON r.task_id=t.id JOIN work_admissions a ON a.run_id=r.id WHERE t.id=%s AND r.id=%s',
            (h.task['id'],h.run))).fetchone()
    raw=await engine(h.task['id'],h.run,row['submission_attempt_id'],first=row['engine_first_run_id'],state=state,created_at=row['created_at'])
    proof=await terminal.observe_terminal(raw.client,raw.candidate,**SCOPE)
    async def close():return await terminal.close_terminal(h.store,raw.candidate,proof,**SCOPE)
    return SimpleNamespace(h=h,raw=raw,proof=proof,close=close)


@pytest.mark.anyio
@pytest.mark.parametrize('state',['TERMINATED','TIMED_OUT'])
async def test_terminal_unknown_and_cost_are_atomic_and_replayable(seed,state):
    t=await harness(seed,state=state);h=t.h
    ids={status:await h.action(status) for status in ('admitted','unknown','applied','not_applied','proposed')}
    before=await h.snapshot(); result=await t.close(); after=await h.snapshot()
    assert result['publicCode']=='engine_'+state.lower() and result['unresolvedActions']==2
    assert after['status']=='failed' and not after['authorityActive'] and after['runs'][0]['status']=='failed'
    assert after['usage']==before['usage']==dict(tokenLimit=100,reservedTokens=6,spentTokens=4)
    assert {a['id']:a['status'] for a in after['actions']}=={identity:('unknown' if state=='admitted' else state) for state,identity in ids.items()}
    assert after['attention']=='reconciliation'
    assert await t.close()==result and await h.snapshot()==after
    assert len([e for e in after['events'] if e['kind']=='task.failed'])==1
    assert len([e for e in after['events'] if e['kind']=='run.engine_terminal'])==1
    assert [e for e in before['events'] if e['kind']=='run.claimed']==[e for e in after['events'] if e['kind']=='run.claimed']
    await h.store.resolve(ids['admitted'],applied=True,actual_tokens=2,evidence=dict(source='synthetic',reference=ids['admitted'],sha256='b'*64))
    late=await h.snapshot();assert late['status']=='failed' and late['usage']['reservedTokens']==3
    assert await t.close()==result


@pytest.mark.anyio
async def test_unclaimed_queued_task_can_close_without_new_claim(seed):
    t=await harness(seed);result=await t.close()
    assert result['taskStatus']=='failed' and result['unresolvedActions']==0
    assert not any(e['kind']=='run.claimed' for e in (await t.h.snapshot())['events'])


@pytest.mark.anyio
async def test_owner_cancel_unknown_stays_pending_until_verified_receipt(seed):
    t=await harness(seed);h=t.h;action=await h.action()
    await h.store.cancel(seed['token'],h.task['id'])
    result=await t.close();after=await h.snapshot()
    assert result['disposition']=='cancellation_preserved' and after['status']=='open'
    assert after['cancelRequested'] and not after['authorityActive'] and after['actions'][0]['status']=='unknown'
    assert after['usage']['reservedTokens']==3 and not any(e['kind']=='task.failed' for e in after['events'])
    assert await terminal._page(h.store,'default',None,64)==()
    await h.store.resolve(action,applied=False,actual_tokens=0,evidence=dict(source='synthetic',reference=action,sha256='c'*64))
    assert (await h.snapshot())['status']=='cancelled'
    assert await t.close()==result


@pytest.mark.anyio
async def test_cancel_without_uncertainty_and_completed_task_are_not_overwritten(seed):
    for status in ('cancelled','completed'):
        t=await harness(seed);h=t.h
        if status=='cancelled':await h.store.cancel(seed['token'],h.task['id'])
        else:
            async with h.store._transaction(trusted=True) as db:
                await h.store._task(db,h.task['id'])
                await db.execute("UPDATE work_tasks SET status='completed',authority_active=false WHERE id=%s",(h.task['id'],))
                await db.execute("UPDATE work_runs SET status='completed' WHERE id=%s",(h.run,))
        before=await h.snapshot();assert (await t.close())['disposition']=='already_closed'
        assert await h.snapshot()==before


@pytest.mark.anyio
async def test_revoked_authority_never_becomes_active(seed):
    t=await harness(seed);await t.h.store.revoke(seed['token'],t.h.task['id'])
    assert (await t.close())['disposition']=='failed'
    assert not (await t.h.snapshot())['authorityActive']


@pytest.mark.anyio
@pytest.mark.parametrize('old_status',['queued','failed'])
async def test_old_engine_never_closes_newer_sql_run(seed,old_status):
    t=await harness(seed);h=t.h
    async with h.store._transaction(trusted=True) as db:
        await h.store._task(db,h.task['id'])
        await db.execute('UPDATE work_runs SET status=%s WHERE id=%s',(old_status,h.run))
        await db.execute('INSERT INTO work_runs(id,task_id,ordinal) VALUES(%s,%s,2)',(str(uuid4()),h.task['id']))
    before=await h.snapshot()
    with pytest.raises(WorkConflict,match='superseded'):await t.close()
    assert await h.snapshot()==before


@pytest.mark.anyio
async def test_original_attempt_rechecked_after_rpc_before_commit(seed):
    t=await harness(seed);h=t.h
    async with h.store._transaction(trusted=True) as db:
        await h.store._task(db,h.task['id'])
        await db.execute('UPDATE work_admissions SET submission_attempt_id=%s WHERE run_id=%s',('f'*32,h.run))
    before=await h.snapshot()
    with pytest.raises(WorkConflict,match='attempt_changed'):await t.close()
    assert await h.snapshot()==before


@pytest.mark.anyio
async def test_duplicate_instances_and_owner_cancel_have_one_outcome(seed):
    t=await harness(seed);h=t.h;await h.action()
    async def cancel():
        try:return await h.store.cancel(seed['token'],h.task['id'])
        except WorkConflict:return None
    values=await asyncio.gather(t.close(),t.close(),cancel())
    after=await h.snapshot();assert values[0]==values[1]
    assert after['actions'][0]['status']=='unknown' and after['usage']['reservedTokens']==3
    assert len([e for e in after['events'] if e['kind']=='run.engine_terminal'])==1
    assert (after['status'],after['cancelRequested']) in (('failed',False),('open',True))


@pytest.mark.anyio
async def test_transaction_failure_rolls_back_all_closure_facts(seed):
    t=await harness(seed);h=t.h;await h.action();before=await h.snapshot();name='terminal_'+uuid4().hex
    with psycopg.connect(seed['dsn']) as db:
        db.execute(sql.SQL("CREATE FUNCTION {}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='run.engine_terminal' THEN RAISE EXCEPTION 'synthetic-private-detail'; END IF; RETURN NEW; END $$").format(sql.Identifier(name)))
        db.execute(sql.SQL('CREATE TRIGGER {} BEFORE INSERT ON work_events FOR EACH ROW EXECUTE FUNCTION {}()').format(sql.Identifier(name),sql.Identifier(name)))
    try:
        with pytest.raises(StoreUnavailable):await t.close()
        assert await h.snapshot()==before
    finally:
        with psycopg.connect(seed['dsn']) as db:
            db.execute(sql.SQL('DROP TRIGGER {} ON work_events').format(sql.Identifier(name)))
            db.execute(sql.SQL('DROP FUNCTION {}()').format(sql.Identifier(name)))
    assert (await t.close())['disposition']=='failed'


@pytest.mark.anyio
async def test_commit_before_ack_recovers_original_without_claim_or_effect(seed):
    t=await harness(seed);h=t.h;await h.action();transaction=h.store._transaction
    @asynccontextmanager
    async def lose_ack(*args,**kwargs):
        async with transaction(*args,**kwargs) as db:yield db
        raise RuntimeError('synthetic lost acknowledgement')
    with patch.object(h.store,'_transaction',lose_ack),pytest.raises(RuntimeError):await t.close()
    before=await h.snapshot();result=await t.close()
    assert result['disposition']=='failed' and await h.snapshot()==before
    assert len([e for e in before['events'] if e['kind']=='task.failed'])==1


@pytest.mark.anyio
async def test_terminal_event_corruption_is_not_acknowledged(seed):
    t=await harness(seed);await t.close();h=t.h
    async with h.store._transaction(trusted=True) as db:
        await h.store._task(db,h.task['id'])
        await db.execute("UPDATE work_events SET payload=jsonb_set(payload,'{result,unresolvedActions}','true') WHERE task_id=%s AND kind='run.engine_terminal'",(h.task['id'],))
    before=await h.snapshot()
    with pytest.raises(WorkConflict,match='record_invalid'):await t.close()
    assert await h.snapshot()==before


@pytest.mark.anyio
async def test_late_actual_failure_activity_can_only_read_terminal_result(seed):
    t=await harness(seed);await t.close();h=t.h;before=await h.snapshot()
    result=await h.invoke()
    assert result['disposition']=='already_failed' and result['publicCode']=='engine_terminated'
    assert await h.snapshot()==before


@pytest.mark.anyio
async def test_shared_tree_cascade_and_child_isolation(seed,tmp_path):
    from test_work_collaboration import harness as collaboration_harness
    ch=await collaboration_harness(seed,tmp_path/'parent')
    identity=await ch.prepare(0);await ch.execute(identity);link=(await ch.relations())[0]
    t=await harness(seed,task=await ch.store.snapshot(seed['token'],ch.task['id']),store=ch.store)
    await t.close()
    child=await ch.store.snapshot(seed['token'],link['child_task_id'])
    assert child['status']=='cancelled' and child['cancelRequested'] and not child['authorityActive']
    ch=await collaboration_harness(seed,tmp_path/'child')
    identity=await ch.prepare(0);await ch.execute(identity);link=(await ch.relations())[0]
    parent=await ch.store.snapshot(seed['token'],ch.task['id'])
    t=await harness(seed,task=await ch.store.snapshot(seed['token'],link['child_task_id']),store=ch.store)
    await t.h.action();await t.close()
    assert await ch.store.snapshot(seed['token'],ch.task['id'])==parent


@pytest.mark.anyio
async def test_keyset_rotation_reset_and_multiple_instances_cannot_starve(seed):
    cases=[await harness(seed) for _ in range(5)]
    terminal_id=cases[-1].h.task['id']
    async def observed(client,candidate,**scope):
        return cases[-1].proof if candidate.cursor.task_id==terminal_id else None
    with patch.object(terminal,'observe_terminal',observed):
        first=await terminal.terminal_batch(cases[0].h.store,cases[0].raw.client,limit=2,**SCOPE)
        assert first.next_cursor is not None and all(row['status']=='not_terminal' for row in first.results)
        reset=await terminal.terminal_batch(cases[0].h.store,cases[0].raw.client,limit=2,**SCOPE)
        assert reset==first
        second=await terminal.terminal_batch(cases[0].h.store,cases[0].raw.client,limit=2,after=first.next_cursor,**SCOPE)
        third,duplicate=await asyncio.gather(*[terminal.terminal_batch(cases[0].h.store,cases[0].raw.client,limit=2,after=second.next_cursor,**SCOPE) for _ in range(2)])
        assert third.next_cursor is duplicate.next_cursor is None
        assert (await cases[-1].h.snapshot())['status']=='failed'
        assert len([e for e in (await cases[-1].h.snapshot())['events'] if e['kind']=='run.engine_terminal'])==1
        wrap=await terminal.terminal_batch(cases[0].h.store,cases[0].raw.client,limit=2,after=None,**SCOPE)
        assert wrap==first
        empty=await terminal.terminal_batch(cases[0].h.store,cases[0].raw.client,limit=2,after=cases[-1].raw.candidate.cursor,**SCOPE)
        assert empty.results==() and empty.next_cursor is None


@pytest.mark.anyio
async def test_unavailable_observation_is_sanitized_and_cursor_still_advances(seed):
    t=await harness(seed);before=await t.h.snapshot()
    with patch.object(terminal,'observe_terminal',AsyncMock(side_effect=RuntimeError('synthetic-private-detail'))):
        result=await terminal.terminal_batch(t.h.store,t.raw.client,limit=1,**SCOPE)
    assert result.next_cursor is not None and result.results[0]['status']=='unconfirmed'
    assert 'private' not in str(result) and await t.h.snapshot()==before


@pytest.mark.anyio
async def test_new_insert_after_page_cursor_is_observed_before_wrap(seed):
    first=await harness(seed)
    with patch.object(terminal,'observe_terminal',AsyncMock(return_value=None)):
        page=await terminal.terminal_batch(first.h.store,first.raw.client,limit=1,**SCOPE)
    added=await harness(seed)
    with patch.object(terminal,'observe_terminal',AsyncMock(return_value=added.proof)):
        result=await terminal.terminal_batch(first.h.store,first.raw.client,limit=2,after=page.next_cursor,**SCOPE)
    assert len(result.results)==1 and result.results[0]['taskId']==added.h.task['id']
    assert result.results[0]['status']=='closed' and result.next_cursor is None


@pytest.mark.anyio
async def test_parent_and_child_terminal_closure_use_common_lock_order(seed,tmp_path):
    from test_work_collaboration import harness as collaboration_harness
    ch=await collaboration_harness(seed,tmp_path)
    identity=await ch.prepare(0);await ch.execute(identity);link=(await ch.relations())[0]
    parent=await harness(seed,task=await ch.store.snapshot(seed['token'],ch.task['id']),store=ch.store)
    child=await harness(seed,task=await ch.store.snapshot(seed['token'],link['child_task_id']),store=ch.store)
    await child.h.action()
    async with asyncio.timeout(4):await asyncio.gather(parent.close(),child.close())
    result=await child.h.snapshot()
    assert (await parent.h.snapshot())['status']=='failed'
    assert result['actions'][0]['status']=='unknown' and result['usage']['reservedTokens']==3
    assert (result['status'],result['cancelRequested']) in (('failed',False),('open',True))


@pytest.mark.anyio
async def test_original_completed_publication_is_preserved_without_verifying_again(seed,tmp_path):
    from test_work_failure import publication
    t=await harness(seed);h=t.h
    host,env,verify=await publication(h,tmp_path)
    await env.run(host.publish_task,'Verified synthetic report')
    before=await h.snapshot();count=verify.await_count
    assert (await t.close())['disposition']=='already_closed'
    assert await h.snapshot()==before and verify.await_count==count


@pytest.mark.anyio
async def test_review_inflight_cannot_publish_after_terminal_closure(seed,tmp_path):
    from test_work_failure import publication
    t=await harness(seed);h=t.h;host,env,verify=await publication(h,tmp_path)
    entered,released=asyncio.Event(),asyncio.Event();verdict=verify.return_value
    async def slow(*_):entered.set();await released.wait();return verdict
    verify.side_effect=slow
    running=asyncio.create_task(env.run(host.publish_task,'Verified synthetic report'))
    await asyncio.wait_for(entered.wait(),2)
    try:assert (await t.close())['disposition']=='failed'
    finally:released.set()
    with pytest.raises(WorkConflict):await running
    after=await h.snapshot();assert after['status']=='failed' and after['artifacts']==[]
