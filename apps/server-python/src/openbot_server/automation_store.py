"""Owner interval schedules and atomic due-task admission; no execution/retry scheduler.

Ported from OpenBot's MIT TypeScript automation store and task submission transaction.
The file lock precedes SQL; SQL owns schedule claims, routing, source messages and audit.
"""
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
import re
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, field_validator

from .authority import OwnerTransactions, PostgresTransactions
from .control_errors import ControlError
from .database import StoreUnavailable
from .identity_inputs import _ECMASCRIPT_WHITESPACE
from .message_models import project_messages
from .models import iso_timestamp
from .task_inputs import CreateMessageInput
from .task_models import project_run
from .task_routing import TaskCandidate, TaskValidation, select_assignees
from .task_store import attachment_ids, task_title, TooManyAttachments

ACTIVE_STATUSES = ("queued", "assigned", "running", "waiting_approval", "blocked")
_DATETIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z")
_TEXT_COLUMNS = ("id", "name", "channel_id", "bot_id", "prompt", "last_run_id", "last_outcome")
# A corrupt identifier must not make even a ten-row claim transfer unbounded text.
_SIZE = "+".join(f"coalesce(octet_length({column})::bigint,0)" for column in _TEXT_COLUMNS)
_COLUMNS = ",".join(f"CASE WHEN ({_SIZE})<=65536 THEN {column} END AS {column}" for column in _TEXT_COLUMNS)
_SELECT = f"{_COLUMNS},({_SIZE})>65536 AS oversized,interval_minutes,enabled,next_run_at,last_run_at,created_at,updated_at"


def _text(value: str, maximum: int, *, trim: bool = False) -> str:
    if trim:
        value = value.strip(_ECMASCRIPT_WHITESPACE)
    try:
        value.encode("utf-8")
        size = len(value.encode("utf-16-le")) // 2
    except UnicodeError:
        raise ValueError("Invalid Unicode text") from None
    if not 1 <= size <= maximum:
        raise ValueError("Text length outside its bound")
    return value


class CreateAutomationInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str
    channelId: str
    botId: str
    prompt: str
    intervalMinutes: int
    firstRunAt: str

    @field_validator("name", "prompt")
    @classmethod
    def bounded_text(cls, value, info):
        return _text(value, 80 if info.field_name == "name" else 8000, trim=True)

    @field_validator("channelId", "botId")
    @classmethod
    def bounded_identity(cls, value):
        return _text(value, 128)

    @field_validator("intervalMinutes", mode="before")
    @classmethod
    def interval(cls, value):
        if type(value) not in (int, float) or not 15 <= value <= 10080 or int(value) != value:
            raise ValueError("Invalid interval")
        return int(value)

    @field_validator("firstRunAt")
    @classmethod
    def first_run(cls, value):
        if _DATETIME.fullmatch(value) is None:
            raise ValueError("Expected UTC ISO datetime")
        datetime.fromisoformat(value)
        return value


def parse_automation(value: object) -> CreateAutomationInput:
    return CreateAutomationInput.model_validate(value)


