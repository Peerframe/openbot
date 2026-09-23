"""Owner-authorized identity and audit writes share one PostgreSQL transaction."""
import asyncio
import hashlib
import re
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .database import PostgresReadStore, StoreUnavailable
from .identity_inputs import CreateBotInput, CreateChannelInput
from .models import Bot, Channel, iso_timestamp, project_bot


class AuthenticationRequired(Exception):
    pass


class IdentityConflict(Exception):
    pass


class UnknownMembers(Exception):
    pass


class PostgresIdentityStore:
    def __init__(self, dsn: str):
        if not dsn:
            raise ValueError("Explicit control-plane database configuration is required.")
        self._dsn = dsn
        self._capacity = asyncio.Semaphore(4)

    async def verify_schema(self) -> None:
        await PostgresReadStore(self._dsn).verify_schema()

    async def _connect(self):
        connection = await psycopg.AsyncConnection.connect(
            self._dsn, connect_timeout=3, row_factory=dict_row, application_name="openbot-control-identity",
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

    @staticmethod
    def _digest(token: str | None) -> str:
        if not isinstance(token, str) or re.fullmatch(r"[A-Za-z0-9_-]{43}", token) is None:
            raise AuthenticationRequired()
        return hashlib.sha256(token.encode("ascii")).hexdigest()

    @staticmethod
    async def _authorize(connection, digest: str, *, lock: bool = False):
        # SHARE blocks revoked_at UPDATE; KEY SHARE would not protect this authority check.
        cursor = await connection.execute(
            "SELECT id FROM auth_sessions WHERE token_digest=%s AND owner_id='owner' "
            "AND revoked_at IS NULL AND expires_at > clock_timestamp()" + (" FOR SHARE" if lock else ""),
            (digest,))
        if await cursor.fetchone() is None:
            raise AuthenticationRequired()

    async def create_bot(self, token: str | None, value: CreateBotInput) -> Bot:
        digest = self._digest(token)
        try:
            async with asyncio.timeout(6), self._capacity:
                async with await self._connect() as connection:
                    await self._authorize(connection, digest, lock=True)
                    configuration = {} if value.appearance is None else {"appearance": value.appearance.model_dump(mode="json")}
                    cursor = await connection.execute(
                        "INSERT INTO bots (id, name, role, status, computer_profile, configuration, created_at, updated_at) "
                        "VALUES (%s, %s, %s, 'idle', %s, %s, date_trunc('milliseconds', statement_timestamp()), "
                        "date_trunc('milliseconds', statement_timestamp())) RETURNING *",
                        (str(uuid4()), value.name, value.role, value.computerProfile, Jsonb(configuration)))
                    row = await cursor.fetchone()
                    await connection.execute(
                        "INSERT INTO employee_evolution_events (id, bot_id, type, title, summary, source, evidence, created_at) "
                        "VALUES (%s, %s, 'created', 'Employee created', %s, 'manual', '[]'::jsonb, %s)",
                        (str(uuid4()), row["id"], f"{value.name} was created with the {value.role} role.", row["created_at"]))
                    await connection.execute(
                        "INSERT INTO run_events (id, bot_id, type, payload) VALUES (%s, %s, 'BOT_CREATED', %s)",
                        (str(uuid4()), row["id"], Jsonb({"name": value.name, "role": value.role})))
                    result = project_bot(row)
                    await self._authorize(connection, digest)
                    # Context exit commits identity AND audit before the result reaches HTTP.
                    return result
        except psycopg.errors.UniqueViolation as error:
            if error.diag.constraint_name == "bots_name_idx":
                raise IdentityConflict("A Bot with this name already exists.") from None
            raise StoreUnavailable("identity_storage_unavailable") from None
        except (psycopg.Error, TimeoutError, ValueError, KeyError):
            raise StoreUnavailable("identity_storage_unavailable") from None

    async def create_channel(self, token: str | None, value: CreateChannelInput) -> Channel:
        digest = self._digest(token)
        try:
            async with asyncio.timeout(6), self._capacity:
                async with await self._connect() as connection:
                    await self._authorize(connection, digest, lock=True)
                    if value.botIds:
                        cursor = await connection.execute(
                            "SELECT id FROM bots WHERE id=ANY(%s) ORDER BY id FOR KEY SHARE", (value.botIds,))
                        if len(await cursor.fetchall()) != len(value.botIds):
                            raise UnknownMembers()
                    cursor = await connection.execute(
                        "INSERT INTO channels (id, name, description, created_at, updated_at) "
                        "VALUES (%s, %s, %s, date_trunc('milliseconds', statement_timestamp()), "
                        "date_trunc('milliseconds', statement_timestamp())) RETURNING id, created_at",
                        (str(uuid4()), value.name, value.description))
                    row = await cursor.fetchone()
                    await connection.execute(
                        "INSERT INTO run_events (id, channel_id, type, payload) VALUES (%s, %s, 'CHANNEL_CREATED', %s)",
                        (str(uuid4()), row["id"], Jsonb({"name": value.name})))
                    for bot_id in value.botIds:
                        await connection.execute(
                            "INSERT INTO channel_bots (channel_id, bot_id, joined_at) VALUES (%s, %s, %s)",
                            (row["id"], bot_id, row["created_at"]))
                        await connection.execute(
                            "INSERT INTO run_events (id, channel_id, bot_id, type, payload) "
                            "VALUES (%s, %s, %s, 'BOT_JOINED_CHANNEL', '{}'::jsonb)",
                            (str(uuid4()), row["id"], bot_id))
                    result = Channel(id=row["id"], name=value.name, description=value.description,
                                     botIds=value.botIds, createdAt=iso_timestamp(row["created_at"]))
                    await self._authorize(connection, digest)
                    return result
        except psycopg.errors.UniqueViolation as error:
            if error.diag.constraint_name == "channels_name_idx":
                raise IdentityConflict("A channel with this name already exists.") from None
            raise StoreUnavailable("identity_storage_unavailable") from None
        except (psycopg.Error, TimeoutError, ValueError, KeyError):
            raise StoreUnavailable("identity_storage_unavailable") from None
