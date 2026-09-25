"""Accepted Workflow failure closure. No effect, model, claim, refund, or retry owner.

The actual SDK Activity and immutable acknowledged start identify the only Task this Activity
may close. Historical correlation permits lost-ACK recovery after closure, never new work.
"""
import asyncio
from copy import deepcopy
import hashlib
import inspect
import re

from temporalio import activity
from temporalio.exceptions import ApplicationError
from temporalio.service import RPCError, RPCStatusCode

from .database import StoreUnavailable
from .work_collaboration import cascade
from .work_engine_binding import assert_historical_workflow_in_transaction
from .work_temporal_activity import current_activity_id, inspect_activity_start
from .work_terminal import terminal_record
from .work_values import InvalidWork, WorkConflict, WorkNotFound, canonical, text

ACTIVITY_NAME = 'openbot.finalize_task_failure.v1'
WORKFLOW_TYPE = 'OpenBotWorkV1'
FAILURE_CODES = frozenset(('startup_failed', 'execution_failed', 'publication_failed', 'engine_cancelled'))
MAX_ACTIONS = 256


class _RetryableFailure(Exception):
    pass


def _request(value):
    if (type(value) is not dict or set(value) != {'version', 'code'}
            or type(value['version']) is not int or value['version'] != 1
            or type(value['code']) is not str or value['code'] not in FAILURE_CODES):
        raise InvalidWork('invalid_failure_request')
    return value['code']


def _result(task_id, run_id, status, disposition, *, cancelled=False, code=None, unresolved=0, completion=None):
    return dict(version=1, taskId=task_id, runId=run_id, disposition=disposition,
                taskStatus=status, cancelRequested=cancelled, publicCode=code,
                unresolvedActions=unresolved, completion=completion)


def _record(payload, task_id):
    """Only the closure DTO is replayed; malformed audit data never becomes public output."""
    if (type(payload) is not dict or set(payload) != {'version', 'reason', 'runId', 'code', 'operationKey', 'result'}
            or type(payload['version']) is not int or payload['version'] != 1
            or payload['reason'] != 'workflow_failure'):
        raise WorkConflict('failure_record_invalid')
    _request(dict(version=1, code=payload['code']))
    text(payload['runId'], 128)
    if type(payload['operationKey']) is not str or re.fullmatch('[a-f0-9]{64}', payload['operationKey']) is None:
        raise WorkConflict('failure_record_invalid')
    result = payload['result']
    if type(result) is not dict or type(result.get('unresolvedActions')) is not int or not 0 <= result['unresolvedActions'] <= MAX_ACTIONS:
        raise WorkConflict('failure_record_invalid')
    expected = _result(task_id, payload['runId'], 'failed', 'failed',
                       code=payload['code'], unresolved=result['unresolvedActions'])
    # Canonical bytes distinguish bool/int aliases and reject extra or unbounded values.
    if canonical(result)[0] != canonical(expected)[0]:
        raise WorkConflict('failure_record_invalid')
    return deepcopy(result)


