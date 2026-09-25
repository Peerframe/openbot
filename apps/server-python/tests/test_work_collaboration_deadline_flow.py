"""Deterministic command/unit tests, not a Temporal Server execution or Replay claim."""
import asyncio
from contextlib import ExitStack
from datetime import datetime,timedelta,timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from temporalio.exceptions import ApplicationError
from pydantic_ai import DeferredToolRequests
from pydantic_ai.messages import ToolCallPart
from openbot_server import work_collaboration_workflow as flow
from openbot_server import work_worker as worker
from openbot_server.work_corrected_workflow import run_corrected

NOW=datetime(2026,9,25,tzinfo=timezone.utc)
def record(seconds=30):
    return dict(version=1,rootTaskId='root',rootRunId='exact-root-run',deadline=(NOW+timedelta(seconds=seconds)).isoformat())

class Engine:
    def __init__(self):
        self.now=NOW;self.commands=[];self.timer=asyncio.Event();self.poll=asyncio.Event();self.entered=asyncio.Event()
        self.observed=None
    async def wait_condition(self,predicate):
        while not predicate():await asyncio.sleep(0)
    async def sleep(self,seconds):
        self.commands.append(('sleep',seconds));self.entered.set()
        await (self.poll if seconds==2 else self.timer).wait()
        self.now+=timedelta(seconds=seconds)
    async def execute(self,name,value,**options):
        self.commands.append((name,value));return self.observed
    def install(self):
        stack=ExitStack()
        for name,value in dict(wait=asyncio.wait,wait_condition=self.wait_condition,sleep=self.sleep,
                               execute_activity=self.execute,now=lambda:self.now).items():
            stack.enter_context(patch.object(flow.workflow,name,value))
        return stack


def test_ordinary_body_does_not_poll_or_arm_timer_and_cleans_watcher():
    async def check():
        e=Engine()
        async def body():await asyncio.sleep(0);return 'done'
        with e.install():assert await flow.CollaborationDeadline(None,{}).run(body)=='done'
        assert e.commands==[]
    asyncio.run(check())


def test_initial_child_deadline_interrupts_idle_body_and_awaits_cleanup():
    async def check():
        e=Engine();cleaned=[];release=asyncio.Event()
        async def body():
            try:await asyncio.Event().wait()
            finally:
                await release.wait();cleaned.append(True)
        with e.install():
            task=asyncio.create_task(flow.CollaborationDeadline(record(17),{}).run(body))
            await e.entered.wait();assert e.commands==[('sleep',17)]
            e.timer.set();await asyncio.sleep(0);await asyncio.sleep(0)
            assert not task.done() and not cleaned
            release.set()
            with pytest.raises(ApplicationError) as error:await task
        assert error.value.type=='OpenBotCollaborationDeadline' and cleaned==[True]
    asyncio.run(check())


def test_creation_commit_without_ack_arms_original_deadline():
    async def check():
        e=Engine();control=flow.CollaborationDeadline(None,{});cleaned=[]
        async def body():
            control.expect_tree()
            try:await asyncio.Event().wait() # prepare/execute never acknowledges
            finally:cleaned.append(True)
        with e.install():
            task=asyncio.create_task(control.run(body));await e.entered.wait()
            assert e.commands==[('openbot.collaboration_deadline.v1',{}),('sleep',2)]
            e.observed=record(10);e.poll.set()
            while ('sleep',8) not in e.commands:await asyncio.sleep(0)
            assert len([x for x in e.commands if x[0]=='openbot.collaboration_deadline.v1'])==2
            e.timer.set()
            with pytest.raises(ApplicationError):await task
        assert cleaned==[True]
    asyncio.run(check())


def test_external_cancel_stops_body_and_watcher_before_single_finalizer():
    async def check():
        e=Engine();events=[];control=flow.CollaborationDeadline(None,{})
        async def body():
            control.expect_tree()
            try:await asyncio.Event().wait()
            finally:await asyncio.sleep(0);events.append('body-cleaned')
        async def main(identity):
            instance._loaded=True
            return await control.run(body)
        original=e.execute
        async def execute(name,value,**options):
            if name=='openbot.finalize_task_failure.v1':
                assert events==['body-cleaned'];events.append(value['code']);return dict(completion=None)
            return await original(name,value,**options)
        e.execute=execute;instance=worker.OpenBotWork()
        with e.install(),patch.object(worker.workflow,'patched',return_value=True),patch.object(instance,'_run',main):
            task=asyncio.create_task(instance.run({}));await e.entered.wait();task.cancel()
            with pytest.raises(asyncio.CancelledError):await task
        assert events==['body-cleaned','engine_cancelled']
    asyncio.run(check())


