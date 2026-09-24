"""One bounded handoff pass. Repeated delivery uses the existing reservation/history policy."""
import asyncio
import math

from .work_dispatcher import dispatch_one, MAX_EXECUTION_TIMEOUT_SECONDS
from .work_values import InvalidWork, WorkConflict, text


async def dispatch_batch(handoff, engine, *, namespace, queue, workflow_type,
                         execution_timeout_seconds=3600, limit=16, item_timeout_seconds=10):
    text(namespace, 64); text(queue, 256); text(workflow_type, 256)
    if (type(execution_timeout_seconds) is not int
            or not 1 <= execution_timeout_seconds <= MAX_EXECUTION_TIMEOUT_SECONDS
            or type(limit) is not int or not 1 <= limit <= 64
            or type(item_timeout_seconds) not in (int, float)
            or not math.isfinite(item_timeout_seconds) or not 0 < item_timeout_seconds <= 30):
        raise InvalidWork('invalid_dispatch_batch')
    if engine.namespace != namespace:
        raise WorkConflict('engine_namespace_mismatch')
    # Observe each list once. Neither observation authorizes a start, claim or retry.
    async with asyncio.timeout(item_timeout_seconds):
        pending = await handoff.pending(limit)
        unconfirmed = await handoff.unconfirmed(limit)
    identities, seen = [], set()
    for rows in (unconfirmed, pending):
        if type(rows) not in (list, tuple) or len(rows) > limit:
            raise InvalidWork('invalid_dispatch_rows')
        for row in rows:
            if type(row) is not dict:
                raise InvalidWork('invalid_dispatch_rows')
            task_id, run_id = text(row.get('taskId'), 128), text(row.get('runId'), 128)
            if (task_id, run_id) not in seen:
                identities.append((task_id, run_id)); seen.add((task_id, run_id))
    results = []
    for task_id, run_id in identities:
        record = dict(taskId=task_id, runId=run_id)
        try:
            async with asyncio.timeout(item_timeout_seconds):
                result = await dispatch_one(task_id, run_id, namespace, queue, workflow_type,
                    execution_timeout_seconds, handoff, engine)
            record.update(status='acknowledged' if result.acknowledged else 'unconfirmed',
                          reason=result.reason, startRequested=result.start_requested)
        except TimeoutError:
            record.update(status='unconfirmed', reason='observation_timeout', startRequested=None)
        except asyncio.CancelledError:
            raise
        except Exception:
            # An exception is not evidence of non-delivery. Do not leak database/provider text.
            record.update(status='error', reason='delivery_failed', startRequested=None)
        results.append(record)
    return results
