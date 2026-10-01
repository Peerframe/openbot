"""Owner session policy; cryptographic primitives are supplied by the Python standard library."""
import asyncio
from dataclasses import dataclass, field
from datetime import datetime
import hashlib
import ipaddress
import secrets
from typing import Literal, Protocol
from uuid import uuid4

from .auth_credentials import StoredCredential, hash_password, verify_password
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
                      token_digest: str, ttl_hours: int, credential_revision: int | None = None,
                      user_agent: str = "") -> AttemptResult: ...
    async def revoke(self, token_digest: str) -> bool: ...
    async def credentials(self, *, token: str | None = None, required: bool = False) -> StoredCredential | None: ...
    async def list_sessions(self, token: str | None) -> list[dict]: ...
    async def revoke_others(self, token: str | None) -> int: ...
    async def rotate_password(self, token: str | None, **values) -> AttemptResult: ...


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
        self._kdf_capacity = asyncio.Semaphore(2)

    async def verify_schema(self) -> None:
        await self._store.verify_schema()

    async def login(self, password: str, address: str | None, *, user_agent: str = "") -> IssuedSession:
        if not isinstance(password, str) or not 1 <= password_length(password) <= 1024:
            raise ValueError("Invalid login input.")
        digest = client_digest(address)
        credential = await self._store.credentials()
        valid = await self._verify(password,credential)
        token = secrets.token_urlsafe(32)
        result = await self._store.attempt(client_digest=digest, valid_password=valid,
                                          session_id=str(uuid4()), token_digest=hashlib.sha256(token.encode()).hexdigest(),
                                          ttl_hours=self._ttl_hours, credential_revision=credential.revision if credential else None,
                                          user_agent=user_agent[:256])
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

    async def _verify(self, password, credential):
        if credential is None:
            return secrets.compare_digest(hashlib.sha256(password.encode("utf-8")).digest(),self._expected)
        try:
            async with asyncio.timeout(6),self._kdf_capacity:
                return await asyncio.to_thread(verify_password,password,credential.password_hash)
        except (ValueError,TimeoutError):
            from .database import StoreUnavailable
            raise StoreUnavailable("owner_credential_unavailable") from None

    async def change_password(self, token, current, new, address):
        credential = await self._store.credentials(token=token,required=True)
        valid = await self._verify(current,credential)
        async with self._kdf_capacity:
            encoded = await asyncio.to_thread(hash_password,new) if valid else ""
        result = await self._store.rotate_password(token,valid_password=valid,
            credential_revision=credential.revision if credential else None,
            password_hash=encoded,client_digest=client_digest(address))
        if result.status == "throttled": raise RateLimited(result.retry_after)
        if result.status != "issued": raise InvalidCredentials()

    async def sessions(self, token):
        return await self._store.list_sessions(token)

    async def revoke_other_sessions(self, token):
        return await self._store.revoke_others(token)
