"""Owner session policy; cryptographic primitives are supplied by the Python standard library."""
from dataclasses import dataclass, field
from datetime import datetime
import hashlib
import ipaddress
import secrets
from typing import Literal, Protocol
from uuid import uuid4

from .models import AuthenticatedSession, Owner, iso_timestamp


class InvalidCredentials(Exception):
    pass


class InvalidClientIdentity(Exception):
    pass


class RateLimited(Exception):
    def __init__(self, retry_after: int):
        self.retry_after = max(1, min(300, retry_after))
        super().__init__("Too many login attempts. Try again later.")


@dataclass(frozen=True)
class AttemptResult:
    status: Literal["issued", "invalid", "throttled"]
    expires_at: datetime | None = None
    retry_after: int = 0


@dataclass(frozen=True)
class IssuedSession:
    token: str = field(repr=False)
    session: AuthenticatedSession


class AuthPersistence(Protocol):
    async def verify_schema(self) -> None: ...
    async def attempt(self, *, client_digest: str, valid_password: bool, session_id: str,
                      token_digest: str, ttl_hours: int) -> AttemptResult: ...
    async def revoke(self, token_digest: str) -> bool: ...


def client_digest(address: str | None) -> str:
    if not address or "%" in address:
        raise InvalidClientIdentity()
    try:
        parsed = ipaddress.ip_address(address.strip())
        if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped is not None:
            # WHATWG URL in the retained Node implementation uses hexadecimal mapped tails.
            tail = int(parsed.ipv4_mapped)
            canonical = f"::ffff:{tail >> 16:x}:{tail & 65535:x}"
        else:
            canonical = parsed.compressed.lower()
    except ValueError:
        raise InvalidClientIdentity() from None
    return hashlib.sha256(("openbot:client-network:v1\0" + canonical).encode("ascii")).hexdigest()


def password_length(value: str) -> int:
    # Zod 4.6.2 measures Unicode code points, including astral characters.
    return len(value)


class OwnerAuthentication:
    def __init__(self, store: AuthPersistence, *, owner_name: str, password: str, ttl_hours: int = 12):
        if (not isinstance(password, str) or not 15 <= password_length(password) <= 1024
                or password == "replace-with-a-long-random-owner-password"):
            raise ValueError("Set a non-example Owner password of 15 to 1024 Unicode characters.")
        if type(ttl_hours) is not int or not 1 <= ttl_hours <= 168:
            raise ValueError("Owner session TTL must be 1 to 168 hours.")
        if not isinstance(owner_name, str) or not owner_name.strip() or len(owner_name) > 80:
            raise ValueError("Owner name must be 1 to 80 characters.")
        self._store = store
        self.owner_name = owner_name
        self._expected = hashlib.sha256(password.encode("utf-8")).digest()
        self._ttl_hours = ttl_hours

    async def verify_schema(self) -> None:
        await self._store.verify_schema()

    async def login(self, password: str, address: str | None) -> IssuedSession:
        if not isinstance(password, str) or not 1 <= password_length(password) <= 1024:
            raise ValueError("Invalid login input.")
        digest = client_digest(address)
        valid = secrets.compare_digest(hashlib.sha256(password.encode("utf-8")).digest(), self._expected)
        token = secrets.token_urlsafe(32)
        result = await self._store.attempt(client_digest=digest, valid_password=valid,
                                          session_id=str(uuid4()), token_digest=hashlib.sha256(token.encode()).hexdigest(),
                                          ttl_hours=self._ttl_hours)
        if result.status == "throttled":
            raise RateLimited(result.retry_after)
        if not valid or result.status != "issued" or result.expires_at is None:
            raise InvalidCredentials()
        return IssuedSession(token, AuthenticatedSession(authenticated=True, owner=Owner(id="owner", name=self.owner_name),
                                                        expiresAt=iso_timestamp(result.expires_at)))

    async def logout(self, token: str | None) -> bool:
        if not isinstance(token, str) or len(token) != 43 or not token.isascii():
            return False
        return await self._store.revoke(hashlib.sha256(token.encode("ascii")).hexdigest())
