"""Probe tests use real SDK protobufs and synthetic responses, not an actual engine."""
import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest
from temporalio.api.enums.v1 import TaskQueueType
from temporalio.api.taskqueue.v1 import PollerInfo
from temporalio.api.workflowservice.v1 import DescribeTaskQueueResponse

spec = importlib.util.spec_from_file_location('observe_pollers', Path(__file__).with_name('observe-pollers.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def poller(identity, nanoseconds):
    value = PollerInfo(identity=identity)
    value.last_access_time.FromNanoseconds(nanoseconds)
    return value


def response(*entries):
    return DescribeTaskQueueResponse(pollers=entries)


def client_with(*responses):
    pending = iter(responses)
    calls = []
    async def describe(request, **options):
        calls.append((request, options))
        return next(pending)
    return SimpleNamespace(namespace='synthetic', workflow_service=SimpleNamespace(describe_task_queue=describe)), calls


def test_freshness_uses_exact_nanosecond_boundary_and_never_accepts_absent_identity():
    found = module.fresh_identities(response(poller('old', 999_999_999),
        poller('fresh', 1_000_000_000), poller('', 2_000_000_000), PollerInfo(identity='no-time')), 1000)
    assert found == {'fresh'}


def test_both_default_task_queue_types_require_one_matching_fresh_identity():
    client, calls = client_with(response(poller('worker-private-identity', 1_000_000_000)),
                                response(poller('worker-private-identity', 1_000_000_001)))
    result = asyncio.run(module.observe(client, 'unique-queue', 1000))
    assert result['freshWorkflowPollers'] == result['freshActivityPollers'] == 1
    assert result['sameWorkerIdentity'] is True and len(result['workerIdentitySha256']) == 64
    assert 'worker-private-identity' not in str(result)
    assert [call[0].task_queue_type for call in calls] == [
        TaskQueueType.TASK_QUEUE_TYPE_WORKFLOW, TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY]
    assert all(call[0].namespace == 'synthetic' and call[0].task_queue.name == 'unique-queue' and
               call[1]['retry'] is False and call[1]['timeout'].total_seconds() == 5 for call in calls)


def test_old_stopped_workers_do_not_count_as_multiple_current_workers():
    entries = (poller('old-worker', 999_000_000), poller('fresh-worker', 1_000_000_000))
    client, _ = client_with(response(*entries), response(*entries))
    assert asyncio.run(module.observe(client, 'queue', 1000))['sameWorkerIdentity'] is True


def test_pending_descriptions_are_read_again_without_starting_any_execution():
    client, calls = client_with(response(), response(), response(poller('worker', 1_000_000_000)),
                                response(poller('worker', 1_000_000_000)))
    assert asyncio.run(module.observe(client, 'queue', 1000, interval_seconds=0))['sameWorkerIdentity'] is True
    assert len(calls) == 4


def test_multiple_current_workers_fail_closed():
    client, _ = client_with(response(poller('one', 1_000_000_000), poller('two', 1_000_000_000)),
                            response(poller('one', 1_000_000_000)))
    with pytest.raises(ValueError, match='multiple_fresh_worker_identities'):
        asyncio.run(module.observe(client, 'queue', 1000))


@pytest.mark.parametrize('activity_identity', ['', 'another-worker'])
def test_missing_or_different_activity_worker_never_counts_as_connected(activity_identity):
    async def describe(request, **_):
        identity = 'workflow-worker' if request.task_queue_type == TaskQueueType.TASK_QUEUE_TYPE_WORKFLOW else activity_identity
        return response(poller(identity, 1_000_000_000))
    client = SimpleNamespace(namespace='synthetic', workflow_service=SimpleNamespace(describe_task_queue=describe))
    with pytest.raises(TimeoutError):
        asyncio.run(module.observe(client, 'queue', 1000, timeout_seconds=0.03, interval_seconds=0.005))
