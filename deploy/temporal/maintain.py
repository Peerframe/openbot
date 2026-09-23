"""Single-administrator preflight around upstream schema tools; no automatic migrations."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import stat
import subprocess

PROFILE = Path(__file__).with_name('compose.yaml')
TARGETS = {'temporal': '1.19', 'temporal_visibility': '1.14'}
PASSWORD_KEYS = ('OPENBOT_TEMPORAL_SCHEMA_PASSWORD', 'OPENBOT_TEMPORAL_RUNTIME_PASSWORD')


def read_environment(path: Path) -> dict[str, str]:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise ValueError('Environment file must be an owned private regular file (mode 0600).')
    if info.st_size > 4096:
        raise ValueError('Environment file exceeds profile bounds.')
    values = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or key in values or key not in (*PASSWORD_KEYS, 'OPENBOT_TEMPORAL_PORT'):
            raise ValueError('Unknown, duplicate or malformed profile environment setting.')
        values[key] = value
    for key in PASSWORD_KEYS:
        if not re.fullmatch(r'[0-9a-fA-F]{48,128}', values.get(key, '')):
            raise ValueError('Use distinct random hexadecimal passwords of 48–128 characters.')
    if values[PASSWORD_KEYS[0]] == values[PASSWORD_KEYS[1]]:
        raise ValueError('Schema and runtime credentials must differ.')
    port = values.setdefault('OPENBOT_TEMPORAL_PORT', '7233')
    if not re.fullmatch(r'[0-9]{1,5}', port) or not 1024 <= int(port) <= 65535:
        raise ValueError('Use an unprivileged loopback port.')
    return values


def version(value: str) -> tuple[int, int]:
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', value):
        raise ValueError('Missing, multiple or malformed schema version.')
    return tuple(map(int, value.split('.')))


def maintain(mode, command, sql):
    if mode not in ('initialize', 'upgrade'):
        raise ValueError('Expected initialize or upgrade.')
    states = command('ps', '--all', '--format', '{{.State}}', 'temporal').stdout.decode().splitlines()
    if any(state not in ('exited', 'created') for state in states):
        raise ValueError('Stop the engine and workers before exclusive schema maintenance; paused is not stopped.')
    # Inspect both stores before any mutation; a mixed/foreign target must not be partly changed.
    for db, target in TARGETS.items():
        if mode == 'initialize':
            count = sql(db, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%';").stdout.strip()
            if count != b'0':
                raise ValueError('Initialization requires both engine databases to be empty.')
        else:
            current = sql(db, 'SELECT curr_version FROM schema_version;').stdout.decode().strip()
            if version(current) > version(target):
                raise ValueError('Schema is newer than the pinned tools; downgrade is unsupported.')
    command('run', '--rm', '--no-deps', '-e', 'OPENBOT_TEMPORAL_SCHEMA_PREFLIGHT=passed', 'schema', mode)
    for db, target in TARGETS.items():
        current = sql(db, 'SELECT curr_version FROM schema_version;').stdout.decode().strip()
        if current != target:
            raise ValueError('Schema tool did not produce the pinned target version.')
    seal_metadata(sql)


def seal_metadata(sql):
    for db in TARGETS:
        sql(db, 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON schema_version, schema_update_history FROM temporal_runtime;')


class Profile:
    def __init__(self, env_file: Path, project: str):
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,62}', project):
            raise ValueError('Invalid Compose project name.')
        self.values = read_environment(env_file)
        self.env_file, self.project = env_file.resolve(), project
        # Reject ambient Compose/file selection and variable overrides, without reading dotenv.
        self.environment = {key: os.environ[key] for key in
            ('PATH', 'HOME', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG') if key in os.environ}
        self.environment.update(self.values)

    def command(self, *args, input=None):
        result = subprocess.run(['docker', 'compose', '--env-file', str(self.env_file),
            '--project-name', self.project, '--file', str(PROFILE), *args], env=self.environment,
            input=input, capture_output=True, timeout=120)
        if result.returncode:
            diagnostic = (result.stdout + result.stderr).decode(errors='replace')[-3000:]
            for key in PASSWORD_KEYS:
                diagnostic = diagnostic.replace(self.values[key], '[credential]')
            raise RuntimeError('Profile operation failed: ' + diagnostic)
        return result

    def sql(self, database, statement):
        if database not in TARGETS:
            raise ValueError('Unexpected engine database.')
        return self.command('exec', '-T', 'postgresql', 'psql', '-U', 'temporal_schema',
            '-v', 'ON_ERROR_STOP=1', '-At', '-d', database, input=statement.encode())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('initialize', 'upgrade'))
    parser.add_argument('--env-file', required=True, type=Path)
    parser.add_argument('--project', required=True)
    args = parser.parse_args()
    try:
        profile = Profile(args.env_file, args.project)
        maintain(args.mode, profile.command, profile.sql)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        parser.exit(1, str(error) + '\n')
    print('Pinned engine schemas verified; runtime metadata writes revoked. Engine remains stopped.')


if __name__ == '__main__':
    main()
