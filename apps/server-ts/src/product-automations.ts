import { randomUUID } from "node:crypto";
import {
  automationSchema,
  createAutomationRequestSchema,
  updateAutomationRequestSchema,
} from "@openbot/protocol";
import type postgres from "postgres";
import type { OwnerFiles, FileSession } from "./owner-files.js";
import { employeeTime } from "./employee-records.js";
import { parseEmployee } from "./employee-input.js";
import { refuse } from "./owner-transaction.js";
import { WriteFailure } from "./primary-bot-write.js";
import type { ProductRoute } from "./product-identity.js";

type DB = postgres.TransactionSql;
type Row = Record<string, any>;
const columns = ["id", "name", "channel_id", "bot_id", "prompt", "last_run_id", "last_outcome"];
const size = columns.map((c) => `coalesce(octet_length(${c})::bigint,0)`).join("+");
const selection =
  columns.map((c) => `CASE WHEN (${size})<=65536 THEN ${c} END AS ${c}`).join(",") +
  `,(${size})>65536 AS oversized,interval_minutes,enabled,next_run_at,last_run_at,created_at,updated_at`;
const projection = (row: Row) => {
  if (row.oversized) refuse(503, "automation_projection_limit");
  return automationSchema.parse({
    id: row.id,
    name: row.name,
    channelId: row.channel_id,
    botId: row.bot_id,
    prompt: row.prompt,
    intervalMinutes: row.interval_minutes,
    enabled: row.enabled,
    nextRunAt: employeeTime(row.next_run_at),
    lastRunAt: row.last_run_at == null ? null : employeeTime(row.last_run_at),
    lastRunId: row.last_run_id,
    lastOutcome: row.last_outcome,
    createdAt: employeeTime(row.created_at),
  });
};
export function automationReferences(session: FileSession, channelId: string, prompt: string) {
  const ids = [
    ...new Set(
      [
        ...prompt.matchAll(
          /\[OpenBot attachment: ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\]/gi,
        ),
      ].map((m) => m[1]!.toLowerCase()),
    ),
  ];
  if (ids.length > 8) refuse(400, "invalid_attachment_references");
  let bytes = 0;
  for (const id of ids) {
    const { item } = session.content(channelId, id);
    if (item.deletedAt) refuse(400, "deleted_attachment");
    bytes += item.sizeBytes;
    if (bytes > 20 * 1024 * 1024) refuse(413, "task_attachment_limit");
    if (item.processing) {
      const derived = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          session.read(id + ".text.json", 2 * 1024 * 1024),
        ),
      );
      if (
        derived.sha256 !== item.sha256 ||
        typeof derived.text !== "string" ||
        !derived.text.trim()
      )
        refuse(404, "processed_attachment_unavailable");
    }
  }
}
async function bounded(db: DB) {
  await db`SET LOCAL transaction_timeout='10s'`;
  await db`SET LOCAL statement_timeout='10s'`;
  await db`SET LOCAL lock_timeout='3s'`;
}
async function membership(db: DB, channel: string, bot: string) {
  if (
    !(await db`SELECT bot_id FROM channel_bots WHERE channel_id=${channel} AND bot_id=${bot}`)
      .length
  )
    refuse(422, "automation_bot_not_member");
}
async function audit(db: DB, row: Row, type: string, payload: Record<string, unknown>) {
  await db`INSERT INTO run_events(id,channel_id,bot_id,type,payload) VALUES(${randomUUID()},${row.channel_id},${row.bot_id},${type},${db.json({ automationId: row.id, ...payload } as postgres.JSONValue)})`;
}
async function create(
  db: DB,
  session: FileSession,
  value: ReturnType<typeof createAutomationRequestSchema.parse>,
) {
  await bounded(db);
  automationReferences(session, value.channelId, value.prompt);
  await db`SELECT pg_advisory_xact_lock(1330660686,1096111153)`;
  const first = new Date(value.firstRunAt);
  const [range] =
    await db`SELECT date_trunc('milliseconds',now())<${first} AND ${first}<=date_trunc('milliseconds',now())+interval '366 days' AS valid`;
  if (!range?.valid) refuse(422, "automation_first_run_out_of_range");
  const [count] = await db`SELECT count(*) AS total FROM automations`;
  if (Number(count!.total) >= 50) refuse(422, "automation_count_limit");
  await membership(db, value.channelId, value.botId);
  const [row] =
    await db`INSERT INTO automations(id,name,channel_id,bot_id,prompt,interval_minutes,next_run_at) VALUES(${randomUUID()},${value.name},${value.channelId},${value.botId},${value.prompt},${value.intervalMinutes},${first}) RETURNING *`;
  await audit(db, row!, "AUTOMATION_CREATED", {
    intervalMinutes: row!.interval_minutes,
    nextRunAt: employeeTime(first),
    actor: "owner",
  });
  return { automation: projection(row!) };
}
async function enabled(db: DB, session: FileSession, id: string, value: boolean) {
  await bounded(db);
  const [before] = await db.unsafe(`SELECT ${selection} FROM automations WHERE id=$1 FOR UPDATE`, [
    id,
  ]);
  if (!before) return refuse(404, "automation_not_found");
  const prior = projection(before);
  if (value) automationReferences(session, before.channel_id, before.prompt);
  if (before.enabled === value) return { automation: prior };
  if (value) await membership(db, before.channel_id, before.bot_id);
  // Arithmetic remains in PostgreSQL so persisted sub-millisecond times cannot be rounded by
  // the driver. Missed occurrences advance directly past now, without replaying a backlog.
  const [row] =
    await db`UPDATE automations SET enabled=${value},next_run_at=CASE WHEN ${value} AND next_run_at<=date_trunc('milliseconds',now()) THEN next_run_at+(floor(extract(epoch FROM (date_trunc('milliseconds',now())-next_run_at))/(interval_minutes*60))+1)*interval_minutes*interval '1 minute' ELSE next_run_at END,updated_at=date_trunc('milliseconds',now()) WHERE id=${id} RETURNING *`;
  await audit(db, row!, value ? "AUTOMATION_RESUMED" : "AUTOMATION_PAUSED", { actor: "owner" });
  return { automation: projection(row!) };
}
export function automationRoutes(files: OwnerFiles): readonly ProductRoute[] {
  return [
    {
      method: "GET",
      path: "/api/v1/automations",
      kind: "product",
      error: "automation_storage_unavailable",
      execute: async (db) => ({
        automations: (
          await db.unsafe(`SELECT ${selection} FROM automations ORDER BY created_at DESC LIMIT 50`)
        ).map(projection),
      }),
    },
    ...["POST", "PATCH"].map(
      (method): ProductRoute => ({
        method,
        path: "/api/v1/automations" + (method === "PATCH" ? "/{automation_id}" : ""),
        kind: "product",
        status: method === "POST" ? 201 : 200,
        maxBytes: method === "POST" ? 32768 : 1024,
        error: "automation_storage_unavailable",
        remote: async (owner, ids, body, signal) => {
          const value =
            method === "POST"
              ? parseEmployee(createAutomationRequestSchema, body)
              : parseEmployee(updateAutomationRequestSchema, body);
          try {
            return await files.withLock(
              (session) =>
                owner(
                  (db) =>
                    "enabled" in value
                      ? enabled(db, session, ids[0]!, value.enabled)
                      : create(db, session, value),
                  session.signal,
                ),
              signal,
            );
          } catch (error) {
            if (error instanceof WriteFailure) throw error;
            return refuse(503, "automation_storage_unavailable");
          }
        },
        execute: async () => {
          throw new Error("Automation mutations require the shared file lock.");
        },
      }),
    ),
    {
      method: "DELETE",
      path: "/api/v1/automations/{automation_id}",
      kind: "product",
      maxBytes: 1024,
      error: "automation_storage_unavailable",
      execute: async (db, ids) => {
        await bounded(db);
        const [row] = await db.unsafe(
          `DELETE FROM automations WHERE id=$1 RETURNING ${selection}`,
          [ids[0]!],
        );
        if (!row) return refuse(404, "automation_not_found");
        projection(row);
        await audit(db, row, "AUTOMATION_DELETED", { actor: "owner" });
        return { deleted: true };
      },
    },
  ];
}

export { projection as automationProjection, selection as automationSelection };
