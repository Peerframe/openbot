"""Owner-authorized atomic source messages, recipients, queued runs and audits."""
import re
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from .authority import OwnerTransactions
from .database import StoreUnavailable
from .message_models import project_messages
from .task_inputs import CreateMessageInput
from .task_models import SubmitTaskResult, project_run
from .task_routing import TaskCandidate, TaskValidation, select_assignees

_ATTACHMENT = re.compile(r"\[OpenBot attachment: ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\]", re.IGNORECASE | re.ASCII)


class TaskChannelNotFound(Exception):
    pass


class AttachmentReferencesUnavailable(Exception):
    pass


class TooManyAttachments(Exception):
    pass


def attachment_ids(content: str) -> list[str]:
    values = list(dict.fromkeys(match.group(1).lower() for match in _ATTACHMENT.finditer(content)))
    if len(values) > 8:
        raise TooManyAttachments()
    return values


def task_title(content: str) -> str:
    encoded = content.encode("utf-16-le")
    if len(encoded) <= 160:
        return content
    # Preserve the legacy UTF-16 bound while refusing to split a Unicode scalar at its edge.
    return encoded[:154].decode("utf-16-le", errors="ignore") + "..."


class PostgresTaskStore:
    def __init__(self, dsn: str, *, files=None, work_sources=None, model_connections=None):
        self._transactions = OwnerTransactions(dsn, application_name="openbot-control-tasks")
        self.files = files
        self.work_sources = work_sources
        self.model_connections = model_connections

    async def verify_schema(self) -> None:
        await self._transactions.verify_schema()

    async def submit(self, token: str | None, channel_id: str, value: CreateMessageInput) -> SubmitTaskResult:
        if self.files is not None and attachment_ids(value.content):
            async with self.files.lock():
                return await self._submit(token, channel_id, value)
        return await self._submit(token, channel_id, value)

    async def _submit(self, token: str | None, channel_id: str, value: CreateMessageInput) -> SubmitTaskResult:
        try:
            async with self._transactions.transaction(token) as connection:
                # The file authority lock spans validation and SQL commit, so delete/cleanup
                # cannot race a newly retained task reference. Model text grants no file scope.
                references = attachment_ids(value.content)
                if references:
                    if self.files is None:
                        raise AttachmentReferencesUnavailable()
                    self.files.validate_references(channel_id, references)
                try:
                    value.content.encode("utf-8")
                except UnicodeError:
                    raise TaskValidation("Task text must contain valid Unicode.") from None
                cursor = await connection.execute(
                    "SELECT id,direct_bot_id FROM channels WHERE id=%s FOR UPDATE", (channel_id,))
                channel = await cursor.fetchone()
                if channel is None:
                    raise TaskChannelNotFound()
                if value.replyToMessageId is not None:
                    cursor = await connection.execute(
                        "SELECT id FROM messages WHERE id=%s AND channel_id=%s",
                        (value.replyToMessageId, channel_id))
                    if await cursor.fetchone() is None:
                        raise TaskValidation("The replied message does not belong to this channel.")
                cursor = await connection.execute(
                    "SELECT b.id,b.name,b.role,b.computer_profile AS \"computerProfile\" "
                    "FROM channel_bots cb JOIN bots b ON b.id=cb.bot_id WHERE cb.channel_id=%s "
                    "ORDER BY cb.joined_at,b.created_at,b.id LIMIT 10001 FOR SHARE OF cb,b", (channel_id,))
                candidates = await cursor.fetchall()
                if len(candidates) > 10000:
                    raise StoreUnavailable("task_membership_limit")
                selected = select_assignees([TaskCandidate.model_validate(row) for row in candidates],
                                            value, channel["direct_bot_id"])
                if not 1 <= len(selected) <= 6:
                    raise StoreUnavailable("invalid_task_recipients")
                cursor = await connection.execute(
                    "SELECT greatest(date_trunc('milliseconds',statement_timestamp()), "
                    "coalesce(date_trunc('milliseconds',max(created_at)) + interval '1 millisecond', "
                    "'-infinity'::timestamptz)) AS created_at FROM messages "
                    "WHERE channel_id=%s AND author_type IN ('human','system')", (channel_id,))
                created_at = (await cursor.fetchone())["created_at"]
                message_id, first_run_id = str(uuid4()), str(uuid4())
                title = task_title(value.content)
                cursor = await connection.execute(
                    "INSERT INTO messages(id,channel_id,author_type,reply_to_message_id,run_id,content,created_at) "
                    "VALUES (%s,%s,'human',%s,%s,%s,%s) RETURNING *",
                    (message_id,channel_id,value.replyToMessageId,first_run_id,value.content,created_at))
                message = project_messages([await cursor.fetchone()])[0]
                runs = []
                for index, candidate in enumerate(selected):
                    cursor = await connection.execute(
                        "INSERT INTO runs(id,channel_id,bot_id,source_message_id,execution_profile,instruction,title,status,created_at,updated_at) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,'queued',%s,%s) RETURNING *",
                        (first_run_id if index == 0 else str(uuid4()), channel_id, candidate.id, message_id,
                         candidate.computerProfile, value.content, title, created_at, created_at))
                    run = project_run(await cursor.fetchone())
                    selection = None
                    if self.model_connections is not None:
                        selection = await self.model_connections.in_transaction(connection, candidate.id)
                        await connection.execute('UPDATE runs SET model_selection=%s WHERE id=%s',
                                                 (Jsonb(selection) if selection else None, run.id))
                    if self.work_sources is not None:
                        task = await self.work_sources.admit(connection, run)
                        run = run.model_copy(update={"workTaskId":task["id"]})
                    runs.append(run.model_copy(update={"model":selection}))
                await connection.execute(
                    "INSERT INTO run_events(id,channel_id,type,payload) VALUES (%s,%s,'MESSAGE_CREATED',%s)",
                    (str(uuid4()), channel_id, Jsonb({"messageId": message_id, "authorType": "human"})))
                for run in runs:
                    await connection.execute(
                        "INSERT INTO run_events(id,run_id,channel_id,bot_id,type,payload) "
                        "VALUES (%s,%s,%s,%s,'RUN_CREATED',%s)",
                        (str(uuid4()),run.id,channel_id,run.botId,Jsonb({"sourceMessageId": message_id,
                                                                                "title": title,"executionProfile": run.executionProfile})))
                # The shared context rechecks authority and commits before HTTP or a dispatcher sees it.
                return SubmitTaskResult(message=message, run=runs[0], runs=runs if value.botIds is not None else None)
        except (psycopg.Error, TimeoutError, ValueError, KeyError, TypeError):
            raise StoreUnavailable("task_storage_unavailable") from None
