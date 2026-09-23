"""Owner-authorized identity and audit writes share one PostgreSQL transaction."""
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from .authority import AuthenticationRequired, OwnerTransactions
from .database import StoreUnavailable
from .identity_inputs import CreateBotInput, CreateChannelInput
from .models import Bot, Channel, iso_timestamp, project_bot


class IdentityConflict(Exception):
    pass


class UnknownMembers(Exception):
    pass


class PostgresIdentityStore:
    def __init__(self, dsn: str):
        self._transactions = OwnerTransactions(dsn)

    async def verify_schema(self) -> None:
        await self._transactions.verify_schema()

    async def create_bot(self, token: str | None, value: CreateBotInput) -> Bot:
        try:
            async with self._transactions.transaction(token) as connection:
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
                # Context exit commits identity AND audit before the result reaches HTTP.
                return result
        except psycopg.errors.UniqueViolation as error:
            if error.diag.constraint_name == "bots_name_idx":
                raise IdentityConflict("A Bot with this name already exists.") from None
            raise StoreUnavailable("identity_storage_unavailable") from None
        except (psycopg.Error, TimeoutError, ValueError, KeyError):
            raise StoreUnavailable("identity_storage_unavailable") from None

    async def create_channel(self, token: str | None, value: CreateChannelInput) -> Channel:
        try:
            async with self._transactions.transaction(token) as connection:
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
                return result
        except psycopg.errors.UniqueViolation as error:
            if error.diag.constraint_name == "channels_name_idx":
                raise IdentityConflict("A channel with this name already exists.") from None
            raise StoreUnavailable("identity_storage_unavailable") from None
        except (psycopg.Error, TimeoutError, ValueError, KeyError):
            raise StoreUnavailable("identity_storage_unavailable") from None
