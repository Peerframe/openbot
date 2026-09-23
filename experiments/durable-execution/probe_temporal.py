"""Compare real Temporal worker failures using only owned local development fixtures."""
from __future__ import annotations

import argparse
import asyncio
from datetime import timedelta
import importlib.metadata
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
import time

import psycopg
from temporalio.client import Client, WorkflowExecutionStatus, WorkflowFailureError
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import (
    ActivityError, CancelledError, TimeoutError as ActivityTimeoutError, WorkflowAlreadyStartedError,
)

# These are test fixtures, not a generic engine adapter or a dependency of the product.
from probe import CLEAN_ENV, Effects, ROOT, database, wait_for


class Server:
    def __init__(self, binary: Path, directory: Path):
        self.directory = directory
        self.binary = binary
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        self.address = f'127.0.0.1:{self.port}'
        self.process = None
        self.log = (directory / 'server.log').open('w')

    def start(self):
        self.process = subprocess.Popen([
            str(self.binary), '--disable-config-env', '--disable-config-file',
            'server', 'start-dev', '--ip', '127.0.0.1', '--headless',
            '--port', str(self.port), '--db-filename', str(self.directory / 'history.sqlite'),
        ], env=CLEAN_ENV, stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)

    async def connect(self):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise AssertionError('Owned Temporal server exited: ' +
                                     (self.directory / 'server.log').read_text()[-2500:])
            try:
                client = await asyncio.wait_for(Client.connect(self.address), timeout=2)
                if await asyncio.wait_for(client.service_client.check_health(), timeout=2):
                    return client
            except (Exception, asyncio.TimeoutError):
                pass
            await asyncio.sleep(0.1)
        raise AssertionError('Owned Temporal server did not become healthy')

    def kill(self):
        if self.process and self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=5)

    def close(self):
        self.kill()
        self.log.close()


class Worker:
    def __init__(self, directory, cfg):
        self.directory = directory
        directory.mkdir()
        config = directory / 'config.json'
        config.write_text(json.dumps({**cfg, 'directory': str(directory)}))
        config.chmod(0o600)
        self.log = (directory / 'worker.log').open('w')
        self.process = subprocess.Popen([sys.executable, '-u', str(ROOT / 'temporal_worker.py')],
            env={**CLEAN_ENV, 'PYTHONDONTWRITEBYTECODE': '1', 'OPENBOT_PROBE_CONFIG': str(config)}, stdout=self.log,
            stderr=subprocess.STDOUT, start_new_session=True)

    def wait(self, marker):
        def observed():
            if (self.directory / marker).exists():
                return True
            if self.process.poll() is not None:
                raise AssertionError(f'Worker exited before {marker}: ' +
                                     (self.directory / 'worker.log').read_text()[-3000:])
            return False
        wait_for(observed, marker)

    def release(self):
        (self.directory / 'release').touch()

    def kill(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=5)
        self.log.close()