def next_interval_occurrence(previous: datetime, minutes: int, now: datetime) -> datetime:
    if (type(minutes) is not int or not 15 <= minutes <= 10080
            or any(not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None
                   for value in (previous, now))):
        raise ValueError("Invalid interval occurrence")
    if previous > now:
        return previous
    interval = timedelta(minutes=minutes)
    return previous + ((now - previous) // interval + 1) * interval


def _project(row):
    if row.get("oversized"):
        raise ControlError(503, "automation_projection_limit")
    return {
        "id": row["id"], "name": row["name"], "channelId": row["channel_id"],
        "botId": row["bot_id"], "prompt": row["prompt"], "intervalMinutes": row["interval_minutes"],
        "enabled": row["enabled"], "nextRunAt": iso_timestamp(row["next_run_at"]),
        "lastRunAt": iso_timestamp(row["last_run_at"]) if row["last_run_at"] else None,
        "lastRunId": row["last_run_id"], "lastOutcome": row["last_outcome"],
        "createdAt": iso_timestamp(row["created_at"]),
    }


@asynccontextmanager
async def _storage_errors():
    try:
        yield
    except (psycopg.Error, TimeoutError, ValueError, TypeError, KeyError, StoreUnavailable):
        raise ControlError(503, "automation_storage_unavailable") from None


class PostgresAutomations:
    def __init__(self, dsn: str, *, files=None, work_sources=None, model_connections=None):
        self._transactions = OwnerTransactions(dsn, application_name="openbot-control-automations")
        self._scheduler_transactions = PostgresTransactions(dsn, application_name="openbot-automation-admission")
        self._files = files
        self.work_sources = work_sources
        self.model_connections = model_connections

    async def verify_schema(self):
        await self._transactions.verify_schema()

    @asynccontextmanager
    async def _file_lock(self):
        if self._files is None:
            yield
        else:
            async with self._files.lock():
                yield

    def _validate_files(self, channel_id, prompt):
        try:
            identities = attachment_ids(prompt)
        except TooManyAttachments:
            raise ControlError(400, "invalid_attachment_references") from None
        if identities and self._files is None:
            raise ControlError(503, "attachment_references_unavailable")
        if self._files is not None:
            self._files.validate_references(channel_id, identities)

    async def list(self, token):
        async with _storage_errors(), self._transactions.transaction(token) as db:
            rows = await (await db.execute(f"SELECT {_SELECT} FROM automations ORDER BY created_at DESC LIMIT 50")).fetchall()
            return [_project(row) for row in rows]

    async def create(self, token, value):
        command = parse_automation(value)
        async with _storage_errors(), self._file_lock(), self._transactions.transaction(token) as db:
            await self._bounded(db)
            self._validate_files(command.channelId, command.prompt)
            await db.execute("SELECT pg_advisory_xact_lock(1330660686,1096111153)")
            now = await self._now(db)
            first = datetime.fromisoformat(command.firstRunAt)
            first = first.replace(microsecond=first.microsecond // 1000 * 1000)
            if not now < first <= now + timedelta(days=366):
                raise ControlError(422, "automation_first_run_out_of_range")
            total = await (await db.execute("SELECT count(*) AS total FROM automations")).fetchone()
            if total["total"] >= 50:
                raise ControlError(422, "automation_count_limit")
            await self._membership(db, command.channelId, command.botId)
            row = await (await db.execute(
                "INSERT INTO automations(id,name,channel_id,bot_id,prompt,interval_minutes,next_run_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *",
                (str(uuid4()), command.name, command.channelId, command.botId, command.prompt, command.intervalMinutes, first))).fetchone()
            await self._audit(db, row, "AUTOMATION_CREATED", {"intervalMinutes": row["interval_minutes"], "nextRunAt": iso_timestamp(first), "actor": "owner"})
            return _project(row)

    async def set_enabled(self, token, identity, enabled):
        if type(enabled) is not bool:
            raise ControlError(400, "invalid_automation_update")
        self._identity(identity)
        async with _storage_errors(), self._file_lock(), self._transactions.transaction(token) as db:
            await self._bounded(db)
            row = await (await db.execute(f"SELECT {_SELECT} FROM automations WHERE id=%s FOR UPDATE", (identity,))).fetchone()
            if row is None:
                raise ControlError(404, "automation_not_found")
            _project(row)
            if enabled:
                self._validate_files(row["channel_id"], row["prompt"])
            if row["enabled"] == enabled:
                return _project(row)
            now = await self._now(db)
            if enabled:
                await self._membership(db, row["channel_id"], row["bot_id"])
            next_run = next_interval_occurrence(row["next_run_at"], row["interval_minutes"], now) if enabled else row["next_run_at"]
            row = await (await db.execute(
                "UPDATE automations SET enabled=%s,next_run_at=%s,updated_at=%s WHERE id=%s RETURNING *",
                (enabled, next_run, now, identity))).fetchone()
            await self._audit(db, row, "AUTOMATION_RESUMED" if enabled else "AUTOMATION_PAUSED", {"actor": "owner"})
            return _project(row)

    async def delete(self, token, identity):
        self._identity(identity)
        async with _storage_errors(), self._transactions.transaction(token) as db:
            await self._bounded(db)
            row = await (await db.execute(f"DELETE FROM automations WHERE id=%s RETURNING {_SELECT}", (identity,))).fetchone()
            if row is None:
                raise ControlError(404, "automation_not_found")
            _project(row)
            # Existing Runs retain their ordinary authority and lifecycle after schedule deletion.
            await self._audit(db, row, "AUTOMATION_DELETED", {"actor": "owner"})

    async def submit_due(self):
        """Trusted process entry: admission only, never exposed as an unauthenticated Owner API."""
        async with _storage_errors(), self._file_lock(), self._scheduler_transactions.transaction() as db:
            await self._bounded(db)
            now = await self._now(db)
            due = await (await db.execute(
                f"SELECT {_SELECT} FROM automations WHERE enabled=true AND next_run_at<=%s "
                "ORDER BY next_run_at,id LIMIT 10 FOR UPDATE SKIP LOCKED", (now,))).fetchall()
            submitted = []
            for row in due:
                _project(row)
                previous = (await (await db.execute("SELECT status FROM runs_work_projection WHERE id=%s", (row["last_run_id"],))).fetchone()
                            if row["last_run_id"] is not None else None)
                result, outcome = None, "submitted"
                try:
                    self._validate_files(row["channel_id"], row["prompt"])
                except (ControlError, OSError, ValueError, KeyError):
                    outcome = "attachment_unavailable"
                if outcome == "submitted":
                    if previous and previous["status"] in ACTIVE_STATUSES:
                        outcome = "skipped_active"
                    else:
                        try:
                            result = await self._submit(db, row)
                        except TaskValidation:
                            outcome = "target_unavailable"
                        except ControlError as error:
                            if error.code != "channel_not_found":
                                raise
                            outcome = "target_unavailable"
                next_run = next_interval_occurrence(row["next_run_at"], row["interval_minutes"], now)
                await db.execute(
                    "UPDATE automations SET next_run_at=%s,last_run_at=%s,last_run_id=%s,last_outcome=%s,enabled=%s,updated_at=%s WHERE id=%s",
                    (next_run, now, result["run"]["id"] if result else row["last_run_id"], outcome,
                     outcome not in ("target_unavailable", "attachment_unavailable"), now, row["id"]))
                await self._audit(db, row, "AUTOMATION_OCCURRENCE", {
                    "scheduledFor": iso_timestamp(row["next_run_at"]), "outcome": outcome,
                    "nextRunAt": iso_timestamp(next_run), "actor": "schedule",
                }, result["run"]["id"] if result else None)
                if result:
                    submitted.append(result)
            return submitted

    @staticmethod
    def _identity(identity):
        if not isinstance(identity, str) or not 1 <= len(identity) <= 128:
            raise ControlError(400, "invalid_automation_id")

    @staticmethod
    async def _bounded(db):
        await db.execute("SET LOCAL transaction_timeout='10s'")
        await db.execute("SET LOCAL statement_timeout='10s'")
        await db.execute("SET LOCAL lock_timeout='3s'")

    @staticmethod
    async def _now(db):
        return (await (await db.execute("SELECT date_trunc('milliseconds',now()) AS now")).fetchone())["now"]

    @staticmethod
    async def _membership(db, channel_id, bot_id):
        row = await (await db.execute("SELECT bot_id FROM channel_bots WHERE channel_id=%s AND bot_id=%s", (channel_id, bot_id))).fetchone()
        if row is None:
            raise ControlError(422, "automation_bot_not_member")

    @staticmethod
    async def _audit(db, row, kind, payload, run_id=None):
        await db.execute("INSERT INTO run_events(id,channel_id,bot_id,run_id,type,payload) VALUES (%s,%s,%s,%s,%s,%s)",
                         (str(uuid4()), row["channel_id"], row["bot_id"], run_id, kind, Jsonb({"automationId": row["id"], **payload})))

    async def _submit(self, db, schedule):
        """The schedule claim owns this transaction; reuse routing/projections, not an Owner API."""
        channel_id = schedule["channel_id"]
        channel = await (await db.execute("SELECT id,direct_bot_id FROM channels WHERE id=%s FOR UPDATE", (channel_id,))).fetchone()
        if channel is None:
            raise ControlError(404, "channel_not_found")
        value = CreateMessageInput(content=schedule["prompt"], botId=schedule["bot_id"])
        candidates = await (await db.execute(
            # An automation always names exactly one Bot, so other members and their free text
            # do not participate in routing. Avoid transferring unrelated profile text entirely.
            'SELECT b.id,\'\' AS name,\'\' AS role,b.computer_profile AS "computerProfile" FROM channel_bots cb '
            "JOIN bots b ON b.id=cb.bot_id WHERE cb.channel_id=%s AND b.id=%s "
            "LIMIT 1 FOR SHARE OF cb,b", (channel_id, value.botId))).fetchall()
        selected = select_assignees([TaskCandidate.model_validate(row) for row in candidates], value, channel["direct_bot_id"])
        candidate = selected[0]
        created_at = (await (await db.execute(
            "SELECT greatest(date_trunc('milliseconds',statement_timestamp()), "
            "coalesce(date_trunc('milliseconds',max(created_at))+interval '1 millisecond','-infinity'::timestamptz)) AS created_at "
            "FROM messages WHERE channel_id=%s AND author_type IN ('human','system')", (channel_id,))).fetchone())["created_at"]
        message_id, run_id = str(uuid4()), str(uuid4())
        title = task_title(value.content)
        message = await (await db.execute(
            "INSERT INTO messages(id,channel_id,author_type,run_id,content,created_at) VALUES (%s,%s,'system',%s,%s,%s) RETURNING *",
            (message_id, channel_id, run_id, value.content, created_at))).fetchone()
        run = await (await db.execute(
            "INSERT INTO runs(id,channel_id,bot_id,source_message_id,execution_profile,instruction,title,status,created_at,updated_at) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,'queued',%s,%s) RETURNING *",
            (run_id, channel_id, candidate.id, message_id, candidate.computerProfile, value.content, title, created_at, created_at))).fetchone()
        if self.model_connections is not None:
            selection = await self.model_connections.in_transaction(db, candidate.id)
            await db.execute('UPDATE runs SET model_selection=%s WHERE id=%s',
                             (Jsonb(selection) if selection else None, run_id))
            run['model_selection'] = selection
        if self.work_sources is not None:
            task = await self.work_sources.admit(db, project_run(run))
            run["work_task_id"] = task["id"]
        await db.execute("INSERT INTO run_events(id,channel_id,type,payload) VALUES (%s,%s,'MESSAGE_CREATED',%s)",
                         (str(uuid4()), channel_id, Jsonb({"messageId": message_id, "authorType": "system", "automationId": schedule["id"]})))
        await db.execute("INSERT INTO run_events(id,run_id,channel_id,bot_id,type,payload) VALUES (%s,%s,%s,%s,'RUN_CREATED',%s)",
                         (str(uuid4()), run_id, channel_id, candidate.id, Jsonb({"sourceMessageId": message_id,
                          "automationId": schedule["id"], "title": title, "executionProfile": candidate.computerProfile})))
        return {"message": project_messages([message])[0].model_dump(mode="json", exclude_none=True),
                "run": project_run(run).model_dump(mode="json", exclude_none=True)}
