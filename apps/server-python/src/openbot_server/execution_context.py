"""Frozen channel context for a persisted invocation; newly submitted tasks stay separate."""
import psycopg

from .database import StoreUnavailable
from .execution_scope import active_chain
from .execution_values import bounded_text
from .runtime_ports import RuntimeDenied

_PROJECTION = "m.id,m.author_type AS author,m.author_id AS \"authorId\",left(m.content,1600) AS content"


async def context(transactions, run):
    try:
        async with transactions.transaction() as connection:
            await active_chain(connection,run)
            cursor = await connection.execute(
                'SELECT m.id,m.created_at,m.reply_to_message_id,r.root_run_id,rm.created_at AS root_created_at '
                'FROM runs r JOIN messages m ON m.id=r.source_message_id AND m.channel_id=r.channel_id '
                'LEFT JOIN runs rr ON rr.id=r.root_run_id AND rr.channel_id=r.channel_id '
                'LEFT JOIN messages rm ON rm.id=rr.source_message_id AND rm.channel_id=r.channel_id WHERE r.id=%s', (run.id,))
            source = await cursor.fetchone()
            if source is None or (source['root_run_id'] is not None and source['root_created_at'] is None):
                raise RuntimeDenied('invalid_target')
            cursor = await connection.execute("SELECT created_at FROM run_events WHERE run_id=%s AND type='RUN_STARTED' ORDER BY created_at LIMIT 1",(run.id,))
            started = await cursor.fetchone()
            if started is None:
                raise RuntimeDenied('conflict')
            input_cutoff = source['root_created_at'] or source['created_at']
            cursor = await connection.execute(
                f'SELECT {_PROJECTION} FROM messages m WHERE m.channel_id=%s AND (m.id=%s OR m.created_at<=%s '
                "OR (m.author_type='bot' AND m.created_at<=%s AND EXISTS (SELECT 1 FROM runs reply_run "
                'JOIN runs root_run ON root_run.id=coalesce(reply_run.root_run_id,reply_run.id) '
                'JOIN messages root_source ON root_source.id=root_run.source_message_id '
                'WHERE reply_run.id=m.run_id AND reply_run.channel_id=%s AND root_run.channel_id=%s '
                'AND root_source.channel_id=%s AND root_source.created_at<=%s))) '
                'ORDER BY m.created_at DESC,m.id COLLATE "C" DESC LIMIT 12',
                (run.channelId,source['id'],input_cutoff,started['created_at'],run.channelId,run.channelId,run.channelId,input_cutoff))
            rows = await cursor.fetchall()
            if source['reply_to_message_id'] is not None:
                cursor = await connection.execute(f'SELECT {_PROJECTION} FROM messages m WHERE m.id=%s AND m.channel_id=%s',
                                                  (source['reply_to_message_id'],run.channelId))
                reply = await cursor.fetchone()
                if reply is not None:
                    rows = [{**reply,'referenced':True},*(row for row in rows if row['id']!=reply['id'])]
            remaining, selected = 10000, []
            for row in rows:
                row['content'] = bounded_text(row['content'],min(1600,remaining))
                remaining -= len(row['content'].encode('utf-8'))
                if len(row['id'].encode('utf-8'))>128 or (row['authorId'] is not None and len(row['authorId'].encode('utf-8'))>128):
                    raise RuntimeDenied('invalid_target')
                selected.append(row)
            return list(reversed(selected))
    except (psycopg.Error,ValueError,TypeError,KeyError):
        raise StoreUnavailable('execution_storage_unavailable') from None


async def tasks(transactions,run):
    try:
        async with transactions.transaction() as connection:
            await active_chain(connection,run)
            cursor = await connection.execute('SELECT left(title,240) AS title,status FROM runs WHERE channel_id=%s '
                'AND created_at<=(SELECT created_at FROM runs WHERE id=%s) ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT 8',
                (run.channelId,run.id))
            return await cursor.fetchall()
    except (psycopg.Error,ValueError,TypeError,KeyError):
        raise StoreUnavailable('execution_storage_unavailable') from None
