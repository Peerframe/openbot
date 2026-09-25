"""Finite hard-terminal observation and SQL closure, never execution or effect settlement."""
import asyncio
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timedelta
import hashlib
import re

from temporalio.api.common.v1 import WorkflowExecution
from temporalio.api.enums.v1 import EventType, HistoryEventFilterType, WorkflowExecutionStatus
from temporalio.api.workflowservice.v1 import (DescribeWorkflowExecutionRequest,
                                             GetWorkflowExecutionHistoryRequest)

from .work_collaboration import cascade
from .work_engine_binding import (EngineActivityFacts, assert_historical_workflow_in_transaction,
                                  engine_start_input)
from .work_values import InvalidWork, WorkConflict, canonical, text

_CODES = {'TERMINATED': 'engine_terminated', 'TIMED_OUT': 'engine_timed_out'}
_STATES = {WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_TERMINATED: 'TERMINATED',
           WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_TIMED_OUT: 'TIMED_OUT'}
_EVENTS = {'TERMINATED': EventType.EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED,
           'TIMED_OUT': EventType.EVENT_TYPE_WORKFLOW_EXECUTION_TIMED_OUT}
_ATTRS = {'TERMINATED': 'workflow_execution_terminated_event_attributes',
          'TIMED_OUT': 'workflow_execution_timed_out_event_attributes'}
_MAX_ACTIONS, _MAX_RESPONSE = 256, 65536


@dataclass(frozen=True)
class TerminalCursor:
    created_at: datetime
    task_id: str
    ordinal: int
    run_id: str


@dataclass(frozen=True)
class TerminalCandidate:
    cursor: TerminalCursor
    first_run_id: str

    @property
    def identity(self):
        return dict(taskId=self.cursor.task_id, runId=self.cursor.run_id)


@dataclass(frozen=True)
class TerminalProof:
    facts: EngineActivityFacts
    terminal: dict


@dataclass(frozen=True)
class TerminalBatch:
    results: tuple[dict, ...]
    next_cursor: TerminalCursor | None


def _key(proof):
    data, _ = canonical([proof['namespace'], proof['workflowId'], proof['engineRunId'],
                         proof['closeEventId'], proof['closeEventType']])
    return hashlib.sha256(b'openbot.work.engine-terminal.v1\0' + data).hexdigest()


def _result(task_id, run_id, status, disposition, *, cancelled=False, code=None, unresolved=0):
    return dict(version=1, taskId=task_id, runId=run_id, disposition=disposition,
                taskStatus=status, cancelRequested=cancelled, publicCode=code,
                unresolvedActions=unresolved, completion=None)


def terminal_record(payload, task_id, *, failure=False):
    """Strict immutable readback also shared by a late actual failure Activity."""
    if (type(payload) is not dict or set(payload) != {'version', 'reason', 'runId', 'operationKey', 'proof', 'result'}
            or type(payload['version']) is not int or payload['version'] != 1 or payload['reason'] != 'engine_terminal'):
        raise WorkConflict('terminal_record_invalid')
    run_id = text(payload['runId'], 128)
    proof = payload['proof']
    if (type(proof) is not dict or set(proof) != {'namespace', 'workflowId', 'engineRunId', 'firstRunId',
            'closeEventId', 'closeEventTime', 'closeEventType', 'closeEventSha256'}
            or type(proof['closeEventId']) is not int or not 2 <= proof['closeEventId'] <= 2**63-1
            or type(proof['closeEventType']) is not str or proof['closeEventType'] not in _CODES
            or proof['workflowId'] != 'openbot-work-v1-' + run_id
            or proof['firstRunId'] != proof['engineRunId']):
        raise WorkConflict('terminal_record_invalid')
    text(proof['namespace'], 64); text(proof['engineRunId'], 128)
    try:
        closed = datetime.fromisoformat(text(proof['closeEventTime'], 64))
        if closed.tzinfo is None: raise ValueError()
    except (ValueError, TypeError):
        raise WorkConflict('terminal_record_invalid') from None
    if (type(proof['closeEventSha256']) is not str or re.fullmatch('[a-f0-9]{64}', proof['closeEventSha256']) is None
            or payload['operationKey'] != _key(proof)):
        raise WorkConflict('terminal_record_invalid')
    result = payload['result']
    if (type(result) is not dict or type(result.get('unresolvedActions')) is not int
            or not 0 <= result['unresolvedActions'] <= _MAX_ACTIONS):
        raise WorkConflict('terminal_record_invalid')
    if result.get('disposition') == 'failed':
        expected = _result(task_id, run_id, 'failed', 'failed', code=_CODES[proof['closeEventType']],
                           unresolved=result['unresolvedActions'])
    elif not failure and result.get('disposition') == 'cancellation_preserved':
        expected = _result(task_id, run_id, 'open' if result['unresolvedActions'] else 'cancelled',
                           'cancellation_preserved', cancelled=True, unresolved=result['unresolvedActions'])
        # An unclaimed cancelled task with unresolved actions is not a valid product state.
    else:
        raise WorkConflict('terminal_record_invalid')
    if canonical(result)[0] != canonical(expected)[0]:
        raise WorkConflict('terminal_record_invalid')
    return deepcopy(result)


