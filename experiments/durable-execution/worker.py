"""Disposable DBOS worker for process-crash qualification, never a Server entry point."""
from __future__ import annotations

import json
import os
from pathlib import Path
import time
from urllib.request import Request, urlopen

from dbos import DBOS, SetWorkflowID, WorkflowSerializationFormat
import psycopg


def settings() -> dict:
    # The parent creates this private file inside an owned TemporaryDirectory.
    return json.loads(Path(os.environ['OPENBOT_PROBE_CONFIG']).read_text())


def barrier(name: str) -> None:
    cfg = settings()
    if cfg['barrier'] != name:
        return
    root = Path(cfg['directory'])
    (root / 'reached').write_text(name)
    deadline = time.monotonic() + 45
    while not (root / 'release').exists():
        if time.monotonic() >= deadline:
            raise TimeoutError('Parent did not release the fault barrier')
        time.sleep(0.025)


def effect(name: str) -> None:
    cfg = settings()
    body = json.dumps({'case': cfg['case'], 'action': name, 'epoch': cfg['epoch']}).encode()
    request = Request(cfg['effect_url'], body, {'Content-Type': 'application/json'})
    with urlopen(request, timeout=3) as response:
        if response.status != 200 or response.read(64) != b'ok':
            raise RuntimeError('Fixture effect failed')


@DBOS.step(retries_allowed=False)
def prepare() -> str:
    effect('prepare')
    return 'prepared-artifact'


@DBOS.step(retries_allowed=False)
def checkpoint_barrier() -> None:
    # Entering this step proves prepare() already returned through its checkpoint.
    barrier('after-checkpoint')


@DBOS.step(retries_allowed=False)
def announce_wait() -> None:
    Path(settings()['directory'], 'waiting').write_text('waiting')


@DBOS.step(retries_allowed=False)
def write_action(guarded: bool) -> str:
    cfg = settings()
    with psycopg.connect(cfg['dsn']) as conn:
        allowed = conn.execute(
            'SELECT allowed FROM probe_authority WHERE case_id = %s', (cfg['case'],)
        ).fetchone()[0]
        if not allowed:
            return 'revoked'
        if guarded:
            claimed = conn.execute(
                "INSERT INTO probe_intents(case_id, outcome) VALUES (%s, 'submitted') "
                'ON CONFLICT DO NOTHING RETURNING case_id', (cfg['case'],)
            ).fetchone()
            if claimed is None:
                previous = conn.execute(
                    'SELECT outcome FROM probe_intents WHERE case_id = %s', (cfg['case'],)
                ).fetchone()[0]
                return 'applied' if previous == 'applied' else 'needs-reconciliation'
    # The committed intent is intentionally separate from the HTTP effect. Unknown outcome
    # remains blocked; this simple probe has no retry, lease takeover or reconciliation engine.
    barrier('after-intent')
    effect('write')
    barrier('after-write')
    if guarded:
        with psycopg.connect(cfg['dsn']) as conn:
            conn.execute("UPDATE probe_intents SET outcome = 'applied' WHERE case_id = %s",
                         (cfg['case'],))
    return 'applied'


@DBOS.step(retries_allowed=False)
def finish() -> None:
    effect('finish')


@DBOS.workflow(serialization_type=WorkflowSerializationFormat.PORTABLE)
def work(scenario: str) -> str:
    prepare()
    checkpoint_barrier()
    if scenario == 'approval':
        announce_wait()
        approval = DBOS.recv('approval', timeout_seconds=40)
        if approval != {'approved': True}:
            return 'not-approved'
    result = write_action(scenario != 'unsafe')
    if result == 'applied':
        finish()
    return result


def main() -> None:
    cfg = settings()
    DBOS(config={
        'name': 'openbot-durability-probe',
        'system_database_url': cfg['dbos_url'],
        'application_version': 'probe-v1',
        'executor_id': 'probe-local',
        'enable_otlp': False,
        'console_log_level': 'ERROR',
        'sys_db_pool_size': 5,
    })
    DBOS.launch()
    Path(cfg['directory'], 'ready').write_text('ready')
    try:
        if cfg['mode'] == 'start':
            with SetWorkflowID(cfg['case']):
                handle = DBOS.start_workflow(work, cfg['scenario'])
        else:
            # Public startup recovery, not private replay functions or edited engine tables.
            handle = DBOS.retrieve_workflow(cfg['case'])
        result = handle.get_result()
        Path(cfg['directory'], 'result.json').write_text(json.dumps({'result': result}))
    except Exception as error:
        Path(cfg['directory'], 'error.txt').write_text(type(error).__name__)
        raise
    finally:
        DBOS.destroy()


if __name__ == '__main__':
    main()
