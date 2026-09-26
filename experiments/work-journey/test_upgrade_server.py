"""An upgrade failure must leave the engine stopped, without an automatic retry owner."""
import unittest
from unittest.mock import AsyncMock, patch

from upgrade_server import UpgradeServer, maintenance


class UpgradeFailureTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self):
        server = object.__new__(UpgradeServer)
        server.upgraded = False
        server.release_overlay = 'old-release.json'
        server.evidence = []
        server.versions = lambda: {'temporal': '1.19', 'temporal_visibility': '1.14'}
        server.schema_records = lambda: {'temporal': b'old', 'temporal_visibility': b'old'}
        server.shard_ids = lambda: ['1', '2', '3', '4']
        server.version = AsyncMock()
        server.sql = lambda *args, **kwargs: None
        commands = []
        server.command = lambda *args, **kwargs: commands.append(args)
        return server, commands

    async def test_schema_tool_failure_does_not_start_target(self):
        server, commands = self.fixture()
        with patch.object(maintenance, 'maintain', side_effect=RuntimeError('schema tool failed')):
            with self.assertRaisesRegex(RuntimeError, 'schema tool failed'):
                await server.upgrade()
        self.assertEqual(commands, [('stop', 'temporal')])
        self.assertFalse(server.upgraded)
        server.version.assert_not_awaited()

    async def test_unexpected_schema_history_mutation_does_not_start_target(self):
        server, commands = self.fixture()
        with patch.object(server, 'schema_records', side_effect=[{'temporal': b'before'}, {'temporal': b'after'}]), \
                patch.object(maintenance, 'maintain'):
            with self.assertRaises(AssertionError):
                await server.upgrade()
        self.assertEqual(commands, [('stop', 'temporal')])
        server.version.assert_not_awaited()

    async def test_missing_shard_stops_before_schema_write(self):
        server, commands = self.fixture()
        server.shard_ids = lambda: ['1', '2', '3']
        with patch.object(maintenance, 'maintain') as migrate:
            with self.assertRaises(AssertionError):
                await server.upgrade()
            migrate.assert_not_called()
        self.assertEqual(commands, [('stop', 'temporal')])

    async def test_second_upgrade_is_rejected_before_mutation(self):
        server, commands = self.fixture()
        server.upgraded = True
        with self.assertRaisesRegex(ValueError, 'once only'):
            await server.upgrade()
        self.assertEqual(commands, [])


if __name__ == '__main__':
    unittest.main()