async def qualify(server, dsn, effects, tmp):
    client = await server.connect()
    workers = []
    records = []

    def new_case(label):
        case = label + '-' + secrets.token_hex(6)
        with psycopg.connect(dsn) as conn:
            conn.execute('INSERT INTO probe_authority VALUES (%s, true)', (case,))
        return case

    def launch(case, scenario, barrier='', epoch=1, cooperative=True):
        cfg = dict(dsn=dsn, case=case, scenario=scenario, barrier=barrier, epoch=epoch,
                   effect_url=effects.url, temporal_address=server.address,
                   task_queue='queue-' + case, cooperative=cooperative)
        worker = Worker(Path(tmp) / f'worker-{len(workers)}', cfg)
        workers.append(worker)
        worker.wait('ready')
        return worker

    async def start(case, scenario):
        return await client.start_workflow('ProbeWorkflow', scenario, id=case,
            task_queue='queue-' + case, execution_timeout=timedelta(seconds=100),
            id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE)

    async def result(handle):
        return await asyncio.wait_for(handle.result(), timeout=35)

    def record(label, case, value):
        row = dict(case=label, result=value, prepare=effects.count(case, 'prepare'),
                   writes=effects.count(case, 'write'), finish=effects.count(case, 'finish'))
        records.append(row)
        print(json.dumps(row), flush=True)

    async def waiting(handle):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if await asyncio.wait_for(handle.query('waiting'), timeout=5):
                return
            await asyncio.sleep(0.05)
        raise AssertionError('Approval wait not reached')

    try:
        for label, scenario, barrier, expected, count in [
            ('checkpoint_resume', 'guarded', 'after-checkpoint', 'applied', 1),
            ('unsafe_effect_negative_control', 'unsafe', 'after-write', 'applied', 2),
            ('guarded_unknown_effect', 'guarded', 'after-write', 'needs-reconciliation', 1),
            ('guarded_intent_before_effect', 'guarded', 'after-intent', 'needs-reconciliation', 0),
        ]:
            case = new_case(label)
            first = launch(case, scenario, barrier)
            handle = await start(case, scenario)
            first.wait('reached')
            first.kill()
            second = launch(case, scenario)
            value = await result(handle)
            assert value == expected
            assert effects.count(case, 'prepare') == 1
            assert effects.count(case, 'write') == count
            assert effects.count(case, 'finish') == (1 if expected == 'applied' else 0)
            record(label, case, value)
            if label == 'checkpoint_resume':
                try:
                    await start(case, scenario)
                except WorkflowAlreadyStartedError:
                    pass
                else:
                    raise AssertionError('Completed ID unexpectedly started another workflow')
                assert await result(client.get_workflow_handle(case)) == 'applied'
                assert effects.count(case, 'write') == 1
                record('completed_id_rejected', case, 'same-completed-result')
            second.kill()

        for revoke, restart_server in [(False, False), (True, False), (False, True)]:
            label = ('approval_after_server_restart' if restart_server else
                     'approval_then_revocation' if revoke else 'approval_survives_restart')
            case = new_case(label)
            first = launch(case, 'approval')
            handle = await start(case, 'approval')
            await waiting(handle)
            first.kill()
            if revoke:
                with psycopg.connect(dsn) as conn:
                    conn.execute('UPDATE probe_authority SET allowed = false WHERE case_id = %s', (case,))
            await handle.signal('approval', {'approved': True})
            # Same decision redelivery, not proof of a complete approval idempotency protocol.
            await handle.signal('approval', {'approved': True})
            if restart_server:
                server.kill()
                server.start()
                client = await server.connect()
                handle = client.get_workflow_handle(case)
            second = launch(case, 'approval')
            value = await result(handle)
            assert value == ('revoked' if revoke else 'applied')
            assert effects.count(case, 'prepare') == 1
            assert effects.count(case, 'write') == (0 if revoke else 1)
            assert effects.count(case, 'finish') == (0 if revoke else 1)
            record(label, case, value)
            second.kill()

        for fenced in (False, True):
            label = 'stale_executor_fenced' if fenced else 'stale_executor_negative_control'
            case = new_case(label)
            first = launch(case, 'guarded', 'after-intent', cooperative=False)
            handle = await start(case, 'guarded')
            first.wait('reached')
            os.killpg(first.process.pid, signal.SIGSTOP)
            if fenced:
                effects.fence(case, 2)
            second = launch(case, 'guarded', epoch=2)
            assert await result(handle) == 'needs-reconciliation'
            assert effects.count(case, 'write') == 0
            first.release()
            os.killpg(first.process.pid, signal.SIGCONT)
            wait_for(lambda: effects.rejected_count(case) == 1 if fenced else
                     effects.count(case, 'write') == 1, 'old activity reaches effect boundary')
            assert effects.count(case, 'write') == (0 if fenced else 1)
            assert effects.count(case, 'finish') == 0
            record(label, case, 'stale-effect-rejected' if fenced else 'stale-effect-observed')
            first.kill()
            second.kill()

        case = new_case('single_attempt_unknown')
        first = launch(case, 'single-attempt', 'after-write')
        handle = await start(case, 'single-attempt')
        first.wait('reached')
        first.kill()
        second = launch(case, 'single-attempt')
        try:
            await result(handle)
        except WorkflowFailureError as error:
            assert isinstance(error.cause, ActivityError)
            assert isinstance(error.cause.cause, ActivityTimeoutError)
            assert (await handle.describe()).status == WorkflowExecutionStatus.FAILED
        else:
            raise AssertionError('Single-attempt unfinished activity unexpectedly succeeded')
        assert effects.count(case, 'write') == 1
        assert effects.count(case, 'finish') == 0
        record('single_attempt_unknown', case, 'engine-failed-external-write-retained')
        second.kill()

        case = new_case('cancel_in_flight')
        first = launch(case, 'guarded', 'after-write')
        handle = await start(case, 'guarded')
        first.wait('reached')
        await handle.cancel()
        try:
            await result(handle)
        except WorkflowFailureError as error:
            assert isinstance(error.cause, CancelledError)
            assert (await handle.describe()).status == WorkflowExecutionStatus.CANCELED
        else:
            raise AssertionError('Canceled workflow unexpectedly succeeded')
        assert effects.count(case, 'write') == 1
        assert effects.count(case, 'finish') == 0
        record('cancel_in_flight', case, 'CANCELED')
        first.kill()
        return records
    except BaseException:
        # Test diagnostics contain only fixture IDs and data. Preserve no credentials/config.
        for worker in workers[-2:]:
            print((worker.directory / 'worker.log').read_text()[-2000:], file=sys.stderr)
        raise
    finally:
        for worker in workers:
            worker.kill()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--temporal-cli', type=Path, required=True)
    args = parser.parse_args()
    if sys.platform == 'win32':
        raise SystemExit('Requires POSIX process signals; no Windows claim')
    assert importlib.metadata.version('temporalio') == '1.33.0'
    binary = args.temporal_cli.resolve(strict=True)
    version = subprocess.run([str(binary), '--version'], env=CLEAN_ENV, check=True,
                             capture_output=True, text=True, timeout=10).stdout.strip()
    assert version == 'temporal version 1.9.1 (Server 1.32.0, UI 2.54.1)', version
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    effects = Effects()
    try:
        with TemporaryDirectory(prefix='openbot-temporal-') as tmp, database() as dsn:
            server = Server(binary, Path(tmp))
            try:
                server.start()
                records = asyncio.run(qualify(server, dsn, effects, tmp))
                print(json.dumps({'passed': len(records), 'sdk': '1.33.0', 'cli': '1.9.1',
                    'server': '1.32.0', 'scope': 'local dev SQLite + POSIX workers + fake HTTP'}))
            finally:
                server.close()
    finally:
        effects.close()


if __name__ == '__main__':
    main()
