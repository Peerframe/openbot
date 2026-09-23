"""Run actual SIGKILL/restart cases with owned PostgreSQL and fake loopback effects."""
from __future__ import annotations

from collections import Counter
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
from tempfile import TemporaryDirectory
import threading
import time

from dbos import DBOSClient, WorkflowSerializationFormat
import psycopg

IMAGE = 'postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0'
ROOT = Path(__file__).resolve().parent
CLEAN_ENV = {key: os.environ[key] for key in
             ('PATH', 'HOME', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG')
             if key in os.environ}


def command(*args: str, timeout: int = 60) -> str:
    return subprocess.run(args, env=CLEAN_ENV, check=True, capture_output=True,
                          text=True, timeout=timeout).stdout.strip()


def wait_for(check, label: str, timeout: int = 30) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.025)
    raise AssertionError(f'Timed out: {label}')


@contextmanager
def database():
    name = 'openbot-durability-' + secrets.token_hex(6)
    password = secrets.token_hex(24)
    created = False
    try:
        command('docker', 'create', '--name', name, '--publish', '127.0.0.1::5432',
                '--env', 'POSTGRES_USER=openbot_probe', '--env', f'POSTGRES_PASSWORD={password}',
                '--env', 'POSTGRES_DB=openbot_probe', '--tmpfs', '/var/lib/postgresql/data', IMAGE)
        created = True
        command('docker', 'start', name)
        binding = command('docker', 'port', name, '5432/tcp')
        host, port = binding.rsplit(':', 1)
        assert host == '127.0.0.1' and port.isdecimal()
        dsn = f'postgresql://openbot_probe:{password}@{binding}/openbot_probe'
        def ready():
            try:
                with psycopg.connect(dsn, connect_timeout=1):
                    return True
            except psycopg.OperationalError:
                return False
        wait_for(ready, 'owned PostgreSQL readiness')
        with psycopg.connect(dsn) as conn:
            conn.execute('CREATE TABLE probe_authority(case_id text PRIMARY KEY, allowed boolean NOT NULL)')
            conn.execute('CREATE TABLE probe_intents(case_id text PRIMARY KEY, outcome text NOT NULL)')
        yield dsn
    finally:
        if created:
            command('docker', 'rm', '--force', name, timeout=20)


class Effects:
    def __init__(self):
        self.counts = Counter()
        self.rejected = Counter()
        self.epochs = {}
        self.lock = threading.Lock()
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                size = int(self.headers.get('Content-Length', '0'))
                if self.path != '/effects' or not 0 < size <= 2048:
                    self.send_error(400)
                    return
                payload = json.loads(self.rfile.read(size))
                with owner.lock:
                    case = payload['case']
                    if case in owner.epochs and payload['epoch'] != owner.epochs[case]:
                        owner.rejected[case] += 1
                        self.send_error(409, 'Stale execution epoch')
                        return
                    owner.counts[case, payload['action']] += 1
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'ok')
            def log_message(self, *_):
                pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/effects'

    def count(self, case, action):
        with self.lock:
            return self.counts[case, action]

    def fence(self, case, epoch):
        with self.lock:
            self.epochs[case] = epoch

    def rejected_count(self, case):
        with self.lock:
            return self.rejected[case]

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class Worker:
    def __init__(self, directory, dsn, effects, case, scenario, mode, barrier, epoch):
        self.directory = Path(directory)
        self.directory.mkdir()
        cfg = dict(directory=str(self.directory), dsn=dsn,
                   dbos_url=dsn.replace('postgresql:', 'postgresql+psycopg:'),
                   effect_url=effects.url, case=case, scenario=scenario, mode=mode, barrier=barrier, epoch=epoch)
        config = self.directory / 'config.json'
        config.write_text(json.dumps(cfg))
        config.chmod(0o600)
        self.log = (self.directory / 'worker.log').open('w')
        self.process = subprocess.Popen([sys.executable, '-u', str(ROOT / 'worker.py')],
            env={**CLEAN_ENV, 'OPENBOT_PROBE_CONFIG': str(config)}, stdout=self.log,
            stderr=subprocess.STDOUT, start_new_session=True)

    def wait(self, marker):
        def observed():
            if (self.directory / marker).exists():
                return True
            if self.process.poll() is not None:
                error_file = self.directory / 'error.txt'
                failure = error_file.read_text() if error_file.exists() else 'startup/process failure'
                raise AssertionError(f'Worker exited before {marker}: {failure}')
            return False
        wait_for(observed, marker)

    def release(self):
        (self.directory / 'release').touch()

    def result(self):
        self.wait('result.json')
        value = json.loads((self.directory / 'result.json').read_text())['result']
        assert self.process.wait(timeout=15) == 0
        return value

    def kill(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=5)
        self.log.close()


