"""Bounded exact-history correlation only; no external engine or SQL is used in this file."""
import asyncio
from copy import deepcopy
from dataclasses import replace

import pytest
pytest.importorskip('temporalio', reason='optional Worker SDK profile')
from temporalio.api.common.v1 import Payloads
from temporalio.api.enums.v1 import EventType, WorkflowExecutionStatus
from temporalio.converter import DataConverter

from openbot_server.work_terminal import observe_terminal
from openbot_server.work_values import WorkConflict
from terminal_fixtures import SCOPE, engine


@pytest.mark.parametrize('state',['TERMINATED','TIMED_OUT'])
def test_only_exact_start_and_terminal_event_prove_hard_closure(state):
    async def check():
        h=await engine(state=state)
        proof=await observe_terminal(h.client,h.candidate,**SCOPE)
        assert proof.terminal['closeEventType']==state and proof.facts.start_input['attemptId']=='a'*32
        assert len(h.requests)==4
        assert [entry[1].execution.run_id for entry in h.requests]==['first-run']*3+['']
        assert all(entry[1].namespace=='default' and entry[2]['retry'] is False and
                   entry[2]['timeout'].total_seconds()==3 for entry in h.requests)
        assert all(entry[1].skip_archival and not entry[1].wait_new_event and entry[1].maximum_page_size==1
                   for entry in h.requests if entry[0]=='history')
    asyncio.run(check())


@pytest.mark.parametrize('state',['RUNNING','FAILED','COMPLETED','CANCELED','CONTINUED_AS_NEW'])
def test_other_terminal_types_do_not_expand_closure_scope(state):
    async def check():
        h=await engine();h.values.described.workflow_execution_info.status=getattr(WorkflowExecutionStatus,'WORKFLOW_EXECUTION_STATUS_'+state)
        assert await observe_terminal(h.client,h.candidate,**SCOPE) is None and len(h.requests)==1
    asyncio.run(check())


@pytest.mark.parametrize('fault',[
    'namespace','description_id','description_first','description_queue','description_type','description_time',
    'missing_start','wrong_first_event','wrong_start_type','start_workflow','start_first','start_original',
    'continued','retry','cron','attempt','start_queue','start_type','extra_input','wrong_input','missing_close',
    'close_pagination','wrong_close_type','wrong_close_id','wrong_close_time','successor','latest_run','latest_status',
    'oversized_start','oversized_close','raw_history','prefix_gap','prefix_missing_page','archived',
])
def test_incomplete_or_changed_proof_never_closes(fault):
    async def check():
        h=await engine(state='TIMED_OUT')
        desc=h.values.described.workflow_execution_info
        first=h.values.first.history.events[0];start=first.workflow_execution_started_event_attributes
        closed=h.values.close.history.events[0]
        if fault=='namespace':h.client.namespace='other'
        if fault=='description_id':desc.execution.run_id='other'
        if fault=='description_first':desc.first_run_id='other'
        if fault=='description_queue':desc.task_queue='other'
        if fault=='description_type':desc.type.name='other'
        if fault=='description_time':desc.ClearField('close_time')
        if fault=='missing_start':h.values.first.history.ClearField('events')
        if fault=='wrong_first_event':first.event_id=2
        if fault=='wrong_start_type':first.event_type=EventType.EVENT_TYPE_WORKFLOW_TASK_STARTED
        if fault=='start_workflow':start.workflow_id='other'
        if fault=='start_first':start.first_execution_run_id='other'
        if fault=='start_original':start.original_execution_run_id='other'
        if fault=='continued':start.continued_execution_run_id='prior'
        if fault=='retry':start.retry_policy.SetInParent()
        if fault=='cron':start.cron_schedule='* * * * *'
        if fault=='attempt':start.attempt=2
        if fault=='start_queue':start.task_queue.name='other'
        if fault=='start_type':start.workflow_type.name='other'
        if fault in ('extra_input','wrong_input'):
            value=dict(taskId='task',runId='run',attemptId='a'*32)
            if fault=='extra_input':value['skipApproval']=True
            else:value['runId']='other'
            start.input.CopyFrom(Payloads(payloads=await DataConverter.default.encode([value])))
        if fault=='missing_close':h.values.close.history.ClearField('events')
        if fault=='close_pagination':h.values.close.next_page_token=b'cannot-assume-last-page'
        if fault=='wrong_close_type':closed.event_type=EventType.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED
        if fault=='wrong_close_id':closed.event_id=9
        if fault=='wrong_close_time':closed.event_time.FromSeconds(1700000001)
        if fault=='successor':closed.workflow_execution_timed_out_event_attributes.new_execution_run_id='next'
        if fault=='latest_run':h.values.latest.workflow_execution_info.execution.run_id='newer'
        if fault=='latest_status':h.values.latest.workflow_execution_info.status=WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_RUNNING
        if fault=='oversized_start':start.identity='secret'*12000
        if fault=='oversized_close':closed.user_metadata.summary.data=b'x'*65537
        if fault=='raw_history':h.values.close.raw_history.add().data=b'unparsed'
        if fault=='prefix_gap':h.values.first.history.events.add(event_id=3)
        if fault=='prefix_missing_page':h.values.first.ClearField('next_page_token')
        if fault=='archived':h.values.first.archived=True
        with pytest.raises((ValueError,WorkConflict)):
            await observe_terminal(h.client,h.candidate,**SCOPE)
    asyncio.run(check())


def test_bounded_contiguous_first_batch_can_contain_more_than_requested_event():
    async def check():
        h=await engine()
        h.values.first.history.events.add(event_id=2,event_type=EventType.EVENT_TYPE_WORKFLOW_TASK_SCHEDULED)
        assert (await observe_terminal(h.client,h.candidate,**SCOPE)).terminal['closeEventType']=='TERMINATED'
    asyncio.run(check())
