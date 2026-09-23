"""Trusted persisted lifecycle; no Owner-cookie requirement and no model/worker database access."""
from datetime import datetime
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from .authority import PostgresTransactions
from .database import StoreUnavailable
from .execution_scope import active_chain
from .execution_values import FAILURE_MESSAGES
from .identity_inputs import _ECMASCRIPT_WHITESPACE
from .models import iso_timestamp
from .run_command_store import read_steering
from .run_query import read_run_records
from .runtime_ports import RuntimeDenied
from .task_models import Run, RunUsage


async def audit(connection, run, kind, payload, *, event_id=None, created_at=None):
    identity = event_id or str(uuid4())
    cursor = await connection.execute(
        'INSERT INTO run_events(id,run_id,channel_id,bot_id,type,payload,created_at) '
        "VALUES (%s,%s,%s,%s,%s,%s,coalesce(%s,date_trunc('milliseconds',clock_timestamp()))) RETURNING created_at",
        (identity,run.id,run.channelId,run.botId,kind,Jsonb(payload),created_at))
    return identity, (await cursor.fetchone())['created_at']


def timestamp(value):
    try:
        result = datetime.fromisoformat(value.replace('Z','+00:00')) if isinstance(value,str) else value
        if not isinstance(result,datetime) or result.tzinfo is None or result.utcoffset() is None:
            raise ValueError()
        return result
    except (ValueError,TypeError):
        raise RuntimeDenied('invalid_target') from None


