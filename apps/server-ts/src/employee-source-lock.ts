import { parseJsonInput, hasIntegerTokens } from "./json-input.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { modelSelectionSchema } from "@openbot/protocol";
import { z } from "zod";
import {
  employeeRows as rows,
  employeeOne as one,
  type EmployeeDB as DB,
  type EmployeeRow as Row,
} from "./employee-records.js";
import { refuse } from "./owner-transaction.js";

function conflict(message: string): never {
  return refuse(409, message);
}
async function links(db: DB, id: string): Promise<Row[]> {
  const found: Row[] = [],
    seen = new Set([id]);
  for (;;) {
    const [row] = await rows(db, "SELECT * FROM work_collaborations WHERE child_task_id=$1", [id]);
    if (!row) return found.reverse();
    if (found.length >= 2 || seen.has(row.parent_task_id))
      conflict("collaboration_ancestry_invalid");
    found.push(row);
    id = row.parent_task_id;
    seen.add(id);
  }
}
// Profile/scope contracts contain only fixed ASCII keys and bounded integers. This preserves
// Python's sorted UTF-8 representation; it is not a new canonicalizer for arbitrary Work input.
function digest(value: unknown): string {
  const sort = (v: any): any => {
    if (typeof v === "string" && (v.includes("\0") || /[\ud800-\udfff]/u.test(v)))
      conflict("native_task_scope_changed");
    return Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort(v[k])]),
          )
        : v;
  };
  const raw = JSON.stringify(sort(value));
  if (Buffer.byteLength(raw) > 16384) conflict("native_task_scope_changed");
  return createHash("sha256").update(raw).digest("hex");
}
const identity = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  .transform((s) => s.toLowerCase());
const identities = (limit: number) =>
  z
    .array(identity)
    .max(limit)
    .refine((a) => new Set(a).size === a.length)
    .transform((a) => a.sort());
