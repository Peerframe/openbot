"""Owned lifecycle fixture for the real PostgreSQL/Server Compose profile, not a dispatcher."""
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import time

from google.protobuf.duration_pb2 import Duration
from temporalio.api.workflowservice.v1 import DescribeNamespaceRequest, RegisterNamespaceRequest
from temporalio.client import Client
from temporalio.service import RPCError, RPCStatusCode, TLSConfig
from engine_client import connect as connect_engine, tls_config

ROOT = Path(__file__).resolve().parents[2]
PROFILE = ROOT / 'deploy/temporal/compose.yaml'
ENV = {key: os.environ[key] for key in ('PATH', 'HOME', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG') if key in os.environ}
DATABASES = ('temporal', 'temporal_visibility')
_spec = importlib.util.spec_from_file_location('temporal_maintenance', ROOT / 'deploy/temporal/maintain.py')
maintenance = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(maintenance)


class PostgresServer:
    def __init__(self, directory, *, mtls=False):
        self.directory = Path(directory)
        self.base = 'openbot-temporal-qualification-' + secrets.token_hex(6)
        self.project = self.base
        self.projects = [self.project]
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); self.port = sock.getsockname()[1]
        self.address = f'127.0.0.1:{self.port}'
        self.schema_password, self.runtime_password = secrets.token_hex(24), secrets.token_hex(24)
        self.env_file = self.directory / 'engine.env'
        self.env_file.write_text(f'OPENBOT_TEMPORAL_SCHEMA_PASSWORD={self.schema_password}\n'
            f'OPENBOT_TEMPORAL_RUNTIME_PASSWORD={self.runtime_password}\nOPENBOT_TEMPORAL_PORT={self.port}\n')
        self.env_file.chmod(0o600)
        self.certificates = None
        self.client_settings = None
        if mtls:
            from tls_fixture import CertificateFixture
            self.certificates = CertificateFixture(self.directory / 'pki')
            self.client_settings = self.certificates.settings()
            with self.env_file.open('a') as stream:
                stream.write('OPENBOT_TEMPORAL_TLS_DIRECTORY=' + str(self.certificates.engine) + '\n')
        maintenance.read_environment(self.env_file)
        self.namespace_id = None
        self.evidence = []

    def command(self, *args, input=None, check=True, timeout=60):
        assert self.project in self.projects and self.project.startswith('openbot-temporal-qualification-')
        files = ['--file', str(PROFILE)]
        if self.certificates is not None:
            files += ['--file', str(PROFILE.with_name('compose.mtls.yaml'))]
        if getattr(self, 'release_overlay', None) is not None:
            files += ['--file', str(self.release_overlay)]
        result = subprocess.run(['docker', 'compose', '--env-file', str(self.env_file),
            '--project-name', self.project, *files, *args], env=ENV,
            input=input, capture_output=True, timeout=timeout)
        if check and result.returncode:
            diagnostic = (result.stdout + result.stderr).decode(errors='replace')[-4500:]
            for secret in (self.schema_password, self.runtime_password):
                diagnostic = diagnostic.replace(secret, '[owned credential]')
            raise AssertionError('Owned Compose operation failed: ' + diagnostic)
        return result

    def sql(self, database, statement, *, runtime=False, check=True):
        assert database in (*DATABASES, 'postgres')
        if runtime:
            command = ['sh', '-c', 'PGPASSWORD="$OPENBOT_TEMPORAL_RUNTIME_PASSWORD" exec psql -h 127.0.0.1 -U temporal_runtime -v ON_ERROR_STOP=1 -At -d "$1"', 'owned-runtime-query', database]
        else:
            command = ['psql', '-U', 'temporal_schema', '-v', 'ON_ERROR_STOP=1', '-At', '-d', database]
        return self.command('exec', '-T', 'postgresql', *command, input=statement.encode(), check=check)

    def versions(self):
        return {db: self.sql(db, 'SELECT curr_version FROM schema_version;').stdout.decode().strip() for db in DATABASES}

    def stopped_schema_failure(self):
        self.command('up', '-d', 'temporal')
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            identity = self.command('ps', '--all', '-q', 'temporal').stdout.decode().strip()
            state = json.loads(subprocess.run(['docker', 'inspect', identity, '--format', '{{json .State}}'],
                env=ENV, check=True, capture_output=True).stdout)
            if state['Status'] == 'exited':
                assert state['ExitCode'] != 0
                logs = self.command('logs', '--no-color', 'temporal').stdout.decode(errors='replace')
                assert 'sql schema version compatibility check failed' in logs.lower(), logs[-3000:]
                self.command('rm', '-f', 'temporal')
                return
            time.sleep(.1)
        raise AssertionError('Server did not reject the missing/incompatible schema')

    def start(self):
        self.command('config', '--quiet')
        self.command('up', '-d', '--wait', '--wait-timeout', '40', 'postgresql')
        self.stopped_schema_failure()
        maintenance.maintain('initialize', self.command, self.sql)
        try:
            maintenance.maintain('initialize', self.command, self.sql)
        except ValueError as error:
            assert 'empty' in str(error)
        else:
            raise AssertionError('Initialization accepted existing databases')
        versions = self.versions()
        # An ordinary runtime has data privileges, not schema/cluster administration.
        flags = self.sql('temporal', "SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user; SELECT has_schema_privilege(current_user,'public','CREATE');", runtime=True).stdout.decode().splitlines()
        assert flags == ['f|f|f', 'f'], flags
        denied = self.sql('temporal', 'CREATE TABLE forbidden_reference(id integer);', runtime=True, check=False)
        assert denied.returncode != 0 and b'permission denied' in denied.stderr
        for db in DATABASES:
            for table in ('schema_version', 'schema_update_history'):
                denied = self.sql(db, f'DELETE FROM {table} WHERE false;', runtime=True, check=False)
                assert denied.returncode != 0 and b'permission denied' in denied.stderr
        maintenance.maintain('upgrade', self.command, self.sql)
        assert self.versions() == versions
        self.evidence.append({'case': 'schema-and-role-boundary', 'versions': versions,
            'absentSchemaRejected': True, 'runtimeDDLRejected': True, 'runtimeSchemaWritesRejected': True, 'initializeExistingRejected': True, 'sameVersionUpgrade': 'unchanged'})
        self.command('up', '-d', 'temporal')

    async def connect(self):
        deadline = time.monotonic() + 45
        last = None
        while time.monotonic() < deadline:
            try:
                client = await asyncio.wait_for(connect_engine(self.address, self.client_settings), 2)
                if not await asyncio.wait_for(client.service_client.check_health(), 2):
                    continue
                try:
                    namespace = await asyncio.wait_for(client.workflow_service.describe_namespace(
                        DescribeNamespaceRequest(namespace='default')), 3)
                except RPCError as error:
                    if error.status != RPCStatusCode.NOT_FOUND or self.namespace_id is not None:
                        raise
                    await asyncio.wait_for(client.workflow_service.register_namespace(RegisterNamespaceRequest(
                        namespace='default', workflow_execution_retention_period=Duration(seconds=604800))), 5)
                    namespace = await asyncio.wait_for(client.workflow_service.describe_namespace(
                        DescribeNamespaceRequest(namespace='default')), 3)
                if self.namespace_id is None:
                    self.namespace_id = namespace.namespace_info.id
                assert namespace.namespace_info.id == self.namespace_id, 'Restore changed namespace identity'
                return client
            except (Exception, asyncio.TimeoutError) as error:
                last = type(error).__name__
                await asyncio.sleep(.1)
        logs = self.command('logs', '--no-color', '--tail', '40', 'temporal', check=False).stdout.decode(errors='replace')
        raise AssertionError(f'PostgreSQL Temporal not healthy ({last}): {logs[-3500:]}')

    async def rejected_client(self, name, tls):
        good = await connect_engine(self.address, self.client_settings)
        assert await asyncio.wait_for(good.service_client.check_health(), 3)
        try:
            bad = await asyncio.wait_for(Client.connect(self.address, tls=tls), 5)
            assert await asyncio.wait_for(bad.service_client.check_health(), 3)
        except (RuntimeError, RPCError) as error:
            # Healthy authenticated access on both sides excludes a server outage as evidence.
            assert await asyncio.wait_for(good.service_client.check_health(), 3)
            self.evidence.append({'case': 'mtls-reject-' + name, 'failure': type(error).__name__})
        else:
            raise AssertionError('Unauthorized transport reached the engine: ' + name)

    async def qualify_transport(self):
        if self.certificates is None:
            return
        valid = tls_config(self.client_settings)
        await self.rejected_client('plaintext', False)
        await self.rejected_client('missing-certificate', TLSConfig(
            server_root_ca_cert=valid.server_root_ca_cert, domain=valid.domain))
        await self.rejected_client('unknown-client-ca', tls_config(self.certificates.settings('unknown-client')))
        await self.rejected_client('wrong-server-name', TLSConfig(server_root_ca_cert=valid.server_root_ca_cert,
            client_cert=valid.client_cert, client_private_key=valid.client_private_key, domain='wrong.invalid'))
        self.evidence.append({'case': 'mtls-valid-client', 'issuerTool': self.certificates.version,
            'serverNameVerified': True, 'namespaceIdentity': 'retained'})

    async def rotate_transport(self):
        if self.certificates is None:
            return
        previous = tls_config(self.client_settings)
        self.command('stop', 'temporal')
        self.certificates.rotate_client_ca()
        self.client_settings = self.certificates.settings('replacement-client')
        self.command('up', '-d', 'temporal')
        await self.connect()
        await self.rejected_client('retired-client-ca', previous)
        self.evidence.append({'case': 'mtls-stop-rotate-reconnect', 'namespacePreserved': True})

    def backup(self, destination, *, restart_engine=True):
        """Cold engine-only snapshot; the caller has already stopped its owned workers."""
        self.command('stop', 'temporal')
        destination.mkdir(mode=0o700)
        manifest = {'schema': self.versions(), 'namespaceId': self.namespace_id, 'databases': {}}
        for db in DATABASES:
            result = self.command('exec', '-T', 'postgresql', 'pg_dump', '-U', 'temporal_schema',
                '--format=custom', '--no-owner', '--no-privileges', db)
            assert result.stdout[:5] == b'PGDMP' and len(result.stdout) <= 64 * 1024 * 1024
            path = destination / (db + '.dump'); path.write_bytes(result.stdout); path.chmod(0o600)
            manifest['databases'][db] = {'sha256': hashlib.sha256(result.stdout).hexdigest(), 'size': len(result.stdout)}
        (destination / 'manifest.json').write_text(json.dumps(manifest))
        if restart_engine:
            self.command('up', '-d', 'temporal')
        self.evidence.append({'case': 'cold-engine-backup', 'schema': manifest['schema'],
            'bytes': {key: value['size'] for key, value in manifest['databases'].items()}})
        return destination

    def restore(self, snapshot, *, start_engine=True):
        """Restore to a new named volume; never overwrite a preexisting database."""
        self.command('stop', 'temporal')
        manifest = json.loads((snapshot / 'manifest.json').read_text())
        assert manifest['namespaceId'] == self.namespace_id
        self.project = self.base + '-restore-' + str(len(self.projects))
        self.projects.append(self.project)
        assert not self.command('ps', '--all', '-q').stdout.strip()
        self.command('up', '-d', '--wait', '--wait-timeout', '40', 'postgresql')
        for db in DATABASES:
            empty = self.sql(db, "SELECT count(*) FROM pg_tables WHERE schemaname='public';").stdout.strip()
            assert empty == b'0', 'Restore target must be empty'
            data = (snapshot / (db + '.dump')).read_bytes()
            assert len(data) == manifest['databases'][db]['size']
            assert hashlib.sha256(data).hexdigest() == manifest['databases'][db]['sha256']
            self.command('exec', '-T', 'postgresql', 'pg_restore', '-U', 'temporal_schema',
                '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', '-d', db, input=data)
        assert self.versions() == manifest['schema']
        maintenance.seal_metadata(self.sql)
        if start_engine:
            self.command('up', '-d', 'temporal')
        self.evidence.append({'case': 'restore-new-engine-volume', 'schema': manifest['schema'], 'namespacePreserved': True})

    def crash_restart(self):
        start = time.monotonic()
        self.command('kill', '-s', 'SIGKILL', 'temporal', 'postgresql')
        self.command('up', '-d', '--wait', '--wait-timeout', '40', 'postgresql')
        self.command('up', '-d', 'temporal')
        self.evidence.append({'case': 'server-and-database-sigkill', 'containerStartSeconds': round(time.monotonic()-start, 2)})

    def finish_checks(self):
        self.command('stop', 'temporal')
        try:
            maintenance.maintain('upgrade', self.command, self.sql)
        except ValueError:
            raise AssertionError('Stopped engine maintenance unexpectedly refused')
        version = self.versions()['temporal']
        self.sql('temporal', "UPDATE schema_version SET curr_version='999.0';")
        try:
            maintenance.maintain('upgrade', self.command, self.sql)
        except ValueError as error:
            assert 'newer' in str(error)
        else:
            raise AssertionError('Newer schema accepted by pinned operator')
        assert self.versions()['temporal'] == '999.0'
        self.sql('temporal', "UPDATE schema_version SET curr_version='0.0';")
        self.stopped_schema_failure()
        # Version is from the owned upstream schema table, never an external identifier.
        assert all(c in '0123456789.' for c in version)
        self.sql('temporal', "UPDATE schema_version SET curr_version='" + version + "';")
        self.evidence.append({'case': 'incompatible-schema-rejected', 'newerRejectedByOperator': True, 'tooOldRejectedByServer': True, 'restoredVersion': version})
        for record in self.evidence:
            print(json.dumps(record), flush=True)

    def close(self):
        errors = []
        for project in reversed(self.projects):
            self.project = project
            try:
                result = self.command('down', '--volumes', '--remove-orphans', check=False)
                if result.returncode:
                    errors.append(project)
            except (OSError, subprocess.TimeoutExpired):
                # A failed cleanup must not prevent attempts for other owned restore projects.
                errors.append(project)
        if errors:
            raise RuntimeError('Could not clean owned Compose projects: ' + ','.join(errors))