def _bounded(response):
    if response.ByteSize() > _MAX_RESPONSE:
        raise WorkConflict('terminal_history_limit')
    return response


async def observe_terminal(client, candidate, *, namespace, queue, workflow_type):
    """Only exact immutable engine history is positive evidence; latest identity is a veto."""
    if client.namespace != namespace:
        raise WorkConflict('engine_namespace_mismatch')
    workflow_id = 'openbot-work-v1-' + candidate.cursor.run_id
    first = text(candidate.first_run_id, 128)
    execution = WorkflowExecution(workflow_id=workflow_id, run_id=first)
    service = client.workflow_service
    async def describe(target):
        return _bounded(await service.describe_workflow_execution(DescribeWorkflowExecutionRequest(
            namespace=namespace, execution=target), retry=False, timeout=timedelta(seconds=3))).workflow_execution_info
    description = await describe(execution)
    if description.status not in _STATES:
        return None
    state = _STATES[description.status]
    def exact(value):
        return (value.execution.workflow_id == workflow_id and value.execution.run_id == first
            and value.first_run_id == first and value.task_queue == queue and value.type.name == workflow_type
            and value.status == description.status and value.HasField('close_time')
            and value.close_time == description.close_time and value.history_length == description.history_length)
    if not exact(description) or description.history_length < 2:
        raise WorkConflict('terminal_description_changed')
    async def event(filter_type):
        response = _bounded(await service.get_workflow_execution_history(GetWorkflowExecutionHistoryRequest(
            namespace=namespace, execution=execution, maximum_page_size=1, wait_new_event=False,
            history_event_filter_type=filter_type, skip_archival=True), retry=False, timeout=timedelta(seconds=3)))
        events = response.history.events
        if response.raw_history or response.archived or not 1 <= len(events) <= 128:
            raise WorkConflict('terminal_history_incomplete')
        if filter_type == HistoryEventFilterType.HISTORY_EVENT_FILTER_TYPE_CLOSE_EVENT:
            if len(events) != 1 or response.next_page_token:
                raise WorkConflict('terminal_history_incomplete')
        elif ([item.event_id for item in events] != list(range(1, len(events)+1))
                or events[-1].event_id > description.history_length
                or events[-1].event_id < description.history_length and not response.next_page_token):
            # Page size is a request bound, not authority to assume a complete history.
            # Accept a bounded contiguous first batch; only event 1 supplies start facts.
            raise WorkConflict('terminal_history_incomplete')
        return events[0]
    start_event = await event(HistoryEventFilterType.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
    if (start_event.event_id != 1 or start_event.event_type != EventType.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED
            or not start_event.HasField('workflow_execution_started_event_attributes')):
        raise WorkConflict('terminal_start_invalid')
    start = start_event.workflow_execution_started_event_attributes
    if (start.workflow_id != workflow_id or start.first_execution_run_id != first
            or start.original_execution_run_id != first or start.continued_execution_run_id
            or start.HasField('retry_policy') or start.cron_schedule or start.attempt != 1
            or start.workflow_type.name != workflow_type or start.task_queue.name != queue
            or start.input.ByteSize() > 4096 or len(start.input.payloads) != 1):
        raise WorkConflict('terminal_chain_unproven')
    values = await client.data_converter.decode(start.input.payloads, [dict])
    if len(values) != 1:
        raise WorkConflict('terminal_start_invalid')
    start_input = engine_start_input(values[0])
    if {key: start_input[key] for key in ('taskId', 'runId')} != candidate.identity:
        raise WorkConflict('terminal_start_invalid')
    closed = await event(HistoryEventFilterType.HISTORY_EVENT_FILTER_TYPE_CLOSE_EVENT)
    if (closed.event_id != description.history_length or closed.event_type != _EVENTS[state]
            or not closed.HasField(_ATTRS[state]) or not closed.HasField('event_time')
            or closed.event_time != description.close_time
            or state == 'TIMED_OUT' and closed.workflow_execution_timed_out_event_attributes.new_execution_run_id):
        raise WorkConflict('terminal_close_invalid')
    # The first Run can be reset externally. A different latest Run is never positive proof
    # for this one; the product itself neither resets nor continues this accepted execution.
    if not exact(await describe(WorkflowExecution(workflow_id=workflow_id))):
        raise WorkConflict('terminal_latest_changed')
    facts = EngineActivityFacts(namespace=namespace, queue=description.task_queue,
        start_queue=start.task_queue.name, workflow_id=workflow_id, workflow_type=start.workflow_type.name,
        engine_run_id=first, first_run_id=first, start_input=start_input)
    terminal = dict(namespace=namespace, workflowId=workflow_id, engineRunId=first, firstRunId=first,
        closeEventId=closed.event_id, closeEventTime=closed.event_time.ToJsonString(), closeEventType=state,
        closeEventSha256=hashlib.sha256(closed.SerializeToString(deterministic=True)).hexdigest())
    return TerminalProof(facts, terminal)


async def close_terminal(store, candidate, proof, *, namespace, queue, workflow_type):
    if type(proof) is not TerminalProof:
        raise InvalidWork('terminal_proof_required')
    task_id, run_id = candidate.cursor.task_id, candidate.cursor.run_id
    key = _key(proof.terminal)
    async with store._transaction(trusted=True) as db:
        task = await store._task(db, task_id)
        accepted = await assert_historical_workflow_in_transaction(store, db, candidate.identity, proof.facts,
            expected_namespace=namespace, expected_queue=queue, expected_workflow_type=workflow_type)
        if (accepted.engine_run_id != candidate.first_run_id or accepted.first_run_id != candidate.first_run_id
                or proof.terminal['engineRunId'] != accepted.engine_run_id or proof.terminal['namespace'] != namespace
                or proof.terminal['workflowId'] != accepted.workflow_id):
            raise WorkConflict('terminal_proof_changed')
        rows = await (await db.execute("SELECT payload FROM work_events WHERE task_id=%s AND kind='run.engine_terminal' "
            "AND payload->>'runId'=%s LIMIT 2", (task_id, run_id))).fetchall()
        if len(rows) > 1:
            raise WorkConflict('terminal_record_invalid')
        if rows:
            recorded = rows[0]['payload']
            result = terminal_record(recorded, task_id)
            if recorded['operationKey'] != key or canonical(recorded['proof'])[0] != canonical(proof.terminal)[0]:
                raise WorkConflict('terminal_proof_changed')
            return result
        if task['status'] in ('completed', 'failed', 'cancelled'):
            return _result(task_id, run_id, task['status'], 'already_closed', cancelled=task['cancel_requested'])
        runs = await (await db.execute('SELECT id,ordinal,status FROM work_runs WHERE task_id=%s ORDER BY ordinal FOR UPDATE',
                                      (task_id,))).fetchall()
        active = [row['id'] for row in runs if row['status'] in ('queued', 'running')]
        if (not runs or runs[-1]['id'] != run_id or runs[-1]['ordinal'] != candidate.cursor.ordinal
                or active != [run_id] or task['status'] not in ('queued', 'open')):
            raise WorkConflict('terminal_run_superseded')
        failures = await (await db.execute("SELECT 1 FROM work_events WHERE task_id=%s AND kind='task.failed' LIMIT 1",
                                         (task_id,))).fetchone()
        if failures:
            raise WorkConflict('terminal_record_invalid')
        actions = await (await db.execute('SELECT id,status FROM work_actions WHERE task_id=%s ORDER BY id LIMIT 257 FOR UPDATE',
                                         (task_id,))).fetchall()
        if len(actions) > _MAX_ACTIONS:
            raise WorkConflict('terminal_action_limit')
        unresolved = sum(row['status'] in ('admitted', 'unknown') for row in actions)
        await cascade(db, store, task_id, reason='cancel' if task['cancel_requested'] else 'failed', include_self=False)
        for row in actions:
            if row['status'] == 'admitted':
                await db.execute("UPDATE work_actions SET status='unknown' WHERE id=%s", (row['id'],))
                await store._event(db, task_id, 'action.unknown', dict(actionId=row['id']))
        if task['cancel_requested']:
            if task['authority_active']:
                raise WorkConflict('terminal_cancel_authority_invalid')
            await store._finish_cancel(db, task)
            fresh = await store._task(db, task_id)
            result = _result(task_id, run_id, fresh['status'], 'cancellation_preserved', cancelled=True, unresolved=unresolved)
        else:
            await db.execute("UPDATE work_tasks SET status='failed',authority_active=false,authority_generation=authority_generation+1 WHERE id=%s", (task_id,))
            await db.execute("UPDATE work_runs SET status='failed' WHERE task_id=%s AND id=%s", (task_id, run_id))
            result = _result(task_id, run_id, 'failed', 'failed', code=_CODES[proof.terminal['closeEventType']], unresolved=unresolved)
        payload = dict(version=1, reason='engine_terminal', runId=run_id, operationKey=key,
                       proof=proof.terminal, result=result)
        terminal_record(payload, task_id)
        if result['disposition'] == 'failed':
            await store._event(db, task_id, 'task.failed', payload)
        await store._event(db, task_id, 'run.engine_terminal', payload)
        return result


async def _page(store, namespace, after, limit):
    parameters = [namespace]
    predicate = ''
    if after is not None:
        if (type(after) is not TerminalCursor or type(after.created_at) is not datetime or after.created_at.tzinfo is None
                or type(after.ordinal) is not int or after.ordinal < 1):
            raise InvalidWork('terminal_cursor_invalid')
        text(after.task_id, 128); text(after.run_id, 128)
        predicate = 'AND (t.created_at,t.id,r.ordinal,r.id)>(%s,%s,%s,%s) '
        parameters.extend((after.created_at, after.task_id, after.ordinal, after.run_id))
    parameters.append(limit)
    async with store._transaction(trusted=True) as db:
        rows = await (await db.execute('SELECT t.id AS task_id,t.created_at,r.id AS run_id,r.ordinal,a.engine_first_run_id '
            'FROM work_tasks t JOIN work_runs r ON r.task_id=t.id JOIN work_admissions a ON a.run_id=r.id '
            "WHERE t.status IN ('queued','open') AND r.status IN ('queued','running') AND a.state='acknowledged' "
            "AND a.engine_reference='temporal:'||%s||':openbot-work-v1-'||r.id "
            'AND a.submission_attempt_id IS NOT NULL AND a.engine_first_run_id IS NOT NULL '
            "AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.task_id=t.id AND e.kind='run.engine_terminal' AND e.payload->>'runId'=r.id) "
            + predicate + 'ORDER BY t.created_at,t.id,r.ordinal,r.id LIMIT %s', parameters)).fetchall()
    return tuple(TerminalCandidate(TerminalCursor(row['created_at'], row['task_id'], row['ordinal'], row['run_id']),
                                   row['engine_first_run_id']) for row in rows)


async def terminal_batch(store, client, *, namespace, queue, workflow_type, after=None, limit=16, item_timeout_seconds=10):
    text(namespace, 64); text(queue, 256); text(workflow_type, 256)
    if (type(limit) is not int or not 1 <= limit <= 64 or type(item_timeout_seconds) is not int
            or not 1 <= item_timeout_seconds <= 30):
        raise InvalidWork('invalid_terminal_batch')
    if client.namespace != namespace:
        raise WorkConflict('engine_namespace_mismatch')
    async with asyncio.timeout(item_timeout_seconds):
        rows = await _page(store, namespace, after, limit)
    results = []
    for candidate in rows:
        record = candidate.identity
        try:
            async with asyncio.timeout(item_timeout_seconds):
                proof = await observe_terminal(client, candidate, namespace=namespace, queue=queue, workflow_type=workflow_type)
                if proof is None:
                    record.update(status='not_terminal')
                else:
                    result = await close_terminal(store, candidate, proof, namespace=namespace, queue=queue, workflow_type=workflow_type)
                    record.update(status='closed' if result['disposition'] != 'already_closed' else 'already_closed', result=result)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Neither missing history nor a timeout proves death or non-delivery.
            record.update(status='unconfirmed', reason='terminal_observation_unproven')
        results.append(record)
    return TerminalBatch(tuple(results), rows[-1].cursor if len(rows) == limit else None)
