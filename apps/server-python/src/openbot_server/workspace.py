"""Owner workspace projection from retained product facts; node presence requires a live registry."""
import json
from datetime import datetime
import psycopg
from .authority import OwnerTransactions
from .database import StoreUnavailable
from .models import project_bot, project_channels, iso_timestamp
from .run_query import read_run_records


def public(value):
    return value.model_dump(mode='json', exclude_none=True)


def approval(row):
    result = {out: row[key] for out, key in [('id','id'),('runId','run_id'),('channelId','channel_id'),
        ('botId','bot_id'),('nodeId','node_id'),('action','action'),('target','target'),('summary','summary'),
        ('risk','risk'),('targetFingerprint','target_fingerprint'),('beforeState','before_state'),('status','status')]}
    for out, key in [('createdAt','created_at'),('expiresAt','expires_at'),('decidedAt','decided_at')]:
        if row[key] is not None: result[out] = iso_timestamp(row[key])
    if row['decided_by'] is not None: result['decidedBy'] = row['decided_by']
    return result


def artifact(row):
    return dict(id=row['id'], runId=row['run_id'], name=row['name'], mediaType=row['media_type'],
        sha256=row['sha256'], sizeBytes=(row['metadata'] or {}).get('sizeBytes', 0),
        createdAt=iso_timestamp(row['created_at']))


async def bounded_rows(db, query, args=(), *, maximum=4*1024*1024):
    # Check the entire bounded relation's encoded bytes in SQL before driver transfer.
    rows = await (await db.execute('WITH selected AS MATERIALIZED (' + query + '), '
        'sized AS (SELECT to_jsonb(selected) AS payload FROM selected) '
        'SELECT CASE WHEN sum(octet_length(payload::text)::bigint) OVER ()<=%s '
        'THEN payload ELSE NULL END AS payload FROM sized', (*args, maximum))).fetchall()
    if any(r['payload'] is None for r in rows):
        raise StoreUnavailable('workspace_projection_limit')
    return [r['payload'] for r in rows]


class WorkspaceTransactions(OwnerTransactions):
    async def _connect(self):
        connection = await super()._connect()
        await connection.set_isolation_level(psycopg.IsolationLevel.REPEATABLE_READ)
        return connection


class PostgresWorkspace:
    def __init__(self, dsn, *, nodes=lambda: []):
        self.transactions = WorkspaceTransactions(dsn)
        self.nodes = nodes

    async def snapshot(self, token):
        async with self.transactions.transaction(token) as db:
            # A single snapshot prevents counts/relationships from crossing concurrent commits.
            bots = await (await db.execute("SELECT id,name,role,status,computer_profile,"
                "jsonb_build_object('appearance',configuration->'appearance','model',configuration->'model') AS configuration,created_at "
                "FROM bots ORDER BY created_at DESC,id LIMIT 1001")).fetchall()
            channels = await (await db.execute('SELECT c.id,c.name,c.description,c.direct_bot_id,c.created_at,'
                'cb.bot_id FROM channels c LEFT JOIN channel_bots cb ON cb.channel_id=c.id '
                'ORDER BY c.created_at DESC,c.id,cb.bot_id LIMIT 10001')).fetchall()
            if len(bots)>1000 or len(channels)>10000:
                raise StoreUnavailable('workspace_projection_limit')
            ids = [r['id'] for r in await (await db.execute('SELECT id FROM runs ORDER BY created_at DESC,id DESC LIMIT 50')).fetchall()]
            records = await read_run_records(db, ids)
            approvals = await bounded_rows(db, 'SELECT a.*,r.channel_id,r.bot_id FROM approvals a '
                'JOIN runs r ON r.id=a.run_id ORDER BY a.created_at DESC,a.id LIMIT 100')
            artifacts = await bounded_rows(db, 'SELECT * FROM artifacts ORDER BY created_at DESC,id LIMIT 100')
            progress_rows = await bounded_rows(db, "SELECT id,run_id,channel_id,node_id,payload,created_at "
                "FROM run_events WHERE type='RUN_PROGRESS' ORDER BY created_at DESC,id LIMIT 200")
            counts = await (await db.execute("SELECT (SELECT count(*) FROM channels) AS channels, "
                "(SELECT count(*) FROM bots) AS bots, (SELECT count(*) FROM runs_work_projection WHERE status IN "
                "('queued','assigned','running','waiting_approval','blocked')) AS active_runs")).fetchone()
            nodes = self.nodes()
            progress = []
            for row in reversed(progress_rows):
                payload = row['payload'] or {}
                if row['run_id'] and row['channel_id'] and isinstance(payload.get('stage'),str) and isinstance(payload.get('message'),str):
                    item = dict(id=row['id'],runId=row['run_id'],channelId=row['channel_id'],
                        stage=payload['stage'],message=payload['message'],createdAt=iso_timestamp(datetime.fromisoformat(row['created_at'])))
                    if row['node_id']: item['nodeId'] = row['node_id']
                    progress.append(item)
            # JSON projections already encode timestamps; normalize to the same ISO millisecond form.
            for row in approvals:
                for key in ('created_at','expires_at','decided_at'):
                    if row[key] is not None: row[key] = datetime.fromisoformat(row[key])
            for row in artifacts: row['created_at'] = datetime.fromisoformat(row['created_at'])
            result = dict(bots=[public(project_bot(r)) for r in bots], channels=[public(c) for c in project_channels(tuple(channels))],
                nodes=nodes, runs=[public(records[i]) for i in ids], approvals=[approval(r) for r in approvals],
                artifacts=[artifact(r) for r in artifacts], progress=progress,
                counts=dict(channels=counts['channels'],bots=counts['bots'],activeRuns=counts['active_runs'],connectedNodes=len(nodes)))
            if len(json.dumps(result,ensure_ascii=False).encode())>4*1024*1024:
                raise StoreUnavailable('workspace_projection_limit')
            return result