def test_deadline_failure_finalizes_once_after_cleanup_and_preserves_completed_receipt():
    async def check():
        e=Engine();events=[];instance=worker.OpenBotWork()
        async def body():
            try:await asyncio.Event().wait()
            finally:await asyncio.sleep(0);events.append('cleanup')
        async def main(identity):
            instance._loaded=True
            return await flow.CollaborationDeadline(record(1),{}).run(body)
        async def execute(name,value,**options):
            assert name=='openbot.finalize_task_failure.v1' and events==['cleanup']
            events.append(value['code']);return dict(completion=dict(status='completed',artifactIds=['original']))
        e.execute=execute
        with e.install(),patch.object(worker.workflow,'patched',return_value=True),patch.object(instance,'_run',main):
            task=asyncio.create_task(instance.run({}));await e.entered.wait();e.timer.set()
            assert await task==dict(status='completed',artifactIds=['original'])
        assert events==['cleanup','execution_failed']
    asyncio.run(check())


@pytest.mark.parametrize('flag,patched',[(None,True),(1,False)])
def test_old_history_emits_no_deadline_command_or_controller(flag,patched):
    async def check():
        context=dict(taskId='task',runId='run',objective='objective')
        if flag is not None:context['collaborationProtocol']=flag
        calls=[]
        async def execute(name,value,**options):calls.append(name);return context
        async def loaded(ctx,identity,deadline=None):assert deadline is None;return 'old-result'
        instance=worker.OpenBotWork()
        with patch.object(worker.workflow,'execute_activity',execute),patch.object(worker.workflow,'patched',return_value=patched) as marker,patch.object(instance,'_run_loaded',loaded),patch.object(worker,'CollaborationDeadline',side_effect=AssertionError('No new controller')):
            assert await instance._run({})=='old-result'
        assert calls==['openbot.load_task.v1'] and marker.call_count==(1 if flag==1 else 0)
    asyncio.run(check())


@pytest.mark.parametrize('corrected',[False,True])
@pytest.mark.parametrize('tool',['start_task','delegate_task'])
def test_both_paths_expect_tree_before_first_creation_activity(corrected,tool):
    async def check():
        events=[]
        controller=SimpleNamespace(expect_tree=lambda:events.append('armed'))
        async def execute(name,value,**options):
            if name=='openbot.freeze_corrections.v1':return dict(id='context',corrections=[])
            if name in ('openbot.prepare_tool.v1','openbot.prepare_corrected_tool.v1'):
                assert events==['armed'];raise ApplicationError('synthetic-stop',non_retryable=True)
            raise AssertionError(name)
        async def model(*args,**kwargs):
            return SimpleNamespace(output=DeferredToolRequests(calls=[ToolCallPart(tool,dict(botId='target',task='check'),tool_call_id='call')]),all_messages=lambda:[])
        context=dict(taskId='task',runId='run',objective='objective',collaborationProtocol=1)
        with patch.object(worker.workflow,'execute_activity',execute),patch.object(worker.agent,'run',model):
            with pytest.raises(ApplicationError):
                if corrected:await run_corrected(context,{},worker.agent,{},deadline=controller)
                else:await worker.OpenBotWork()._run_loaded(context,{},controller)
        assert events==['armed']
    asyncio.run(check())


@pytest.mark.parametrize('value',[{},dict(record(),version=True),dict(record(),extra=1),dict(record(),deadline='2026-09-25T00:00:00'),dict(record(),deadline='invalid')])
def test_invalid_record_never_extends_lifetime(value):
    with pytest.raises(ApplicationError):flow.CollaborationDeadline(value,{})


def test_changed_deadline_or_root_rejected():
    controller=flow.CollaborationDeadline(record(),{})
    for value in (record(31),dict(record(),rootRunId='replacement'),dict(record(),rootTaskId='other')):
        with pytest.raises(ApplicationError):controller._accept(value)


def test_expired_initial_deadline_has_no_new_timer():
    async def check():
        e=Engine()
        async def body():await asyncio.Event().wait()
        with e.install(),pytest.raises(ApplicationError):await flow.CollaborationDeadline(record(-1),{}).run(body)
        assert not e.commands
    asyncio.run(check())
