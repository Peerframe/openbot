"""Real disposable PostgreSQL + SDK ActivityEnvironment; no live Temporal Server."""
import asyncio
from dataclasses import replace
from datetime import datetime, timedelta
from unittest.mock import patch

import psycopg
import pytest
from openbot_server.work_collaboration_activities import CollaborationActivities
from openbot_server.work_values import InvalidWork, WorkConflict
from test_work_collaboration import harness, seed


def observer(h):
    h.host.deferred=h.activities
    return CollaborationActivities(h.host,h.adapter.join_request,h.adapter.unconsumed_children)


@pytest.mark.anyio
async def test_ordinary_task_has_no_deadline_or_mutation(seed,tmp_path):
    h=await harness(seed,tmp_path);service=observer(h)
    before=await h.store.snapshot(seed['token'],h.task['id'])
    assert await h.env.run(service.deadline,{}) is None
    assert await h.store.snapshot(seed['token'],h.task['id'])==before


@pytest.mark.anyio
async def test_root_and_started_child_share_exact_original_first_claim(seed,tmp_path):
    h=await harness(seed,tmp_path/'root');service=observer(h)
    action=await h.prepare(0);await h.execute(action);link=(await h.relations())[0]
    first=await h.env.run(service.deadline,{})
    with psycopg.connect(seed['dsn']) as db:
        origin=db.execute("SELECT created_at FROM work_events WHERE task_id=%s AND kind='run.claimed' "
            "AND payload->>'runId'=%s ORDER BY created_at,revision LIMIT 1",(h.task['id'],h.run)).fetchone()[0]
    assert first==dict(version=1,rootTaskId=h.task['id'],rootRunId=h.run,deadline=(origin+timedelta(seconds=300)).isoformat())
    await h.store.claim(h.task['id'],h.run,'later-claim')
    h.env.info=replace(h.env.info,attempt=2)
    assert await h.env.run(service.deadline,{})==first
    child=await harness(seed,tmp_path/'child',existing=link['child_task_id'])
    assert await child.env.run(observer(child).deadline,{})==first


@pytest.mark.anyio
async def test_unknown_creation_commit_is_visible_without_tool_receipt(seed,tmp_path):
    h=await harness(seed,tmp_path);action=await h.prepare(0)
    with patch.object(h.results,'save',side_effect=asyncio.CancelledError()),pytest.raises(asyncio.CancelledError):
        await h.execute(action)
    with psycopg.connect(seed['dsn']) as db:
        assert db.execute('SELECT count(*) FROM work_tool_results WHERE action_id=%s',(action,)).fetchone()[0]==0
    before=await h.store.snapshot(seed['token'],h.task['id'])
    result=await h.env.run(observer(h).deadline,{})
    assert result['rootTaskId']==h.task['id'] and result['rootRunId']==h.run
    assert await h.store.snapshot(seed['token'],h.task['id'])==before


@pytest.mark.anyio
async def test_cancelled_expired_tree_fact_remains_readable_without_authority(seed,tmp_path):
    h=await harness(seed,tmp_path);action=await h.prepare(0);await h.execute(action)
    service=observer(h);first=await h.env.run(service.deadline,{})
    await h.store.cancel(seed['token'],h.task['id'])
    assert await h.env.run(service.deadline,{})==first
    # Move the entire synthetic origin consistently; stored immutable deadline is verified.
    with psycopg.connect(seed['dsn']) as db:
        db.execute("UPDATE work_events SET created_at=created_at-interval '301 seconds' WHERE task_id=%s AND kind='run.claimed'",(h.task['id'],))
        db.execute("UPDATE work_collaborations SET deadline_at=deadline_at-interval '301 seconds' WHERE root_task_id=%s",(h.task['id'],))
    expired=await h.env.run(service.deadline,{})
    assert datetime.fromisoformat(expired['deadline'])==datetime.fromisoformat(first['deadline'])-timedelta(seconds=301)
    with pytest.raises(WorkConflict):await h.store.claim(h.task['id'],h.run,'must-not-grant')


@pytest.mark.anyio
@pytest.mark.parametrize('change',['queue','first_run','attempt','missing_claim','stored_deadline'])
async def test_corrupt_binding_or_origin_is_rejected(seed,tmp_path,change):
    h=await harness(seed,tmp_path);action=await h.prepare(0);await h.execute(action)
    if change=='queue':h.env.info=replace(h.env.info,task_queue='wrong')
    elif change=='first_run':h.start.first_execution_run_id='unaccepted'
    elif change=='attempt':h.client.data_converter.decode.return_value=[h.start_input|dict(attemptId='a'*32)]
    else:
        with psycopg.connect(seed['dsn']) as db:
            if change=='missing_claim':db.execute("DELETE FROM work_events WHERE task_id=%s AND kind='run.claimed'",(h.task['id'],))
            else:db.execute("UPDATE work_collaborations SET deadline_at=deadline_at+interval '1 second' WHERE root_task_id=%s",(h.task['id'],))
    with pytest.raises((WorkConflict,InvalidWork)):await h.env.run(observer(h).deadline,{})


@pytest.mark.anyio
@pytest.mark.parametrize('value',[None,[],{'deadline':'2099-01-01T00:00:00+00:00'},{'taskId':'other'}])
async def test_request_cannot_supply_scope_or_extend_deadline(seed,tmp_path,value):
    h=await harness(seed,tmp_path)
    with pytest.raises(InvalidWork):await h.env.run(observer(h).deadline,value)


@pytest.mark.anyio
async def test_outside_actual_sdk_rejected(seed,tmp_path):
    h=await harness(seed,tmp_path)
    with pytest.raises((WorkConflict,InvalidWork)):await observer(h).deadline({})
