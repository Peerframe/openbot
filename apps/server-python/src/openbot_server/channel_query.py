"""Owner-only activity projection; truncate message content before driver transfer."""

CHANNEL_QUERY = (
    "SELECT c.id,c.name,c.description,c.direct_bot_id,c.created_at,cb.bot_id, "
    "coalesce(m.created_at,c.created_at) AS last_activity_at, "
    "m.id AS latest_message_id,m.author_type AS latest_author_type, "
    "m.preview AS latest_preview,m.created_at AS latest_message_at "
    "FROM channels c LEFT JOIN LATERAL ("
    "SELECT id,author_type,left(content,160) AS preview,created_at FROM messages "
    "WHERE channel_id=c.id ORDER BY created_at DESC,id COLLATE \"C\" DESC LIMIT 1"
    ") m ON true LEFT JOIN channel_bots cb ON cb.channel_id=c.id "
    "WHERE c.deleted_at IS NULL ORDER BY coalesce(m.created_at,c.created_at) DESC, "
    "c.id COLLATE \"C\",cb.bot_id COLLATE \"C\" LIMIT 10001"
)
