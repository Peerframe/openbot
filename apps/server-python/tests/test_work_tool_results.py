"""Received tool bytes survive crashes; no synthetic provider response grants new authority."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import psycopg
import pytest

from openbot_server.database import StoreUnavailable
from openbot_server.work_effects import execute_action, recover_action
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_tool_results import (ToolResults, ToolResponseAdapter, ToolResponseVerifier,
                                             encode_result, decode_result)
from openbot_server.work_values import InvalidWork, WorkConflict, canonical
from test_work_postgres import new, store


async def harness(fixture, tmp_path, *, approval=False):
    service = store(fixture)
    task = await new(fixture, service, 100)
    run = task['runs'][0]['id']
    fence = await service.claim(task['id'], run, 'tool')
    tmp_path.chmod(0o700)
    results = ToolResults(service, LocalWorkFiles(tmp_path))
    intent = dict(kind='deferred_tool', tool='read_facts', arguments={}, effect={'operation':'read'})
    scope = dict(task_id=task['id'], run_id=run, intent_digest=canonical(intent)[1])
    invoke = AsyncMock(return_value={'facts':['received content', '中文'], 'isError':False})
    adapter = ToolResponseAdapter(results, invoke, **scope)
    verifier = ToolResponseVerifier(results)
    async def execute():
        return await execute_action(service, task_id=task['id'], run_id=run, fence=fence,
            action_key='tool-activity-v1-test', intent=intent, reserved_tokens=0, requires_approval=approval,
            adapter=adapter, verifier=verifier)
    async def read_action():
        return (await service.snapshot(fixture['token'], task['id']))['actions'][0]
    return SimpleNamespace(**locals())


def test_ack_loss_reads_original_tool_result_without_another_call(fixture, tmp_path):
    async def check():
        h = await harness(fixture, tmp_path)
        original = h.results.save
        async def interrupted(*args, **kwargs):
            await original(*args, **kwargs)
            raise asyncio.CancelledError()
        with patch.object(h.results, 'save', interrupted), pytest.raises(asyncio.CancelledError):
            await h.execute()
        action = await h.read_action()
        assert action['status'] == 'admitted'
        fresh = ToolResults(h.service, LocalWorkFiles(tmp_path))
        recovered = await recover_action(h.service, task_id=h.task['id'], run_id=h.run,
            action_id=action['id'], adapter=ToolResponseAdapter(fresh, h.invoke, **h.scope),
            verifier=ToolResponseVerifier(fresh))
        observed = await fresh.load(action['id'], **h.scope)
        assert recovered.status == 'applied' and not recovered.invoked_apply
        assert observed.value == h.invoke.return_value and h.invoke.await_count == 1
        assert (await h.execute()).status == 'applied' and h.invoke.await_count == 1
    asyncio.run(check())


def test_unknown_missing_response_never_resends(fixture, tmp_path):
    async def check():
        h = await harness(fixture, tmp_path)
        h.invoke.side_effect = TimeoutError('unobserved')
        first = await h.execute()
        assert first.status == 'unknown'
        second = await h.execute()
        assert second.status == 'unknown' and h.invoke.await_count == 1
        assert await h.results.load(first.action_id, **h.scope) is None
    asyncio.run(check())


def test_pending_approval_accepts_no_response_blob(fixture, tmp_path):
    async def check():
        h = await harness(fixture, tmp_path, approval=True)
        with pytest.raises(WorkConflict):
            await h.execute()
        action = await h.read_action()
        with pytest.raises(WorkConflict, match='not_admitted'):
            await h.results.save(action['id'], **h.scope, value={'invented':True})
        assert h.invoke.await_count == 0 and list(tmp_path.iterdir()) == []
    asyncio.run(check())


def test_cancelled_result_records_history_but_cannot_continue(fixture, tmp_path):
    async def check():
        h = await harness(fixture, tmp_path)
        async def late(*_):
            await h.service.cancel(fixture['token'], h.task['id'])
            return {'late':'response'}
        h.invoke.side_effect = late
        outcome = await h.execute()
        assert outcome.status == 'applied'
        assert (await h.results.load(outcome.action_id, **h.scope)).value == {'late':'response'}
        task = await h.service.snapshot(fixture['token'], h.task['id'])
        assert not task['authorityActive'] and task['status'] == 'cancelled'
        with pytest.raises(WorkConflict):
            await h.service.claim(task['id'], h.run, 'new')
    asyncio.run(check())


@pytest.mark.parametrize('damage', ['blob', 'missing', 'metadata', 'evidence'])
def test_settled_corruption_never_replaced_or_hidden(fixture, tmp_path, damage):
    async def check():
        h = await harness(fixture, tmp_path)
        outcome = await h.execute()
        observed = await h.results.load(outcome.action_id, **h.scope)
        with psycopg.connect(fixture['dsn']) as db:
            if damage == 'blob':
                (tmp_path / observed.metadata['sha256']).write_bytes(b'corrupt')
            elif damage == 'missing':
                db.execute('DELETE FROM work_tool_results WHERE action_id=%s', (outcome.action_id,))
            elif damage == 'metadata':
                db.execute("UPDATE work_tool_results SET intent_digest=%s WHERE action_id=%s", ('a'*64, outcome.action_id))
            else:
                db.execute("UPDATE work_actions SET evidence=jsonb_set(evidence,'{sha256}',to_jsonb(%s::text)) WHERE id=%s",
                           ('b'*64, outcome.action_id))
        with pytest.raises((WorkConflict, StoreUnavailable)):
            await h.results.load(outcome.action_id, **h.scope)
        with pytest.raises((WorkConflict, StoreUnavailable)):
            await h.results.save(outcome.action_id, **h.scope, value=h.invoke.return_value)
        assert h.invoke.await_count == 1
    asyncio.run(check())


def test_wrong_scope_and_changed_result_refused(fixture, tmp_path):
    async def check():
        h = await harness(fixture, tmp_path)
        outcome = await h.execute()
        for name in ('task_id', 'run_id', 'intent_digest'):
            scope = h.scope | {name:'other'}
            with pytest.raises(WorkConflict, match='scope'):
                await h.results.load(outcome.action_id, **scope)
        wrong = ToolResponseAdapter(h.results, h.invoke, **(h.scope | {'task_id':'other'}))
        with pytest.raises(WorkConflict, match='scope'):
            await wrong.apply(outcome.action_id, h.intent)
        with pytest.raises(WorkConflict):
            await h.results.save(outcome.action_id, **h.scope, value={'changed':True})
        assert h.invoke.await_count == 1
    asyncio.run(check())


@pytest.mark.parametrize('value', [list(range(5000)), {'x'*129:1}, {'':1}, {'text':'a\0b'}, 2**53])
def test_retained_tool_json_shapes_roundtrip(value):
    data, _ = encode_result(value)
    assert decode_result(data) == value


def test_result_bounds_and_non_json_refusal():
    value = 0
    for _ in range(64): value = [value]
    assert decode_result(encode_result(value)[0]) == value
    for bad in ([value], {'bytes':b'x'}, {'tuple':(1,)}, {1:'key'}, float('nan'), 'x'*131072, '\ud800'):
        with pytest.raises(InvalidWork): encode_result(bad)
    cyclic = []; cyclic.append(cyclic)
    with pytest.raises(InvalidWork): encode_result(cyclic)
    with pytest.raises(WorkConflict): decode_result(b'{"a":1, "a":2}')


def test_activity_result_checks_scope_and_revocation_after_read(fixture, tmp_path):
    pytest.importorskip('temporalio')
    from openbot_server.work_deferred import DeferredActivities
    async def check():
        h = await harness(fixture, tmp_path)
        outcome = await h.execute()
        # Exercise the actual Activity's private reader after a real stored Action transition.
        context = SimpleNamespace(task_id=h.task['id'], run_id=h.run)
        async def reader(ctx, row):
            return (await h.results.load(row['id'], **h.scope)).value
        host = SimpleNamespace(store=h.service, client=object(), scope={}, load_tool_result=reader)
        activities = DeferredActivities(host, lambda *_:None, lambda *_:None)
        activities._context = AsyncMock(return_value=context)
        result = await activities.result(outcome.action_id)
        assert result['result'] == h.invoke.return_value
        async def revoking(ctx, row):
            value = await reader(ctx, row)
            await h.service.cancel(fixture['token'], h.task['id'])
            return value
        host.load_tool_result = revoking
        with pytest.raises(WorkConflict): await activities.result(outcome.action_id)
    asyncio.run(check())
