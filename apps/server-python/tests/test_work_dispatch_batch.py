"""Bounded ingress and observable uncertainty; no alternative dispatch authority."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import pytest
from openbot_server import work_dispatch_batch as batch
from openbot_server.work_dispatcher import DispatchResult
from openbot_server.work_values import InvalidWork, WorkConflict


def setup():
    a, b = dict(taskId='a', runId='ra'), dict(taskId='b', runId='rb')
    handoff = SimpleNamespace(pending=AsyncMock(return_value=[a, b]), unconfirmed=AsyncMock(return_value=[a]))
    return handoff, SimpleNamespace(namespace='default')


OPTIONS = dict(namespace='default', queue='queue', workflow_type='OpenBotWorkV1')


def test_once_per_identity_and_original_dispatcher_used():
    async def check():
        handoff, engine = setup()
        call = AsyncMock(return_value=DispatchResult(True, False, 'acknowledged'))
        with patch.object(batch, 'dispatch_one', call):
            result = await batch.dispatch_batch(handoff, engine, **OPTIONS)
        assert [r['taskId'] for r in result] == ['a', 'b']
        assert all(r['status'] == 'acknowledged' and r['startRequested'] is False for r in result)
        assert call.await_count == 2 and call.await_args_list[0].args[:2] == ('a','ra')
        handoff.pending.assert_awaited_once_with(16); handoff.unconfirmed.assert_awaited_once_with(16)
    asyncio.run(check())


@pytest.mark.parametrize('override', [dict(limit=True),dict(limit=0),dict(limit=65),
    dict(item_timeout_seconds=float('nan')),dict(item_timeout_seconds=True),dict(item_timeout_seconds=31),
    dict(execution_timeout_seconds=False),dict(execution_timeout_seconds=86401),dict(namespace='')])
def test_bad_configuration_before_observation(override):
    async def check():
        handoff, engine = setup()
        with pytest.raises(InvalidWork):
            await batch.dispatch_batch(handoff, engine, **(OPTIONS | override))
        handoff.pending.assert_not_awaited(); handoff.unconfirmed.assert_not_awaited()
    asyncio.run(check())


@pytest.mark.parametrize('rows', [[{'taskId':'a'}], [None], 'bad', [dict(taskId='a',runId='r')]*17])
def test_bad_rows_are_refused_before_any_dispatch(rows):
    async def check():
        handoff, engine = setup(); handoff.pending.return_value = rows
        with patch.object(batch, 'dispatch_one', AsyncMock()) as call, pytest.raises(InvalidWork):
            await batch.dispatch_batch(handoff, engine, **OPTIONS)
        call.assert_not_awaited()
    asyncio.run(check())


def test_timeout_is_unknown_and_error_does_not_leak_or_stop_other_items():
    async def check():
        handoff, engine = setup()
        for failure, status, reason in [(TimeoutError(), 'unconfirmed', 'observation_timeout'),
                                      (ValueError('synthetic-sensitive-value'), 'error', 'delivery_failed')]:
            call = AsyncMock(side_effect=[failure, DispatchResult(True, True, 'acknowledged')])
            with patch.object(batch, 'dispatch_one', call):
                result = await batch.dispatch_batch(handoff, engine, **OPTIONS)
            assert result[0] == dict(taskId='a',runId='ra',status=status,reason=reason,startRequested=None)
            assert result[1]['status']=='acknowledged' and call.await_count == 2
        call = AsyncMock(side_effect=asyncio.CancelledError())
        with patch.object(batch, 'dispatch_one', call), pytest.raises(asyncio.CancelledError):
            await batch.dispatch_batch(handoff, engine, **OPTIONS)
        assert call.await_count == 1
    asyncio.run(check())


def test_actual_deadline_and_initial_store_failure():
    async def check():
        handoff, engine = setup(); handoff.pending.return_value=[]
        async def blocked(*args):
            await asyncio.Event().wait()
        with patch.object(batch, 'dispatch_one', blocked):
            result=await batch.dispatch_batch(handoff,engine,**OPTIONS,item_timeout_seconds=.01)
        assert result[0]['reason']=='observation_timeout' and result[0]['startRequested'] is None
        handoff.pending.side_effect=RuntimeError('unavailable')
        with patch.object(batch, 'dispatch_one', AsyncMock()) as call, pytest.raises(RuntimeError):
            await batch.dispatch_batch(handoff,engine,**OPTIONS)
        call.assert_not_awaited()
        with pytest.raises(WorkConflict,match='namespace'):
            await batch.dispatch_batch(handoff,SimpleNamespace(namespace='other'),**OPTIONS)
    asyncio.run(check())
