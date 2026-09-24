"""No mutation is inferred from a delivery attempt or from the latest same-ID engine Run."""
import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import pytest
pytest.importorskip('temporalio')
pytest.importorskip('pydantic_ai')
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'agent-runtime-python/src'))
from temporalio.client import WorkflowExecutionStatus as Status
from openbot_server import work_repair_dispatch as dispatch
from openbot_server.work_values import WorkConflict, InvalidWork

VALUE = dict(taskId='task', runId='run', actionId='action', commandId='command')
SETTINGS = dict(namespace='namespace', queue='queue', workflow_type='OpenBotWorkV1')


def setup(outcome=None, original=Status.TERMINATED, repair=Status.RUNNING, previous=None):
    commands = SimpleNamespace(read=AsyncMock(return_value=dict(outcome=outcome, delivery_reference=previous)),
        acknowledge=AsyncMock(), pending=AsyncMock(return_value=[VALUE]))
    description = SimpleNamespace(run_id='repair-run', status=repair)
    client = SimpleNamespace(namespace='namespace', start_workflow=AsyncMock(),
        get_workflow_handle=lambda *a, **k: SimpleNamespace(describe=AsyncMock(return_value=description)))
    start = SimpleNamespace(workflow_type=dispatch.TYPE, task_queue='queue', first_run_id='repair-run', input=VALUE)
    return commands, client, start, AsyncMock(return_value=original)


@pytest.mark.parametrize('outcome', ['resolved', 'unresolved'])
def test_finished_cycle_repeated_delivery_never_starts_or_checks_engine(outcome):
    async def check():
        commands, client, start, original = setup(outcome=outcome)
        with patch.object(dispatch, 'ReconciliationStore', return_value=commands), patch.object(dispatch,'original_run',original):
            assert await dispatch.deliver_closed_repair(None,client,VALUE,**SETTINGS)==dict(status='finished',outcome=outcome)
        original.assert_not_awaited();client.start_workflow.assert_not_awaited();commands.acknowledge.assert_not_awaited()
    asyncio.run(check())


def test_running_original_is_left_to_its_existing_workflow():
    async def check():
        commands,client,start,original=setup(original=Status.RUNNING)
        with patch.object(dispatch,'ReconciliationStore',return_value=commands),patch.object(dispatch,'original_run',original):
            assert (await dispatch.deliver_closed_repair(None,client,VALUE,**SETTINGS))['status']=='waiting_original'
        client.start_workflow.assert_not_awaited();commands.acknowledge.assert_not_awaited()
    asyncio.run(check())


@pytest.mark.parametrize('previous',[None,'original-workflow-delivery'])
def test_exact_repair_start_preserves_existing_delivery_reference(previous):
    async def check():
        commands,client,start,original=setup(previous=previous)
        inspect=AsyncMock(return_value=start)
        with patch.object(dispatch,'ReconciliationStore',return_value=commands),patch.object(dispatch,'original_run',original), \
             patch.object(dispatch.TemporalEnginePort,'inspect_start',inspect):
            result=await dispatch.deliver_closed_repair(None,client,VALUE,**SETTINGS)
        assert result==dict(status='delivered',outcome=None)
        assert commands.acknowledge.await_count==(0 if previous else 1)
        assert client.start_workflow.await_args.kwargs['execution_timeout'].total_seconds()==180
        inspect.assert_awaited_once_with(dispatch.PREFIX+'command',run_id='repair-run')
    asyncio.run(check())


@pytest.mark.parametrize('field,value',[('workflow_type','wrong'),('task_queue','wrong'),
    ('first_run_id','other-chain'),('input',VALUE|dict(actionId='other'))])
def test_colliding_repair_never_acknowledged(field,value):
    async def check():
        commands,client,start,original=setup();setattr(start,field,value)
        with patch.object(dispatch,'ReconciliationStore',return_value=commands),patch.object(dispatch,'original_run',original), \
             patch.object(dispatch.TemporalEnginePort,'inspect_start',AsyncMock(return_value=start)),pytest.raises(WorkConflict):
            await dispatch.deliver_closed_repair(None,client,VALUE,**SETTINGS)
        commands.acknowledge.assert_not_awaited()
    asyncio.run(check())


def test_closed_repair_finishes_current_facts_without_restart_or_success_guess():
    async def check():
        commands,client,start,original=setup(repair=Status.FAILED)
        finish=AsyncMock(return_value='unresolved')
        with patch.object(dispatch,'ReconciliationStore',return_value=commands),patch.object(dispatch,'original_run',original), \
             patch.object(dispatch.TemporalEnginePort,'inspect_start',AsyncMock(return_value=start)),patch.object(dispatch,'finish_current',finish):
            assert await dispatch.deliver_closed_repair(None,client,VALUE,**SETTINGS)==dict(status='finished',outcome='unresolved')
        finish.assert_awaited_once_with(None,VALUE)
    asyncio.run(check())


def test_batch_is_bounded_and_delivery_failure_remains_unconfirmed():
    async def check():
        commands,client,_,_=setup()
        for failure in (TimeoutError(),ValueError('sensitive internal value')):
            call=AsyncMock(side_effect=failure)
            with patch.object(dispatch,'ReconciliationStore',return_value=commands),patch.object(dispatch,'deliver_closed_repair',call):
                rows=await dispatch.repair_batch(None,client,**SETTINGS)
            assert rows[0]['status']=='unconfirmed' and 'sensitive' not in str(rows)
        commands.pending.return_value=[VALUE,{'taskId':'bad'}]
        with patch.object(dispatch,'ReconciliationStore',return_value=commands), \
             patch.object(dispatch,'deliver_closed_repair',AsyncMock()) as call,pytest.raises(InvalidWork):
            await dispatch.repair_batch(None,client,**SETTINGS)
        call.assert_not_awaited()
    asyncio.run(check())
