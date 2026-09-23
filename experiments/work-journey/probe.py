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


async def qualify(tmp, dsn, server, *, only_handoff=False, only_case=None):
    client = await server.connect()
    if hasattr(server, 'qualify_transport'):
        await server.qualify_transport()
    artifact_root = tmp / 'artifacts'
    artifact_root.mkdir(mode=0o700)
    migration = tmp / 'migration.json'
    migration.write_text(json.dumps({'dsn': dsn})); migration.chmod(0o600)
    result = subprocess.run(['node', str(HERE / 'migrate.mjs'), str(migration)], cwd=REPO,
        env=CLEAN_ENV, capture_output=True, text=True, timeout=40)
    assert result.returncode == 0, result.stderr.replace(dsn, '[owned database]')
    api = API(tmp, dsn, artifact_root)
    effects = EffectService(tmp / 'effects')
    children, records, held_upgrades = [], [], []

    def launch(script, cfg, barrier=''):
        directory = tmp / f'child-{len(children)}'
        directory.mkdir()
        cfg = {**cfg, 'execution_timeout_seconds': 1200 if hasattr(server, 'upgrade') else 240, 'engine_tls': getattr(server, 'client_settings', None), 'barrier': barrier, 'directory': str(directory), 'effect_url': effects.url}
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

    async def replay_without_effects(handle, task_id, stage):
        from replay import verify_history_replay
        before_state, before_effects = api.snapshot(task_id), counts(task_id)
        evidence = await verify_history_replay(await handle.fetch_history())
        assert api.snapshot(task_id) == before_state, 'Offline replay changed product state'
        assert counts(task_id) == before_effects, 'Offline replay repeated an external operation'
        print(json.dumps({'case': 'offline-replay-' + stage, **evidence,
                          'productAndEffectsUnchanged': True}), flush=True)

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

    async def resume_upgrade_tasks(engine_client, phase):
        for held in held_upgrades:
            task_id = held['cfg']['task_id']
            handle = engine_client.get_workflow_handle('openbot-work-v1-' + held['cfg']['run_id'])
            description = await handle.describe()
            assert description.run_id == held['engineRunId']
            assert description.status == WorkflowExecutionStatus.RUNNING
            assert api.snapshot(task_id) == held['state']
            assert counts(task_id) == held['effects']
            await replay_without_effects(handle, task_id, phase + '-' + held['stage'] + '-before')
            if held['state']['status'] != 'completed':
                approve(held['state'])
            worker = launch('workflow_worker.py', held['cfg'])
            result = await asyncio.wait_for(handle.result(), 35)
            worker.kill()
            completed = api.snapshot(task_id)
            assert completed['status'] == 'completed'
            if phase == 'restored' and held['stage'] == 'approval':
                # Business completion revoked authority. Old engine history must stop at the
                # fresh control check, not re-admit work to imitate its already-published result.
                assert result['outcome'] == 'stopped'
            else:
                assert result['status'] == 'completed'
            if held['state']['status'] == 'completed':
                assert completed == held['state']
            assert completed['usage'] == {'tokenLimit': 20, 'reservedTokens': 0, 'spentTokens': 11}
            assert counts(task_id) == {'attempts': 5, 'writes': 1, 'lookups': 0}
            assert len(completed['artifacts']) == 1
            assert api.call(completed['artifacts'][0]['downloadUrl'], raw=True) == b'row,value\n7,fixed\n'
            assert len([e for e in completed['events'] if e['kind'] == 'task.completed']) == 1
            await replay_without_effects(handle, task_id, phase + '-' + held['stage'] + '-after')
            record = {'case': 'upgrade-' + phase + '-' + held['stage'],
                'engineRunIdentityRetained': True, 'status': completed['status'], **counts(task_id)}
            records.append(record); print(json.dumps(record), flush=True)
            held['state'], held['effects'] = completed, counts(task_id)

    try:
        api.start()
        api.call('/api/v1/auth/login', {'password': api.password})
        bot = api.call('/api/v1/bots', {'name': 'Reference', 'role': 'Correct the fixture CSV'}, expected=201)['bot']
        if hasattr(server, 'upgrade'):
            for stage in ('approval', 'publication-ack'):
                created = api.call('/api/v1/tasks', {'botId': bot['id'],
                    'objective': 'Preserve the pre-upgrade ' + stage, 'tokenLimit': 20,
                    'requestKey': secrets.token_hex(12)}, expected=202)
                held_task, held_run = created['id'], created['runs'][0]['id']
                held_cfg = {'dsn': dsn, 'artifact_root': str(artifact_root), 'task_id': held_task,
                    'run_id': held_run, 'temporal_address': server.address, 'queue': 'work-' + held_run}
                launch('dispatch.py', held_cfg).done()
                held_handle = client.get_workflow_handle('openbot-work-v1-' + held_run)
                worker = launch('workflow_worker.py', held_cfg)
                held_state = await waiting(held_handle, held_task)
                worker.kill()
                if stage == 'publication-ack':
                    approve(held_state)
                    worker = launch('workflow_worker.py', held_cfg, 'after-publication')
                    worker.wait('after-publication'); worker.kill()
                    held_state = api.snapshot(held_task)
                    assert held_state['status'] == 'completed'
                held_upgrades.append({'stage': stage, 'cfg': held_cfg, 'state': held_state,
                    'effects': counts(held_task), 'engineRunId': (await held_handle.describe()).run_id})
        scenarios = () if only_handoff else (only_case,) if only_case else ('recover', 'cancel-before-write', 'cancel-unknown', 'corrupt-receipt', 'malformed-json', 'repair-timeout', 'automatic-repair-race', 'repair-cancelled', 'repair-engine-closed', 'publication-ack')
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
                await replay_without_effects(handle, task_id, 'approval')
            engine_snapshot = None
            if scenario == 'recover' and hasattr(server, 'backup'):
                await server.rotate_transport()
                engine_snapshot = server.backup(tmp / 'engine-backup')
                client = await server.connect()
                handle = client.get_workflow_handle('openbot-work-v1-' + run_id)
            if scenario == 'cancel-before-write' and hasattr(server, 'crash_restart'):
                server.crash_restart()
                client = await server.connect()
                handle = client.get_workflow_handle('openbot-work-v1-' + run_id)
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
                timeout_case = scenario == 'repair-timeout'
                if not timeout_case:
                    effects.drop_write_response(task_id)
                approve(snap)
                barrier = 'after-effect-response' if timeout_case else 'unknown'
                second = launch('workflow_worker.py', cfg, barrier)
                second.wait(barrier)
                unknown = api.snapshot(task_id)
                if not timeout_case:
                    assert unknown['attention'] == 'reconciliation'
                assert unknown['usage'] == {'tokenLimit': 20, 'reservedTokens': 2, 'spentTokens': 6}
                assert counts(task_id) == {'attempts': 4, 'writes': 1, 'lookups': 0}
                second.kill()
                if timeout_case:
                    # Four real start-to-close expiries, with only the first attempt
                    # admitted. The other retries die before inspecting/POSTing.
                    for _ in range(3):
                        retry = launch('workflow_worker.py', cfg, 'before-write-inspection')
                        retry.wait('before-write-inspection'); retry.kill()
                if scenario == 'automatic-repair-race':
                    row = next(a for a in unknown['actions'] if a['status']=='unknown')
                    command = api.call('/api/v1/actions/'+row['id']+'/reconcile', {
                        'intentDigest':row['intentDigest'], 'requestKey':secrets.token_hex(12),
                        'expectedSequence':0, 'reason':'Owner request racing the automatic receipt lookup'}, expected=202)
                if scenario == 'cancel-unknown':
                    cancelled = api.cancel(task_id)
                    assert cancelled['status'] == 'open' and cancelled['attention'] == 'reconciliation'
                if scenario in ('corrupt-receipt', 'malformed-json', 'repair-cancelled', 'repair-engine-closed'):
                    effects.corrupt_receipt(task_id, malformed_json=scenario=='malformed-json')
                if scenario == 'recover' and hasattr(server, 'upgrade'):
                    engine_run_id = (await handle.describe()).run_id
                    await server.upgrade()
                    client = await server.connect()
                    handle = client.get_workflow_handle('openbot-work-v1-' + run_id)
                    assert (await handle.describe()).run_id == engine_run_id
                    assert api.snapshot(task_id) == unknown
                    await replay_without_effects(handle, task_id, 'unknown-after-server-upgrade')
                    for held in held_upgrades:
                        held_handle = client.get_workflow_handle('openbot-work-v1-' + held['cfg']['run_id'])
                        assert (await held_handle.describe()).run_id == held['engineRunId']
                        assert api.snapshot(held['cfg']['task_id']) == held['state']
                        assert counts(held['cfg']['task_id']) == held['effects']
                    await resume_upgrade_tasks(client, 'original-volume')
                if engine_snapshot is not None:
                    # Restore older engine history only. The newer product unknown-write fact
                    # and independent external receipt must prevent a second POST.
                    server.restore(engine_snapshot)
                    client = await server.connect()
                    handle = client.get_workflow_handle('openbot-work-v1-' + run_id)
                    assert api.snapshot(task_id) == unknown
                    if hasattr(server, 'upgrade'):
                        description = await handle.describe()
                        assert description.run_id == engine_run_id
                        assert description.status == WorkflowExecutionStatus.RUNNING
                if scenario == 'recover' and held_upgrades:
                    await resume_upgrade_tasks(client, 'restored')
                    held_upgrades.clear()
                if scenario == 'recover':
                    effects.close(); effects = EffectService(tmp / 'effects')
                    assert counts(task_id)['writes'] == 1
                third = launch('workflow_worker.py', cfg)
                if scenario in ('corrupt-receipt', 'malformed-json', 'repair-timeout', 'repair-cancelled', 'repair-engine-closed'):
                    deadline = time.monotonic() + 35
                    while True:
                        try:
                            waiting_repair = await asyncio.wait_for(handle.query('reconciliation_query'), 5)
                        except asyncio.TimeoutError:
                            # A query can wait behind the activity retry. Keep the bounded
                            # acceptance deadline and report product/engine facts on expiry.
                            waiting_repair = False
                        visible = api.snapshot(task_id)
                        if waiting_repair and any(a['status']=='unknown' for a in visible['actions']):break
                        if time.monotonic() >= deadline:
                            description = await asyncio.wait_for(handle.describe(), 5)
                            raise AssertionError(f'Repair wait not observed: engine={description.status}, '
                                                 f'product={visible["attention"]}, '
                                                 f'actions={[a["status"] for a in visible["actions"]]}')
                        await asyncio.sleep(.05)
                    assert (await handle.describe()).status == WorkflowExecutionStatus.RUNNING
                    unresolved = api.snapshot(task_id)
                    assert unresolved['attention'] == 'reconciliation' and unresolved['status'] == 'open'
                    assert unresolved['usage'] == unknown['usage'] and not unresolved['artifacts']
                    assert counts(task_id)['attempts'] == 4
                    await replay_without_effects(handle, task_id, 'reconciliation-wait')
                    third.kill()
                    row = next(a for a in unresolved['actions'] if a['status'] == 'unknown')
                    path = '/api/v1/actions/' + row['id'] + '/reconcile'
                    body = {'intentDigest': row['intentDigest'], 'requestKey': secrets.token_hex(12),
                            'expectedSequence': 0, 'reason': 'Repair the synthetic connector and verify its original receipt'}
                    api.call(path, {**body, 'applied': False, 'actualTokens': 0}, expected=422)
                    assert api.snapshot(task_id) == unresolved
                    command = api.call(path, body, expected=202)
                    assert api.call(path, body, expected=202) == command
                    alias = {**body, 'requestKey': secrets.token_hex(12)}
                    assert api.call(path, alias, expected=202) == command
                    pending = api.snapshot(task_id)
                    assert pending['usage'] == unknown['usage'] and counts(task_id)['attempts'] == 4
                    api.close(); api.start()
                    assert api.snapshot(task_id) == pending
                    repair_cfg = {**cfg, 'action_id': row['id'], 'command_id': command['id']}
                    if scenario == 'repair-engine-closed':
                        await handle.terminate('Owned test of explicit closed-engine repair refusal')
                        sender=launch('deliver_repair.py',repair_cfg,'after-repair-delivery')
                        sender.wait('after-repair-delivery');sender.kill()
                        assert api.snapshot(task_id)==pending
                        launch('deliver_repair.py', repair_cfg).done()
                        repair_handle=client.get_workflow_handle('openbot-repair-v1-'+command['id'])
                        repair_worker=launch('workflow_worker.py',cfg)
                        first_repair=await asyncio.wait_for(repair_handle.result(),35)
                        assert first_repair=={'commandId':command['id'],'outcome':'unresolved'}
                        failed=api.snapshot(task_id)
                        latest=next(a for a in failed['actions'] if a['id']==row['id'])['reconciliation']
                        assert latest['outcome']=='unresolved' and failed['attention']=='reconciliation'
                        assert failed['usage']==unknown['usage'] and not failed['artifacts']
                        assert counts(task_id)['attempts']==4 and counts(task_id)['writes']==1
                        repair_worker.kill()
                        effects.repair_receipt(task_id)
                        body={**body,'requestKey':secrets.token_hex(12),'expectedSequence':1}
                        command=api.call(path,body,expected=202)
                        repair_cfg={**repair_cfg,'command_id':command['id']}
                        launch('deliver_repair.py',repair_cfg).done()
                        repair_handle=client.get_workflow_handle('openbot-repair-v1-'+command['id'])
                        repair_worker=launch('workflow_worker.py',cfg)
                        second_repair=await asyncio.wait_for(repair_handle.result(),35)
                        assert second_repair=={'commandId':command['id'],'outcome':'applied'}
                        final=api.snapshot(task_id)
                        latest=next(a for a in final['actions'] if a['id']==row['id'])['reconciliation']
                        assert latest['outcome']=='resolved' and final['status']=='open'
                        assert final['usage']=={'tokenLimit':20,'reservedTokens':0,'spentTokens':8}
                        assert not final['artifacts'] and counts(task_id)['attempts']==4
                        assert counts(task_id)['writes']==1
                        repair_worker.kill()
                    else:
                        # Crash after engine acceptance but before the product delivery receipt.
                        sender = launch('deliver_repair.py', repair_cfg, 'after-repair-delivery')
                        sender.wait('after-repair-delivery'); sender.kill()
                        assert api.snapshot(task_id) == pending
                        launch('deliver_repair.py', repair_cfg).done()
                        # A stored delivery acknowledgement is not a workflow checkpoint.
                        # Resending an unfinished command must signal again.
                        launch('deliver_repair.py', repair_cfg).done()
                        if scenario in ('corrupt-receipt', 'malformed-json'):
                            # First Owner-triggered cycle still sees bad data. It must finish
                            # unresolved and await a NEW explicit cycle, without replaying POST.
                            third = launch('workflow_worker.py', cfg)
                            deadline = time.monotonic() + 35
                            while True:
                                still = api.snapshot(task_id)
                                latest = next(a for a in still['actions'] if a['id'] == row['id'])['reconciliation']
                                if latest['outcome'] == 'unresolved':break
                                assert time.monotonic() < deadline
                                await asyncio.sleep(.05)
                            assert still['usage'] == unknown['usage'] and counts(task_id)['attempts'] == 4
                            assert (await handle.describe()).status == WorkflowExecutionStatus.RUNNING
                            assert api.call(path, body, expected=202) == latest
                            api.call(path, {**body, 'requestKey': secrets.token_hex(12)}, expected=409)
                            third.kill()
                            record = {'case':scenario,'status':still['status'],'usage':still['usage'],**counts(task_id)}
                            records.append(record);print(json.dumps(record),flush=True)
                            body = {**body, 'requestKey': secrets.token_hex(12), 'expectedSequence': 1}
                            command = api.call(path, body, expected=202)
                            repair_cfg = {**repair_cfg, 'command_id': command['id']}
                            effects.repair_receipt(task_id)
                            repair_snapshot = server.backup(tmp / ('repair-backup-'+scenario)) if hasattr(server,'backup') else None
                            if repair_snapshot is not None:
                                client = await server.connect()
                                handle = client.get_workflow_handle('openbot-work-v1-'+run_id)
                            launch('deliver_repair.py', repair_cfg).done()
                            if repair_snapshot is not None:
                                delivered = api.snapshot(task_id)
                                assert next(a for a in delivered['actions'] if a['id']==row['id'])['reconciliation']['delivered']
                                server.restore(repair_snapshot)
                                client = await server.connect()
                                handle = client.get_workflow_handle('openbot-work-v1-'+run_id)
                                assert api.snapshot(task_id)==delivered
                                launch('deliver_repair.py', repair_cfg).done()
                            third = launch('workflow_worker.py', cfg, 'after-repair-resolution')
                            third.wait('after-repair-resolution');third.kill()
                            settled = api.snapshot(task_id)
                            assert settled['usage'] == {'tokenLimit':20,'reservedTokens':0,'spentTokens':8}
                            assert counts(task_id)['attempts'] == 4
                        elif scenario == 'repair-cancelled':
                            api.cancel(task_id)
                            effects.repair_receipt(task_id)
                        third = launch('workflow_worker.py', cfg)
                        result = await asyncio.wait_for(handle.result(), 35)
                        final = api.snapshot(task_id)
                        latest = next(a for a in final['actions'] if a['id'] == row['id'])['reconciliation']
                        assert latest['outcome'] == 'resolved'
                        assert api.call(path, body, expected=202) == latest
                        assert counts(task_id)['writes'] == 1
                        assert len([e for e in final['events'] if e['kind']=='action.resolved' and e['payload']['actionId']==row['id']]) == 1
                        if scenario == 'repair-cancelled':
                            assert final['status']=='cancelled' and not final['authorityActive'] and not final['artifacts']
                            assert final['usage']=={'tokenLimit':20,'reservedTokens':0,'spentTokens':8}
                            assert counts(task_id)['attempts']==4 and result['outcome']=='stopped'
                        else:
                            assert final['status']=='completed' and result['status']=='completed'
                            assert final['usage']=={'tokenLimit':20,'reservedTokens':0,'spentTokens':11}
                            assert counts(task_id)['attempts']==5 and len(final['artifacts'])==1
                            assert api.call(final['artifacts'][0]['downloadUrl'],raw=True)==b'row,value\n7,fixed\n'
                            assert len([e for e in final['events'] if e['kind']=='task.completed'])==1
                            scenario=scenario+'-repaired'
                        await replay_without_effects(handle,task_id,scenario+'-finished')
                else:
                    result = await asyncio.wait_for(handle.result(), 35)
                    final = api.snapshot(task_id)
                    if scenario == 'automatic-repair-race':
                        settled = next(a for a in final['actions'] if a['id']==row['id'])['reconciliation']
                        assert settled['id']==command['id'] and settled['outcome']=='resolved' and not settled['delivered']
                        assert len([e for e in final['events'] if e['kind']=='reconciliation.finished'])==1
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
            if scenario == 'recover':
                await replay_without_effects(handle, task_id, 'completed')
            record = {'case': scenario, 'status': final['status'], 'usage': final['usage'], **counts(task_id)}
            records.append(record)
            print(json.dumps(record), flush=True)
        if only_case:
            return records
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
    parser.add_argument('--temporal-cli', type=Path)
    parser.add_argument('--engine', choices=('development', 'postgres', 'postgres-mtls'), default='development')
    parser.add_argument('--upgrade-archive', type=Path, help='Verified official 1.31.3 archive; requires postgres-mtls')
    parser.add_argument('--only-handoff', action='store_true', help='Run only engine-identity rejection regressions')
    parser.add_argument('--only-case', choices=('recover','cancel-before-write','cancel-unknown','corrupt-receipt','malformed-json','repair-timeout','automatic-repair-race','repair-cancelled','repair-engine-closed','publication-ack'), help='Run one public-work scenario')
    args = parser.parse_args()
    assert sys.platform != 'win32', 'POSIX process signals required'
    assert importlib.metadata.version('temporalio') == '1.33.0'
    assert importlib.metadata.version('pydantic-ai-slim') == '2.47.0'
    if args.upgrade_archive and (args.engine != 'postgres-mtls' or args.only_handoff):
        parser.error('--upgrade-archive requires the full postgres-mtls journey')
    if args.only_case and (args.only_handoff or args.upgrade_archive):
        parser.error('--only-case cannot be combined with --only-handoff or --upgrade-archive')
    binary = None
    if args.engine == 'development':
        if args.temporal_cli is None:
            parser.error('--temporal-cli is required for development')
        binary = args.temporal_cli.resolve(strict=True)
        version = subprocess.run([str(binary), '--version'], env=CLEAN_ENV, check=True,
            capture_output=True, text=True, timeout=10).stdout.strip()
        assert version == 'temporal version 1.9.1 (Server 1.32.0, UI 2.54.1)', version
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    with TemporaryDirectory(prefix='openbot-work-journey-') as directory, database() as dsn:
        tmp = Path(directory)
        if args.upgrade_archive:
            from upgrade_server import UpgradeServer
            server = UpgradeServer(tmp, args.upgrade_archive)
        elif args.engine in ('postgres', 'postgres-mtls'):
            from postgres_server import PostgresServer
            server = PostgresServer(tmp, mtls=args.engine == 'postgres-mtls')
        else:
            server = Server(binary, tmp)
        try:
            server.start()
            async def run_qualification():
                if hasattr(server, 'before_qualification'):
                    await server.before_qualification()
                return await qualify(tmp, dsn, server, only_handoff=args.only_handoff, only_case=args.only_case)
            records = asyncio.run(run_qualification())
            if hasattr(server, 'finish_checks'):
                server.finish_checks()
            print(json.dumps({'passed': len(records), 'scope': 'public HTTP + PG + SDK + fake effects', 'engine': args.engine}))
        finally:
            server.close()


if __name__ == '__main__':
    main()
