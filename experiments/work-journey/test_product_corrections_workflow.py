"""Partial batches keep every old correlation; only typed stale control errors resume."""
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch
sys.path[:0]=[str(Path(__file__).parents[2]/'apps/server-python/src'),str(Path(__file__).parents[2]/'apps/agent-runtime-python/src')]
from pydantic_ai import DeferredToolRequests
from pydantic_ai.messages import ToolCallPart
from temporalio.exceptions import ApplicationError
from openbot_server import work_corrected_workflow as module

CTX=dict(taskId='task',runId='run',objective='work')
FROZEN=dict(id='first',corrections=[],generation=1)
NEW=dict(id='next',corrections=[dict(id='c',instruction='Corrected instruction')],generation=2)
def answer(value):return SimpleNamespace(output=value,all_messages=lambda:['retained-history'])
def stale():return ApplicationError('corrections_changed',type='CorrectionsChanged',non_retryable=True)

class CorrectionWorkflowTests(IsolatedAsyncioTestCase):
    async def test_product_correction_discards_knowledge_and_model_copies_but_keeps_action_facts(self):
        prior=dict(actionId='observed-write',tool='call_plugin',status='applied')
        agent=SimpleNamespace(run=AsyncMock(side_effect=[answer('old private knowledge'),answer('new result')]))
        execute=AsyncMock(side_effect=[FROZEN,stale(),dict(NEW,priorActions=[prior]),dict(status='completed')])
        with patch.object(module.workflow,'execute_activity',execute):
            assert await module.run_corrected(dict(CTX,correctionHistoryProtocol=1,prompt='Server role and work'),{},agent,{})==dict(status='completed')
        first,second=agent.run.await_args_list
        assert first.args[0]=='Server role and work'
        assert second.kwargs['message_history']==[] and second.kwargs['deferred_tool_results'] is None
        assert 'Server role and work' in second.args[0] and 'Corrected instruction' in second.args[0]
        assert 'observed-write' in second.args[0] and 'applied' in second.args[0]
        assert 'old private knowledge' not in second.args[0] and 'retained-history' not in second.args[0]
        assert second.kwargs['usage'] is first.kwargs['usage']

    async def test_product_correction_during_tool_result_redacts_before_resuming(self):
        batch=DeferredToolRequests(calls=[ToolCallPart('read_employee_memory',{},tool_call_id='memory')])
        agent=SimpleNamespace(run=AsyncMock(side_effect=[answer(batch),answer('new result')]))
        execute=AsyncMock(side_effect=[FROZEN,'action',dict(status='applied'),stale(),NEW,dict(status='completed')])
        with patch.object(module.workflow,'execute_activity',execute):
            assert await module.run_corrected(dict(CTX,correctionHistoryProtocol=1,toolResultProtocol=1),{},agent,{})==dict(status='completed')
        second=agent.run.await_args_list[1]
        assert second.kwargs['message_history']==[] and second.kwargs['deferred_tool_results'] is None

    async def test_mixed_batch_is_paired_before_new_corrected_segment(self):
        batch=DeferredToolRequests(calls=[ToolCallPart('write',{},tool_call_id=str(i)) for i in range(4)])
        agent=SimpleNamespace(run=AsyncMock(side_effect=[answer(batch),answer('corrected result')]))
        states=iter([dict(status='applied'),dict(status='unknown',commandId='repair'),dict(status='superseded')])
        n=0
        async def execute(name,value,**config):
            nonlocal n
            if name=='openbot.freeze_corrections.v1':
                n+=1;return FROZEN if n==1 else NEW
            if name=='openbot.prepare_corrected_tool.v1':
                call=value['proposal']['call_id']
                if call=='3':raise stale()
                return 'action-'+call
            if name=='openbot.tool_state.v1':return next(states)
            if name=='openbot.reconcile_tool.v1':return dict(status='applied')
            if name=='openbot.publish_corrected_task.v1':return dict(status='completed')
            raise AssertionError(name)
        with patch.object(module.workflow,'execute_activity',execute):
            assert await module.run_corrected(CTX,{},agent,{})==dict(status='completed')
        first,second=agent.run.await_args_list
        assert first.kwargs['usage'] is second.kwargs['usage']
        assert second.kwargs['message_history']==['retained-history']
        assert 'Corrected instruction' in second.args[0]
        assert second.kwargs['deferred_tool_results'].calls=={
            '0':dict(actionId='action-0',status='applied'), '1':dict(actionId='action-1',status='applied'),
            '2':dict(actionId='action-2',status='superseded'), '3':dict(status='not_prepared',reason='owner_correction')}

    async def test_wrapped_stale_resumes_but_unknown_model_never_resends(self):
        for kind in ['CorrectionsChanged','WorkConflict']:
            cause=ApplicationError('corrections_changed' if kind=='CorrectionsChanged' else 'model_observation_unknown',type=kind)
            wrapped=ApplicationError('Model port failed',type='RuntimeFailure');wrapped.__cause__=cause
            agent=SimpleNamespace(run=AsyncMock(side_effect=[wrapped,answer('result')]))
            execute=AsyncMock(side_effect=[FROZEN,NEW,dict(status='completed')])
            with patch.object(module.workflow,'execute_activity',execute):
                if kind=='WorkConflict':
                    with self.assertRaises(ApplicationError):await module.run_corrected(CTX,{},agent,{})
                    assert agent.run.await_count==1
                else:
                    assert await module.run_corrected(CTX,{},agent,{})==dict(status='completed')
                    assert agent.run.await_count==2

    async def test_correction_after_final_keeps_full_history_and_usage(self):
        agent=SimpleNamespace(run=AsyncMock(side_effect=[answer('old result'),answer('new result')]))
        execute=AsyncMock(side_effect=[FROZEN,stale(),NEW,dict(status='completed')])
        with patch.object(module.workflow,'execute_activity',execute):
            assert await module.run_corrected(CTX,{},agent,{})==dict(status='completed')
        first,second=agent.run.await_args_list
        assert second.kwargs['message_history']==['retained-history']
        assert second.kwargs['usage'] is first.kwargs['usage']

    async def test_valid_escaped_corrections_avoid_an_extra_json_encoding_layer(self):
        from pydantic_ai.messages import ModelMessagesTypeAdapter, ModelRequest, ModelResponse, UserPromptPart, TextPart
        history=[ModelRequest(parts=[UserPromptPart('x'*16000)]),ModelResponse(parts=[TextPart('"'*16000)])]
        previous=SimpleNamespace(output='old result',all_messages=lambda:history)
        frozen=dict(id='bounded',generation=9,corrections=[dict(id=str(i),instruction='\x01'*4096) for i in range(8)])
        agent=SimpleNamespace(run=AsyncMock(side_effect=[previous,answer('new result')]))
        execute=AsyncMock(side_effect=[FROZEN,stale(),frozen,dict(status='completed')])
        with patch.object(module.workflow,'execute_activity',execute):
            await module.run_corrected(CTX,{},agent,{})
        prompt=agent.run.await_args_list[1].args[0]
        serialized=ModelMessagesTypeAdapter.dump_json(history+[ModelRequest(parts=[UserPromptPart(prompt)])])
        assert len(serialized)<256*1024
        assert prompt.count('\x01')==8*4096
