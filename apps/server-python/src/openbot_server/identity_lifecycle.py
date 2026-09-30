"""Owner rename, permanent content deletion, read cursors and the audit view (ADR-0047).

Every write runs in one :class:`~openbot_server.authority.OwnerTransactions` transaction together
with its ``run_events`` audit row. Deletion removes conversation content but keeps a tombstone row,
because Runs, durable Work, approvals and audit keep referencing the channel or Bot. A target with
active work is refused rather than cancelled on the Owner's behalf.
"""
from contextlib import asynccontextmanager
from datetime import datetime
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, ValidationError

from .authority import OwnerTransactions
from .control_errors import ControlError
from .database import StoreUnavailable
from .identity_inputs import BotName, ChannelName
from .models import iso_timestamp

ACTIVE_STATUSES = ("queued", "assigned", "running", "waiting_approval", "blocked")
REDACTED_CONTENT = "（内容已删除）"
UNREAD_CAP = 99
AUDIT_LIMIT = 100
# Only these payload keys are copied into the audit view; everything else (message text, prompts,
# tool arguments) stays in storage and is never re-exposed through this read.
AUDIT_PAYLOAD_KEYS = ("name", "from", "to", "actor", "reason", "emoji", "active", "decision",
                      "removedBotId", "deletedMessages", "redactedMessages", "directBotId")


class RenameBotInput(BaseModel):
    """``renameBotInputSchema``: a trimmed Bot name with the create limits; unknown keys stripped."""

    model_config = ConfigDict(extra="ignore", strict=True)
    name: BotName


class RenameChannelInput(BaseModel):
    """``renameChannelInputSchema``: a trimmed channel name with the create limits."""

    model_config = ConfigDict(extra="ignore", strict=True)
    name: ChannelName


def _identity(*values):
    if any(not isinstance(value, str) or not 1 <= len(value) <= 128 for value in values):
        raise ControlError(422, "invalid_identity")


def _parse(model, value):
    try:
        return model.model_validate(value)
    except ValidationError:
        raise ControlError(422, "invalid_rename_input") from None


@asynccontextmanager
async def _storage_errors():
    try:
        yield
    except psycopg.errors.UniqueViolation:
        raise ControlError(409, "name_already_exists") from None
    except (psycopg.Error, TimeoutError, ValueError, TypeError, KeyError, StoreUnavailable):
        raise ControlError(503, "identity_lifecycle_unavailable") from None


async def _audit(db, event_type, payload, *, channel_id=None, bot_id=None):
    await db.execute(
        "INSERT INTO run_events(id,channel_id,bot_id,type,payload) VALUES (%s,%s,%s,%s,%s)",
        (str(uuid4()), channel_id, bot_id, event_type, Jsonb(payload)))


async def _refuse_active(db, channel_id):
    row = await (await db.execute(
        "SELECT 1 FROM runs WHERE channel_id=%s AND id IN "
        "(SELECT id FROM runs_work_projection WHERE status=ANY(%s)) LIMIT 1",
        (channel_id, list(ACTIVE_STATUSES)))).fetchone()
    if row is not None:
        raise ControlError(409, "active_work_blocks_delete")


async def _remove_channel_content(db, channel_id):
    """Delete unreferenced messages and redact those durable Work still points at."""
    referenced = (
        "SELECT source_message_id FROM work_sources UNION "
        "SELECT assignment_message_id FROM work_collaborations")
    redacted = await (await db.execute(
        "UPDATE messages SET content=%s WHERE channel_id=%s AND id IN (" + referenced + ") RETURNING id",
        (REDACTED_CONTENT, channel_id))).fetchall()
    deleted = await (await db.execute(
        "DELETE FROM messages WHERE channel_id=%s AND id NOT IN (" + referenced + ") RETURNING id",
        (channel_id,))).fetchall()
    await db.execute("DELETE FROM message_reactions WHERE channel_id=%s", (channel_id,))
    await db.execute("DELETE FROM automations WHERE channel_id=%s", (channel_id,))
    await db.execute("DELETE FROM channel_read_states WHERE channel_id=%s", (channel_id,))
    members = await (await db.execute(
        "DELETE FROM channel_bots WHERE channel_id=%s RETURNING bot_id", (channel_id,))).fetchall()
    await db.execute(
        "UPDATE channels SET description='',deleted_at=date_trunc('milliseconds',statement_timestamp()),"
        "updated_at=date_trunc('milliseconds',statement_timestamp()) WHERE id=%s", (channel_id,))
    return len(deleted), len(redacted), [row["bot_id"] for row in members]