class FailureActivities:
    def __init__(self, store, client, *, namespace, queue, completed_result):
        text(namespace, 64); text(queue, 256)
        if getattr(client, 'namespace', None) != namespace:
            raise WorkConflict('engine_namespace_mismatch')
        if not callable(completed_result):
            raise InvalidWork('completion_readback_required')
        self.store, self.client, self.completed_result = store, client, completed_result
        self.scope = dict(expected_namespace=namespace, expected_queue=queue, expected_workflow_type=WORKFLOW_TYPE)

    @activity.defn(name=ACTIVITY_NAME)
    async def finalize(self, request: dict) -> dict:
        """Only real delivery/storage failures retry; public failures never copy exception text."""
        try:
            code = _request(request)
            if not activity.in_activity():
                raise WorkConflict('activity_required')
            info = activity.info()
            if info.activity_type != ACTIVITY_NAME:
                raise WorkConflict('failure_activity_required')
            activity_id = current_activity_id(info)
            try:
                async with asyncio.timeout(4):
                    facts = await inspect_activity_start(self.client, info, **self.scope)
            except TimeoutError:
                raise _RetryableFailure('failure_history_unavailable') from None
            except RPCError as error:
                if error.status in (RPCStatusCode.UNAVAILABLE, RPCStatusCode.DEADLINE_EXCEEDED):
                    raise _RetryableFailure('failure_history_unavailable') from None
                raise WorkConflict('failure_history_refused') from None
            identity = dict(taskId=facts.start_input['taskId'], runId=facts.start_input['runId'])
            data, _ = canonical([facts.namespace, facts.workflow_id, facts.engine_run_id, activity_id])
            key = hashlib.sha256(b'openbot.work.failure.activity.v1\0' + data).hexdigest()
            try:
                result, completed = await self._close(identity, facts, code, key)
            except StoreUnavailable:
                raise _RetryableFailure('failure_storage_unavailable') from None
            if completed is not None:
                # No nested SQL transaction or Task->files lock. Reuse the original digest/blob
                # readback after releasing SQL locks, never a new verifier or publication.
                async with asyncio.timeout(4):
                    public = self.completed_result(*completed)
                    if not inspect.isawaitable(public):
                        raise WorkConflict('completion_readback_invalid')
                    public = await public
                if (type(public) is not dict or set(public) != {'taskId', 'status', 'artifactIds'}
                        or public['taskId'] != identity['taskId'] or public['status'] != 'completed'
                        or type(public['artifactIds']) is not list or len(public['artifactIds']) > 16
                        or len(set(text(x, 128) for x in public['artifactIds'])) != len(public['artifactIds'])):
                    raise WorkConflict('completion_readback_invalid')
                result['completion'] = deepcopy(public)
            return result
        except _RetryableFailure as error:
            # Only literal codes constructed at the actual transport/transaction boundary.
            code = 'failure_history_unavailable' if error.args == ('failure_history_unavailable',) else 'failure_storage_unavailable'
            raise ApplicationError(code, type='WorkFinalizationUnavailable') from None
        except (InvalidWork, WorkConflict, WorkNotFound):
            raise ApplicationError('failure_finalization_refused', type='WorkConflict', non_retryable=True) from None
        except Exception:
            raise ApplicationError('failure_finalization_invalid', type='InvalidWork', non_retryable=True) from None

    async def _close(self, identity, facts, code, key):
        async with self.store._transaction(trusted=True) as db:
            task = await self.store._task(db, identity['taskId'])
            accepted = await assert_historical_workflow_in_transaction(self.store, db, identity, facts, **self.scope)
            run = await (await db.execute('SELECT status FROM work_runs WHERE task_id=%s AND id=%s',
                                         (task['id'], accepted.run_id))).fetchone()
            rows = await (await db.execute("SELECT payload FROM work_events WHERE task_id=%s AND kind='task.failed' LIMIT 2",
                                         (task['id'],))).fetchall()
            if len(rows) > 1:
                raise WorkConflict('failure_record_invalid')
            event = rows[0]['payload'] if rows else None
            if event is not None and event.get('reason') == 'workflow_failure':
                recorded = _record(event, task['id'])
                if task['status'] != 'failed' or task['authority_active'] or task['cancel_requested']:
                    raise WorkConflict('failure_record_invalid')
                if event['operationKey'] == key:
                    if event['code'] != code or event['runId'] != accepted.run_id or run['status'] != 'failed':
                        raise WorkConflict('failure_request_changed')
                    return recorded, None
            actions = await (await db.execute('SELECT id,status FROM work_actions WHERE task_id=%s ORDER BY id LIMIT 257 FOR UPDATE',
                                              (task['id'],))).fetchall()
            if len(actions) > MAX_ACTIONS:
                raise WorkConflict('failure_action_limit')
            unresolved = sum(row['status'] in ('admitted', 'unknown') for row in actions)
            result = _result(task['id'], accepted.run_id, task['status'], 'already_failed',
                             cancelled=task['cancel_requested'], unresolved=unresolved)
            if task['status'] == 'completed':
                if event is not None:
                    raise WorkConflict('failure_record_invalid')
                completed = await (await db.execute("SELECT payload FROM work_events WHERE task_id=%s AND kind='task.completed' LIMIT 2",
                                                   (task['id'],))).fetchall()
                if len(completed) != 1 or completed[0]['payload'].get('runId') != accepted.run_id:
                    raise WorkConflict('completion_record_invalid')
                result['disposition'] = 'completed'
                return result, (task['result_summary'], completed[0]['payload'].get('correctionContext'))
            if task['status'] == 'failed':
                if event is None or task['authority_active'] or task['cancel_requested']:
                    raise WorkConflict('failure_record_invalid')
                if event.get('reason') == 'workflow_failure':
                    result['publicCode'] = event['code']
                elif event.get('reason') == 'engine_terminal':
                    original = terminal_record(event, task['id'], failure=True)
                    if event['runId'] != accepted.run_id or run['status'] != 'failed':
                        raise WorkConflict('failure_record_invalid')
                    result['publicCode'] = original['publicCode']
                elif (set(event) != {'runId', 'actionId', 'reason'} or event['reason'] not in ('denied', 'expired', 'not_applied')
                      or not any(row['id'] == event['actionId'] for row in actions)):
                    raise WorkConflict('failure_record_invalid')
                return result, None
            if event is not None:
                raise WorkConflict('failure_record_invalid')
            if task['status'] not in ('queued', 'open', 'cancelled'):
                raise WorkConflict('failure_task_invalid')
            if task['status'] == 'cancelled' and (not task['cancel_requested'] or unresolved):
                raise WorkConflict('failure_task_invalid')
            if task['status'] in ('queued', 'open') and run['status'] not in ('queued', 'running'):
                # An acknowledged historical start does not let a superseded/closed Run
                # terminate a later Run that now owns the still-open Task.
                raise WorkConflict('failure_run_closed')
            # Existing root-to-leaf helper owns descendant closure; it never guesses outcomes.
            await cascade(db, self.store, task['id'], reason='cancel' if task['cancel_requested'] else 'failed', include_self=False)
            for row in actions:
                if row['status'] == 'admitted':
                    await db.execute("UPDATE work_actions SET status='unknown' WHERE id=%s", (row['id'],))
                    await self.store._event(db, task['id'], 'action.unknown', dict(actionId=row['id']))
            if task['cancel_requested']:
                await self.store._finish_cancel(db, task)
                fresh = await self.store._task(db, task['id'])
                result.update(disposition='cancellation_preserved', taskStatus=fresh['status'])
                return result, None
            await db.execute("UPDATE work_tasks SET status='failed',authority_active=false,authority_generation=authority_generation+1 WHERE id=%s", (task['id'],))
            await db.execute("UPDATE work_runs SET status='failed' WHERE task_id=%s AND status IN ('queued','running')", (task['id'],))
            result.update(disposition='failed', taskStatus='failed', publicCode=code)
            await self.store._event(db, task['id'], 'task.failed', dict(version=1, reason='workflow_failure',
                runId=accepted.run_id, code=code, operationKey=key, result=result))
            return result, None
