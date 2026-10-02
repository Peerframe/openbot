"""Reversible same-filesystem staging; SQL receipts decide recovery, never a guessed commit."""
import json
import os
import stat
from uuid import uuid4

from .control_errors import ControlError
from .owner_files import UUID, MAX_BYTES

SUFFIXES = ('.json', '.bin', '.text.json')
MAX_JOURNAL = 262144


def marker(item):
    return json.dumps(dict(id=item['id'], channelId=item['channelId'], purged=True), separators=(',', ':')).encode()


def regular(info, maximum):
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) & 0o077 or not 0 <= info.st_size <= maximum):
        raise ControlError(503, 'purge_file_refused')


class PurgeFiles:
    def __init__(self, files):
        self.files = files

    def _open(self, root, name):
        if not name.startswith('.purge-') or not UUID.fullmatch(name[7:]):
            raise ControlError(503, 'purge_journal_refused')
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=root)
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
            os.close(fd)
            raise ControlError(503, 'purge_journal_refused')
        return fd

    def journals(self):
        root = self.files._directory()
        try:
            names = [name for name in os.listdir(root) if name.startswith('.purge-')]
            if len(names) > 16: raise ControlError(503, 'purge_journal_limit')
            return sorted(names)
        finally: os.close(root)

    def usage(self, item):
        # Prove the immutable original before authorizing physical removal.
        self.files.read(item['channelId'], item['id'])
        root = self.files._directory()
        try:
            sizes = {}
            for suffix in SUFFIXES:
                try: info = os.stat(item['id'] + suffix, dir_fd=root, follow_symlinks=False)
                except FileNotFoundError:
                    if suffix != '.text.json': raise
                    continue
                regular(info, MAX_BYTES if suffix == '.bin' else 2097152 if suffix == '.text.json' else 4096)
                sizes[suffix] = info.st_size
            return sizes
        finally: os.close(root)

    def stage(self, items):
        if not 1 <= len(items) <= 1024: raise ControlError(503, 'purge_batch_limit')
        operation = str(uuid4())
        entries = [dict(id=item['id'], channelId=item['channelId'], suffixes=list(self.usage(item))) for item in items]
        data = json.dumps(dict(operation=operation, entries=entries), separators=(',', ':')).encode()
        if len(data) > MAX_JOURNAL: raise ControlError(503, 'purge_journal_limit')
        root = self.files._directory()
        name = '.purge-' + operation
        fd = None
        try:
            os.mkdir(name, 0o700, dir_fd=root)
            fd = self._open(root, name)
            journal = os.open('manifest.pending', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            with os.fdopen(journal, 'wb') as stream:
                stream.write(data); stream.flush(); os.fsync(stream.fileno())
            os.rename('manifest.pending', 'manifest.json', src_dir_fd=fd, dst_dir_fd=fd)
            os.fsync(fd); os.fsync(root)
            for entry in entries:
                for suffix in entry['suffixes']:
                    filename = entry['id'] + suffix
                    os.rename(filename, filename, src_dir_fd=root, dst_dir_fd=fd)
            os.fsync(fd); os.fsync(root)
            return operation
        finally:
            if fd is not None: os.close(fd)
            os.close(root)

    def read_journal(self, name):
        root = self.files._directory()
        fd = None
        try:
            fd = self._open(root, name)
            source = os.open('manifest.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            with os.fdopen(source, 'rb') as stream:
                regular(os.fstat(stream.fileno()), MAX_JOURNAL)
                value = json.loads(stream.read(MAX_JOURNAL + 1))
            if (type(value) is not dict or set(value) != {'operation', 'entries'}
                    or value['operation'] != name[7:] or type(value['entries']) is not list
                    or not 1 <= len(value['entries']) <= 1024): raise ValueError()
            identities = set()
            allowed = {'manifest.json'}
            for item in value['entries']:
                if (type(item) is not dict or set(item) != {'id', 'channelId', 'suffixes'}
                        or not isinstance(item['id'], str) or not UUID.fullmatch(item['id'])
                        or not isinstance(item['channelId'], str) or not UUID.fullmatch(item['channelId'])
                        or item['id'] in identities or type(item['suffixes']) is not list
                        or set(item['suffixes']) not in ({'.json', '.bin'}, set(SUFFIXES))
                        or len(item['suffixes']) != len(set(item['suffixes']))): raise ValueError()
                identities.add(item['id'])
                allowed.update(item['id'] + suffix for suffix in item['suffixes'])
            if set(os.listdir(fd)) - allowed: raise ValueError()
            return value
        except (ValueError, TypeError, KeyError):
            raise ControlError(503, 'purge_journal_refused') from None
        finally:
            if fd is not None: os.close(fd)
            os.close(root)

    def discard_unstarted(self, name):
        # No blob can move before the durable manifest rename; an empty finished directory is safe too.
        root = self.files._directory()
        fd = None
        try:
            fd = self._open(root, name)
            names = set(os.listdir(fd))
            if names - {'manifest.pending'}: raise ControlError(503, 'purge_journal_refused')
            if 'manifest.pending' in names:
                regular(os.stat('manifest.pending', dir_fd=fd, follow_symlinks=False), MAX_JOURNAL)
                os.unlink('manifest.pending', dir_fd=fd)
            os.fsync(fd); os.rmdir(name, dir_fd=root); os.fsync(root)
        finally:
            if fd is not None: os.close(fd)
            os.close(root)

    def resolve(self, name, value, committed):
        root = self.files._directory()
        fd = None
        try:
            fd = self._open(root, name)
            names = set(os.listdir(fd))
            # Validate every destination before restoring anything. Never replace another file.
            for item in value['entries']:
                for suffix in item['suffixes']:
                    filename = item['id'] + suffix
                    if filename not in names: continue
                    regular(os.stat(filename, dir_fd=fd, follow_symlinks=False), MAX_BYTES)
                    if item['id'] not in committed:
                        try: os.stat(filename, dir_fd=root, follow_symlinks=False)
                        except FileNotFoundError: pass
                        else: raise ControlError(503, 'purge_recovery_conflict')
            for item in value['entries']:
                if item['id'] in committed:
                    self.files._write(item['id'] + '.purged.json', marker(item))
                for suffix in item['suffixes']:
                    filename = item['id'] + suffix
                    if filename not in names: continue
                    if item['id'] in committed: os.unlink(filename, dir_fd=fd)
                    else: os.rename(filename, filename, src_dir_fd=fd, dst_dir_fd=root)
            os.fsync(fd); os.fsync(root)
            os.unlink('manifest.json', dir_fd=fd)
            os.fsync(fd)
            os.rmdir(name, dir_fd=root)
            os.fsync(root)
        finally:
            if fd is not None: os.close(fd)
            os.close(root)