def qualify(dsn, effects, tmp):
    records = []
    client = None
    workers = []
    def launch(case, scenario, mode='start', barrier='', epoch=1):
        worker = Worker(Path(tmp) / f'worker-{len(workers)}', dsn, effects, case,
                        scenario, mode, barrier, epoch)
        workers.append(worker)
        worker.wait('ready')
        return worker
    def new_case(label):
        case = label + '-' + secrets.token_hex(6)
        with psycopg.connect(dsn) as conn:
            conn.execute('INSERT INTO probe_authority VALUES (%s, true)', (case,))
        return case
    def record(label, case, result):
        row = dict(case=label, result=result,
                   prepare=effects.count(case, 'prepare'), writes=effects.count(case, 'write'),
                   finish=effects.count(case, 'finish'))
        records.append(row)
        print(json.dumps(row), flush=True)
    try:
        for label, scenario, barrier, expected, count in [
            ('checkpoint_resume', 'guarded', 'after-checkpoint', 'applied', 1),
            ('unsafe_effect_negative_control', 'unsafe', 'after-write', 'applied', 2),
            ('guarded_unknown_effect', 'guarded', 'after-write', 'needs-reconciliation', 1),
            ('guarded_intent_before_effect', 'guarded', 'after-intent', 'needs-reconciliation', 0),
        ]:
            case = new_case(label)
            first = launch(case, scenario, barrier=barrier)
            first.wait('reached')
            first.kill()
            second = launch(case, scenario, mode='recover')
            result = second.result()
            assert result == expected
            assert effects.count(case, 'prepare') == 1
            assert effects.count(case, 'write') == count
            assert effects.count(case, 'finish') == (1 if expected == 'applied' else 0)
            record(label, case, result)
            second.kill()
            if label == 'checkpoint_resume':
                duplicate = launch(case, scenario)
                assert duplicate.result() == 'applied'
                assert effects.count(case, 'write') == 1
                record('completed_id_reuse', case, 'applied')
                duplicate.kill()
        client = DBOSClient(system_database_url=dsn.replace('postgresql:', 'postgresql+psycopg:'),
                            application_name='openbot-durability-probe', retry_connection_errors=False)
        for revoke in (False, True):
            label = 'approval_then_revocation' if revoke else 'approval_survives_restart'
            case = new_case(label)
            first = launch(case, 'approval')
            first.wait('waiting')
            first.kill()
            if revoke:
                with psycopg.connect(dsn) as conn:
                    conn.execute('UPDATE probe_authority SET allowed = false WHERE case_id = %s', (case,))
            # Deliver while no worker exists, then recover from the durable message.
            client.send(case, {'approved': True}, topic='approval', idempotency_key='owner-decision',
                        serialization_type=WorkflowSerializationFormat.PORTABLE)
            second = launch(case, 'approval', mode='recover')
            result = second.result()
            assert result == ('revoked' if revoke else 'applied')
            assert effects.count(case, 'prepare') == 1
            assert effects.count(case, 'write') == (0 if revoke else 1)
            record(label, case, result)
            second.kill()
        for fenced in (False, True):
            label = 'stale_executor_fenced' if fenced else 'stale_executor_negative_control'
            case = new_case(label)
            first = launch(case, 'guarded', barrier='after-intent')
            first.wait('reached')
            # Suspend the still-live original process (including its queue poller), then
            # simulate takeover. This is process suspension, not a network partition,
            # automatic failure detection or a production lease implementation.
            os.killpg(first.process.pid, signal.SIGSTOP)
            if fenced:
                effects.fence(case, 2)
            second = launch(case, 'guarded', mode='recover', epoch=2)
            assert second.result() == 'needs-reconciliation'
            assert effects.count(case, 'write') == 0
            first.release()
            os.killpg(first.process.pid, signal.SIGCONT)
            wait_for(lambda: effects.rejected_count(case) == 1 if fenced else
                     effects.count(case, 'write') == 1, 'old executor reaches effect boundary')
            first.process.wait(timeout=15)
            assert effects.count(case, 'write') == (0 if fenced else 1)
            assert effects.count(case, 'finish') == 0
            record(label, case, 'stale-effect-rejected' if fenced else 'stale-effect-observed')
            first.kill()
            second.kill()
        case = new_case('cancel_in_flight')
        first = launch(case, 'guarded', barrier='after-write')
        first.wait('reached')
        client.cancel_workflow(case)
        first.release()
        assert first.process.wait(timeout=15) == 1
        assert (first.directory / 'error.txt').read_text() == 'DBOSAwaitedWorkflowCancelledError'
        assert client.retrieve_workflow(case).get_status().status == 'CANCELLED'
        assert effects.count(case, 'write') == 1
        assert effects.count(case, 'finish') == 0
        record('cancel_in_flight', case, 'CANCELLED')
        first.kill()
        return records
    finally:
        for worker in workers:
            worker.kill()
        if client is not None:
            client.destroy()


def main():
    if sys.platform == 'win32':
        raise SystemExit('Probe requires POSIX process-group SIGKILL; no Windows claim')
    assert importlib.metadata.version('dbos') == '3.0.0'
    # Signal handlers unwind fixture ownership; never remove a pre-existing container.
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    effects = Effects()
    try:
        with TemporaryDirectory(prefix='openbot-durability-') as tmp, database() as dsn:
            records = qualify(dsn, effects, tmp)
            print(json.dumps({'passed': len(records), 'dbos': '3.0.0',
                              'scope': 'local POSIX workers + owned PostgreSQL17 + fake HTTP'}))
    finally:
        effects.close()


if __name__ == '__main__':
    main()
