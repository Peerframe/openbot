/** Reads bounded audit projections under the current Owner session. */
import { auditCategorySchema, auditEventSchema, type AuditEvent } from "@openbot/protocol";
import type postgres from "postgres";
import { refuse } from "./owner-transaction.js";

const keys = [
  "name",
  "from",
  "to",
  "actor",
  "reason",
  "emoji",
  "active",
  "decision",
  "removedBotId",
  "deletedMessages",
  "redactedMessages",
  "directBotId",
  "revokedSessions",
  "nodeId",
  "revision",
  "operationId",
  "attachmentId",
  "fileName",
  "sizeBytes",
  "freedBytes",
  "removed",
  "retainedCount",
  "trashAutoPurgeDays",
  "outcome",
  "previousBotId",
  "primaryBotId",
] as const;
const categorySql = String.raw`CASE
 WHEN e.type LIKE 'AUTH\_%' ESCAPE '\' OR e.type LIKE 'OWNER\_%' ESCAPE '\' THEN 'authentication'
 WHEN e.type LIKE 'MODEL\_%' ESCAPE '\' OR e.type LIKE 'SETTINGS\_%' ESCAPE '\' OR e.type='EMPLOYEE_MODEL_UPDATED' THEN 'settings'
 WHEN e.type LIKE 'WORKER_HOST\_%' ESCAPE '\' OR e.type LIKE 'NODE\_%' ESCAPE '\' THEN 'hosts'
 WHEN e.type LIKE '%APPROVAL%' OR e.type LIKE 'ACTION\_%' ESCAPE '\' THEN 'approvals'
 WHEN e.type LIKE 'CHANNEL\_%' ESCAPE '\' OR e.type LIKE 'MESSAGE\_%' ESCAPE '\' OR e.type LIKE '%CHANNEL' THEN 'channels'
 WHEN e.type LIKE 'BOT\_%' ESCAPE '\' OR e.type LIKE 'EMPLOYEE\_%' ESCAPE '\' THEN 'bots'
 WHEN e.type LIKE 'RUN\_%' ESCAPE '\' OR e.type LIKE 'WORK\_%' ESCAPE '\' OR e.type LIKE 'TASK\_%' ESCAPE '\' THEN 'runs'
 WHEN e.type LIKE 'PLUGIN\_%' ESCAPE '\' THEN 'plugins' ELSE 'other' END`;
// Project the retained allowlist inside SQL: private prompts and credentials never enter the driver.
const payloadSql =
  "jsonb_strip_nulls(jsonb_build_object(" +
  keys
    .map(
      (key) =>
        `'${key}',CASE WHEN jsonb_typeof(e.payload->'${key}')='string' THEN to_jsonb(left(e.payload->>'${key}',${key === "fileName" ? 160 : 120})) ` +
        `WHEN (jsonb_typeof(e.payload->'${key}')='boolean' OR jsonb_typeof(e.payload->'${key}')='number' AND (e.payload->'${key}')::text ~ '^-?[0-9]+$') AND octet_length((e.payload->'${key}')::text)<=40 THEN e.payload->'${key}' ELSE NULL END`,
    )
    .join(",") +
  ")) || CASE WHEN e.type='SETTINGS_PRIMARY_BOT_UPDATED' THEN jsonb_build_object(" +
  ["previousBotId", "primaryBotId"]
    .map(
      (key) =>
        `'${key}',CASE WHEN jsonb_typeof(e.payload->'${key}')='string' THEN to_jsonb(left(e.payload->>'${key}',128)) ELSE 'null'::jsonb END`,
    )
    .join(",") +
  ") ELSE '{}'::jsonb END";

