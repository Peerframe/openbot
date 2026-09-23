"""Operator failure boundaries; integration probe separately verifies PostgreSQL privileges."""
import importlib.util
from pathlib import Path
from subprocess import CompletedProcess, TimeoutExpired
from tempfile import TemporaryDirectory
import unittest

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location('maintenance', ROOT / 'deploy/temporal/maintain.py')
maintenance = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(maintenance)


class MaintenancePreflightTests(unittest.TestCase):
    def exercise_rejection(self, mode, values, *, state=None):
        mutations = []
        def command(*args):
            if args[0] != 'ps':
                mutations.append(args)
            return CompletedProcess(args, 0, state.encode() if state is not None else b'', b'')
        def sql(db, statement):
            self.assertTrue(statement.startswith('SELECT '), statement)
            return CompletedProcess([], 0, values[db].encode(), b'')
        with self.assertRaises(ValueError):
            maintenance.maintain(mode, command, sql)
        self.assertEqual(mutations, [], 'No schema writes before both stores pass preflight')

    def test_empty_history_with_existing_visibility_makes_no_changes(self):
        self.exercise_rejection('initialize', {'temporal': '0', 'temporal_visibility': '1'})

    def test_running_engine_is_rejected_before_database_access(self):
        self.exercise_rejection('upgrade', {}, state='running')

    def test_paused_restarting_or_unknown_engine_is_not_stopped(self):
        for state in ('paused', 'restarting', 'removing', 'unexpected'):
            with self.subTest(state=state):
                self.exercise_rejection('upgrade', {}, state=state)

    def test_newer_second_schema_does_not_partly_upgrade_first(self):
        self.exercise_rejection('upgrade', {'temporal': '1.18', 'temporal_visibility': '999.0'})

    def test_missing_multiple_or_malformed_schema_rows_fail_closed(self):
        for bad in ('', '1.19\n1.19', 'NaN', '-1.0', '01.19', '1.19.1', '1.19;DROP TABLE t'):
            with self.subTest(value=bad):
                self.exercise_rejection('upgrade', {'temporal': bad})

    def test_environment_cannot_expand_yaml_shell_or_compose_settings(self):
        good = ('OPENBOT_TEMPORAL_SCHEMA_PASSWORD=' + 'a' * 48 + '\n'
                'OPENBOT_TEMPORAL_RUNTIME_PASSWORD=' + 'b' * 48 + '\n')
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'engine.env'
            path.write_text(good); path.chmod(0o600)
            self.assertEqual(maintenance.read_environment(path)['OPENBOT_TEMPORAL_PORT'], '7233')
            bad_values = [good + 'COMPOSE_FILE=other.yaml\n', good + 'OPENBOT_TEMPORAL_PORT=80\n',
                good + 'OPENBOT_TEMPORAL_PORT=65536\n', good + 'OPENBOT_TEMPORAL_PORT=${PORT}\n',
                good + 'OPENBOT_TEMPORAL_RUNTIME_PASSWORD=' + 'c' * 48 + '\n',
                good.replace('b' * 48, 'a' * 48), good.replace('b' * 48, 'b' * 47 + '"'),
                good.replace('b' * 48, '$(ignored)'), good.replace('b' * 48, 'x' * 49)]
            for content in bad_values:
                path.write_text(content)
                with self.subTest(content=content), self.assertRaises(ValueError):
                    maintenance.read_environment(path)
            path.write_text(good); path.chmod(0o644)
            with self.assertRaises(ValueError):
                maintenance.read_environment(path)
            path.chmod(0o600)
            link = path.with_name('linked.env'); link.symlink_to(path)
            with self.assertRaises(ValueError):
                maintenance.read_environment(link)


class CleanupTests(unittest.TestCase):
    def test_cleanup_attempts_all_owned_projects_after_command_exception(self):
        from postgres_server import PostgresServer
        for error in (TimeoutExpired('docker', 60), OSError('fixture unavailable')):
            with self.subTest(error=type(error).__name__):
                fixture = object.__new__(PostgresServer)
                fixture.projects = ['original', 'restored']
                attempted = []
                def command(*args, **kwargs):
                    attempted.append(fixture.project)
                    if fixture.project == 'restored':
                        raise error
                    return CompletedProcess(args, 0, b'', b'')
                fixture.command = command
                with self.assertRaisesRegex(RuntimeError, 'restored'):
                    fixture.close()
                self.assertEqual(attempted, ['restored', 'original'])


if __name__ == '__main__':
    unittest.main()
