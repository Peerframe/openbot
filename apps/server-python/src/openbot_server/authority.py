"""Bounded database transactions and explicit Owner authorization for HTTP writers."""
import asyncio
from contextlib import asynccontextmanager
import hashlib
import re

import psycopg
from psycopg.rows import dict_row

from .database import PostgresReadStore, StoreUnavailable


class AuthenticationRequired(Exception):
    pass


class PostgresTransactions:
    def __init__(self, dsn: str, *, application_name: str = "openbot-control-execution"):
        if not dsn:
            raise ValueError("Explicit control-plane database configuration is required.")
        self._dsn = dsn
        self._application_name = application_name
        self._capacity = asyncio.Semaphore(4)

    async def verify_schema(self) -> None:
        await PostgresReadStore(self._dsn).verify_schema()

    async def _connect(self):
        connection = await psycopg.AsyncConnection.connect(
            self._dsn, connect_timeout=3, row_factory=dict_row, application_name=self._application_name,
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

    @asynccontextmanager
    async def transaction(self):
        # Connection lifetime is shared; this primitive grants no business authority.
        try:
            async with asyncio.timeout(6), self._capacity:
                async with await self._connect() as connection:
                    yield connection
        except TimeoutError:
            raise StoreUnavailable("authority_transaction_unavailable") from None


class OwnerTransactions(PostgresTransactions):
    def __init__(self, dsn: str, *, application_name: str = "openbot-control-identity"):
        super().__init__(dsn, application_name=application_name)

    @staticmethod
    async def _authorize(connection, digest: str, *, lock: bool = False):
        # SHARE blocks revoked_at UPDATE; KEY SHARE would not protect this authority check.
        cursor = await connection.execute(
            "SELECT id FROM auth_sessions WHERE token_digest=%s AND owner_id='owner' "
            "AND revoked_at IS NULL AND expires_at > clock_timestamp()" + (" FOR SHARE" if lock else ""),
            (digest,))
        if await cursor.fetchone() is None:
            raise AuthenticationRequired()

    @asynccontextmanager
    async def transaction(self, token: str | None):
        if not isinstance(token, str) or re.fullmatch(r"[A-Za-z0-9_-]{43}", token) is None:
            raise AuthenticationRequired()
        digest = hashlib.sha256(token.encode("ascii")).hexdigest()
        try:
            async with asyncio.timeout(6), self._capacity:
                async with await self._connect() as connection:
                    await self._authorize(connection, digest, lock=True)
                    yield connection
                    # Returning from a caller's async-with still runs this check before commit.
                    await self._authorize(connection, digest)
        except TimeoutError:
            raise StoreUnavailable("authority_transaction_unavailable") from None
