"""Byte-compatible feature-source API-key cipher; no singleton format conversion.

Translated from OpenBot MIT model-credential-cipher.ts at 9cc73c9. The explicit
POSIX key loader publishes a complete raw 32-byte key without replacing any existing inode.
"""
import base64
import json
import os
from pathlib import Path
import re
import secrets
import stat
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .control_errors import ControlError


def _error():
    return ControlError(503, "model_credential_unavailable")


def _encode(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode(value):
    if re.fullmatch(r"[A-Za-z0-9_-]+", value) is None:
        raise ValueError()
    decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if _encode(decoded) != value:
        raise ValueError()
    return decoded


def _aad(context):
    # Property order and UTF-8 JSON serialization are part of the retained ciphertext identity.
    return json.dumps({name: context[name] for name in ("id", "presetId", "baseUrl")},
                      ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _directory(path, create):
    if os.name != "posix":
        raise ValueError()
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            try:
                following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
                following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = following
        return fd
    except BaseException:
        os.close(fd)
        raise


def _read(fd, name):
    try:
        before = os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        info = os.fstat(file)
        if (not stat.S_ISREG(info.st_mode) or info.st_size != 32 or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_uid != os.getuid() or (before.st_dev, before.st_ino) != (info.st_dev, info.st_ino)):
            raise ValueError()
        data = os.read(file, 33)
        if len(data) != 32:
            raise ValueError()
        after = os.fstat(file)
        named = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if ((after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                or (named.st_dev, named.st_ino) != (info.st_dev, info.st_ino)):
            raise ValueError()
        return data
    finally:
        os.close(file)


class ModelCredentialCipher:
    def __init__(self, key: bytes):
        if type(key) is not bytes or len(key) != 32:
            raise _error()
        self._cipher = AESGCM(key)

    @classmethod
    def load(cls, path, *, allow_create: bool):
        fd = None
        try:
            if type(allow_create) is not bool:
                raise ValueError()
            path = Path(os.path.abspath(os.fspath(path)))
            fd = _directory(path.parent, allow_create)
            # Publishing via hard link changes ctime once more when the temporary name is
            # removed. Serialize cooperating readers on the directory inode so that this
            # expected publication cannot look like an in-place key mutation to _read.
            import fcntl
            deadline = time.monotonic() + 3
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise ValueError()
                    time.sleep(.01)
            key = _read(fd, path.name)
            if key is None:
                if not allow_create:
                    raise ValueError()
                name = ".model-key-" + secrets.token_hex(12) + ".tmp"
                file = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
                try:
                    os.fchmod(file, 0o600)
                    data = secrets.token_bytes(32)
                    if os.write(file, data) != 32:
                        raise ValueError()
                    os.fsync(file)
                    try:
                        os.link(name, path.name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                    except FileExistsError:
                        pass
                    os.fsync(fd)
                finally:
                    os.close(file)
                    os.unlink(name, dir_fd=fd)
                key = _read(fd, path.name)
            return cls(key)
        except Exception:
            raise _error() from None
        finally:
            if fd is not None:
                os.close(fd)

    def encrypt(self, api_key, context):
        try:
            data = api_key.encode("utf-8")
            if not api_key.strip() or len(data) > 4096:
                raise ValueError()
            nonce = secrets.token_bytes(12)
            combined = self._cipher.encrypt(nonce, data, _aad(context))
            return ".".join(("v1", _encode(nonce), _encode(combined[-16:]), _encode(combined[:-16])))
        except Exception:
            raise _error() from None

    def decrypt(self, value, context):
        try:
            if type(value) is not str or len(value) > 5600:
                raise ValueError()
            version, nonce, tag, ciphertext = value.split(".")
            nonce, tag, ciphertext = _decode(nonce), _decode(tag), _decode(ciphertext)
            if version != "v1" or len(nonce) != 12 or len(tag) != 16 or len(ciphertext) > 4096:
                raise ValueError()
            result = self._cipher.decrypt(nonce, ciphertext + tag, _aad(context)).decode("utf-8")
            if not result.strip():
                raise ValueError()
            return result
        except Exception:
            raise _error() from None
