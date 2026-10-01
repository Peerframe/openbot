"""Pinned stdlib scrypt format; parameters are fixed, never attacker-selected."""
from dataclasses import dataclass, field
import hashlib
import re
import secrets


@dataclass(frozen=True)
class StoredCredential:
    revision: int
    password_hash: str = field(repr=False)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=32768, r=8, p=3,
                            maxmem=64 * 1024 * 1024, dklen=32)
    return "scrypt$32768$8$3$" + salt.hex() + "$" + digest.hex()


def verify_password(password: str, encoded: str) -> bool:
    if not isinstance(encoded, str) or re.fullmatch(
            r"scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{64}", encoded) is None:
        raise ValueError("Invalid stored Owner credential.")
    _, _, _, _, salt, expected = encoded.split("$")
    actual = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt), n=32768,
                            r=8, p=3, maxmem=64 * 1024 * 1024, dklen=32)
    return secrets.compare_digest(actual, bytes.fromhex(expected))
