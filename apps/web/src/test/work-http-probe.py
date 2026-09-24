"""Owned S2 HTTP fixture; run with the locked Python control environment after building Web/DB."""
import argparse
import contextlib
import http.cookiejar
import json
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[4]
IMAGE = 'postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serve', action='store_true', help='Keep the disposable fixture for browser checks until Ctrl+C')
    args = parser.parse_args()
    import fastapi, psycopg, uvicorn  # Verify the caller supplied the existing control environment.
    assert (fastapi.__version__, psycopg.__version__, uvicorn.__version__) == ('0.141.1', '3.3.6', '0.53.0')
    assert (ROOT / 'apps/web/dist/index.html').is_file(), 'Build @openbot/web first'
    name = 'openbot-s2-' + secrets.token_hex(6)
    password = secrets.token_hex(24)
    owner_password = secrets.token_hex(24)
    service = None
    owned = False
    def run(*command):
        return subprocess.check_output(command, cwd=ROOT, text=True, stderr=subprocess.PIPE, timeout=120).strip()
    with tempfile.TemporaryDirectory(prefix='openbot-s2-') as temporary:
        temporary = Path(temporary)
        try:
            run('docker', 'create', '--name', name, '--publish', '127.0.0.1::5432',
                '--env', 'POSTGRES_USER=openbot_test', '--env', 'POSTGRES_PASSWORD=' + password,
                '--env', 'POSTGRES_DB=openbot_probe', '--tmpfs', '/var/lib/postgresql/data', IMAGE,
                '-c', 'client_min_messages=warning')
            owned = True
            run('docker', 'start', name)
            binding = run('docker', 'port', name, '5432/tcp')
            assert binding.startswith('127.0.0.1:') and binding.count(':') == 1
            dsn = f'postgres://openbot_test:{password}@{binding}/openbot_probe'
            for _ in range(80):
                try:
                    with psycopg.connect(dsn, connect_timeout=1): pass
                    break
                except psycopg.OperationalError: time.sleep(0.25)
            else: raise AssertionError('Disposable PostgreSQL did not start')
            config = temporary / 'config.json'; config.write_text(json.dumps({'dsn': dsn}))
            run('node', str(ROOT / 'experiments/work-journey/migrate.mjs'), str(config))
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
            origin = f'http://127.0.0.1:{port}'
            server = temporary / 'server.py'
            server.write_text(f'''
import sys
sys.path.insert(0, {str(ROOT / 'apps/server-python/src')!r})
import uvicorn
from fastapi.staticfiles import StaticFiles
from openbot_server.app import create_app
from openbot_server.database import PostgresReadStore
from openbot_server.auth import OwnerAuthentication
from openbot_server.auth_store import PostgresAuthStore
from openbot_server.identity_store import PostgresIdentityStore
from openbot_server.work_store import PostgresWorkStore
dsn = {dsn!r}
app = create_app(PostgresReadStore(dsn), owner_name='S2 Test Owner', secure_cookies=False,
    allowed_origins=({origin!r},), identity=PostgresIdentityStore(dsn), work=PostgresWorkStore(dsn),
    auth=OwnerAuthentication(PostgresAuthStore(dsn), owner_name='S2 Test Owner', password={owner_password!r}, ttl_hours=1))
app.mount('/', StaticFiles(directory={str(ROOT / 'apps/web/dist')!r}, html=True), name='web')
uvicorn.run(app, host='127.0.0.1', port={port}, proxy_headers=False, access_log=False)
''')
            jar = http.cookiejar.CookieJar()
            client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
            def request(path, body=None, *, trusted=True, authenticated=True):
                headers = {'Origin': origin if trusted else 'https://untrusted.example'}
                if body is not None: headers['Content-Type'] = 'application/json'
                req = urllib.request.Request(origin + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
                try:
                    with (client.open(req, timeout=10) if authenticated else urllib.request.urlopen(req, timeout=10)) as response:
                        return response.status, json.load(response) if response.status != 204 else None
                except urllib.error.HTTPError as error:
                    return error.code, json.load(error)
            with (temporary / 'server.log').open('w') as log:
                service = subprocess.Popen([sys.executable, str(server)], stdout=log, stderr=log)
                for _ in range(80):
                    if service.poll() is not None: raise AssertionError('Fixture Server startup failed')
                    try:
                        assert request('/health')[0] == 200
                        break
                    except urllib.error.URLError: time.sleep(0.25)
                else: raise AssertionError('Fixture Server not ready')
                assert request('/api/v1/tasks/absent', authenticated=False)[0] == 401
                assert request('/api/v1/auth/login', {'password': owner_password})[0] == 200
                status, bot = request('/api/v1/bots', {'name': 'S2 Reviewer', 'role': 'Synthetic test', 'computerProfile': 'none'})
                assert status == 201
                body = {'botId': bot['bot']['id'], 'objective': 'S2 real HTTP acceptance', 'tokenLimit': 1000, 'requestKey': 's2-exact-retry'}
                assert request('/api/v1/tasks', body, trusted=False)[0] == 403
                assert request('/api/v1/tasks', {**body, 'authorityActive': True})[0] == 422
                status, task = request('/api/v1/tasks', body)
                assert status == 202 and task['status'] == 'queued' and task['revision'] == 1
                assert request('/api/v1/tasks', body) == (202, task)
                assert request('/api/v1/tasks', {**body, 'objective': 'different'})[0] == 409
                path = '/api/v1/tasks/' + task['id']
                assert request(path, authenticated=False)[0] == 401
                assert request(path + '/cancel', {}, trusted=False)[0] == 403
                assert request(path)[1]['status'] == 'queued'
                assert request(path + '/cancel', {})[0] == 200
                status, closed = request(path)
                assert status == 200 and closed['cancelRequested'] and closed['status'] == 'cancelled' and not closed['authorityActive']
                assert request(path + '/cancel', {})[1] == closed
                schema = request('/openapi.json')[1]
                assert schema['paths']['/api/v1/tasks']['post']['operationId'] == 'createWorkTask'
                assert schema['paths']['/api/v1/tasks/{task_id}']['get']['security'] == [{'OwnerSession': []}]
                assert request('/api/v1/auth/logout', {})[0] == 204
                assert request(path)[0] == 401
                print('PASS: real HTTP/PG login, Bot, create/read/cancel, exact retry, 401/403/409/422, OpenAPI, logout', flush=True)
                if args.serve:
                    print(f'Browser: {origin}/#/tasks\nDisposable Owner password: {owner_password}', flush=True)
                    print('Ctrl+C removes this fixture and all of its synthetic data.', flush=True)
                    signal.pause()
        except KeyboardInterrupt:
            pass
        finally:
            if service is not None:
                service.terminate()
                try: service.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    service.kill(); service.wait(timeout=5)
            if owned:
                with contextlib.suppress(subprocess.SubprocessError): run('docker', 'rm', '--force', name)


if __name__ == '__main__': main()