class PostgresIdentityLifecycle:
    def __init__(self, dsn: str):
        self._transactions = OwnerTransactions(dsn, application_name="openbot-control-identity-lifecycle")

    async def verify_schema(self):
        await self._transactions.verify_schema()

    async def rename_channel(self, token, channel_id, value):
        _identity(channel_id)
        command = _parse(RenameChannelInput, value)
        async with _storage_errors(), self._transactions.transaction(token) as db:
            row = await (await db.execute(
                "SELECT name,direct_bot_id FROM channels WHERE id=%s AND deleted_at IS NULL FOR UPDATE",
                (channel_id,))).fetchone()
            if row is None:
                raise ControlError(404, "channel_not_found")
            if row["direct_bot_id"] is not None:
                # A direct conversation is named after its Bot; rename the Bot instead.
                raise ControlError(409, "direct_channel_identity_follows_bot")
            if row["name"] != command.name:
                await db.execute(
                    "UPDATE channels SET name=%s,updated_at=date_trunc('milliseconds',statement_timestamp()) WHERE id=%s",
                    (command.name, channel_id))
                await _audit(db, "CHANNEL_RENAMED", {"actor": "owner", "from": row["name"], "to": command.name},
                             channel_id=channel_id)
            return {"channelId": channel_id, "name": command.name}

    async def rename_bot(self, token, bot_id, value):
        _identity(bot_id)
        command = _parse(RenameBotInput, value)
        async with _storage_errors(), self._transactions.transaction(token) as db:
            row = await (await db.execute(
                "SELECT name FROM bots WHERE id=%s AND deleted_at IS NULL FOR UPDATE", (bot_id,))).fetchone()
            if row is None:
                raise ControlError(404, "bot_not_found")
            if row["name"] != command.name:
                await db.execute(
                    "UPDATE bots SET name=%s,updated_at=date_trunc('milliseconds',statement_timestamp()) WHERE id=%s",
                    (command.name, bot_id))
                # Direct channels are excluded from channel name uniqueness, so this cannot conflict.
                await db.execute(
                    "UPDATE channels SET name=%s,updated_at=date_trunc('milliseconds',statement_timestamp()) "
                    "WHERE direct_bot_id=%s AND deleted_at IS NULL", (command.name, bot_id))
                await _audit(db, "BOT_RENAMED", {"actor": "owner", "from": row["name"], "to": command.name},
                             bot_id=bot_id)
            return {"botId": bot_id, "name": command.name}

    async def delete_channel(self, token, channel_id):
        _identity(channel_id)
        async with _storage_errors(), self._transactions.transaction(token) as db:
            # Same lock order as membership revocation and native claims.
            await db.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,731))", (channel_id,))
            row = await (await db.execute(
                "SELECT name,direct_bot_id FROM channels WHERE id=%s AND deleted_at IS NULL FOR UPDATE",
                (channel_id,))).fetchone()
            if row is None:
                raise ControlError(404, "channel_not_found")
            if row["direct_bot_id"] is not None:
                raise ControlError(409, "direct_channel_identity_follows_bot")
            await _refuse_active(db, channel_id)
            deleted, redacted, members = await _remove_channel_content(db, channel_id)
            await _audit(db, "CHANNEL_DELETED", {"actor": "owner", "name": row["name"], "deletedMessages": deleted,
                                                 "redactedMessages": redacted, "memberCount": len(members)},
                         channel_id=channel_id)
            return {"deleted": True, "channelId": channel_id}

    async def delete_bot(self, token, bot_id):
        _identity(bot_id)
        async with _storage_errors(), self._transactions.transaction(token) as db:
            row = await (await db.execute(
                "SELECT name FROM bots WHERE id=%s AND deleted_at IS NULL FOR UPDATE", (bot_id,))).fetchone()
            if row is None:
                raise ControlError(404, "bot_not_found")
            active = await (await db.execute(
                "SELECT 1 FROM runs WHERE (bot_id=%s OR delegated_by_bot_id=%s) AND id IN "
                "(SELECT id FROM runs_work_projection WHERE status=ANY(%s)) LIMIT 1",
                (bot_id, bot_id, list(ACTIVE_STATUSES)))).fetchone()
            if active is not None:
                raise ControlError(409, "active_work_blocks_delete")
            direct = await (await db.execute(
                "SELECT id FROM channels WHERE direct_bot_id=%s AND deleted_at IS NULL FOR UPDATE", (bot_id,))).fetchone()
            deleted = redacted = 0
            if direct is not None:
                await db.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,731))", (direct["id"],))
                deleted, redacted, _ = await _remove_channel_content(db, direct["id"])
            memberships = await (await db.execute(
                "DELETE FROM channel_bots WHERE bot_id=%s RETURNING channel_id", (bot_id,))).fetchall()
            for membership in memberships:
                await _audit(db, "BOT_REMOVED_FROM_CHANNEL", {"actor": "owner", "reason": "bot_deleted"},
                             channel_id=membership["channel_id"], bot_id=bot_id)
            for table in ("automations", "knowledge_proposals", "employee_memory_events", "employee_memories",
                          "employee_skills", "employee_evolution_events"):
                await db.execute("DELETE FROM " + table + " WHERE bot_id=%s", (bot_id,))
            await db.execute(
                "UPDATE bots SET description='',configuration='{}'::jsonb,"
                "deleted_at=date_trunc('milliseconds',statement_timestamp()),"
                "updated_at=date_trunc('milliseconds',statement_timestamp()) WHERE id=%s", (bot_id,))
            await _audit(db, "BOT_DELETED", {"actor": "owner", "name": row["name"], "deletedMessages": deleted,
                                             "redactedMessages": redacted, "memberships": len(memberships)},
                         bot_id=bot_id)
            return {"deleted": True, "botId": bot_id}

    async def mark_read(self, token, channel_id):
        _identity(channel_id)
        async with _storage_errors(), self._transactions.transaction(token) as db:
            row = await (await db.execute(
                "SELECT id FROM channels WHERE id=%s AND deleted_at IS NULL FOR SHARE", (channel_id,))).fetchone()
            if row is None:
                raise ControlError(404, "channel_not_found")
            result = await (await db.execute(
                "INSERT INTO channel_read_states(channel_id,last_read_at) "
                "VALUES (%s,date_trunc('milliseconds',statement_timestamp())) "
                "ON CONFLICT (channel_id) DO UPDATE SET last_read_at=GREATEST(channel_read_states.last_read_at,EXCLUDED.last_read_at) "
                "RETURNING last_read_at", (channel_id,))).fetchone()
            return {"channelId": channel_id, "lastReadAt": iso_timestamp(result["last_read_at"])}

    async def unread(self, token):
        async with _storage_errors(), self._transactions.transaction(token) as db:
            rows = await (await db.execute(
                "SELECT c.id, (SELECT count(*) FROM (SELECT 1 FROM messages m WHERE m.channel_id=c.id "
                "AND m.author_type<>'human' AND m.created_at > COALESCE(r.last_read_at, c.created_at) "
                "LIMIT %s) capped) AS unread FROM channels c "
                "LEFT JOIN channel_read_states r ON r.channel_id=c.id "
                "WHERE c.deleted_at IS NULL ORDER BY c.id LIMIT 10001",
                (UNREAD_CAP,))).fetchall()
            if len(rows) > 10000:
                raise ControlError(503, "identity_lifecycle_projection_limit")
            return {row["id"]: int(row["unread"]) for row in rows if row["unread"]}

    async def audit(self, token, *, before=None, limit=50):
        if not isinstance(limit, int) or not 1 <= limit <= AUDIT_LIMIT:
            raise ControlError(422, "invalid_audit_limit")
        cursor = None
        if before is not None:
            try:
                cursor = datetime.fromisoformat(before.replace("Z", "+00:00"))
            except (AttributeError, ValueError):
                raise ControlError(422, "invalid_audit_cursor") from None
            if cursor.tzinfo is None:
                raise ControlError(422, "invalid_audit_cursor")
        async with _storage_errors(), self._transactions.transaction(token) as db:
            rows = await (await db.execute(
                "SELECT e.id,e.type,e.created_at,e.channel_id,e.bot_id,e.run_id,e.payload,"
                "left(c.name,81) AS channel_name,c.deleted_at IS NOT NULL AS channel_deleted,"
                "left(b.name,65) AS bot_name,b.deleted_at IS NOT NULL AS bot_deleted "
                "FROM run_events e LEFT JOIN channels c ON c.id=e.channel_id LEFT JOIN bots b ON b.id=e.bot_id "
                "WHERE (%s::timestamptz IS NULL OR e.created_at < %s::timestamptz) "
                "ORDER BY e.created_at DESC,e.id DESC LIMIT %s",
                (cursor, cursor, limit + 1))).fetchall()
            events = []
            for row in rows[:limit]:
                payload = row["payload"] if isinstance(row["payload"], dict) else {}
                details = {key: payload[key] for key in AUDIT_PAYLOAD_KEYS
                           if isinstance(payload.get(key), (str, int, bool)) and not isinstance(payload.get(key), float)}
                details = {key: (value[:120] if isinstance(value, str) else value) for key, value in details.items()}
                event = {"id": row["id"], "type": str(row["type"])[:64], "createdAt": iso_timestamp(row["created_at"]),
                         "details": details}
                for key, column in (("channelId", "channel_id"), ("botId", "bot_id"), ("runId", "run_id")):
                    if row[column] is not None:
                        event[key] = row[column]
                if row["channel_name"] is not None:
                    event["channelName"] = row["channel_name"]
                    event["channelDeleted"] = bool(row["channel_deleted"])
                if row["bot_name"] is not None:
                    event["botName"] = row["bot_name"]
                    event["botDeleted"] = bool(row["bot_deleted"])
                events.append(event)
            next_before = events[-1]["createdAt"] if len(rows) > limit and events else None
            return {"events": events, **({"nextBefore": next_before} if next_before else {})}
