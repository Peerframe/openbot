"""Batch refusal occurs before any proposal Activity; resumed SDK retains context and usage."""
import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock,patch
sys.path[:0]=[str(Path(__file__).parents[2]/'apps/server-python/src'),str(Path(__file__).parents[2]/'apps/agent-runtime-python/src')]
from pydantic_ai import DeferredToolRequests
from pydantic_ai.messages import ToolCallPart
from temporalio.exceptions import ApplicationError
from openbot_server import work_worker as worker


class ProductDeferredTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # These unit cases run without a Temporal loop and exercise the current patch branch.
        marker = patch.object(worker.workflow, 'patched', return_value=True)
        self.marker = marker.start()
        self.addCleanup(marker.stop)

    async def test_mixed_batch_refused_before_first_prepare(self):
        for bad in [ToolCallPart('write','[]',tool_call_id='bad'),
                    ToolCallPart('write',{},tool_call_id=['unhashable']),
                    ToolCallPart('write',{},tool_call_id='good')]:
            result=SimpleNamespace(output=DeferredToolRequests(calls=[ToolCallPart('write',{},tool_call_id='good'),bad]))
            execute=AsyncMock(side_effect=[dict(taskId='t',runId='r',objective='task'),dict(completion=None)])
            with patch.object(worker.workflow,'execute_activity',execute),patch.object(worker,'agent',SimpleNamespace(run=AsyncMock(return_value=result))):
                with self.assertRaises(ApplicationError) as error:await worker.OpenBotWork().run({})
            self.assertTrue(error.exception.non_retryable)
            self.assertEqual(error.exception.type, 'OpenBotTaskFailed')
            self.assertEqual([item.args[0] for item in execute.await_args_list],
                ['openbot.load_task.v1', 'openbot.finalize_task_failure.v1'])
            self.assertEqual(execute.await_args.args[1],dict(version=1,code='execution_failed'))

    async def test_resume_keeps_history_and_one_usage_object(self):
        first=SimpleNamespace(output=DeferredToolRequests(calls=[ToolCallPart('write',{},tool_call_id='call')]),
                              all_messages=lambda:['original-message-history'])
        run=AsyncMock(side_effect=[first,SimpleNamespace(output='verified')])
        execute=AsyncMock(side_effect=[dict(taskId='t',runId='r',objective='task'),'action',
            dict(status='approved'),dict(actionId='action',status='applied'),dict(status='completed')])
        with patch.object(worker.workflow,'execute_activity',execute),patch.object(worker,'agent',SimpleNamespace(run=run)):
            self.assertEqual(await worker.OpenBotWork().run({}),dict(status='completed'))
        initial,resumed=run.await_args_list
        self.assertIs(initial.kwargs['usage'],resumed.kwargs['usage'])
        self.assertEqual(resumed.kwargs['message_history'],['original-message-history'])
        self.assertEqual(resumed.kwargs['deferred_tool_results'].calls,{'call':dict(actionId='action',status='applied')})

    async def test_opt_in_received_content_reaches_next_model_turn(self):
        first=SimpleNamespace(output=DeferredToolRequests(calls=[ToolCallPart('read',{},tool_call_id='call')]),
                              all_messages=lambda:['original-history'])
        run=AsyncMock(side_effect=[first,SimpleNamespace(output='checked')])
        content=dict(actionId='action',status='applied',result={'actual':'received content'})
        execute=AsyncMock(side_effect=[dict(taskId='t',runId='r',objective='task',toolResultProtocol=1),
            'action',dict(status='applied'),content,dict(status='completed')])
        with patch.object(worker.workflow,'execute_activity',execute),patch.object(worker,'agent',SimpleNamespace(run=run)):
            await worker.OpenBotWork().run({})
        self.assertEqual(execute.await_args_list[3].args,('openbot.tool_result.v1','action'))
        self.assertEqual(run.await_args_list[1].kwargs['deferred_tool_results'].calls,{'call':content})
