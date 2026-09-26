"""A single-snapshot channel lookup and bounded recent-message projection."""

# Only fixed identifiers are interpolated. Channel values are driver parameters. Size is checked
# before text leaves PostgreSQL, so a malformed stored value cannot make the driver fetch it whole.
_TEXT_COLUMNS = ("id", "channel_id", "author_type", "author_id", "reply_to_message_id", "run_id", "content")
_BYTE_SIZE = " + ".join(f"coalesce(octet_length({name})::bigint, 0)" for name in _TEXT_COLUMNS)
_BOUNDED_TEXT = ", ".join(
    f"CASE WHEN s.byte_count <= 4194304 THEN s.{name} ELSE NULL END AS {name}"
    for name in _TEXT_COLUMNS
)
MESSAGE_QUERY = (
    "WITH recent AS MATERIALIZED ("
    "SELECT id, channel_id, author_type, author_id, reply_to_message_id, run_id, content, created_at "
    "FROM messages WHERE channel_id=%s ORDER BY created_at DESC, id COLLATE \"C\" DESC LIMIT 100), "
    f"sized AS (SELECT recent.*, sum({_BYTE_SIZE}) OVER () AS byte_count FROM recent) "
    f"SELECT true AS channel_exists, s.created_at, s.byte_count > 4194304 AS oversized, {_BOUNDED_TEXT} "
    "FROM channels c LEFT JOIN sized s ON true WHERE c.id=%s "
    "ORDER BY s.created_at, s.id COLLATE \"C\""
)