const scopeRequest = z.strictObject({
  version: z.literal(1),
  attachmentIds: identities(8),
  collaboratorBotIds: identities(32),
  knowledge: z.boolean(),
  plugins: z.boolean(),
  web: z.boolean(),
});
const attachment = z.strictObject({
  id: z.string(),
  name: z.string(),
  mediaType: z.string(),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(10 * 1024 * 1024),
  sha256: z.string(),
  metadataSha256: z.string(),
});
const scopeValue = z.strictObject({
  version: z.literal(1),
  taskId: z.string(),
  botId: z.string(),
  request: scopeRequest,
  attachments: z.array(attachment).max(8),
});
async function nativeSource(db: DB, task: Row) {
  const id = task.id;
  const mapping = await rows(db, "SELECT 1 FROM work_sources WHERE task_id=$1 FOR SHARE", [id]);
  const [profile] = await rows(
    db,
    "SELECT task_id,bot_id,execution_profile,model_selection,profile_digest FROM work_task_profiles WHERE task_id=$1 FOR SHARE",
    [id],
  );
  const command = await rows(db, "SELECT 1 FROM work_command_profiles WHERE task_id=$1 FOR SHARE", [
    id,
  ]);
  const browser = await rows(db, "SELECT 1 FROM work_browser_profiles WHERE task_id=$1 FOR SHARE", [
    id,
  ]);
  if (mapping.length || command.length || browser.length) conflict("product_source_ambiguous");
  if (!profile || profile.bot_id !== task.bot_id) conflict("product_source_changed");
  if (!["none", "model"].includes(profile.execution_profile))
    conflict("product_task_profile_required");
  let selection = profile.model_selection;
  if (selection != null || profile.execution_profile === "model") {
    const parsed = modelSelectionSchema.safeParse(selection);
    if (
      !parsed.success ||
      (profile.execution_profile === "model" && !isDeepStrictEqual(parsed.data, selection))
    )
      conflict("product_task_model_required");
    selection = parsed.data;
  }
  if (
    digest({
      kind: "work_task_profile",
      version: 1,
      taskId: id,
      botId: task.bot_id,
      executionProfile: profile.execution_profile,
      modelSelection: selection,
    }) !== profile.profile_digest
  )
    conflict("product_task_profile_changed");
  const [stored] = await rows(
    db,
    "SELECT scope::text AS encoded,scope_digest FROM work_task_scopes WHERE task_id=$1 FOR SHARE",
    [id],
  );
  if (!stored) return null;
  const raw = parseJsonInput(stored.encoded) as Row;
  if (
    !raw ||
    !hasIntegerTokens(raw, ["version"]) ||
    !hasIntegerTokens(raw.request, ["version"]) ||
    (Array.isArray(raw.attachments) &&
      raw.attachments.some((item: unknown) => !hasIntegerTokens(item, ["sizeBytes"])))
  )
    conflict("native_task_scope_changed");
  const value = scopeValue.safeParse(raw);
  if (
    !value.success ||
    !isDeepStrictEqual(value.data, raw) ||
    value.data.taskId !== id ||
    value.data.botId !== task.bot_id ||
    value.data.request.collaboratorBotIds.includes(task.bot_id) ||
    !isDeepStrictEqual(
      value.data.attachments.map((a) => a.id),
      value.data.request.attachmentIds,
    ) ||
    digest(value.data) !== stored.scope_digest
  )
    conflict("native_task_scope_changed");
  return value.data;
}
function subset(
  parent: Awaited<ReturnType<typeof nativeSource>>,
  child: Awaited<ReturnType<typeof nativeSource>>,
  botId: string,
) {
  if (!parent || !child) return false;
  const p = parent.request,
    c = child.request;
  return (
    p.collaboratorBotIds.includes(botId) &&
    !c.collaboratorBotIds.includes(botId) &&
    c.collaboratorBotIds.every((id) => p.collaboratorBotIds.includes(id)) &&
    c.attachmentIds.every((id) => p.attachmentIds.includes(id)) &&
    (["knowledge", "plugins", "web"] as const).every((k) => !c[k] || p[k]) &&
    isDeepStrictEqual(
      child.attachments,
      parent.attachments.filter((a) => c.attachmentIds.includes(a.id)),
    )
  );
}
async function channelSource(db: DB, id: string) {
  return (
    await rows(
      db,
      `SELECT s.*,r.bot_id,r.parent_run_id,r.root_run_id,r.delegated_by_bot_id,r.execution_profile,r.node_id,r.instruction,r.channel_id AS run_channel,r.source_message_id AS run_message,m.channel_id AS message_channel,r.created_at AS run_created_at,m.created_at AS message_created_at FROM work_sources s JOIN runs r ON r.id=s.legacy_run_id JOIN messages m ON m.id=s.source_message_id WHERE s.task_id=$1`,
      [id],
    )
  )[0];
}
/** Owner proposal review shares retained P4 source -> root/descendant Task -> Bot lock order.
 * It neither creates Work nor admits execution. Terminal source checks remain in the caller. */
