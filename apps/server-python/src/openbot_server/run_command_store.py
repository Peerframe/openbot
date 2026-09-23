"""Owner task commands: state and audit commit together before any process notification."""
from dataclasses import dataclass
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from .authority import OwnerTransactions
from .database import StoreUnavailable
from .run_commands import SteeringInstruction, parse_steering, project_steering
from .run_query import read_run_records
from .task_models import Run
from .task_store import TooManyAttachments, attachment_ids


class RunCommandNotFound(Exception):
    pass


class RunCommandConflict(Exception):
    pass


class InvalidRunCommand(Exception):
    pass


class SteeringAttachmentRefused(Exception):
    pass


@dataclass(frozen=True)
class CancelledRuns:
    run: Run
    descendants: tuple[Run, ...]


async def read_steering(connection, run) -> list[SteeringInstruction]:
    """Callers own Run authority/locks; this bounded reader never grants execution permission."""
    cursor = await connection.execute(
        "WITH selected AS MATERIALIZED (SELECT id,run_id,channel_id,bot_id,payload,created_at "
        "FROM run_events WHERE run_id=%s AND channel_id=%s AND bot_id=%s "
        "AND type='RUN_STEERING_SUBMITTED' ORDER BY created_at,id COLLATE \"C\" LIMIT 9) "
        "SELECT id,run_id,channel_id,bot_id,created_at,octet_length(payload::text)>65536 AS oversized, "
        "CASE WHEN octet_length(payload::text)<=65536 THEN payload ELSE NULL END AS payload FROM selected "
        "ORDER BY created_at,id COLLATE \"C\"",
        (run['id'], run['channel_id'], run['bot_id']))
    rows = await cursor.fetchall()
    if len(rows) > 8 or any(row['oversized'] for row in rows):
        raise StoreUnavailable('steering_history_limit')
    return [project_steering(row) for row in rows]


class PostgresRunCommandStore:
    def __init__(self, dsn: str):
        self._transactions = OwnerTransactions(dsn, application_name='openbot-control-run-commands')

    async def verify_schema(self) -> None:
        await self._transactions.verify_schema()

    @staticmethod
    async def _target(connection, run_id):
        cursor = await connection.execute(
            'SELECT id,channel_id,bot_id,execution_profile,node_id,status FROM runs WHERE id=%s FOR UPDATE',
            (run_id,))
        row = await cursor.fetchone()
        if row is None:
            raise RunCommandNotFound()
        return row

    async def cancel(self, token: str | None, run_id: str) -> CancelledRuns:
        try:
            async with self._transactions.transaction(token) as connection:
                row = await self._target(connection, run_id)
                if row['execution_profile'] != 'none' or row['node_id'] is not None:
                    raise RunCommandConflict('Only native Agent tasks can be stopped here.')
                if row['status'] not in ('cancelled', 'queued', 'running'):
                    raise RunCommandConflict('This task has already ended.')
                changed = []
                if row['status'] != 'cancelled':
                    # A target lock also excludes new delegation through this ancestor. Match the
                    # existing root/parent selection, without acquiring the channel advisory lease.
                    cursor = await connection.execute(
                        "SELECT id,channel_id,bot_id FROM runs WHERE channel_id=%s AND id<>%s "
                        "AND execution_profile='none' AND node_id IS NULL AND status IN ('queued','running') "
                        "AND (root_run_id=%s OR parent_run_id=%s) ORDER BY created_at,id COLLATE \"C\" "
                        "LIMIT 1001 FOR UPDATE", (row['channel_id'], run_id, run_id, run_id))
                    changed = await cursor.fetchall()
                    if len(changed) > 1000:
                        raise StoreUnavailable('cancellation_descendant_limit')
                    await connection.execute(
                        "UPDATE runs SET status='cancelled',updated_at=date_trunc('milliseconds',clock_timestamp()) "
                        "WHERE id=ANY(%s)", ([run_id, *(child['id'] for child in changed)],))
                    for item in (row, *changed):
                        payload = {'executor': 'native-agent', 'actor': 'owner'}
                        if item['id'] != run_id:
                            payload['ancestorRunId'] = run_id
                        await connection.execute(
                            "INSERT INTO run_events(id,run_id,channel_id,bot_id,type,payload) "
                            "VALUES (%s,%s,%s,%s,'RUN_CANCELLED',%s)",
                            (str(uuid4()), item['id'], item['channel_id'], item['bot_id'], Jsonb(payload)))
                records = await read_run_records(connection, [run_id, *(item['id'] for item in changed)])
                return CancelledRuns(records[run_id], tuple(records[item['id']] for item in changed))
        except (psycopg.Error, TimeoutError, ValueError, KeyError, TypeError):
            raise StoreUnavailable('run_command_storage_unavailable') from None

    async def steer(self, token: str | None, run_id: str, instruction: str) -> SteeringInstruction:
        try:
            async with self._transactions.transaction(token) as connection:
                try:
                    text = parse_steering({'instruction': instruction}).instruction
                    text.encode('utf-8')
                except (ValueError, TypeError):
                    raise InvalidRunCommand() from None
                try:
                    if attachment_ids(text):
                        raise SteeringAttachmentRefused()
                except TooManyAttachments:
                    raise SteeringAttachmentRefused() from None
                row = await self._target(connection, run_id)
                if row['execution_profile'] != 'none' or row['node_id'] is not None or row['status'] not in ('queued', 'running'):
                    raise RunCommandConflict('Only active native tasks accept additional instructions.')
                cursor = await connection.execute(
                    'SELECT bot_id FROM channel_bots WHERE channel_id=%s AND bot_id=%s FOR SHARE',
                    (row['channel_id'], row['bot_id']))
                if await cursor.fetchone() is None:
                    raise RunCommandConflict('The Bot is no longer a channel member.')
                if len(await read_steering(connection, row)) >= 8:
                    raise RunCommandConflict('A task accepts at most eight additional instructions.')
                cursor = await connection.execute(
                    "INSERT INTO run_events(id,run_id,channel_id,bot_id,type,payload,created_at) "
                    "VALUES (%s,%s,%s,%s,'RUN_STEERING_SUBMITTED',%s,date_trunc('milliseconds',clock_timestamp())) "
                    "RETURNING id,run_id,channel_id,bot_id,payload,created_at",
                    (str(uuid4()), run_id, row['channel_id'], row['bot_id'], Jsonb({'instruction': text, 'actor': 'owner'})))
                return project_steering(await cursor.fetchone())
        except (psycopg.Error, TimeoutError, ValueError, KeyError, TypeError):
            raise StoreUnavailable('run_command_storage_unavailable') from None
