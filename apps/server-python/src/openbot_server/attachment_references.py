"""Owner-only metadata projection over retained channel Message and task identities."""
from .control_errors import ControlError

REFERENCE_LIMIT = 10000

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
