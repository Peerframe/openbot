"""Read-only real SDK observation; no Worker, Workflow, model or engine is created here."""
import asyncio
from datetime import timedelta
import hashlib
import json
from pathlib import Path
import re
import sys


def fresh_identities(response, started_at_ms):
    """Old pollers remain in the server's cache after shutdown and are deliberately ignored."""
    return {poller.identity for poller in response.pollers
            if poller.identity and poller.HasField('last_access_time')
            and poller.last_access_time.ToNanoseconds() >= started_at_ms * 1_000_000}


async def observe(client, queue, started_at_ms, *, timeout_seconds=35, interval_seconds=1):
    from temporalio.api.enums.v1 import TaskQueueType
    from temporalio.api.taskqueue.v1 import TaskQueue
    from temporalio.api.workflowservice.v1 import DescribeTaskQueueRequest

    async with asyncio.timeout(timeout_seconds):
        while True:
            identities = []
            for queue_type in (TaskQueueType.TASK_QUEUE_TYPE_WORKFLOW,
                               TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY):
                response = await client.workflow_service.describe_task_queue(
                    DescribeTaskQueueRequest(namespace=client.namespace,
                        task_queue=TaskQueue(name=queue), task_queue_type=queue_type),
                    retry=False, timeout=timedelta(seconds=5))
                identities.append(fresh_identities(response, started_at_ms))
            if any(len(found) > 1 for found in identities):
                raise ValueError('multiple_fresh_worker_identities')
            if len(identities[0]) == 1 and identities[0] == identities[1]:
                identity = next(iter(identities[0]))
                return dict(format='openbot.desktop.temporal-pollers/v1',
                    freshWorkflowPollers=1, freshActivityPollers=1, sameWorkerIdentity=True,
                    workerIdentitySha256=hashlib.sha256(identity.encode()).hexdigest())
            await asyncio.sleep(interval_seconds)


async def main(arguments):
    if len(arguments) != 3:
        raise ValueError('explicit_probe_arguments_required')
    runtime_root, config_path = (Path(value) for value in arguments[:2])
    if not runtime_root.is_absolute() or not config_path.is_absolute():
        raise ValueError('absolute_paths_required')
    if not arguments[2].isascii() or not arguments[2].isdigit():
        raise ValueError('start_timestamp_required')
    started_at_ms = int(arguments[2])
    if started_at_ms <= 0:
        raise ValueError('start_timestamp_required')
    # -I rejects ambient PYTHONPATH; inspect exactly the operator-selected bundle.
    sys.path.insert(0, str(runtime_root / 'apps/server-python/src'))
    from openbot_server.work_engine_client import connect, read_owned_file
    config = json.loads(read_owned_file(config_path, private=True, maximum=16384))
    if not re.fullmatch(r'openbot-desktop-probe-[0-9a-f-]{36}', config['queue']):
        raise ValueError('isolated_probe_queue_required')
    async with asyncio.timeout(40):
        client = await connect(config['temporal_address'], config['tls'], namespace=config['namespace'])
        return await observe(client, config['queue'], started_at_ms)


if __name__ == '__main__':
    try:
        result = asyncio.run(main(sys.argv[1:]))
    except Exception:
        # RPC and file exceptions may contain private identities, endpoints or paths.
        print(json.dumps({'ok': False, 'code': 'fresh_worker_pollers_not_observed'}))
        raise SystemExit(1) from None
    print(json.dumps(result, sort_keys=True))
