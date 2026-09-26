"""Fail-closed transport boundaries; the live probe verifies real certificates."""
from pathlib import Path
from tempfile import TemporaryDirectory
import subprocess
import unittest
from unittest.mock import AsyncMock, patch

import engine_client
from test_maintenance import maintenance

ROOT = Path(__file__).resolve().parents[2]


class ClientConfigurationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.settings = {'server_name': 'temporal.openbot.internal'}
        for key in ('ca', 'certificate', 'key'):
            path = self.root / key
            path.write_bytes(('fixture-' + key).encode())
            self.settings[key] = str(path)

    async def test_bad_configuration_never_connects_or_falls_back(self):
        bad = [{}, {**self.settings, 'extra': True},
               {**self.settings, 'server_name': 'other.invalid'},
               {**self.settings, 'ca': 'relative.pem'},
               {**self.settings, 'ca': str(self.root)}]
        empty = self.root / 'empty'; empty.touch()
        large = self.root / 'large'; large.write_bytes(b'x' * 65537)
        linked = self.root / 'linked'; linked.symlink_to(self.settings['ca'])
        bad += [{**self.settings, 'ca': str(path)} for path in (empty, large, linked)]
        with patch.object(engine_client.Client, 'connect', new_callable=AsyncMock) as connect:
            for settings in bad:
                with self.subTest(settings=settings), self.assertRaises((ValueError, OSError)):
                    await engine_client.connect('127.0.0.1:7233', settings)
            connect.assert_not_called()

    async def test_connection_failure_has_no_plaintext_retry(self):
        with patch.object(engine_client.Client, 'connect', new_callable=AsyncMock,
                          side_effect=RuntimeError('TLS connection rejected')) as connect:
            with self.assertRaisesRegex(RuntimeError, 'TLS connection rejected'):
                await engine_client.connect('127.0.0.1:7233', self.settings, plugins=('plugin',))
            self.assertEqual(connect.await_count, 1)
            options = connect.call_args.kwargs
            self.assertEqual(options['tls'].domain, 'temporal.openbot.internal')
            self.assertEqual(options['tls'].client_private_key, b'fixture-key')
            self.assertEqual(options['plugins'], ('plugin',))


class ServerStartupTests(unittest.TestCase):
    def test_missing_or_weakened_tls_settings_never_enter_upstream(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / 'entered'
            upstream = root / 'upstream.sh'
            upstream.write_text('#!/bin/sh\ntouch "' + str(marker) + '"\n')
            upstream.chmod(0o700)
            # Only relocate absolute mounts/entrypoint for a non-root shell fixture.
            source = (ROOT / 'deploy/temporal/start.sh').read_text()
            source = source.replace('/openbot/tls', str(root)).replace('/etc/temporal/entrypoint.sh', str(upstream))
            guard = root / 'start.sh'; guard.write_text(source)
            for name in ('server.pem', 'server.key', 'server-ca.pem', 'client-ca.pem'):
                (root / name).write_text('nonempty test material')
            env = {'PATH': '/usr/bin:/bin', 'POSTGRES_PWD': 'a' * 48,
                   'OPENBOT_REQUIRE_MTLS': 'true', 'TEMPORAL_TLS_REQUIRE_CLIENT_AUTH': 'true',
                   'TEMPORAL_TLS_INTERNODE_DISABLE_HOST_VERIFICATION': 'false',
                   'TEMPORAL_TLS_FRONTEND_DISABLE_HOST_VERIFICATION': 'false',
                   'TEMPORAL_TLS_INTERNODE_SERVER_NAME': 'temporal.openbot.internal',
                   'TEMPORAL_TLS_FRONTEND_SERVER_NAME': 'temporal.openbot.internal'}
            for setting, filename in (
                ('SERVER_CERT', 'server.pem'), ('SERVER_KEY', 'server.key'),
                ('SERVER_CA_CERT', 'server-ca.pem'), ('FRONTEND_CERT', 'server.pem'),
                ('FRONTEND_KEY', 'server.key'), ('CLIENT1_CA_CERT', 'client-ca.pem'),
                ('CLIENT2_CA_CERT', 'server-ca.pem')):
                env['TEMPORAL_TLS_' + setting] = str(root / filename)
            result = subprocess.run(['/bin/sh', str(guard)], env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(marker.exists()); marker.unlink()
            for key in env:
                if not key.startswith('TEMPORAL_TLS_'):
                    continue
                with self.subTest(missing=key):
                    result = subprocess.run(['/bin/sh', str(guard)],
                                            env={k: v for k, v in env.items() if k != key},
                                            capture_output=True)
                    self.assertEqual(result.returncode, 2)
                    self.assertFalse(marker.exists())
            (root / 'server.key').write_text('')
            self.assertEqual(subprocess.run(['/bin/sh', str(guard)], env=env).returncode, 2)
            self.assertFalse(marker.exists())

    def test_operator_rejects_missing_or_linked_tls_directory(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            env_file = root / 'engine.env'
            prefix = ('OPENBOT_TEMPORAL_SCHEMA_PASSWORD=' + 'a' * 48 + '\n'
                      'OPENBOT_TEMPORAL_RUNTIME_PASSWORD=' + 'b' * 48 + '\n')
            env_file.write_text(prefix + 'OPENBOT_TEMPORAL_TLS_DIRECTORY=' + str(root) + '\n')
            env_file.chmod(0o600)
            self.assertEqual(maintenance.read_environment(env_file)['OPENBOT_TEMPORAL_TLS_DIRECTORY'], str(root))
            link = root / 'linked'; link.symlink_to(root, target_is_directory=True)
            for path in (link, root / 'missing', env_file, Path('relative')):
                with self.subTest(path=path), self.assertRaises(ValueError):
                    env_file.write_text(prefix + 'OPENBOT_TEMPORAL_TLS_DIRECTORY=' + str(path) + '\n')
                    maintenance.read_environment(env_file)


if __name__ == '__main__':
    unittest.main()