function utcDate(year: number, month: number, day: number) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw new Error();
  return date;
}
// Preserve datetime.fromisoformat's calendar/basic/week dates and aware time forms, while passing
// PostgreSQL only a normalized timestamp. In particular no Date millisecond roundtrip loses a cursor.
export function auditCursorTime(source: string): string {
  const datePart =
    /^(?:([0-9]{4})(-?)([0-9]{2})\2([0-9]{2})|([0-9]{4})(-?)W([0-9]{2})(?:\6([1-7]))?)/.exec(
      source,
    );
  if (!datePart) throw new Error();
  const year = Number(datePart[1] ?? datePart[5]);
  if (year < 1 || year > 9999) throw new Error();
  let date: Date;
  if (datePart[1]) date = utcDate(year, Number(datePart[3]), Number(datePart[4]));
  else {
    const week = Number(datePart[7]),
      day = Number(datePart[8] ?? "1");
    const jan4 = utcDate(year, 1, 4),
      first = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000;
    const next4 = utcDate(year + 1, 1, 4),
      next = next4.getTime() - ((next4.getUTCDay() + 6) % 7) * 86400000;
    const start = first + (week - 1) * 7 * 86400000;
    if (week < 1 || start >= next) throw new Error();
    date = new Date(start + (day - 1) * 86400000);
  }
  const rest = [...source.slice(datePart[0].length)].slice(1).join("");
  const aware = /^(.*?)(Z|[+-].*)$/.exec(rest);
  if (!aware) throw new Error();
  const time = parseIsoTime(aware[1]!, false);
  let offset = 0n;
  if (aware[2] !== "Z") {
    const part = aware[2]!,
      value = parseIsoTime(part.slice(1), true);
    offset = value === 0n ? 0n : value * (part[0] === "-" ? -1n : 1n);
  }
  const micros = BigInt(date.getTime()) * 1000n + time - offset;
  const seconds = micros >= 0 ? micros / 1000000n : (micros - 999999n) / 1000000n;
  const value = new Date(Number(seconds) * 1000);
  if (value.getUTCFullYear() < 1 || value.getUTCFullYear() > 9999) throw new Error();
  return (
    value.toISOString().slice(0, 19) +
    "." +
    String(micros - seconds * 1000000n).padStart(6, "0") +
    "Z"
  );
}
function parseIsoTime(value: string, offset: boolean): bigint {
  const match = /^([0-9]{2})(?:(:?)([0-9]{2})(?:\2([0-9]{2}))?)?(?:[.,]([0-9]+))?$/.exec(value);
  if (!match) throw new Error();
  const hour = Number(match[1]),
    minute = Number(match[3] ?? "0"),
    second = Number(match[4] ?? "0");
  const base = hour * 3600 + minute * 60 + second;
  if (offset ? base >= 86400 : hour > 23 || minute > 59 || second > 59) throw new Error();
  // CPython treats fractional zero offsets as UTC (the h/m/s part is zero).
  return (
    BigInt(base) * 1000000n +
    (offset && base === 0 ? 0n : BigInt((match[5] ?? "").slice(0, 6).padEnd(6, "0")))
  );
}
export function auditQuery(query: URLSearchParams, exporting = false) {
  for (const [key] of query)
    if (!["before", "limit", "category"].includes(key) || query.getAll(key).length !== 1)
      refuse(422, "invalid_audit_query");
  const rawLimit = query.get("limit") ?? (exporting ? "1000" : "50");
  const limit = Number(rawLimit);
  if (!/^[0-9]{1,4}$/.test(rawLimit) || limit < 1 || limit > (exporting ? 1000 : 100))
    refuse(422, "invalid_audit_limit");
  const category = query.get("category");
  if (category !== null && !auditCategorySchema.safeParse(category).success)
    refuse(422, "invalid_audit_category");
  let cursor: string | null = null,
    cursorId: string | null = null;
  const before = query.get("before");
  if (before !== null) {
    try {
      const split = before.indexOf("|");
      if ([...before].length > 200 || split < 0) throw new Error();
      cursorId = before.slice(split + 1);
      if ([...cursorId].length < 1 || [...cursorId].length > 128) throw new Error();
      cursor = auditCursorTime(before.slice(0, split));
    } catch {
      return refuse(422, "invalid_audit_cursor");
    }
  }
  return { limit, category, cursor, cursorId };
}
export async function readAudit(
  db: postgres.TransactionSql,
  query: URLSearchParams,
  exporting = false,
) {
  const { limit, category, cursor, cursorId } = auditQuery(query, exporting);
  const rows = await db.unsafe(
    `SELECT left(e.id,129) AS id,left(e.type,65) AS type,e.created_at,
    to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS cursor_time,
    left(e.channel_id,129) AS channel_id,left(e.bot_id,129) AS bot_id,left(e.run_id,129) AS run_id,
    ${payloadSql} AS payload,${categorySql} AS category,
    left(c.name,81) AS channel_name,c.deleted_at IS NOT NULL AS channel_deleted,
    left(b.name,65) AS bot_name,b.deleted_at IS NOT NULL AS bot_deleted,
    left(previous_bot.name,64) AS previous_primary_name,left(primary_bot.name,64) AS primary_name
    FROM run_events e LEFT JOIN channels c ON c.id=e.channel_id LEFT JOIN bots b ON b.id=e.bot_id
    LEFT JOIN bots previous_bot ON e.type='SETTINGS_PRIMARY_BOT_UPDATED' AND previous_bot.id=e.payload->>'previousBotId'
    LEFT JOIN bots primary_bot ON e.type='SETTINGS_PRIMARY_BOT_UPDATED' AND primary_bot.id=e.payload->>'primaryBotId'
    WHERE ($1::timestamptz IS NULL OR (e.created_at,e.id)<($1::timestamptz,$2::text))
    AND ($3::text IS NULL OR (${categorySql})=$3) ORDER BY e.created_at DESC,e.id DESC LIMIT $4`,
    [cursor, cursorId, category, limit + 1],
  );
  const events = rows.slice(0, limit).map((row) => {
    if (
      ["id", "channel_id", "bot_id", "run_id"].some(
        (key) => row[key] != null && [...row[key]].length > 128,
      )
    )
      refuse(503, "audit_projection_limit");
    const details: Record<string, string | number | boolean | null> = {};
    for (const key of keys) {
      const value = row.payload[key];
      if (
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isSafeInteger(value)) ||
        (value === null && ["previousBotId", "primaryBotId"].includes(key))
      )
        details[key] = value;
    }
    if (row.type === "SETTINGS_PRIMARY_BOT_UPDATED") {
      delete details.from;
      delete details.to;
      if (row.previous_primary_name !== null) details.from = row.previous_primary_name;
      if (row.primary_name !== null) details.to = row.primary_name;
    }
    const event: Record<string, unknown> = {
      id: row.id,
      type: [...row.type].slice(0, 64).join(""),
      category: row.category,
      createdAt: row.created_at.toISOString(),
      details,
    };
    for (const [key, column] of [
      ["channelId", "channel_id"],
      ["botId", "bot_id"],
      ["runId", "run_id"],
    ] as const)
      if (row[column] !== null) event[key] = row[column];
    for (const prefix of ["channel", "bot"])
      if (row[prefix + "_name"] !== null) {
        event[prefix + "Name"] = row[prefix + "_name"];
        event[prefix + "Deleted"] = row[prefix + "_deleted"];
      }
    return auditEventSchema.parse(event);
  });
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return { events, ...(last ? { nextBefore: last.cursor_time + "|" + last.id } : {}) };
}
export function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  const trimCodes = new Set([32, 9, 13, 10, 0, 0xfeff]);
  let start = 0;
  while (trimCodes.has(text.charCodeAt(start))) start++;
  return ["=", "+", "-", "@", "\t", "\r", "\n", "＝", "＋", "－", "＠"].includes(text[0] ?? "") ||
    ["=", "+", "-", "@", "＝", "＋", "－", "＠"].includes(text[start] ?? "")
    ? "'" + text
    : text;
}
export function auditCsv(events: readonly AuditEvent[]): Buffer {
  const columns = [
    "id",
    "createdAt",
    "category",
    "type",
    "channelId",
    "channelName",
    "botId",
    "botName",
    "runId",
    "details",
  ] as const;
  const quote = (value: unknown) => '"' + csvCell(value).replaceAll('"', '""') + '"';
  const data = Buffer.from(
    "\ufeff" +
      [
        columns.map(quote).join(","),
        ...events.map((event) =>
          columns
            .map((key) => quote(key === "details" ? JSON.stringify(event.details) : event[key]))
            .join(","),
        ),
      ].join("\r\n") +
      "\r\n",
  );
  if (data.length > 4 * 1024 * 1024) refuse(503, "audit_export_limit");
  return data;
}
