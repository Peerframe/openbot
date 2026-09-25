"""Workflow command tests; actual engine/replay acceptance is the composed journey probe."""
import asyncio
from types import SimpleNamespace
from unittest.mock import patch

import pytest
pytest.importorskip('pydantic_ai',reason='Optional Worker SDK profile is required')
from pydantic_ai import DeferredToolRequests
from pydantic_ai.messages import ToolCallPart

from openbot_server import work_collaboration_workflow as flow
from openbot_server.work_corrected_workflow import run_corrected


def answer(output,history):
    return SimpleNamespace(output=output,all_messages=lambda:history)


def test_final_draft_waits_then_consumes_child_result_in_same_conversation():
    async def check():
        events=[];states=iter(['pending','not_required']);pending_calls=0;model_calls=[]
        async def activity(name,value,**options):
            nonlocal pending_calls
            events.append((name,value))
            if name=='openbot.freeze_corrections.v1':return dict(id='context',corrections=[])
            if name=='openbot.children_to_join.v1':
                pending_calls+=1
                return ['creation-action'] if pending_calls==1 else []
            if name=='openbot.prepare_child_join.v1':return 'join-action'
            if name=='openbot.tool_state.v1':return dict(status=next(states))
            if name=='openbot.execute_tool.v1':return dict(status='applied')
            if name=='openbot.tool_result.v1':return dict(actionId='join-action',status='applied',
                result=dict(runId='child',status='completed',result='Committed child evidence'))
            if name=='openbot.publish_corrected_task.v1':
                assert len(model_calls)==2 and value['summary']=='Revised answer'
                return dict(status='completed')
            raise AssertionError(name)
        async def pause(seconds):events.append(('timer',seconds))
        async def model(prompt,**options):
            model_calls.append((prompt,options))
            return answer('Unpublished draft' if len(model_calls)==1 else 'Revised answer',['original-conversation'])
        context=dict(taskId='task',runId='run',objective='Original objective',collaborationProtocol=1)
        with patch.object(flow.workflow,'execute_activity',activity),patch.object(flow.workflow,'sleep',pause):
            assert await run_corrected(context,{},SimpleNamespace(run=model),{})==dict(status='completed')
        assert 'Committed child evidence' in model_calls[1][0]
        assert model_calls[1][1]['message_history']==['original-conversation']
        assert [e for e in events if e[0]=='openbot.prepare_child_join.v1']==[
            ('openbot.prepare_child_join.v1',dict(creationActionId='creation-action',contextToken='context'))]
        assert ('timer',2) in events
    asyncio.run(check())


def test_delegate_returns_join_to_original_call_without_another_model_plan():
    async def check():
        events=[];calls=[]
        async def activity(name,value,**options):
            events.append((name,value))
            if name=='openbot.freeze_corrections.v1':return dict(id='context',corrections=[])
            if name=='openbot.prepare_corrected_tool.v1':return 'creation-action'
            if name=='openbot.tool_state.v1':return dict(status='applied')
            if name=='openbot.prepare_child_join.v1':return 'join-action'
            if name=='openbot.tool_result.v1':
                assert value=='join-action'
                return dict(actionId=value,status='applied',result=dict(status='failed',error='execution_failed'))
            if name=='openbot.children_to_join.v1':return []
            if name=='openbot.publish_corrected_task.v1':return dict(status='completed')
            raise AssertionError(name)
        async def model(prompt,**options):
            calls.append(options)
            if len(calls)==1:
                return answer(DeferredToolRequests(calls=[ToolCallPart('delegate_task',
                    dict(botId='target',task='Check supplied facts'),tool_call_id='original-call')]),['same-history'])
            assert options['deferred_tool_results'].calls['original-call']['result']['status']=='failed'
            return answer('The child failed; its requested work remains incomplete.',['same-history'])
        with patch.object(flow.workflow,'execute_activity',activity):
            result=await run_corrected(dict(taskId='task',runId='run',objective='Original objective',
                collaborationProtocol=1,toolResultProtocol=1),{},SimpleNamespace(run=model),{})
        assert result['status']=='completed' and len(calls)==2
        assert len([e for e in events if e[0]=='openbot.prepare_corrected_tool.v1'])==1
        assert len([e for e in events if e[0]=='openbot.prepare_child_join.v1'])==1
    asyncio.run(check())


def test_older_profile_adds_no_child_activity_commands():
    async def check():
        async def forbidden(*args,**kwargs):raise AssertionError('Older history acquired a new command')
        with patch.object(flow.workflow,'execute_activity',forbidden):
            assert await flow.completion_children({},None,{})==(None,None)
    asyncio.run(check())