export async function lockEmployeeSource(db: DB, id: string): Promise<Row> {
  const ancestry = await links(db, id),
    ids = ancestry.length
      ? [ancestry[0]!.root_task_id, ...ancestry.map((r) => r.child_task_id)]
      : [id];
  if (ancestry.length && (ancestry[0]!.parent_task_id !== ids[0] || ids.at(-1) !== id))
    conflict("collaboration_ancestry_invalid");
  const native =
    ancestry[0]?.source_kind === "task" ||
    (await rows(db, "SELECT 1 FROM work_task_profiles WHERE task_id=$1", [id])).length > 0;
  const sources = new Map<string, Row>(),
    scopes = new Map<string, Awaited<ReturnType<typeof nativeSource>>>();
  if (native)
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${"native-task:" + ids[0]},731))`;
  else {
    for (const identity of ids) {
      const source = await channelSource(db, identity);
      if (source) sources.set(identity, source);
    }
    const channels = new Set([...sources.values()].map((r) => r.channel_id));
    if (channels.size > 1 || (ancestry.length && sources.size !== ids.length))
      conflict("collaboration_source_changed");
    if (channels.size) {
      const channel = [...channels][0];
      await db`SELECT pg_advisory_xact_lock(hashtextextended(${channel},731))`;
      await db`SELECT id FROM channels WHERE id=${channel} FOR KEY SHARE`;
      for (const identity of ids) {
        const source = sources.get(identity);
        if (!source) continue;
        await db`SELECT id FROM runs WHERE id=${source.legacy_run_id} FOR SHARE`;
        if (!isDeepStrictEqual(await channelSource(db, identity), source))
          conflict("collaboration_source_changed");
      }
    }
  }
  const tasks: Row[] = [];
  for (const identity of ids) {
    const task = await one(
      db,
      "SELECT * FROM work_tasks WHERE id=$1 FOR UPDATE",
      [identity],
      "work_not_found",
    );
    tasks.push(task);
    if (native) scopes.set(identity, await nativeSource(db, task));
  }
  if (!isDeepStrictEqual(await links(db, id), ancestry)) conflict("collaboration_ancestry_changed");
  for (let i = 1; i < ids.length; i++) {
    const link = ancestry[i - 1]!;
    if (link.depth !== i || link.root_task_id !== ids[0] || link.parent_task_id !== ids[i - 1])
      conflict("collaboration_ancestry_invalid");
    if (native) {
      if (
        link.source_kind !== "task" ||
        link.child_source_run_id !== null ||
        link.assignment_message_id !== null ||
        !subset(scopes.get(ids[i - 1]!)!, scopes.get(ids[i]!)!, tasks[i]!.bot_id)
      )
        conflict("collaboration_ancestry_invalid");
      for (const [task, run] of [
        [ids[i - 1], link.parent_work_run_id],
        [ids[i], link.child_work_run_id],
      ])
        if (!(await db`SELECT 1 FROM work_runs WHERE task_id=${task} AND id=${run}`).length)
          conflict("collaboration_ancestry_invalid");
    } else {
      const parent = sources.get(ids[i - 1]!)!,
        child = sources.get(ids[i]!)!;
      if (
        link.child_source_run_id !== child.legacy_run_id ||
        link.assignment_message_id !== child.source_message_id ||
        child.parent_run_id !== parent.legacy_run_id ||
        child.root_run_id !== sources.get(ids[0]!)!.legacy_run_id ||
        child.delegated_by_bot_id !== tasks[i - 1]!.bot_id
      )
        conflict("collaboration_ancestry_invalid");
    }
  }
  const tree =
    ancestry[0] ??
    (
      await rows(
        db,
        "SELECT * FROM work_collaborations WHERE root_task_id=$1 ORDER BY created_at,creation_action_id LIMIT 1",
        [id],
      )
    )[0];
  if (tree) {
    const [claim] = await rows(
      db,
      "SELECT payload::text AS encoded,created_at FROM work_events WHERE task_id=$1 AND kind='run.claimed' AND payload->>'runId'=$2 ORDER BY created_at,revision LIMIT 1",
      [ids[0], tree.root_work_run_id],
    );
    if (claim) claim.payload = parseJsonInput(claim.encoded);
    if (
      !claim ||
      !claim.payload ||
      !hasIntegerTokens(claim.payload, ["epoch"]) ||
      !isDeepStrictEqual(Object.keys(claim.payload).sort(), ["epoch", "runId"]) ||
      !Number.isInteger(claim.payload.epoch) ||
      claim.payload.epoch < 1 ||
      claim.payload.epoch > 10000
    )
      conflict("collaboration_root_claim_required");
    for (const link of [...ancestry, tree]) {
      if (
        link.root_work_run_id !== tree.root_work_run_id ||
        (native && link.source_kind !== "task")
      )
        conflict("collaboration_deadline_changed");
      const [same] =
        await db`SELECT ${link.deadline_at}::text::timestamptz=${claim.created_at}::text::timestamptz+interval '300 seconds' AS valid`;
      if (!same?.valid) conflict("collaboration_deadline_changed");
    }
    for (const task of tasks) {
      if (native) await db`SELECT computer_profile FROM bots WHERE id=${task.bot_id} FOR SHARE`;
      else {
        const source = sources.get(task.id);
        if (
          !source ||
          source.bot_id !== task.bot_id ||
          source.instruction !== task.objective ||
          source.channel_id !== source.run_channel ||
          source.channel_id !== source.message_channel ||
          source.source_message_id !== source.run_message
        )
          conflict("collaboration_source_changed");
        await db`SELECT b.computer_profile FROM channel_bots cb JOIN bots b ON b.id=cb.bot_id WHERE cb.channel_id=${source.channel_id} AND cb.bot_id=${task.bot_id} FOR SHARE OF cb,b`;
      }
    }
  }
  return tasks.at(-1)!;
}
