"""Disposable Temporal 1.33.0 candidate worker for the durability fault probe.

This is an experiment fixture, never a Server entry point. It exercises the same
approval/crash/stale-worker/unknown-effect journey as the DBOS 3.0.0 fixture, using only a
parent-owned temporary config, a fake loopback effect service and a disposable PostgreSQL.

Authority boundaries the fixture deliberately keeps outside the engine:

* the engine orchestrates; it owns no OpenBot identity, approval or budget record;
* every external effect and every authority read happens in a remote normal activity;
* workflow determinism is a replay constraint, not an operating-system sandbox, and neither
  cancellation nor termination fences an external write that already reached the network;
* an unknown external outcome stays unknown here - this probe has no lease, takeover or
  reconciliation engine, so it reports `needs-reconciliation` instead of claiming success.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
from contextlib import nullcontext
from datetime import timedelta
import json
import os
from pathlib import Path
import threading
import time
import traceback
from typing import Any

from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.common import RetryPolicy
from temporalio.worker import Worker

# Activity options: normal remote activities (never local), bounded and short lived. A remote
# activity that stops heartbeating is timed out by the server, which is what lets this fixture
# observe a killed or suspended worker instead of pretending a stale executor was fenced.
_ACTIVITY_OPTIONS: dict[str, Any] = {
    'start_to_close_timeout': timedelta(seconds=6),
    'heartbeat_timeout': timedelta(seconds=2),
    'schedule_to_close_timeout': timedelta(seconds=25),
}
_BOUNDED_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    maximum_interval=timedelta(seconds=1),
    backoff_coefficient=1.0,
    maximum_attempts=3,
)
_SINGLE_ATTEMPT_RETRY = RetryPolicy(maximum_attempts=1)
_BARRIER_DEADLINE_SECONDS = 45.0
_HEARTBEAT_INTERVAL_SECONDS = 0.5
_POLL_INTERVAL_SECONDS = 0.025
_APPROVAL_TIMEOUT_SECONDS = 40

_config_lock = threading.Lock()
_config_cache: dict[str, Any] | None = None


def probe_config() -> dict[str, Any]:
    """Return the parent-owned probe config.

    Only host code and activity code call this. Workflow code never reads the file, the
    environment or the clock: the engine cannot automatically record those nondeterministic inputs.
    """
    global _config_cache
    with _config_lock:
        if _config_cache is None:
            _config_cache = json.loads(Path(os.environ['OPENBOT_PROBE_CONFIG']).read_text())
        return _config_cache


def _barrier(name: str) -> None:
    """Block the calling activity thread until the parent releases this named barrier."""
    cfg = probe_config()
    if cfg.get('barrier') != name:
        return
    root = Path(cfg['directory'])
    (root / 'reached').write_text(name)
    cooperative = bool(cfg.get('cooperative'))
    deadline = time.monotonic() + _BARRIER_DEADLINE_SECONDS
    while not (root / 'release').exists():
        if time.monotonic() >= deadline:
            raise TimeoutError('Parent did not release the fault barrier')
        if cooperative:
            # Heartbeats cooperate with cancellation. The SDK can also inject cancellation
            # on timeout; neither mechanism constitutes authority at an external service.
            activity.heartbeat(name)
        time.sleep(_HEARTBEAT_INTERVAL_SECONDS if cooperative else _POLL_INTERVAL_SECONDS)


def _effect(name: str) -> None:
    """POST to the fixture effect service and treat any non-200 answer as failure."""
    # Imported per call so the sandboxed copy of this module never imports a network client.
    from urllib.request import Request, urlopen

    cfg = probe_config()
    body = json.dumps({'case': cfg['case'], 'action': name, 'epoch': cfg['epoch']}).encode()
    request = Request(cfg['effect_url'], body, {'Content-Type': 'application/json'})
    with urlopen(request, timeout=3) as response:
        if response.status != 200 or response.read(64) != b'ok':
            raise RuntimeError('Fixture effect failed')


@activity.defn
def prepare() -> str:
    _effect('prepare')
    return 'prepared-artifact'


@activity.defn
def checkpoint_barrier() -> None:
    # Reaching this activity proves prepare() already returned through its recorded result.
    _barrier('after-checkpoint')


@activity.defn
def write_action(guarded: bool) -> str:
    # Imported per call: the sandboxed copy of this module must not import a database driver.
    import psycopg

    cfg = probe_config()
    with psycopg.connect(cfg['dsn']) as conn:
        allowed = conn.execute(
            'SELECT allowed FROM probe_authority WHERE case_id = %s', (cfg['case'],)
        ).fetchone()[0]
        if not allowed:
            return 'revoked'
        if guarded:
            # Committing the intent is what makes a repeat recognisable; it is not an external
            # effect and it cannot prove the external request happened.
            claimed = conn.execute(
                "INSERT INTO probe_intents(case_id, outcome) VALUES (%s, 'submitted') "
                'ON CONFLICT DO NOTHING RETURNING case_id', (cfg['case'],)
            ).fetchone()
            if claimed is None:
                previous = conn.execute(
                    'SELECT outcome FROM probe_intents WHERE case_id = %s', (cfg['case'],)
                ).fetchone()[0]
                return 'applied' if previous == 'applied' else 'needs-reconciliation'
    # The committed intent is intentionally separate from the HTTP effect. A non-200 answer
    # (including HTTP 409) stays a failure: this probe must never report it as applied.
    # Only the deliberate stale-executor case shields thread cancellation. This models a
    # non-interruptible action section, not default Temporal behavior or production policy.
    with (activity.shield_thread_cancel_exception() if not cfg['cooperative'] else nullcontext()):
        _barrier('after-intent')
        _effect('write')
        _barrier('after-write')
        if guarded:
            with psycopg.connect(cfg['dsn']) as conn:
                conn.execute("UPDATE probe_intents SET outcome = 'applied' WHERE case_id = %s",
                             (cfg['case'],))
        return 'applied'


@activity.defn
def finish() -> None:
    _effect('finish')


@workflow.defn
class ProbeWorkflow:
    """Bounded orchestrator. It proposes actions and reads their recorded outcomes only."""

    def __init__(self) -> None:
        self._decision: dict[str, Any] | None = None
        self._awaiting_approval = False

    @workflow.signal
    def approval(self, value: dict) -> None:
        # First decision wins: a redelivered signal is not new authority to act.
        if self._decision is None:
            self._decision = value

    @workflow.query
    def waiting(self) -> bool:
        """Whether the workflow is blocked on an approval decision the parent has not sent."""
        return self._awaiting_approval and self._decision is None

    @workflow.run
    async def run(self, scenario: str) -> str:
        await workflow.execute_activity(
            prepare, **_ACTIVITY_OPTIONS, retry_policy=_BOUNDED_RETRY
        )
        await workflow.execute_activity(
            checkpoint_barrier, **_ACTIVITY_OPTIONS, retry_policy=_BOUNDED_RETRY
        )
        if scenario == 'approval':
            self._awaiting_approval = True
            try:
                await workflow.wait_condition(
                    lambda: self._decision is not None,
                    timeout=timedelta(seconds=_APPROVAL_TIMEOUT_SECONDS),
                )
            except asyncio.TimeoutError:
                # Same result as the DBOS fixture's expired receive: absence of a decision is
                # not consent, and it must not fall through to the effect.
                return 'not-approved'
            finally:
                self._awaiting_approval = False
            if self._decision != {'approved': True}:
                return 'not-approved'
        # 'unsafe' and 'single-attempt' deliberately run the unguarded write: they are the
        # negative controls that must not claim domain intent.
        guarded = scenario not in ('unsafe', 'single-attempt')
        retry_policy = (_SINGLE_ATTEMPT_RETRY if scenario == 'single-attempt'
                        else _BOUNDED_RETRY)
        outcome = await workflow.execute_activity(
            write_action, guarded, **_ACTIVITY_OPTIONS, retry_policy=retry_policy
        )
        if outcome == 'applied':
            await workflow.execute_activity(finish, **_ACTIVITY_OPTIONS,
                                            retry_policy=_BOUNDED_RETRY)
        return outcome


async def run_worker() -> None:
    cfg = probe_config()
    missing = [key for key in ('directory', 'dsn', 'effect_url', 'case', 'temporal_address',
                               'task_queue') if not cfg.get(key)]
    if missing:
        raise RuntimeError(f'Probe config is missing {missing}')
    # Sync activities run on this bounded executor. It also enables per-thread cancellation
    # delivery; it is not a resource or security boundary.
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix='probe-activity')
    try:
        client = await Client.connect(cfg['temporal_address'])
        worker = Worker(
            client,
            task_queue=cfg['task_queue'],
            workflows=[ProbeWorkflow],
            activities=[prepare, checkpoint_barrier, write_action, finish],
            activity_executor=executor,
            max_concurrent_activities=4,
        )
        Path(cfg['directory'], 'ready').write_text('ready')
        # The parent owns the client, the workflow start and the outcome; this process only
        # serves the task queue and is expected to be killed by the harness.
        await worker.run()
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


def main() -> None:
    try:
        asyncio.run(run_worker())
    except Exception:
        traceback.print_exc()
        raise SystemExit(1) from None


# A workflow's module is also re-imported inside the sandboxed workflow runner (as
# __temporal_main__), so this guard is what keeps the fixture from starting a second worker there.
if __name__ == '__main__':
    main()
