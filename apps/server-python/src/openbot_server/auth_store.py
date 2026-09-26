"""Existing Owner-auth tables are the only write surface of this reference adapter."""
import asyncio
from datetime import timedelta
import math
import re

import psycopg
from psycopg.rows import dict_row

from .auth import AttemptResult
from .database import PostgresReadStore, StoreUnavailable


class PostgresAuthStore:
    def __init__(self, dsn: str):
        if not dsn:
            raise ValueError("Explicit control-plane database configuration is required.")
        self._dsn = dsn
        self._capacity = asyncio.Semaphore(4)

    async def verify_schema(self) -> None:
        await PostgresReadStore(self._dsn).verify_schema()

    async def _connect(self):
        connection = await psycopg.AsyncConnection.connect(
            self._dsn, connect_timeout=3, row_factory=dict_row,
            options=("-c statement_timeout=3000 -c lock_timeout=1000 "
                     "-c idle_in_transaction_session_timeout=5000 -c search_path=public,pg_catalog -c timezone=UTC"),
        )
        try:
            await connection.set_isolation_level(psycopg.IsolationLevel.READ_COMMITTED)
            await connection.set_read_only(False)
            return connection
        except BaseException:
            await connection.close()
            raise

    async def attempt(self, *, client_digest: str, valid_password: bool, session_id: str,
                      token_digest: str, ttl_hours: int) -> AttemptResult:
        if (re.fullmatch(r"[0-9a-f]{64}", client_digest) is None
                or re.fullmatch(r"[0-9a-f]{64}", token_digest) is None
                or type(valid_password) is not bool or type(ttl_hours) is not int or not 1 <= ttl_hours <= 168):
            raise ValueError("Invalid authentication reservation.")
        try:
            async with asyncio.timeout(6), self._capacity:
                async with await self._connect() as connection:
                    # This is the existing TypeScript throttle lock, not a second rate-limit domain.
                    await connection.execute("SELECT pg_advisory_xact_lock(%s, hashtext(%s))",
                                             (1745083476, "owner-login:" + client_digest))
                    cursor = await connection.execute("SELECT date_trunc('milliseconds', clock_timestamp()) AS now")
                    now = (await cursor.fetchone())["now"]
                    await connection.execute("DELETE FROM request_throttle_buckets WHERE updated_at < %s",
                                             (now - timedelta(minutes=10),))
                    cursor = await connection.execute(
                        "SELECT attempt_count, window_started_at, blocked_until FROM request_throttle_buckets "
                        "WHERE scope='owner-login' AND client_digest=%s", (client_digest,))
                    current = await cursor.fetchone()
                    if current and current["blocked_until"] and current["blocked_until"] > now:
                        return AttemptResult("throttled", retry_after=math.ceil((current["blocked_until"] - now).total_seconds()))
                    expired = current is None or now - current["window_started_at"] >= timedelta(minutes=5)
                    count = 1 if expired else current["attempt_count"] + 1
                    started = now if expired else current["window_started_at"]
                    blocked = now + timedelta(minutes=5) if count >= 5 else None
                    await connection.execute(
                        "INSERT INTO request_throttle_buckets "
                        "(scope, client_digest, attempt_count, window_started_at, blocked_until, updated_at) "
                        "VALUES ('owner-login', %s, %s, %s, %s, %s) "
                        "ON CONFLICT (scope, client_digest) DO UPDATE SET "
                        "attempt_count=EXCLUDED.attempt_count, window_started_at=EXCLUDED.window_started_at, "
                        "blocked_until=EXCLUDED.blocked_until, updated_at=EXCLUDED.updated_at",
                        (client_digest, count, started, blocked, now))
                    if not valid_password:
                        # Normal context exit commits an invalid attempt. Raising here would erase it.
                        return AttemptResult("invalid")
                    await connection.execute("DELETE FROM request_throttle_buckets WHERE scope='owner-login' AND client_digest=%s",
                                             (client_digest,))
                    await connection.execute("DELETE FROM auth_sessions WHERE expires_at <= %s", (now,))
                    expires = now + timedelta(hours=ttl_hours)
                    await connection.execute(
                        "INSERT INTO auth_sessions (id, owner_id, token_digest, expires_at, created_at) "
                        "VALUES (%s, 'owner', %s, %s, %s)", (session_id, token_digest, expires, now))
                    # The connection context commits before this result reaches the caller.
                    return AttemptResult("issued", expires_at=expires)
        except (psycopg.Error, TimeoutError, ValueError, KeyError):
            raise StoreUnavailable("auth_storage_unavailable") from None

    async def revoke(self, token_digest: str) -> bool:
        if re.fullmatch(r"[0-9a-f]{64}", token_digest) is None:
            raise ValueError("Invalid session digest.")
        try:
            async with asyncio.timeout(6), self._capacity:
                async with await self._connect() as connection:
                    cursor = await connection.execute(
                        "UPDATE auth_sessions SET revoked_at=clock_timestamp() "
                        "WHERE token_digest=%s AND owner_id='owner' AND revoked_at IS NULL "
                        "AND expires_at > clock_timestamp() RETURNING id", (token_digest,))
                    return await cursor.fetchone() is not None
        except (psycopg.Error, TimeoutError):
            raise StoreUnavailable("auth_storage_unavailable") from None
