"""Actual public HTTP, PostgreSQL, SDK and Temporal recovery in disposable fixtures."""
from __future__ import annotations

import argparse
from datetime import timedelta
import asyncio
import hashlib
from http.cookiejar import CookieJar
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
from urllib.error import HTTPError, URLError
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen

import psycopg
from temporalio.client import WorkflowExecutionStatus, WorkflowFailureError
from effect_service import EffectService

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
# These reused helpers create only owned loopback services and disposable databases.
sys.path.insert(0, str(REPO / 'experiments/durable-execution'))
from probe_temporal import Server
from probe import CLEAN_ENV, database, wait_for


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Process:
    def __init__(self, command, directory, env):
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True)
        self.log = (directory / 'process.log').open('w')
        self.process = subprocess.Popen(command, env=env, cwd=REPO, stdout=self.log,
            stderr=subprocess.STDOUT, start_new_session=True)

    def alive(self):
        if self.process.poll() is not None:
            raise AssertionError('Fixture process exited: ' + self.diagnostic())

    def diagnostic(self):
        return (self.directory / 'process.log').read_text()[-5000:]

    def wait(self, marker):
        def observed():
            if (self.directory / marker).exists():
                return True
            self.alive()
            return False
        wait_for(observed, marker)

    def done(self):
        code = self.process.wait(timeout=30)
        assert code == 0, self.diagnostic()

    def kill(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=5)
        self.log.close()


