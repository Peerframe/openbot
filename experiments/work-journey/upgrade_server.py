"""Stopped adjacent-release acceptance on owned storage; never a production upgrader."""
import asyncio
import hashlib
import json
import subprocess
import time

from temporalio.api.workflowservice.v1 import GetSystemInfoRequest
from postgres_server import PostgresServer, ENV, DATABASES, maintenance
from release_archive import extract_release


class UpgradeServer(PostgresServer):
    def __init__(self, directory, archive):
        super().__init__(directory, mtls=True)
        architecture = subprocess.run(['docker', 'info', '--format', '{{.Architecture}}'],
                                     env=ENV, capture_output=True, check=True, timeout=15).stdout.decode().strip()
        try:
            self.arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'amd64', 'amd64': 'amd64'}[architecture]
        except KeyError:
            raise ValueError('Only the reviewed Linux amd64/arm64 binaries are supported') from None
        paths = extract_release(archive, self.arch, self.directory / 'release-1.31.3')
        self.release_overlay = self.directory / 'previous-release.json'
        services = {}
        for service, name in (('temporal', 'temporal-server'), ('schema', 'temporal-sql-tool')):
            services[service] = {'volumes': [{'type': 'bind', 'source': str(paths[name]),
                'target': '/usr/local/bin/' + name, 'read_only': True, 'bind': {'create_host_path': False}}]}
        self.release_overlay.write_text(json.dumps({'services': services}))
        self.release_overlay.chmod(0o600)
        self.upgraded = False

    async def version(self, expected):
        client = await self.connect()
        info = await asyncio.wait_for(client.workflow_service.get_system_info(GetSystemInfoRequest()), 5)
        assert info.server_version == expected, (info.server_version, expected)
        return client

    def schema_records(self):
        return {db: self.sql(db, 'SELECT row_to_json(s)::text FROM schema_update_history s ORDER BY year,month,update_time;').stdout
                for db in DATABASES}

    def shard_ids(self):
        return self.sql('temporal', 'SELECT shard_id FROM shards ORDER BY shard_id;').stdout.decode().splitlines()

    async def before_qualification(self):
        client = await self.version('1.31.3')
        sql_version = self.command('run', '--rm', '--no-deps', '--entrypoint',
                                   'temporal-sql-tool', 'schema', '--version').stdout.decode().strip()
        assert sql_version.endswith('1.31.3'), sql_version
        started = time.monotonic()
        next_report = 0
        # Official guidance allows ~10 minutes per release for History Shard metadata.
        while time.monotonic() - started < 600:
            assert await asyncio.wait_for(client.service_client.check_health(), 5)
            elapsed = time.monotonic() - started
            if elapsed >= next_report:
                print(json.dumps({'stage': 'previous-release-warmup', 'server': '1.31.3',
                                  'healthySeconds': round(elapsed), 'requiredSeconds': 600}), flush=True)
                next_report += 60
            await asyncio.sleep(min(10, max(.01, 600 - elapsed)))
        shards = self.shard_ids()
        assert shards == ['1', '2', '3', '4'], shards
        self.evidence.append({'case': 'previous-release-qualified', 'server': '1.31.3',
            'fixture': 'official binaries over pinned 1.32.0 images', 'architecture': self.arch,
            'healthySeconds': round(time.monotonic() - started), 'shardIds': shards})

    async def upgrade(self):
        if self.upgraded:
            raise ValueError('Adjacent release fixture upgrades once only')
        self.command('stop', 'temporal')
        versions, records, shards = self.versions(), self.schema_records(), self.shard_ids()
        assert shards == ['1', '2', '3', '4'], shards
        # Removing only the verified old binary mounts selects the pinned target images/tools.
        # A maintenance failure leaves the engine stopped; there is no restart in a finally block.
        self.release_overlay = None
        maintenance.maintain('upgrade', self.command, self.sql)
        assert self.versions() == versions and self.schema_records() == records
        for db in DATABASES:
            denied = self.sql(db, 'DELETE FROM schema_update_history WHERE false;', runtime=True, check=False)
            assert denied.returncode != 0 and b'permission denied' in denied.stderr
        self.command('up', '-d', 'temporal')
        await self.version('1.32.0')
        assert self.shard_ids() == shards
        self.upgraded = True
        self.evidence.append({'case': 'adjacent-release-upgrade', 'from': '1.31.3', 'to': '1.32.0',
            'namespacePreserved': True, 'schemaHistoryUnchanged': True, 'shardIds': shards,
            'schemaHistoryDigests': {db: hashlib.sha256(data).hexdigest() for db, data in records.items()}})
