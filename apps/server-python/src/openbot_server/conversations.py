"""Owner-authorized direct conversations and member joins.

Persistence only: the Bot ``FOR UPDATE`` lock serializes direct-conversation creation, the channel
lock plus ``ON CONFLICT DO NOTHING`` keeps joins idempotent, and a new member is the only thing that
writes a ``BOT_JOINED_CHANNEL`` audit event. Session validation, expiry and commit/rollback belong to
the shared :class:`~openbot_server.authority.OwnerTransactions` context, which this store reuses.

Out of scope here: membership removal, task cancellation, message submission, model tools, realtime,
and any HTTP status mapping.
"""
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict

from .authority import OwnerTransactions
from .database import StoreUnavailable
from .identity_inputs import ChannelBotId
from .models import Channel, project_channels

_NOT_FOUND = "Conversation not found."
_MEMBERSHIP_LOCKED = "Direct conversation membership cannot be changed."
_STORAGE_UNAVAILABLE = "conversation_storage_unavailable"
_MEMBER_LIMIT = 10000

_CHANNEL_READ = (
    "SELECT c.id, c.name, c.description, c.direct_bot_id, c.created_at, cb.bot_id "
    "FROM channels c LEFT JOIN channel_bots cb ON cb.channel_id=c.id "
    "WHERE c.id=%s ORDER BY cb.joined_at, cb.bot_id LIMIT " + str(_MEMBER_LIMIT + 1)
)


class JoinChannelInput(BaseModel):
    """``joinChannelBotInputSchema``: one Bot id, unknown keys stripped, no coercion."""

    model_config = ConfigDict(extra="ignore", strict=True)

    botId: ChannelBotId


def parse_join(value: object) -> JoinChannelInput:
    """Validate a join payload; raises ``pydantic.ValidationError`` when Zod would fail."""
    return JoinChannelInput.model_validate(value)


class ConversationNotFound(Exception):
    """The Bot or the channel does not exist; the message is fixed and deliberately generic."""


class DirectMembershipLocked(Exception):
    """A direct conversation has exactly one member and that membership is immutable."""


class PostgresConversationStore:
    def __init__(self, dsn: str):
        self._transactions = OwnerTransactions(dsn, application_name="openbot-control-conversations")

    async def verify_schema(self) -> None:
        await self._transactions.verify_schema()

    async def direct(self, token: str | None, bot_id: str) -> Channel:
        try:
            async with self._transactions.transaction(token) as connection:
                cursor = await connection.execute(
                    "SELECT id, name FROM bots WHERE id=%s FOR UPDATE", (bot_id,))
                bot = await cursor.fetchone()
                if bot is None:
                    raise ConversationNotFound(_NOT_FOUND)
                cursor = await connection.execute(
                    "SELECT id FROM channels WHERE direct_bot_id=%s", (bot_id,))
                existing = await cursor.fetchone()
                channel_id = existing["id"] if existing is not None else str(uuid4())
                if existing is None:
                    cursor = await connection.execute(
                        "INSERT INTO channels (id, name, description, direct_bot_id, created_at, updated_at) "
                        "VALUES (%s, %s, '', %s, date_trunc('milliseconds', statement_timestamp()), "
                        "date_trunc('milliseconds', statement_timestamp())) RETURNING created_at",
                        (channel_id, bot["name"], bot_id))
                    created_at = (await cursor.fetchone())["created_at"]
                    await connection.execute(
                        "INSERT INTO channel_bots (channel_id, bot_id, joined_at) VALUES (%s, %s, %s)",
                        (channel_id, bot_id, created_at))
                    await connection.execute(
                        "INSERT INTO run_events (id, channel_id, type, payload) "
                        "VALUES (%s, %s, 'CHANNEL_CREATED', %s)",
                        (str(uuid4()), channel_id, Jsonb({"name": bot["name"], "directBotId": bot_id})))
                    await connection.execute(
                        "INSERT INTO run_events (id, channel_id, bot_id, type, payload) "
                        "VALUES (%s, %s, %s, 'BOT_JOINED_CHANNEL', '{}'::jsonb)",
                        (str(uuid4()), channel_id, bot_id))
                channel = await self._read(connection, channel_id)
                if channel.botIds != [bot_id]:
                    # An existing direct row must be its own Bot's singleton membership; never repair it.
                    raise StoreUnavailable(_STORAGE_UNAVAILABLE)
                return channel
        except (psycopg.Error, TimeoutError, ValueError, KeyError):
            raise StoreUnavailable(_STORAGE_UNAVAILABLE) from None

    async def join(self, token: str | None, channel_id: str, value: JoinChannelInput) -> Channel:
        bot_id = value.botId
        try:
            async with self._transactions.transaction(token) as connection:
                cursor = await connection.execute(
                    "SELECT direct_bot_id FROM channels WHERE id=%s FOR UPDATE", (channel_id,))
                channel = await cursor.fetchone()
                if channel is None:
                    raise ConversationNotFound(_NOT_FOUND)
                if channel["direct_bot_id"] is not None:
                    raise DirectMembershipLocked(_MEMBERSHIP_LOCKED)
                cursor = await connection.execute(
                    "SELECT id FROM bots WHERE id=%s FOR KEY SHARE", (bot_id,))
                if await cursor.fetchone() is None:
                    raise ConversationNotFound(_NOT_FOUND)
                cursor = await connection.execute(
                    "INSERT INTO channel_bots (channel_id, bot_id, joined_at) "
                    "VALUES (%s, %s, date_trunc('milliseconds', statement_timestamp())) "
                    "ON CONFLICT DO NOTHING RETURNING bot_id",
                    (channel_id, bot_id))
                if await cursor.fetchone() is not None:
                    await connection.execute(
                        "INSERT INTO run_events (id, channel_id, bot_id, type, payload) "
                        "VALUES (%s, %s, %s, 'BOT_JOINED_CHANNEL', '{}'::jsonb)",
                        (str(uuid4()), channel_id, bot_id))
                return await self._read(connection, channel_id)
        except (psycopg.Error, TimeoutError, ValueError, KeyError):
            raise StoreUnavailable(_STORAGE_UNAVAILABLE) from None

    @staticmethod
    async def _read(connection, channel_id: str) -> Channel:
        cursor = await connection.execute(_CHANNEL_READ, (channel_id,))
        rows = await cursor.fetchall()
        if len(rows) > _MEMBER_LIMIT:
            # limit+1 means an oversized channel is an error, never a truncated projection.
            raise StoreUnavailable(_STORAGE_UNAVAILABLE)
        channels = project_channels(rows)
        if len(channels) != 1:
            raise StoreUnavailable(_STORAGE_UNAVAILABLE)
        return channels[0]
