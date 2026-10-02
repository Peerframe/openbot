"""Read existing control-plane facts without dispatching or mutating business state."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal

import psycopg
from psycopg.rows import dict_row

from .control_errors import ControlError
from .channel_query import CHANNEL_QUERY
from .message_query import message_page_query
from .message_pagination import decode_cursor, encode_cursor
from .run_query import RUN_QUERY

Projection = Literal["session", "bots", "channels", "messages", "runs"]
MIGRATIONS = Path(__file__).resolve().parents[4] / "packages/db/migrations"


class StoreUnavailable(Exception):
    """Fixed public category; never expose a DSN or database exception."""


@dataclass(frozen=True)
class ReadResult:
    expires_at: datetime | None
    rows: tuple[dict, ...] = ()
    found: bool = True
    has_more: bool = False
    next_cursor: str | None = None


def expected_history() -> tuple[tuple[int, str], ...]:
    """Use the existing Drizzle history, never a second Python migration journal."""
    journal_path = MIGRATIONS / "meta/_journal.json"
    if journal_path.is_symlink():
        raise StoreUnavailable("schema_unavailable")
    journal = json.loads(journal_path.read_text(encoding="utf-8"))
    if journal.get("version") != "7" or journal.get("dialect") != "postgresql":
        raise StoreUnavailable("schema_unavailable")
    entries = journal.get("entries")
    if not isinstance(entries, list) or not 1 <= len(entries) <= 1000:
        raise StoreUnavailable("schema_unavailable")
    result = []
    tags = []
    for index, entry in enumerate(entries):
        tag = entry.get("tag")
        timestamp = entry.get("when")
        if (
            type(entry.get("idx")) is not int
            or entry.get("idx") != index
            or entry.get("version") != "7"
            or entry.get("breakpoints") is not True
            or type(timestamp) is not int
            or timestamp > 2**53 - 1
            or (result and timestamp <= result[-1][0])
            or not isinstance(tag, str)
            or re.fullmatch(r"[0-9]{4}_[a-z0-9_]+", tag) is None
            or int(tag[:4]) != index
        ):
            raise StoreUnavailable("schema_unavailable")
        path = MIGRATIONS / f"{tag}.sql"
        if path.is_symlink() or not path.is_file():
            raise StoreUnavailable("schema_unavailable")
        sql = path.read_bytes()
        if not sql.decode("utf-8").strip():
            raise StoreUnavailable("schema_unavailable")
        result.append((timestamp, hashlib.sha256(sql).hexdigest()))
        tags.append(path.name)
    if set(tags) != {path.name for path in MIGRATIONS.glob("*.sql")}:
        raise StoreUnavailable("schema_unavailable")
    return tuple(result)


class PostgresReadStore:
    def __init__(self, dsn: str):
        if not dsn:
            raise ValueError("Explicit control-plane database configuration is required.")
        self._dsn = dsn
        self._capacity = asyncio.Semaphore(8)
        self._history = expected_history()

    async def _connect(self):
        # Even an accidentally added write is refused by PostgreSQL for this slice.
        connection = await psycopg.AsyncConnection.connect(
            self._dsn,
            connect_timeout=3,
            row_factory=dict_row,
            options=("-c default_transaction_read_only=on -c statement_timeout=3000 "
                     "-c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000 "
                     "-c search_path=public,pg_catalog -c timezone=UTC"),
        )
        try:
            await connection.set_isolation_level(psycopg.IsolationLevel.READ_COMMITTED)
            await connection.set_read_only(True)
            return connection
        except BaseException:
            await connection.close()
            raise

    async def verify_schema(self) -> None:
        try:
            async with asyncio.timeout(6), self._capacity:
                async with await self._connect() as connection:
                    cursor = await connection.execute(
                        "SELECT created_at, hash FROM drizzle.__drizzle_migrations "
                        "ORDER BY created_at, id"
                    )
                    actual = tuple((int(row["created_at"]), row["hash"]) for row in await cursor.fetchall())
                    if actual != self._history:
                        raise StoreUnavailable("schema_history_mismatch")
        except (psycopg.Error, TimeoutError, ValueError, KeyError):
            raise StoreUnavailable("storage_unavailable") from None

    async def read(self, token: str | None, projection: Projection, *, channel_id: str | None = None,
                   before: str | None = None, limit: int = 100) -> ReadResult:
        if projection not in ("session", "bots", "channels", "messages", "runs"):
            raise ValueError("Unknown read projection.")
        if projection in ("messages", "runs") and (not isinstance(channel_id, str) or not 1 <= len(channel_id) <= 128):
            raise ValueError("A bounded channel identity is required.")
        if type(limit) is not int or not 1 <= limit <= 100 or (projection != 'messages' and (before is not None or limit != 100)):
            raise ValueError('Invalid message pagination.')
        boundary = None if before is None else decode_cursor(before, channel_id)
        if not isinstance(token, str) or re.fullmatch(r"[A-Za-z0-9_-]{43}", token) is None:
            return ReadResult(None)
        digest = hashlib.sha256(token.encode("ascii")).hexdigest()
        try:
            async with asyncio.timeout(6), self._capacity:
                async with await self._connect() as connection:
                    expires = await self._session(connection, digest)
                    if expires is None:
                        return ReadResult(None)
                    if projection == "bots":
                        cursor = await connection.execute(
                            "SELECT id, name, role, status, computer_profile, "
                            "jsonb_build_object('appearance', configuration->'appearance', 'model', configuration->'model') AS configuration, created_at "
                            "FROM bots WHERE deleted_at IS NULL ORDER BY created_at DESC, id LIMIT 1001"
                        )
                    elif projection == "channels":
                        cursor = await connection.execute(CHANNEL_QUERY)
                    elif projection in ("messages", "runs"):
                        query, params = message_page_query(channel_id, limit, boundary) if projection == 'messages' else (RUN_QUERY, (channel_id, channel_id))
                        cursor = await connection.execute(query, params)
                    else:
                        cursor = None
                    rows = tuple(await cursor.fetchall()) if cursor is not None else ()
                    # READ COMMITTED rechecks the current session before exposing data or a
                    # projection-specific error; a logout cannot hide behind the first snapshot.
                    expires = await self._session(connection, digest)
                    if expires is None:
                        return ReadResult(None)
                    found = bool(rows) if projection in ("messages", "runs") else True
                    has_more = bool(rows and rows[0]['has_more']) if projection == 'messages' else False
                    if projection in ("messages", "runs"):
                        if any(row["oversized"] for row in rows):
                            raise StoreUnavailable("projection_limit")
                        # The LEFT JOIN sentinel distinguishes an empty channel from a missing one.
                        rows = tuple(row for row in rows if row["id"] is not None)
                    ceiling = {"messages": limit, "runs": 50, "bots": 1000}.get(projection, 10000)
                    if len(rows) > ceiling:
                        raise StoreUnavailable("projection_limit")
                    try:
                        next_cursor = encode_cursor(channel_id, rows[0]) if has_more and rows else None
                    except ControlError:
                        raise StoreUnavailable('invalid_projection') from None
                    return ReadResult(expires, rows, found, has_more, next_cursor)
        except (psycopg.Error, TimeoutError, ValueError, KeyError):
            raise StoreUnavailable("storage_unavailable") from None

    @staticmethod
    async def _session(connection, digest: str) -> datetime | None:
        cursor = await connection.execute(
            "SELECT expires_at FROM auth_sessions WHERE token_digest=%s AND owner_id='owner' "
            "AND revoked_at IS NULL AND expires_at > clock_timestamp() LIMIT 1",
            (digest,),
        )
        row = await cursor.fetchone()
        return row["expires_at"] if row else None
