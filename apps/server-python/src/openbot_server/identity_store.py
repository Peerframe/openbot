"""Owner-authorized identity and audit writes share one PostgreSQL transaction."""
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from .authority import AuthenticationRequired, OwnerTransactions
from .database import StoreUnavailable
from .identity_inputs import CreateBotInput, CreateChannelInput, QuickCreateBotInput
from .models import Bot, Channel, iso_timestamp, project_bot
from .conversations import open_direct_in_transaction
from .control_errors import ControlError


class IdentityConflict(Exception):
    pass


class UnknownMembers(Exception):
    pass


class PostgresIdentityStore:
    def __init__(self, dsn: str, *, model_connections=None):
        self._transactions = OwnerTransactions(dsn)
        self.model_connections = model_connections

    async def verify_schema(self) -> None:
        await self._transactions.verify_schema()

    async def create_bot(self, token: str | None, value: CreateBotInput) -> Bot:
        try:
            async with self._transactions.transaction(token) as connection:
                configuration = {} if value.appearance is None else {"appearance": value.appearance.model_dump(mode="json")}
                selection = value.model
                if selection is None and value.computerProfile in ('model', 'docker-linux'):
                    from .owner_preferences import current_preferences
                    selection = (await current_preferences(connection))['defaultModel']
                if selection is not None:
                    if value.computerProfile not in ('model', 'docker-linux') or self.model_connections is None:
                        raise ValueError('model_selection_unavailable')
                    await self.model_connections.resolve_in_transaction(connection, selection)
                    configuration['model'] = selection
                row = await self._insert_bot(connection, value, configuration)
                # Context exit commits identity AND audit before the result reaches HTTP.
                return project_bot(row)
        except psycopg.errors.UniqueViolation as error:
            if error.diag.constraint_name == "bots_name_idx":
                raise IdentityConflict("A Bot with this name already exists.") from None
            raise StoreUnavailable("identity_storage_unavailable") from None
        except (psycopg.Error, TimeoutError, ValueError, KeyError):
            raise StoreUnavailable("identity_storage_unavailable") from None

    @staticmethod
    async def _insert_bot(connection, value, configuration, *, skip_name_conflict=False):
        cursor = await connection.execute(
            "INSERT INTO bots (id, name, role, status, computer_profile, configuration, created_at, updated_at) "
            "VALUES (%s, %s, %s, 'idle', %s, %s, date_trunc('milliseconds', statement_timestamp()), "
            "date_trunc('milliseconds', statement_timestamp())) "
            + ("ON CONFLICT (name) WHERE deleted_at IS NULL DO NOTHING " if skip_name_conflict else "")
            + "RETURNING *",
            (str(uuid4()), value.name, value.role, value.computerProfile, Jsonb(configuration)))
        row = await cursor.fetchone()
        if row is None:
            return None
        await connection.execute(
            "INSERT INTO employee_evolution_events (id, bot_id, type, title, summary, source, evidence, created_at) "
            "VALUES (%s, %s, 'created', 'Employee created', %s, 'manual', '[]'::jsonb, %s)",
            (str(uuid4()), row["id"], f"{value.name} was created with the {value.role} role.", row["created_at"]))
        await connection.execute(
            "INSERT INTO run_events (id, bot_id, type, payload) VALUES (%s, %s, 'BOT_CREATED', %s)",
            (str(uuid4()), row["id"], Jsonb({"name": value.name, "role": value.role})))
        return row

    async def quick_create_bot(self, token: str | None, value: QuickCreateBotInput):
        from .owner_preferences import current_preferences
        try:
            async with self._transactions.transaction(token) as connection:
                # Database-scoped, transaction-owned lock: independent Server processes agree.
                await connection.execute("SELECT pg_advisory_xact_lock(1869636212, 12)")
                selection = (await current_preferences(connection))["defaultModel"]
                configuration = {"appearance": value.appearance.model_dump(mode="json")}
                if selection is not None:
                    if self.model_connections is None:
                        raise ControlError(503, "model_selection_unavailable")
                    await self.model_connections.resolve_in_transaction(connection, selection)
                    configuration["model"] = selection
                for _ in range(3):
                    cursor = await connection.execute(
                        "SELECT candidate.name FROM generate_series(1, 10001) AS suffix(n) "
                        "CROSS JOIN LATERAL (SELECT CASE WHEN n=1 THEN '新建 Bot' "
                        "ELSE '新建 Bot ' || n::text END AS name) AS candidate "
                        "WHERE NOT EXISTS (SELECT 1 FROM bots WHERE bots.name=candidate.name "
                        "AND deleted_at IS NULL) ORDER BY n LIMIT 1")
                    candidate = await cursor.fetchone()
                    if candidate is None:
                        raise ControlError(409, "quick_bot_name_exhausted")
                    command = CreateBotInput(name=candidate["name"], role="通用助手")
                    # Ordinary creates/renames do not take our advisory lock. The unique index
                    # arbitrates their race; DO NOTHING keeps this transaction usable for retry.
                    row = await self._insert_bot(connection, command, configuration, skip_name_conflict=True)
                    if row is not None:
                        channel = await open_direct_in_transaction(connection, row)
                        return {"bot": project_bot(row), "channel": channel}
                raise ControlError(409, "quick_bot_name_contention")
        except (psycopg.Error, TimeoutError, ValueError, KeyError):
            raise StoreUnavailable("identity_storage_unavailable") from None

    async def create_channel(self, token: str | None, value: CreateChannelInput) -> Channel:
        try:
            async with self._transactions.transaction(token) as connection:
                if value.botIds:
                    cursor = await connection.execute(
                        "SELECT id FROM bots WHERE id=ANY(%s) AND deleted_at IS NULL ORDER BY id FOR KEY SHARE", (value.botIds,))
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
