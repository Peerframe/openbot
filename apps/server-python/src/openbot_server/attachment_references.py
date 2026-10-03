"""Owner-only bounded counts and previews over retained channel Message and task identities."""
from datetime import datetime

from .control_errors import ControlError
from .models import iso_timestamp

REFERENCE_LIMIT = 10000
LIST_LIMIT = 100
_MARKER_PATTERN = r'\[openbot attachment: [0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\]'

# Counts come from one SQL snapshot. Match the same canonical marker as task_store.attachment_ids;
# existence counts a record once even if its text repeats the marker. No content leaves PostgreSQL.
# runs are the channel task identities (including delegated runs); work_sources is a 1:1 mapping,
# not another task to add to the count. Owner-native Tasks have a separate attachment namespace.
_QUERY = """
SELECT a.id,
 (SELECT count(*) FROM
   (SELECT 1 FROM messages m WHERE m.channel_id=%s
      AND position('[openbot attachment: ' || a.id || ']' in lower(m.content COLLATE "C"))>0
    LIMIT %s) bounded) AS messages,
 (SELECT count(*) FROM
   (SELECT 1 FROM runs r WHERE r.channel_id=%s
      AND position('[openbot attachment: ' || a.id || ']' in lower(r.instruction COLLATE "C"))>0
    LIMIT %s) bounded) AS tasks
FROM unnest(%s::text[]) AS a(id)
"""


async def with_reference_counts(db, channel_id, attachments):
    if not attachments:
        return []
    if len(attachments) > 1024:
        raise ControlError(503, 'attachment_count_limit')
    rows = await (await db.execute(_QUERY, (channel_id, REFERENCE_LIMIT + 1,
        channel_id, REFERENCE_LIMIT + 1, [item['id'] for item in attachments]))).fetchall()
    counts = {}
    for row in rows:
        if any(type(row[key]) is not int or not 0 <= row[key] <= REFERENCE_LIMIT for key in ('messages', 'tasks')):
            # Never expose a truncated count as exact; this is no grant to clean up a file.
            raise ControlError(503, 'attachment_reference_limit')
        counts[row['id']] = dict(messages=row['messages'], tasks=row['tasks'])
    if len(counts) != len(attachments):
        raise ControlError(503, 'attachment_references_unavailable')
    return [{**item, 'referenceCount': counts[item['id']]} for item in attachments]


_LIST_QUERY = """
WITH message_refs AS MATERIALIZED (
 SELECT id,created_at FROM messages
 WHERE channel_id=%s AND position(%s in lower(content COLLATE "C"))>0 LIMIT %s
), task_refs AS MATERIALIZED (
 SELECT id,created_at FROM runs
 WHERE channel_id=%s AND position(%s in lower(instruction COLLATE "C"))>0 LIMIT %s
), message_page AS (
 SELECT * FROM message_refs ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT %s
), task_page AS (
 SELECT * FROM task_refs ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT %s
)
SELECT (SELECT count(*) FROM message_refs) AS message_count,
 (SELECT count(*) FROM task_refs) AS task_count,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'createdAt',m.created_at,
   'authorType',m.author_type,'authorId',m.author_id,
   'preview',left(btrim(regexp_replace(m.content COLLATE "C",%s,'','gi')),120))
   ORDER BY m.created_at DESC,m.id COLLATE "C" DESC)
   FROM message_page p JOIN messages m ON m.id=p.id),'[]'::jsonb) AS messages,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('runId',r.id,'title',left(r.title,160),
   'status',r.status,'createdAt',r.created_at) ORDER BY r.created_at DESC,r.id COLLATE "C" DESC)
   FROM task_page p JOIN runs r ON r.id=p.id),'[]'::jsonb) AS tasks
"""


async def reference_list(db, channel_id, attachment_id, limit):
    # Counts and both bounded pages share one statement/snapshot; Work mappings add no identity.
    marker = '[openbot attachment: ' + attachment_id.lower() + ']'
    row = await (await db.execute(_LIST_QUERY, (channel_id, marker, REFERENCE_LIMIT + 1,
        channel_id, marker, REFERENCE_LIMIT + 1, limit, limit, _MARKER_PATTERN))).fetchone()
    if row is None: raise ControlError(503, 'attachment_references_unavailable')
    if any(type(row[key]) is not int or not 0 <= row[key] <= REFERENCE_LIMIT for key in ('message_count', 'task_count')):
        raise ControlError(503, 'attachment_reference_limit')
    messages = []
    for item in row['messages']:
        kind = {'human': 'owner', 'bot': 'bot', 'system': 'system'}[item['authorType']]
        author = dict(kind=kind)
        if kind == 'bot' and item['authorId'] is not None: author['botId'] = item['authorId']
        messages.append(dict(id=item['id'], createdAt=iso_timestamp(datetime.fromisoformat(item['createdAt'])),
            author=author, preview=item['preview']))
    tasks = [{**item, 'createdAt': iso_timestamp(datetime.fromisoformat(item['createdAt']))} for item in row['tasks']]
    return dict(messages=messages, tasks=tasks, messageCount=row['message_count'], taskCount=row['task_count'],
        hasMore=row['message_count'] > len(messages) or row['task_count'] > len(tasks))
