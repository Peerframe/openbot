"""Immutable publisher loaded from the retained offline-managed encrypted keyring.

Private key and passphrase never enter DTOs, PostgreSQL, exceptions or package bytes. Reads use
opened descriptors, owner-only permissions and bounded regular files. Offline rotation/revocation
continues to use the existing operator CLI; running HTTP services cannot mutate their trust root.
"""
import json
import os
import stat
from typing import Literal

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pydantic import Field, field_validator, model_validator

from .employee_knowledge_inputs import Input
from .employee_portability_format import key_id, sign_envelope, verify_envelope
from .employee_portability_inputs import datetime_text


class KeyEntry(Input):
    keyid: str = Field(pattern=r"^ed25519:[a-f0-9]{64}$")
    algorithm: Literal["ed25519"]
    status: Literal["active", "retired", "trusted", "revoked"]
    publicKey: str = Field(min_length=1, max_length=16384)
    createdAt: str
    retiredAt: str | None = None
    revokedAt: str | None = None

    @field_validator("createdAt", "retiredAt", "revokedAt")
    @classmethod
    def timestamp(cls, value):
        return datetime_text(value)

    @model_validator(mode="after")
    def lifecycle(self):
        if self.status in ("active", "trusted") and (self.retiredAt is not None or self.revokedAt is not None):
            raise ValueError("Active or trusted key cannot be retired or revoked.")
        if self.status == "retired" and self.retiredAt is None or self.status == "revoked" and self.revokedAt is None:
            raise ValueError("Missing key lifecycle timestamp.")
        return self


class Manifest(Input):
    version: Literal[1]
    activeKeyId: str = Field(pattern=r"^ed25519:[a-f0-9]{64}$")
    keys: list[KeyEntry] = Field(min_length=1, max_length=256)

    @field_validator("version", mode="before")
    @classmethod
    def integer_version(cls, value):
        if type(value) is not int:
            raise ValueError("Invalid manifest version.")
        return value


def _read_file(path, maximum, *, dir_fd=None):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    if stat.S_ISLNK(os.stat(path, dir_fd=dir_fd, follow_symlinks=False).st_mode):
        raise ValueError("Publisher file must not be a symlink.")
    fd = os.open(path, flags, dir_fd=dir_fd)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > maximum or os.name != "nt" and metadata.st_mode & 0o077:
            raise ValueError("Publisher file protection or bound failed.")
        result = b""
        while len(result) <= maximum:
            block = os.read(fd, min(65536, maximum + 1 - len(result)))
            if not block:
                return result
            result += block
        raise ValueError("Publisher file exceeds its bound.")
    finally:
        os.close(fd)


def _directory(path, *, dir_fd=None):
    if stat.S_ISLNK(os.stat(path, dir_fd=dir_fd, follow_symlinks=False).st_mode):
        raise ValueError("Publisher directory must not be a symlink.")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0), dir_fd=dir_fd)
    metadata = os.fstat(fd)
    if not stat.S_ISDIR(metadata.st_mode) or os.name != "nt" and metadata.st_mode & 0o077:
        os.close(fd)
        raise ValueError("Publisher directory protection failed.")
    return fd


class EmployeePublisher:
    """Trusted composition object; the key material is never accepted through HTTP arguments."""
    def __init__(self, active_key_id, private_key, trusted_keys):
        if not isinstance(private_key, Ed25519PrivateKey):
            raise ValueError("Employee publisher requires an Ed25519 private key.")
        if key_id(private_key.public_key()) != active_key_id:
            raise ValueError("Employee publisher private/public key mismatch.")
        self.active_key_id = active_key_id
        self._private_key = private_key
        self._trusted_keys = tuple(dict(entry) for entry in trusted_keys)

    def sign(self, document):
        return sign_envelope(document, self.active_key_id, self._private_key)

    def verify(self, value):
        return verify_envelope(value, self._trusted_keys)

    @classmethod
    def load(cls, directory, passphrase_file):
        root = keys = None
        try:
            root = _directory(os.path.abspath(directory))
            manifest = Manifest.model_validate(json.loads(_read_file("trust.json", 512 * 1024, dir_fd=root)))
            trusted, seen, active = [], set(), []
            for entry in manifest.keys:
                if entry.keyid in seen:
                    raise ValueError()
                seen.add(entry.keyid)
                public = serialization.load_pem_public_key(entry.publicKey.encode())
                if key_id(public) != entry.keyid:
                    raise ValueError()
                if entry.status == "active":
                    active.append(entry.keyid)
                if entry.status != "revoked":
                    trusted.append({"keyid": entry.keyid, "publicKey": public})
            if active != [manifest.activeKeyId]:
                raise ValueError()
            password = _read_file(os.path.abspath(passphrase_file), 4096).decode("utf-8")
            password = password[:-2] if password.endswith("\r\n") else password[:-1] if password.endswith("\n") else password
            if not 16 <= len(password.encode("utf-16-le")) // 2 <= 1024:
                raise ValueError()
            keys = _directory("keys", dir_fd=root)
            pem = _read_file(manifest.activeKeyId.split(":", 1)[1] + ".key.pem", 65536, dir_fd=keys)
            private = serialization.load_pem_private_key(pem, password.encode())
            return cls(manifest.activeKeyId, private, trusted)
        except (OSError, ValueError, TypeError, UnicodeError):
            # Startup must refuse configured-but-invalid signing state, never fall back unsigned.
            raise ValueError("Employee publisher keyring could not be loaded.") from None
        finally:
            if keys is not None:
                os.close(keys)
            if root is not None:
                os.close(root)
