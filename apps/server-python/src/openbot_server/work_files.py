"""Private, immutable POSIX blobs. This control-owned root must never be an executor mount."""
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import re
import secrets
import stat

from .database import StoreUnavailable
from .work_values import InvalidWork, text

MAX_BYTES = 8 * 1024 * 1024


def artifact_name(value):
    text(value, 255)
    if value in ('.','..') or any(ord(ch) < 32 or ord(ch) == 127 or ch in '/\\' for ch in value):
        raise InvalidWork('invalid_artifact_name')
    return value


def artifact_media_type(value):
    if type(value) is not str or len(value) > 128 or not re.fullmatch(r'[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*',value):
        raise InvalidWork('invalid_artifact_media_type')
    return value


class LocalWorkFiles:
    def __init__(self, directory):
        self.directory = Path(directory)
        if not self.directory.is_absolute() or os.name != 'posix':
            raise ValueError('An absolute private POSIX artifact directory is required.')

    @contextmanager
    def _directory(self):
        fd = None
        try:
            fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            info = os.fstat(fd)
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
                raise OSError('Artifact directory must be private and control-owned.')
            yield fd
        except OSError:
            raise StoreUnavailable('work_files_unavailable') from None
        finally:
            if fd is not None:
                os.close(fd)

    def verify(self):
        with self._directory():
            pass

    @staticmethod
    def _read(directory, digest, size):
        fd = os.open(digest, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
        with os.fdopen(fd,'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size != size:
                raise StoreUnavailable('work_file_integrity')
            data = stream.read(MAX_BYTES + 1)
        if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
            raise StoreUnavailable('work_file_integrity')
        return data

    def read(self, digest, size):
        if type(digest) is not str or not re.fullmatch('[0-9a-f]{64}',digest) or type(size) is not int or not 0 <= size <= MAX_BYTES:
            raise InvalidWork('invalid_file_descriptor')
        with self._directory() as directory:
            return self._read(directory,digest,size)

    def put(self, data):
        if type(data) is not bytes or len(data) > MAX_BYTES:
            raise InvalidWork('artifact_size_limit')
        digest = hashlib.sha256(data).hexdigest()
        with self._directory() as directory:
            temporary = '.pending-' + secrets.token_hex(16)
            try:
                fd = os.open(temporary,os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                             0o600,dir_fd=directory)
                with os.fdopen(fd,'wb') as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                try:
                    os.link(temporary,digest,src_dir_fd=directory,dst_dir_fd=directory,follow_symlinks=False)
                except FileExistsError:
                    pass  # Never overwrite even an existing corrupt object; readback below must pass.
                os.unlink(temporary,dir_fd=directory)
                os.fsync(directory)
                self._read(directory,digest,len(data))
            finally:
                try:
                    os.unlink(temporary,dir_fd=directory)
                except FileNotFoundError:
                    pass
        return {'sha256':digest,'sizeBytes':len(data)}
