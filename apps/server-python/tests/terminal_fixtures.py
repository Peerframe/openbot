"""Actual SDK protobuf/converter fixtures; synthetic service replies, never a live engine."""
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace

from temporalio.api.common.v1 import WorkflowExecution, WorkflowType, Payloads
from temporalio.api.enums.v1 import EventType, HistoryEventFilterType, WorkflowExecutionStatus
from temporalio.api.history.v1 import History, HistoryEvent
from temporalio.api.taskqueue.v1 import TaskQueue
from temporalio.api.workflow.v1 import WorkflowExecutionInfo
from temporalio.api.workflowservice.v1 import DescribeWorkflowExecutionResponse, GetWorkflowExecutionHistoryResponse
from temporalio.converter import DataConverter

from openbot_server.work_terminal import TerminalCandidate, TerminalCursor

SCOPE = dict(namespace='default', queue='failure-test', workflow_type='OpenBotWorkV1')


async def engine(task_id='task', run_id='run', attempt_id='a'*32, *, first='first-run', state='TERMINATED', created_at=None):
    candidate = TerminalCandidate(TerminalCursor(created_at or datetime.now(timezone.utc), task_id, 1, run_id), first)
    workflow = 'openbot-work-v1-'+run_id
    started = HistoryEvent(event_id=1, event_type=EventType.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED)
    start = started.workflow_execution_started_event_attributes
    start.workflow_id = workflow; start.first_execution_run_id = first; start.original_execution_run_id = first
    start.workflow_type.CopyFrom(WorkflowType(name=SCOPE['workflow_type']))
    start.task_queue.CopyFrom(TaskQueue(name=SCOPE['queue'])); start.attempt=1
    start.input.CopyFrom(Payloads(payloads=await DataConverter.default.encode([dict(taskId=task_id,runId=run_id,attemptId=attempt_id)])))
    started.event_time.FromSeconds(1700000000)
    closed = HistoryEvent(event_id=10, event_type=getattr(EventType, 'EVENT_TYPE_WORKFLOW_EXECUTION_'+state))
    getattr(closed, 'workflow_execution_'+state.lower()+'_event_attributes').SetInParent()
    closed.event_time.FromSeconds(1700000002)
    info = WorkflowExecutionInfo(execution=WorkflowExecution(workflow_id=workflow,run_id=first),
        type=WorkflowType(name=SCOPE['workflow_type']), task_queue=SCOPE['queue'], first_run_id=first,
        status=getattr(WorkflowExecutionStatus,'WORKFLOW_EXECUTION_STATUS_'+state), history_length=10)
    info.close_time.CopyFrom(closed.event_time)
    details = DescribeWorkflowExecutionResponse(workflow_execution_info=info)
    values = SimpleNamespace(described=details, latest=deepcopy(details),
        first=GetWorkflowExecutionHistoryResponse(history=History(events=[started]),next_page_token=b'middle-not-needed'),
        close=GetWorkflowExecutionHistoryResponse(history=History(events=[closed])), error=None)
    requests=[]
    async def describe(request, **kwargs):
        requests.append(('describe',deepcopy(request),kwargs))
        if values.error: raise values.error
        return values.described if request.execution.run_id else values.latest
    async def history(request, **kwargs):
        requests.append(('history',deepcopy(request),kwargs))
        return values.first if request.history_event_filter_type==HistoryEventFilterType.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT else values.close
    client = SimpleNamespace(namespace='default',data_converter=DataConverter.default,
        workflow_service=SimpleNamespace(describe_workflow_execution=describe,get_workflow_execution_history=history))
    return SimpleNamespace(candidate=candidate, client=client, values=values, requests=requests)