class PostgresExecutionStore:
    def __init__(self, dsn):
        self._transactions = PostgresTransactions(dsn)

    async def verify_schema(self):
        await self._transactions.verify_schema()

    async def queued(self, since):
        since = timestamp(since)
        try:
            async with self._transactions.transaction() as connection:
                cursor = await connection.execute("SELECT id FROM runs WHERE status='queued' AND execution_profile='none' "
                    "AND node_id IS NULL AND parent_run_id IS NULL AND created_at>=%s ORDER BY created_at,id COLLATE \"C\" LIMIT 100",(since,))
                ids = [row['id'] for row in await cursor.fetchall()]
                records = await read_run_records(connection,ids)
                return [records[identity] for identity in ids if identity in records]
        except (psycopg.Error,ValueError,TypeError,KeyError):
            raise StoreUnavailable('execution_storage_unavailable') from None

    async def claim(self, candidate: Run, since):
        since = timestamp(since)
        try:
            async with self._transactions.transaction() as connection:
                await connection.execute('SELECT pg_advisory_xact_lock(731,6)')
                cursor = await connection.execute("SELECT id FROM runs WHERE execution_profile='none' AND status='running' AND parent_run_id IS NULL LIMIT 6")
                if len(await cursor.fetchall()) >= 6:
                    return None
                await connection.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,731))',(candidate.channelId,))
                cursor = await connection.execute("SELECT id FROM runs WHERE channel_id=%s AND bot_id=%s "
                    "AND execution_profile='none' AND status='running' LIMIT 1",(candidate.channelId,candidate.botId))
                if await cursor.fetchone():
                    return None
                cursor = await connection.execute('SELECT bot_id FROM channel_bots WHERE channel_id=%s AND bot_id=%s FOR SHARE',
                                                  (candidate.channelId,candidate.botId))
                if await cursor.fetchone() is None:
                    return None
                cursor = await connection.execute("UPDATE runs SET status='running',updated_at=date_trunc('milliseconds',clock_timestamp()) "
                    "WHERE id=%s AND channel_id=%s AND bot_id=%s AND status='queued' AND execution_profile='none' "
                    "AND node_id IS NULL AND parent_run_id IS NULL AND created_at>=%s RETURNING id",
                    (candidate.id,candidate.channelId,candidate.botId,since))
                if await cursor.fetchone() is None:
                    return None
                run = (await read_run_records(connection,[candidate.id]))[candidate.id]
                await audit(connection,run,'RUN_STARTED',{'executor':'native-agent'})
                return run
        except (psycopg.Error,ValueError,TypeError,KeyError):
            raise StoreUnavailable('execution_storage_unavailable') from None

    async def assert_active(self, run: Run):
        try:
            async with self._transactions.transaction() as connection:
                await active_chain(connection,run)
        except (psycopg.Error,ValueError,TypeError,KeyError):
            raise StoreUnavailable('execution_storage_unavailable') from None

    async def current(self, run: Run):
        try:
            async with self._transactions.transaction() as connection:
                record = (await read_run_records(connection,[run.id])).get(run.id)
                if record is None or record.channelId != run.channelId or record.botId != run.botId or record.executionProfile != 'none' or record.nodeId is not None:
                    return None
                return record
        except (psycopg.Error,ValueError,TypeError,KeyError):
            raise StoreUnavailable('execution_storage_unavailable') from None

    async def usage(self, run: Run, value: RunUsage):
        try:
            value = RunUsage.model_validate(value.model_dump())
        except (ValueError,TypeError,AttributeError):
            raise RuntimeDenied('invalid_target') from None
        try:
            async with self._transactions.transaction() as connection:
                await active_chain(connection,run,target_update=True)
                cursor = await connection.execute("UPDATE runs SET model_usage=%s,updated_at=date_trunc('milliseconds',clock_timestamp()) "
                    "WHERE id=%s AND coalesce((model_usage->>'steps')::integer,0)=%s "
                    "AND (model_usage IS NULL OR (model_usage->>'provider'=%s AND model_usage->>'model'=%s)) RETURNING id",
                    (Jsonb(value.model_dump(mode='json')),run.id,value.steps-1,value.provider,value.model))
                if await cursor.fetchone() is None:
                    raise RuntimeDenied('conflict')
                await audit(connection,run,'MODEL_USAGE_RECORDED',{'executor':'native-agent',**value.model_dump(mode='json')})
                return (await read_run_records(connection,[run.id]))[run.id]
        except (psycopg.Error,ValueError,TypeError,KeyError):
            raise StoreUnavailable('execution_storage_unavailable') from None

    async def progress(self, run: Run, stage: str, message: str):
        try:
            if any(type(v) is not str or not v.strip(_ECMASCRIPT_WHITESPACE) or '\0' in v or len(v.encode('utf-8'))>cap
                   for v,cap in ((stage,256),(message,8000))):
                raise ValueError()
        except (ValueError,TypeError):
            raise RuntimeDenied('invalid_target') from None
        try:
            async with self._transactions.transaction() as connection:
                await active_chain(connection,run,target_update=True)
                await connection.execute("UPDATE runs SET updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=%s",(run.id,))
                identity,created = await audit(connection,run,'RUN_PROGRESS',{'stage':stage,'message':message})
                return {'id':identity,'runId':run.id,'channelId':run.channelId,'stage':stage,'message':message,'createdAt':iso_timestamp(created)}
        except (psycopg.Error,ValueError,TypeError,KeyError):
            raise StoreUnavailable('execution_storage_unavailable') from None

    async def steering(self, run: Run):
        try:
            async with self._transactions.transaction() as connection:
                await active_chain(connection,run)
                return [value.model_dump(mode='json') for value in await read_steering(connection,
                    {'id':run.id,'channel_id':run.channelId,'bot_id':run.botId})]
        except (psycopg.Error,ValueError,TypeError,KeyError):
            raise StoreUnavailable('execution_storage_unavailable') from None

    async def fail(self, run: Run, code='execution_failed'):
        if type(code) is not str or code not in FAILURE_MESSAGES:
            raise RuntimeDenied('invalid_target')
        try:
            async with self._transactions.transaction() as connection:
                # Even revoked membership must allow settling an already-running task. No scope
                # grant or successful result is produced by this identity-bound state transition.
                cursor = await connection.execute("UPDATE runs SET status='failed',error_code=%s,error_message=%s,"
                    "updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=%s AND channel_id=%s AND bot_id=%s "
                    "AND status='running' AND execution_profile='none' AND node_id IS NULL RETURNING id",
                    (code,FAILURE_MESSAGES[code],run.id,run.channelId,run.botId))
                if await cursor.fetchone() is None:
                    return None
                cursor = await connection.execute("SELECT id FROM runs WHERE channel_id=%s AND (root_run_id=%s OR parent_run_id=%s) "
                    "AND status IN ('queued','running') AND execution_profile='none' AND node_id IS NULL "
                    "ORDER BY created_at,id COLLATE \"C\" LIMIT 1001 FOR UPDATE",(run.channelId,run.id,run.id))
                descendants = [row['id'] for row in await cursor.fetchall()]
                if len(descendants)>1000:
                    raise RuntimeDenied('task_limit')
                await connection.execute("UPDATE runs SET status='cancelled',updated_at=date_trunc('milliseconds',clock_timestamp()) "
                                         "WHERE id=ANY(%s)",(descendants,))
                records = await read_run_records(connection,[run.id,*descendants])
                await audit(connection,run,'RUN_FAILED',{'code':code,'message':FAILURE_MESSAGES[code],'executor':'native-agent'})
                for identity in descendants:
                    await audit(connection,records[identity],'RUN_CANCELLED',{'executor':'native-agent','actor':'ancestor-failure','ancestorRunId':run.id})
                return records[run.id]
        except (psycopg.Error,ValueError,TypeError,KeyError):
            raise StoreUnavailable('execution_storage_unavailable') from None

    async def complete(self, run: Run, text: str, *, artifacts=(), proposal=None, references=(), skill_references=(), applied_steering_ids=()):
        from .execution_completion import complete
        return await complete(self._transactions,run,text,artifacts=artifacts,proposal=proposal,references=references,
                              skill_references=skill_references,applied_steering_ids=applied_steering_ids)


    async def context(self, run: Run):
        from .execution_context import context
        return await context(self._transactions,run)

    async def tasks(self, run: Run):
        from .execution_context import tasks
        return await tasks(self._transactions,run)
