"""Owner reactions and atomic group membership revocation.

Port of OpenBot's MIT channel-interactions-store.ts. Runtime cancellation signals are the
composition root's responsibility after this transaction commits, never a fabricated side effect.
"""
from contextlib import asynccontextmanager
from typing import Literal
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict

from .authority import OwnerTransactions
from .control_errors import ControlError
from .database import StoreUnavailable
from .models import iso_timestamp
from .run_query import read_run_records

REACTION_EMOJIS = ("👍", "❤️", "😂", "🎉", "🤔", "👀")
ACTIVE_STATUSES = ("queued", "assigned", "running", "waiting_approval", "blocked")


class SetMessageReaction(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    emoji: Literal["👍", "❤️", "😂", "🎉", "🤔", "👀"]
    active: bool


def parse_reaction(value: object) -> SetMessageReaction:
    return SetMessageReaction.model_validate(value)


def _identity(*values):
    if any(not isinstance(value, str) or not 1 <= len(value) <= 128 for value in values):
        raise ControlError(400, "invalid_channel_interaction_identity")


def _reactions(rows):
    result = []
    for row in rows:
        if row["emoji"] not in REACTION_EMOJIS:
            raise ControlError(503, "invalid_stored_reaction")
        result.append({"messageId": row["message_id"], "emoji": row["emoji"], "actor": "owner"})
    return result


def revoked_run_ids(active, bot_id):
    """Depth is the existing delegated-run bound; root links also revoke remote descendants."""
    revoked = {row["id"] for row in active if row["bot_id"] == bot_id}
    for _ in range(3):
        for row in active:
            if row["parent_run_id"] in revoked or row["root_run_id"] in revoked:
                revoked.add(row["id"])
    return [row["id"] for row in active if row["id"] in revoked]


@asynccontextmanager
async def _storage_errors():
    try:
        yield
    except (psycopg.Error, TimeoutError, ValueError, TypeError, KeyError, StoreUnavailable):
        raise ControlError(503, "channel_interaction_unavailable") from None


class PostgresConversationInteractions:
    def __init__(self, dsn: str, *, work_sources=None):
        self._transactions = OwnerTransactions(dsn, application_name="openbot-control-interactions")
        self.work_sources = work_sources

    async def verify_schema(self):
        await self._transactions.verify_schema()

    async def list_reactions(self, token, channel_id):
        _identity(channel_id)
        async with _storage_errors(), self._transactions.transaction(token) as db:
            channel = await (await db.execute("SELECT id FROM channels WHERE id=%s", (channel_id,))).fetchone()
            if channel is None:
                raise ControlError(404, "channel_not_found")
            rows = await (await db.execute(
                "SELECT left(message_id,129) AS message_id,emoji FROM message_reactions WHERE channel_id=%s AND message_id IN "
                "(SELECT id FROM messages WHERE channel_id=%s ORDER BY created_at DESC LIMIT 100) LIMIT 600",
                (channel_id, channel_id))).fetchall()
            if any(len(row["message_id"]) > 128 for row in rows):
                raise ControlError(503, "channel_interaction_projection_limit")
            return _reactions(rows)

    async def set_reaction(self, token, channel_id, message_id, value):
        _identity(channel_id, message_id)
        command = parse_reaction(value)
        async with _storage_errors(), self._transactions.transaction(token) as db:
            row = await (await db.execute("SELECT id FROM messages WHERE id=%s AND channel_id=%s FOR UPDATE", (message_id, channel_id))).fetchone()
            if row is None:
                raise ControlError(404, "message_not_found_in_channel")
            if command.active:
                cursor = await db.execute(
                    "INSERT INTO message_reactions(message_id,channel_id,emoji) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING RETURNING message_id",
                    (message_id, channel_id, command.emoji))
            else:
                cursor = await db.execute("DELETE FROM message_reactions WHERE message_id=%s AND channel_id=%s AND emoji=%s RETURNING message_id",
                                          (message_id, channel_id, command.emoji))
            if await cursor.fetchone() is not None:
                await db.execute("INSERT INTO run_events(id,channel_id,type,payload) VALUES (%s,%s,'MESSAGE_REACTION_CHANGED',%s)",
                                 (str(uuid4()), channel_id, Jsonb({"messageId": message_id, "emoji": command.emoji, "active": command.active, "actor": "owner"})))
            rows = await (await db.execute("SELECT message_id,emoji FROM message_reactions WHERE channel_id=%s AND message_id=%s LIMIT 6",
                                          (channel_id, message_id))).fetchall()
            return _reactions(rows)

    async def remove_member(self, token, channel_id, bot_id):
        _identity(channel_id, bot_id)
        async with _storage_errors(), self._transactions.transaction(token) as db:
            # Match native claim/delegation/completion lock order; revoke before deleting membership.
            await db.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,731))", (channel_id,))
            channel = await (await db.execute(
                "SELECT id,left(name,81) AS name,left(description,501) AS description,direct_bot_id,created_at "
                "FROM channels WHERE id=%s FOR UPDATE", (channel_id,))).fetchone()
            if channel is None:
                raise ControlError(404, "channel_not_found")
            if channel["direct_bot_id"]:
                raise ControlError(409, "direct_channel_membership_immutable")
            if len(channel["name"]) > 80 or len(channel["description"]) > 500:
                raise ControlError(503, "channel_interaction_projection_limit")
            active = await (await db.execute(
                "SELECT left(id,129) AS id,left(bot_id,129) AS bot_id,left(parent_run_id,129) AS parent_run_id,left(root_run_id,129) AS root_run_id "
                "FROM runs WHERE channel_id=%s AND id IN (SELECT id FROM runs_work_projection WHERE status=ANY(%s)) ORDER BY created_at,id LIMIT 1001 FOR UPDATE",
                (channel_id, list(ACTIVE_STATUSES)))).fetchall()
            if len(active) > 1000:
                raise ControlError(409, "too_many_active_tasks")
            if any(value is not None and len(value) > 128 for row in active for value in row.values()):
                raise ControlError(503, "channel_interaction_projection_limit")
            identities = revoked_run_ids(active, bot_id)
            if identities:
                if self.work_sources is None:
                    mapped = await (await db.execute('SELECT 1 FROM work_sources WHERE legacy_run_id=ANY(%s) LIMIT 1',
                                                     (identities,))).fetchone()
                    if mapped:
                        raise ControlError(503, 'durable_work_commands_unconfigured')
                if self.work_sources is not None:
                    await self.work_sources.cancel(db, identities)
                await db.execute("UPDATE runs SET status='cancelled',updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=ANY(%s)", (identities,))
                await db.execute("UPDATE approvals SET status='expired',decided_at=date_trunc('milliseconds',clock_timestamp()),decided_by='owner' "
                                 "WHERE run_id=ANY(%s) AND status='pending'", (identities,))
                for row in active:
                    if row["id"] in identities:
                        await db.execute("INSERT INTO run_events(id,run_id,channel_id,bot_id,type,payload) VALUES (%s,%s,%s,%s,'RUN_CANCELLED',%s)",
                                         (str(uuid4()), row["id"], channel_id, row["bot_id"],
                                          Jsonb({"actor": "owner", "reason": "channel_member_removed", "removedBotId": bot_id})))
            removed = await (await db.execute("DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s RETURNING bot_id", (channel_id, bot_id))).fetchone()
            if removed:
                await db.execute("INSERT INTO run_events(id,channel_id,bot_id,type,payload) VALUES (%s,%s,%s,'BOT_REMOVED_FROM_CHANNEL',%s)",
                                 (str(uuid4()), channel_id, bot_id, Jsonb({"actor": "owner", "cancelledRunIds": identities})))
            members = await (await db.execute("SELECT left(bot_id,129) AS bot_id FROM channel_bots WHERE channel_id=%s ORDER BY joined_at,bot_id LIMIT 10001", (channel_id,))).fetchall()
            if len(members) > 10000 or any(len(row["bot_id"]) > 128 for row in members):
                raise ControlError(503, "channel_interaction_projection_limit")
            cancelled = await read_run_records(db, identities) if identities else {}
            return {"channel": {"id": channel["id"], "name": channel["name"], "description": channel["description"],
                                "createdAt": iso_timestamp(channel["created_at"]), "botIds": [row["bot_id"] for row in members]},
                    "cancelledRuns": [cancelled[identity].model_dump(mode="json", exclude_none=True) for identity in identities]}
