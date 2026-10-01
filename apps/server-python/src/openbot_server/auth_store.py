"""Existing Owner-auth tables are the only write surface of this reference adapter."""
import asyncio
from datetime import timedelta
import math
import re

import psycopg
from psycopg.rows import dict_row
from uuid import uuid4

from .auth import AttemptResult
from .database import PostgresReadStore, StoreUnavailable
from .owner_security import AUTH_LOCK, OwnerSecurityMixin


class PostgresAuthStore(OwnerSecurityMixin):
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
                      token_digest: str, ttl_hours: int, credential_revision: int | None = None,
                      user_agent: str = "") -> AttemptResult:
        if (re.fullmatch(r"[0-9a-f]{64}", client_digest) is None
                or re.fullmatch(r"[0-9a-f]{64}", token_digest) is None
                or not isinstance(user_agent,str) or len(user_agent)>256
                or type(valid_password) is not bool or type(ttl_hours) is not int or not 1 <= ttl_hours <= 168):
            raise ValueError("Invalid authentication reservation.")
        try:
            async with asyncio.timeout(6), self._capacity:
                async with await self._connect() as connection:
                    await connection.execute("SELECT pg_advisory_xact_lock(%s,1)", (AUTH_LOCK,))
                    blocked = await self._reserve_attempt(connection,client_digest)
                    if blocked: return blocked
                    credential = await self._credential(connection)
                    revision = credential.revision if credential else None
                    valid_password = valid_password and revision == credential_revision
                    now = (await (await connection.execute("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).fetchone())["now"]
                    if not valid_password:
                        # Normal context exit commits an invalid attempt. Raising here would erase it.
                        await connection.execute("INSERT INTO run_events(id,type,payload) VALUES (%s,'AUTH_LOGIN_FAILED','{}'::jsonb)",(str(uuid4()),))
                        return AttemptResult("invalid")
                    await connection.execute("DELETE FROM request_throttle_buckets WHERE scope='owner-login' AND client_digest=%s",
                                             (client_digest,))
                    await connection.execute("DELETE FROM auth_sessions WHERE expires_at <= %s", (now,))
                    count = await (await connection.execute("SELECT count(*) AS count FROM auth_sessions "
                        "WHERE owner_id='owner' AND revoked_at IS NULL AND expires_at>clock_timestamp()")).fetchone()
                    if count["count"]>=100: return AttemptResult("throttled",retry_after=300)
                    expires = now + timedelta(hours=ttl_hours)
                    await connection.execute(
                        "INSERT INTO auth_sessions (id, owner_id, token_digest, expires_at, created_at, user_agent) "
                        "VALUES (%s, 'owner', %s, %s, %s, %s)", (session_id, token_digest, expires, now, user_agent))
                    await connection.execute("INSERT INTO run_events(id,type,payload) VALUES (%s,'AUTH_LOGIN_SUCCEEDED','{\"actor\":\"owner\"}'::jsonb)",(str(uuid4()),))
                    # The connection context commits before this result reaches the caller.
                    return AttemptResult("issued", expires_at=expires)
        except (psycopg.Error, TimeoutError, ValueError, KeyError):
            raise StoreUnavailable("auth_storage_unavailable") from None

    async def _reserve_attempt(self, connection, client_digest):
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
        return None

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
                    revoked=await cursor.fetchone() is not None
                    if revoked:
                        await connection.execute("INSERT INTO run_events(id,type,payload) VALUES (%s,'AUTH_LOGOUT','{\"actor\":\"owner\"}'::jsonb)",(str(uuid4()),))
                    return revoked
        except (psycopg.Error, TimeoutError):
            raise StoreUnavailable("auth_storage_unavailable") from None
