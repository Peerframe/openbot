"""Own a pinned macOS Temporal/SQLite/mTLS process for native package smoke only."""
import argparse
import asyncio
from datetime import timedelta
import json
import os
from pathlib import Path
import platform
import signal
import socket
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine_client import connect
from release_archive import extract_release
from tls_fixture import CertificateFixture, SERVER_NAME
from temporalio.api.workflowservice.v1 import GetSystemInfoRequest, RegisterNamespaceRequest
from google.protobuf.duration_pb2 import Duration

ROOT = Path(__file__).resolve().parents[2]


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


async def stop(child):
    if child is not None and child.returncode is None:
        child.terminate()
        try:
            await asyncio.wait_for(child.wait(), 20)
        except TimeoutError:
            child.kill()
            await child.wait()


async def qualify(node, archive, mode, runtime):
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise ValueError('Only the reviewed macOS arm64 native package fixture is supported')
    with tempfile.TemporaryDirectory(prefix='openbot-native-engine-') as raw:
        directory = Path(raw).resolve()
        binary = extract_release(Path(archive), 'darwin-arm64-1.32.0', directory / 'release')['temporal-server']
        certs = CertificateFixture(directory / 'tls')
        ports = {name: (free_port(), free_port()) for name in ('frontend', 'history', 'matching', 'worker')}
        address = f"127.0.0.1:{ports['frontend'][0]}"
        leaf = {'requireClientAuth': True, 'certFile': str(certs.root / 'server.pem'),
                'keyFile': str(certs.root / 'server.key'), 'clientCaFiles': [str(certs.root / 'server-ca.pem')]}
        client_tls = {'serverName': SERVER_NAME, 'disableHostVerification': False,
                      'rootCaFiles': [str(certs.root / 'server-ca.pem')]}
        # Official Server SQLite setup is used only for platform/loading smoke. Full durability,
        # schema and upgrade gates continue to use the existing PostgreSQL/mTLS qualification.
        store = {'sql': {'pluginName': 'sqlite', 'databaseName': str(directory / 'engine.sqlite'),
                 'connectAddr': '127.0.0.1', 'connectProtocol': 'tcp',
                 'connectAttributes': {'setup': 'true', 'cache': 'private', 'journal_mode': 'wal', 'synchronous': '2'},
                 'maxConns': 1, 'maxIdleConns': 1, 'maxConnLifetime': '1h'}}
        dynamic = directory / 'dynamic.yaml'
        dynamic.write_text('{}')
        config = {'log': {'stdout': True, 'level': 'error'},
          'persistence': {'defaultStore': 'default', 'visibilityStore': 'visibility', 'numHistoryShards': 1,
                          'datastores': {'default': store, 'visibility': store}},
          'global': {'membership': {'maxJoinDuration': '30s', 'broadcastAddress': '127.0.0.1'},
                     'tls': {'internode': {'server': leaf, 'client': client_tls},
                             'frontend': {'server': {**leaf, 'clientCaFiles': [*leaf['clientCaFiles'], str(certs.root / 'client-ca.pem')]},
                                          'client': client_tls}}},
          'services': {name: {'rpc': {'grpcPort': ports[name][0], 'membershipPort': ports[name][1],
                                     'bindOnLocalHost': True}} for name in ports},
          'clusterMetadata': {'enableGlobalNamespace': False, 'failoverVersionIncrement': 10,
             'masterClusterName': 'active', 'currentClusterName': 'active',
             'clusterInformation': {'active': {'enabled': True, 'initialFailoverVersion': 1, 'rpcName': 'frontend', 'rpcAddress': address}}},
          'publicClient': {'hostPort': address}, 'dcRedirectionPolicy': {'policy': 'noop'},
          'dynamicConfigClient': {'filepath': str(dynamic), 'pollInterval': '10s'}}
        config_path = directory / 'server.yaml'
        config_path.write_text(json.dumps(config)); config_path.chmod(0o600)
        env = {key: os.environ[key] for key in ('PATH', 'HOME', 'TMPDIR') if key in os.environ}
        engine = child = None
        with (directory / 'engine.log').open('wb') as output:
            try:
                engine = await asyncio.create_subprocess_exec(str(binary), '--config-file', str(config_path),
                    '--allow-no-auth', 'start', cwd=directory, env=env, stdout=output, stderr=output)
                deadline = asyncio.get_running_loop().time() + 60
                client = None
                ready = False
                while asyncio.get_running_loop().time() < deadline:
                    if engine.returncode is not None:
                        output.flush()
                        diagnostic = (directory / 'engine.log').read_text()[-4000:]
                        raise RuntimeError('Owned native engine exited before readiness: ' + diagnostic)
                    try:
                        client = await asyncio.wait_for(connect(address, certs.settings()), 2)
                        info = await client.workflow_service.get_system_info(GetSystemInfoRequest(), timeout=timedelta(seconds=3))
                        if info.server_version != '1.32.0':
                            raise ValueError('Unexpected native engine version')
                        ready = True
                        break
                    except (RuntimeError, TimeoutError):
                        await asyncio.sleep(.2)
                if not ready:
                    raise RuntimeError('Owned native engine readiness timed out')
                # A real unauthenticated TLS/plaintext client must not pass this engine boundary.
                try:
                    bad = await asyncio.wait_for(connect(address), 2)
                    await asyncio.wait_for(bad.service_client.check_health(), 2)
                except (RuntimeError, TimeoutError):
                    pass
                else:
                    raise AssertionError('Native engine accepted unauthenticated access')
                await client.workflow_service.register_namespace(RegisterNamespaceRequest(namespace='default',
                    workflow_execution_retention_period=Duration(seconds=86400)), timeout=timedelta(seconds=5))
                receipt = directory / 'fixture.json'
                receipt.write_text(json.dumps({'address': address, 'tls': certs.settings()})); receipt.chmod(0o600)
                script = 'smoke-python-product.ts' if mode == 'smoke' else 'measure-ts-product.ts'
                child = await asyncio.create_subprocess_exec(node, str(ROOT / 'apps/desktop/scripts' / script), runtime,
                    cwd=ROOT, env={**env, 'OPENBOT_NATIVE_TEMPORAL_FIXTURE': str(receipt)})
                code = await asyncio.wait_for(child.wait(), 900)
                if code:
                    raise RuntimeError('Native P4 package qualification failed')
            finally:
                await stop(child)
                await stop(engine)


async def main(options):
    task = asyncio.current_task()
    for event in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(event, task.cancel)
    await qualify(options.node, options.archive, options.mode, options.runtime)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--mode', choices=('smoke', 'measure'), required=True)
    parser.add_argument('--runtime', required=True)
    asyncio.run(main(parser.parse_args()))