class API:
    def __init__(self, tmp, dsn, artifact_root):
        self.directory = tmp / 'api'
        self.url = f'http://127.0.0.1:{free_port()}'
        self.password = secrets.token_hex(24)
        self.opener = build_opener(HTTPCookieProcessor(CookieJar()))
        self.env = {**CLEAN_ENV, 'PYTHONDONTWRITEBYTECODE': '1',
            'OPENBOT_CONTROL_DATABASE_URL': dsn, 'OPENBOT_CONTROL_AUTHORITY': 'work',
            'OPENBOT_CONTROL_COOKIE_MODE': 'loopback', 'OPENBOT_CONTROL_PORT': self.url.rsplit(':', 1)[1],
            'OPENBOT_CONTROL_OWNER_PASSWORD': self.password,
            'OPENBOT_CONTROL_ARTIFACT_ROOT': str(artifact_root)}
        self.child = None

    def start(self):
        self.child = Process([str(REPO / 'apps/server-python/.venv/bin/python'), '-I',
            str(REPO / 'apps/server-python/scripts/serve.py')], self.directory, self.env)
        def ready():
            self.child.alive()
            try:
                return self.call('/health')['ok']
            except (OSError, URLError):
                return False
        wait_for(ready, 'public API ready')

    def call(self, path, body=None, *, expected=200, raw=False):
        request = Request(self.url + path, None if body is None else json.dumps(body).encode(),
            {'Content-Type': 'application/json', 'Origin': self.url})
        try:
            response = self.opener.open(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            content = response.read()
            assert response.status == expected, (path, response.status, content[:500])
            if raw:
                assert response.headers['X-Content-Type-Options'] == 'nosniff'
                assert response.headers['Content-Disposition'].startswith('attachment;')
                return content
            return json.loads(content) if content else None

    def snapshot(self, task_id):
        return self.call('/api/v1/tasks/' + task_id)

    def cancel(self, task_id):
        return self.call('/api/v1/tasks/' + task_id + '/cancel', {})

    def close(self):
        if self.child:
            self.child.kill()


async def qualify(tmp, dsn, server, *, only_handoff=False):
    client = await server.connect()
    artifact_root = tmp / 'artifacts'
    artifact_root.mkdir(mode=0o700)
    migration = tmp / 'migration.json'
    migration.write_text(json.dumps({'dsn': dsn})); migration.chmod(0o600)
    result = subprocess.run(['node', str(HERE / 'migrate.mjs'), str(migration)], cwd=REPO,
        env=CLEAN_ENV, capture_output=True, text=True, timeout=40)
    assert result.returncode == 0, result.stderr.replace(dsn, '[owned database]')
    api = API(tmp, dsn, artifact_root)
    effects = EffectService(tmp / 'effects')
    children, records = [], []

    def launch(script, cfg, barrier=''):
        directory = tmp / f'child-{len(children)}'
        directory.mkdir()
        cfg = {**cfg, 'barrier': barrier, 'directory': str(directory), 'effect_url': effects.url}
        config = directory / 'config.json'
        config.write_text(json.dumps(cfg)); config.chmod(0o600)
        process = Process([sys.executable, '-u', str(HERE / script)], directory,
            {**CLEAN_ENV, 'PYTHONDONTWRITEBYTECODE': '1', 'OPENBOT_WORK_JOURNEY_CONFIG': str(config)})
        children.append(process)
        if script == 'workflow_worker.py':
            process.wait('ready')
        return process

    def counts(task_id):
        with urlopen(effects.url + '/stats/' + task_id, timeout=3) as response:
            return json.load(response)

    def handoff(task_id):
        with psycopg.connect(dsn) as db:
            return db.execute('SELECT a.state,a.engine_reference FROM work_admissions a '
                'JOIN work_runs r ON r.id=a.run_id WHERE r.task_id=%s', (task_id,)).fetchone()

    async def waiting(handle, task_id):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            snap = api.snapshot(task_id)
            if snap['attention'] == 'approval' and await asyncio.wait_for(handle.query('waiting_query'), 5):
                return snap
            await asyncio.sleep(.05)
        raise AssertionError('Public approval and committed workflow wait not observed')

    def approve(snap):
        action = next(a for a in snap['actions'] if a['decision'] == 'pending')
        path = '/api/v1/actions/' + action['id'] + '/decision'
        api.call(path, {'intentDigest': '0' * 64, 'approved': True}, expected=409)
        return api.call(path, {'intentDigest': action['intentDigest'], 'approved': True})

    try:
        api.start()
        api.call('/api/v1/auth/login', {'password': api.password})
        bot = api.call('/api/v1/bots', {'name': 'Reference', 'role': 'Correct the fixture CSV'}, expected=201)['bot']
        scenarios = () if only_handoff else ('recover', 'cancel-before-write', 'cancel-unknown', 'corrupt-receipt', 'publication-ack')
        for scenario in scenarios:
            request = {'botId': bot['id'], 'objective': 'Correct row 7 in the owned CSV',
                'tokenLimit': 20, 'requestKey': secrets.token_hex(12)}
            initial = api.call('/api/v1/tasks', request, expected=202)
            task_id, run_id = initial['id'], initial['runs'][0]['id']
            cfg = {'dsn': dsn, 'artifact_root': str(artifact_root), 'task_id': task_id, 'run_id': run_id,
                'temporal_address': server.address, 'queue': 'work-' + run_id}
            handle = client.get_workflow_handle('openbot-work-v1-' + run_id)
            if scenario == 'recover':
                before = launch('dispatch.py', cfg, 'before-enqueue')
                before.wait('before-enqueue'); before.kill()
                assert handoff(task_id) == ('pending', None)
                assert counts(task_id)['attempts'] == 0
                after = launch('dispatch.py', cfg, 'after-enqueue')
                after.wait('after-enqueue'); after.kill()
                assert handoff(task_id) == ('pending', None)
                assert (await handle.describe()).status == WorkflowExecutionStatus.RUNNING
                # Duplicate acceptance is verified from history without a live worker.
            dispatch = launch('dispatch.py', cfg); dispatch.done()
            assert handoff(task_id) == ('acknowledged', 'temporal:default:openbot-work-v1-' + run_id)
            first = launch('workflow_worker.py', cfg)
            snap = await waiting(handle, task_id)
            first.kill()
            assert counts(task_id) == {'attempts': 3, 'writes': 0, 'lookups': 0}
            assert snap['usage'] == {'tokenLimit': 20, 'reservedTokens': 0, 'spentTokens': 6}
            if scenario == 'recover':
                api.close(); api.start()
                assert api.snapshot(task_id) == snap
            if scenario == 'cancel-before-write':
                cancelled = api.cancel(task_id)
                assert cancelled['status'] == 'cancelled'
                second = launch('workflow_worker.py', cfg)
                result = await asyncio.wait_for(handle.result(), 35)
                assert result['outcome'] == 'stopped'
                final = api.snapshot(task_id)
                assert counts(task_id)['attempts'] == 3 and counts(task_id)['writes'] == 0
                assert final['status'] == 'cancelled' and not final['artifacts']
                second.kill()
            elif scenario == 'publication-ack':
                approve(snap)
                second = launch('workflow_worker.py', cfg, 'after-publication')
                second.wait('after-publication')
                committed = api.snapshot(task_id)
                assert committed['status'] == 'completed'
                second.kill()
                third = launch('workflow_worker.py', cfg)
                result = await asyncio.wait_for(handle.result(), 35)
                final = api.snapshot(task_id)
                assert final == committed and result['status'] == 'completed'
                assert counts(task_id)['attempts'] == 5 and counts(task_id)['writes'] == 1
                third.kill()
            else:
                effects.drop_write_response(task_id)
                approve(snap)
                second = launch('workflow_worker.py', cfg, 'unknown')
                second.wait('unknown')
                unknown = api.snapshot(task_id)
                assert unknown['attention'] == 'reconciliation'
                assert unknown['usage'] == {'tokenLimit': 20, 'reservedTokens': 2, 'spentTokens': 6}
                assert counts(task_id) == {'attempts': 4, 'writes': 1, 'lookups': 0}
                second.kill()
                if scenario == 'cancel-unknown':
                    cancelled = api.cancel(task_id)
                    assert cancelled['status'] == 'open' and cancelled['attention'] == 'reconciliation'
                if scenario == 'corrupt-receipt':
                    effects.corrupt_receipt(task_id)
                if scenario == 'recover':
                    effects.close(); effects = EffectService(tmp / 'effects')
                    assert counts(task_id)['writes'] == 1
                third = launch('workflow_worker.py', cfg)
                if scenario == 'corrupt-receipt':
                    try:
                        await asyncio.wait_for(handle.result(), 35)
                    except WorkflowFailureError:
                        assert (await handle.describe()).status == WorkflowExecutionStatus.FAILED
                    else:
                        raise AssertionError('Corrupt receipt unexpectedly completed')
                    final = api.snapshot(task_id)
                    assert final['attention'] == 'reconciliation' and final['status'] == 'open'
                    assert final['usage'] == unknown['usage'] and not final['artifacts']
                    assert counts(task_id)['attempts'] == 4
                else:
                    result = await asyncio.wait_for(handle.result(), 35)
                    final = api.snapshot(task_id)
                    if scenario == 'cancel-unknown':
                        assert final['status'] == 'cancelled' and not final['artifacts']
                        assert final['usage'] == {'tokenLimit': 20, 'reservedTokens': 0, 'spentTokens': 8}
                        assert counts(task_id)['attempts'] == 4
                    else:
                        assert final['status'] == 'completed' and result['status'] == 'completed'
                        assert final['usage'] == {'tokenLimit': 20, 'reservedTokens': 0, 'spentTokens': 11}
                        assert len(final['actions']) == 5 and all(a['status'] == 'applied' for a in final['actions'])
                        assert len(final['artifacts']) == 1
                        artifact = final['artifacts'][0]
                        content = api.call(artifact['downloadUrl'], raw=True)
                        assert content == b'row,value\n7,fixed\n'
                        assert artifact['sizeBytes'] == len(content)
                        assert artifact['sha256'] == hashlib.sha256(content).hexdigest()
                        assert len([e for e in final['events'] if e['kind'] == 'task.completed']) == 1
                        assert api.call('/api/v1/tasks', request, expected=202) == final
                        again = launch('dispatch.py', cfg); again.done()
                        assert counts(task_id)['attempts'] == 5
                assert counts(task_id)['writes'] == 1 and counts(task_id)['lookups'] >= 1
                third.kill()
            record = {'case': scenario, 'status': final['status'], 'usage': final['usage'], **counts(task_id)}
            records.append(record)
            print(json.dumps(record), flush=True)
        for mismatch in ('scope', 'type', 'queue'):
            created = api.call('/api/v1/tasks', {'botId': bot['id'], 'objective': 'Reject a colliding workflow',
                'tokenLimit': 20, 'requestKey': secrets.token_hex(12)}, expected=202)
            task_id, run_id = created['id'], created['runs'][0]['id']
            cfg = {'dsn': dsn, 'artifact_root': str(artifact_root), 'task_id': task_id, 'run_id': run_id,
                'temporal_address': server.address, 'queue': 'work-' + run_id}
            identity = {'taskId': task_id, 'runId': run_id}
            handle = await client.start_workflow('UnrelatedWorkflow' if mismatch == 'type' else 'WorkJourney',
                {**identity, 'taskId': 'unrelated'} if mismatch == 'scope' else identity,
                id='openbot-work-v1-' + run_id, task_queue='unrelated' if mismatch == 'queue' else cfg['queue'],
                execution_timeout=timedelta(seconds=240))
            try:
                dispatcher = launch('dispatch.py', cfg)
                assert dispatcher.process.wait(timeout=30) != 0
                assert 'Engine acceptance' in dispatcher.diagnostic()
                if mismatch == 'scope':
                    # A worker may consume an ID before or after dispatcher rejection. Its
                    # own start-input check must prevent any claim/model/tool action.
                    worker = launch('workflow_worker.py', cfg)
                    try:
                        await asyncio.wait_for(handle.result(), 35)
                    except WorkflowFailureError:
                        assert (await handle.describe()).status == WorkflowExecutionStatus.FAILED
                    else:
                        raise AssertionError('Wrong start identity consumed product authority')
                    worker.kill()
                assert handoff(task_id) == ('pending', None)
                assert api.snapshot(task_id) == created
                assert counts(task_id)['attempts'] == 0
                record = {'case': 'handoff-reject-' + mismatch, 'status': 'pending', 'attempts': 0}
                records.append(record)
                print(json.dumps(record), flush=True)
            finally:
                if (await handle.describe()).status == WorkflowExecutionStatus.RUNNING:
                    await handle.terminate('End owned mismatch fixture')
        return records
    except BaseException:
        for child in children[-3:]:
            print(child.diagnostic().replace(dsn, '[owned database]'), file=sys.stderr)
        raise
    finally:
        for child in children:
            child.kill()
        api.close(); effects.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--temporal-cli', type=Path, required=True)
    parser.add_argument('--only-handoff', action='store_true', help='Run only engine-identity rejection regressions')
    args = parser.parse_args()
    assert sys.platform != 'win32', 'POSIX process signals required'
    assert importlib.metadata.version('temporalio') == '1.33.0'
    assert importlib.metadata.version('pydantic-ai-slim') == '2.47.0'
    binary = args.temporal_cli.resolve(strict=True)
    version = subprocess.run([str(binary), '--version'], env=CLEAN_ENV, check=True,
        capture_output=True, text=True, timeout=10).stdout.strip()
    assert version == 'temporal version 1.9.1 (Server 1.32.0, UI 2.54.1)', version
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    with TemporaryDirectory(prefix='openbot-work-journey-') as directory, database() as dsn:
        tmp = Path(directory)
        server = Server(binary, tmp)
        try:
            server.start()
            records = asyncio.run(qualify(tmp, dsn, server, only_handoff=args.only_handoff))
            print(json.dumps({'passed': len(records), 'scope': 'public HTTP + PG + SDK + dev Temporal + fake effects'}))
        finally:
            server.close()


if __name__ == '__main__':
    main()
