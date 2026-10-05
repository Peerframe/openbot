"""A single-snapshot channel lookup and bounded recent-message projection."""

# Only fixed identifiers are interpolated. Channel values are driver parameters. Size is checked
# before text leaves PostgreSQL, so a malformed stored value cannot make the driver fetch it whole.
_TEXT_COLUMNS = ("id", "channel_id", "author_type", "author_id", "reply_to_message_id", "run_id", "content", "origin")
_BYTE_SIZE = " + ".join(f"coalesce(octet_length({name})::bigint, 0)" for name in _TEXT_COLUMNS)
_BOUNDED_TEXT = ", ".join(
    f"CASE WHEN s.byte_count <= 4194304 THEN s.{name} ELSE NULL END AS {name}"
    for name in _TEXT_COLUMNS
)
MESSAGE_QUERY = (
    "WITH recent AS MATERIALIZED ("
    "SELECT id, channel_id, author_type, author_id, reply_to_message_id, run_id, content, origin, created_at "
    "FROM messages WHERE channel_id=%s ORDER BY created_at DESC, id COLLATE \"C\" DESC LIMIT 100), "
    f"sized AS (SELECT recent.*, sum({_BYTE_SIZE}) OVER () AS byte_count FROM recent) "
    f"SELECT true AS channel_exists, s.created_at, s.byte_count > 4194304 AS oversized, {_BOUNDED_TEXT} "
    "FROM channels c LEFT JOIN sized s ON true WHERE c.id=%s AND c.deleted_at IS NULL "
    "ORDER BY s.created_at, s.id COLLATE \"C\""
)


def message_page_query(channel_id, limit, boundary):
    # Only fixed SQL is assembled. Values, including the cursor boundary, remain parameters.
    where = '' if boundary is None else 'AND (created_at,id COLLATE "C") < (%s::timestamptz,%s::text COLLATE "C") '
    params = (channel_id,) + (() if boundary is None else boundary) + (limit + 1, limit, limit, channel_id)
    query = (
        'WITH candidates AS MATERIALIZED (SELECT id,created_at FROM messages WHERE channel_id=%s '
        + where + 'ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT %s), '
        'recent AS MATERIALIZED (SELECT m.id,m.channel_id,m.author_type,m.author_id,m.reply_to_message_id,'
        'm.run_id,m.content,m.origin,m.created_at FROM messages m JOIN candidates p ON p.id=m.id '
        'ORDER BY p.created_at DESC,p.id COLLATE "C" DESC LIMIT %s), '
        f'sized AS (SELECT recent.*,sum({_BYTE_SIZE}) OVER () AS byte_count FROM recent) '
        'SELECT true AS channel_exists,(SELECT count(*) > %s FROM candidates) AS has_more,'
        f's.created_at,s.byte_count > 4194304 AS oversized,{_BOUNDED_TEXT} '
        'FROM channels c LEFT JOIN sized s ON true WHERE c.id=%s AND c.deleted_at IS NULL '
        'ORDER BY s.created_at,s.id COLLATE "C"'
    )
    return query, params
