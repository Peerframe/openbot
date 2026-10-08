/** Fixed SQL mirrors the retained Python read contracts; values remain driver parameters. */
export const botsQuery = `SELECT id,name,role,status,computer_profile,
  jsonb_build_object('appearance',configuration->'appearance','model',configuration->'model') AS configuration,created_at
  FROM bots WHERE deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 1001`;
export const channelsQuery = `SELECT c.id,c.name,c.description,c.direct_bot_id,c.created_at,cb.bot_id, coalesce(m.created_at,c.created_at) AS last_activity_at, m.id AS latest_message_id,m.author_type AS latest_author_type, m.preview AS latest_preview,m.created_at AS latest_message_at FROM channels c LEFT JOIN LATERAL (SELECT id,author_type,left(content,160) AS preview,created_at FROM messages WHERE channel_id=c.id ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT 1) m ON true LEFT JOIN channel_bots cb ON cb.channel_id=c.id WHERE c.deleted_at IS NULL ORDER BY coalesce(m.created_at,c.created_at) DESC, c.id COLLATE "C",cb.bot_id COLLATE "C" LIMIT 10001`;
const messageColumns = [
  "id",
  "channel_id",
  "author_type",
  "author_id",
  "reply_to_message_id",
  "run_id",
  "content",
  "origin",
];
const runColumns = [
  "id",
  "parent_run_id",
  "root_run_id",
  "delegated_by_bot_id",
  "channel_id",
  "bot_id",
  "source_message_id",
  "node_id",
  "execution_profile",
  "instruction",
  "title",
  "status",
  "result_summary",
  "error_message",
  "error_code",
  "work_task_id",
];
const size = (columns: string[]) =>
  columns.map((name) => `coalesce(octet_length(${name})::bigint,0)`).join("+");
const bounded = (columns: string[]) =>
  columns
    .map((name) => `CASE WHEN s.byte_count<=4194304 THEN s.${name} ELSE NULL END AS ${name}`)
    .join(",");
export function messagesQuery(
  channelId: string,
  limit: number,
  boundary?: { time: string; id: string },
) {
  // The timestamp parameter is explicitly text: the driver otherwise serializes timestamptz
  // through Date and drops the microseconds that define this pagination boundary.
  return {
    text: `WITH candidates AS MATERIALIZED (SELECT id,created_at FROM messages WHERE channel_id=$1
      ${boundary ? 'AND (created_at,id COLLATE "C") < ($5::text::timestamptz,$6::text COLLATE "C")' : ""}
      ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT $2),
      recent AS MATERIALIZED (SELECT ${messageColumns.map((name) => "m." + name).join(",")},m.created_at
        FROM messages m JOIN candidates p ON p.id=m.id ORDER BY p.created_at DESC,p.id COLLATE "C" DESC LIMIT $3),
      sized AS (SELECT recent.*,sum(${size(messageColumns)}) OVER () AS byte_count FROM recent)
      SELECT true AS channel_exists,(SELECT count(*) > $3 FROM candidates) AS has_more,
        s.created_at,to_char(s.created_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
        s.byte_count>4194304 AS oversized,${bounded(messageColumns)}
      FROM channels c LEFT JOIN sized s ON true WHERE c.id=$4 AND c.deleted_at IS NULL
      ORDER BY s.created_at,s.id COLLATE "C"`,
    values: [
      channelId,
      limit + 1,
      limit,
      channelId,
      ...(boundary ? [boundary.time, boundary.id] : []),
    ],
  };
}
export const runsQuery = `WITH recent AS MATERIALIZED (SELECT ${runColumns.join(",")},model_usage,model_selection,created_at,updated_at
  FROM runs_work_projection WHERE channel_id=$1 ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT 50),
  sized AS (SELECT recent.*,sum(${size(runColumns)}+coalesce(octet_length(model_usage::text)::bigint,0)+coalesce(octet_length(model_selection::text)::bigint,0)) OVER () AS byte_count FROM recent)
  SELECT true AS channel_exists,s.created_at,s.updated_at,s.byte_count>4194304 AS oversized,${bounded(runColumns)},
    CASE WHEN s.byte_count<=4194304 THEN s.model_selection ELSE NULL END AS model_selection,
    CASE WHEN s.byte_count<=4194304 THEN s.model_usage ELSE NULL END AS model_usage
  FROM channels c LEFT JOIN sized s ON true WHERE c.id=$1 AND c.deleted_at IS NULL
  ORDER BY s.created_at DESC,s.id COLLATE "C" DESC`;
