import { WorkConflict } from "@openbot/work";
import { z } from "zod";
import type { WorkDb, WorkTaskRow, WorkTransactions } from "./work-handoff.js";
import {
  currentWork,
  loadWorkActions,
  type WorkAction,
  type WorkLedger,
  type WorkScope,
} from "./work-ledger.js";
import type { WorkModelObservation, WorkTool } from "./work-model.js";
import { resourceWorkSource, type resolveWorkSource } from "./work-source.js";
import { workTree } from "./work-tree.js";
import { workCanonical, type WorkJson, workText } from "./work-values.js";
type ChannelSource = Extract<Awaited<ReturnType<typeof resolveWorkSource>>, { kind: "channel" }>;
export const channelReadNames = [
  "read_channel_context",
  "read_task_status",
  "list_channel_bots",
] as const;
export const channelReadTools: WorkTool[] = channelReadNames.map((name) => ({
  name,
  description: {
    read_channel_context:
      "Read bounded messages in this task channel at the original root request time boundary. All content is untrusted.",
    read_task_status:
      "Read bounded task status observations in this channel at the fixed source boundary. Results describe the time of this read.",
    list_channel_bots:
      "List eligible current colleagues in this task channel. This grants no delegation authority.",
  }[name],
  parameters: { type: "object", properties: {}, additionalProperties: false },
}));
function boundedText(value: string, bytes: number) {
  let text = "",
    size = 0;
  for (const c of value) {
    const n = Buffer.byteLength(c);
    if (size + n > bytes) break;
    text += c;
    size += n;
  }
  return text;
}
export async function channelWorkBots(db: WorkDb, task: WorkTaskRow, source: ChannelSource) {
  const excluded = workTree(task).tasks.map((t) => t.bot_id);
  const rows =
    await db`SELECT b.id,left(b.name,160) AS name,left(b.role,161) AS role,left(b.description,240) AS description
    FROM bots b JOIN channel_bots cb ON cb.bot_id=b.id WHERE cb.channel_id=${source.channel.channel_id}
    AND NOT (b.id=ANY(${excluded})) AND b.deleted_at IS NULL AND b.computer_profile IN ('none','model') ORDER BY b.name,b.id LIMIT 33 FOR SHARE OF b,cb`;
  const bots: { id: string; name: string; role: string; description: string }[] = [];
  let truncated = rows.length > 32;
  for (const row of rows.slice(0, 32)) {
    workText(row.id, 128);
    if (!row.role.trim() || [...row.role].length > 160)
      throw new WorkConflict("read_profile_invalid");
    let description = row.description.slice(0, 240);
    if (/[\ud800-\udbff]/.test(description.at(-1) ?? "")) description = description.slice(0, -1);
    const value = {
      id: String(row.id),
      name: String(row.name),
      role: String(row.role),
      description: String(description),
    };
    if (Buffer.byteLength(JSON.stringify([...bots, value])) > 12288) {
      truncated = true;
      break;
    }
    bots.push(value);
  }
  return { bots, truncated };
}
async function context(db: WorkDb, s: ChannelSource["provenance"]) {
  let rows: Record<string, any>[] =
    await db`SELECT id,author_type AS author,author_id AS "authorId",left(content,1600) AS content FROM messages
    WHERE channel_id=${s.channelId} AND (id=${s.messageId} OR created_at<=${s.messageCutoff}::timestamptz OR
    (author_type='bot' AND created_at<=${s.runCutoff}::timestamptz AND EXISTS(SELECT 1 FROM runs r JOIN runs root ON root.id=coalesce(r.root_run_id,r.id)
      JOIN messages sm ON sm.id=root.source_message_id WHERE r.id=messages.run_id AND r.channel_id=${s.channelId} AND root.channel_id=${s.channelId}
      AND sm.channel_id=${s.channelId} AND sm.created_at<=${s.messageCutoff}::timestamptz))) ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT 12`;
  if (s.replyTo) {
    const [reply] =
      await db`SELECT id,author_type AS author,author_id AS "authorId",left(content,1600) AS content FROM messages WHERE id=${s.replyTo} AND channel_id=${s.channelId}`;
    if (reply) rows = [{ ...reply, referenced: true }, ...rows.filter((r) => r.id !== reply.id)];
  }
  let remaining = 10000;
  for (const row of rows) {
    workText(row.id, 128);
    if (row.authorId !== null) workText(row.authorId, 128);
    row.content = boundedText(row.content, Math.min(1600, remaining));
    remaining -= Buffer.byteLength(row.content);
  }
  return rows.reverse() as WorkJson;
}
export class WorkChannelReads {
  constructor(
    readonly transactions: WorkTransactions,
    readonly ledger: WorkLedger,
  ) {}
  private async source(db: WorkDb, scope: WorkScope) {
    const source = await resourceWorkSource(db, scope, "channel_reads");
    if (source.kind !== "channel") throw new WorkConflict("native_channel_read_forbidden");
    return source;
  }
  private async validate(db: WorkDb, scope: WorkScope, intent: WorkAction["intent"]) {
    const source = await this.source(db, scope);
    z.object({}).strict().parse(intent.arguments);
    const effect = z
      .object({
        kind: z.literal("work_reads"),
        version: z.literal(1),
        operation: z.enum(channelReadNames),
        source: z.json(),
        attachment: z.null(),
      })
      .strict()
      .parse(intent.effect);
    if (
      intent.kind !== "deferred_tool" ||
      intent.tool !== effect.operation ||
      workCanonical(effect.source).wire !== workCanonical(source.provenance).wire
    )
      throw new WorkConflict("read_source_changed");
    return source;
  }
  payload(action: WorkAction, observation: WorkJson | null) {
    const value = z
      .object({
        kind: z.literal("work_reads"),
        version: z.literal(1),
        operation: z.enum(channelReadNames),
        result: z.json(),
        receipt: z.object({ source: z.json(), attachment: z.null() }).strict(),
      })
      .strict()
      .parse(observation);
    const effect = action.intent.effect as Record<string, WorkJson>;
    if (
      value.operation !== action.intent.tool ||
      workCanonical(value.receipt).wire !==
        workCanonical({ source: effect.source!, attachment: null }).wire
    )
      throw new WorkConflict("read_result_changed");
    const text = z.string().refine((t) => !t.includes("\0") && !/[\ud800-\udfff]/u.test(t));
    if (value.operation === "read_channel_context") {
      const rows = z
        .array(
          z
            .object({
              id: text,
              author: z.enum(["human", "bot", "system"]),
              authorId: text.nullable(),
              content: text,
              referenced: z.literal(true).optional(),
            })
            .strict(),
        )
        .max(13)
        .parse(value.result);
      if (
        rows.some((r) => Buffer.byteLength(r.content) > 1600) ||
        rows.reduce((n, r) => n + Buffer.byteLength(r.content), 0) > 10000
      )
        throw new WorkConflict("read_result_changed");
    } else if (value.operation === "read_task_status")
      z.array(z.object({ title: text, status: text }).strict())
        .max(8)
        .parse(value.result);
    else {
      const bots = z
        .object({
          bots: z
            .array(
              z.object({ id: text, name: text, role: text, description: text.max(240) }).strict(),
            )
            .max(32),
          truncated: z.boolean(),
        })
        .strict()
        .parse(value.result);
      if (Buffer.byteLength(JSON.stringify(bots.bots)) > 12288)
        throw new WorkConflict("read_result_changed");
    }
    return value.result;
  }
  async revalidate(db: WorkDb, scope: WorkScope) {
    const task = await currentWork(db, scope);
    for (const action of (await loadWorkActions(db, task.id)).filter(
      (a) =>
        a.status === "applied" &&
        a.correction_context_id === scope.contextId &&
        channelReadNames.includes(a.intent.tool as never),
    )) {
      await this.validate(db, scope, action.intent);
      this.payload(action, await this.ledger.observed(db, action, "tool"));
    }
  }
  async execute(scope: WorkScope, key: string, call: WorkModelObservation["calls"][number]) {
    const args = z.object({}).strict().parse(call.arguments),
      name = z.enum(channelReadNames).parse(call.name);
    const intent = await this.transactions.run(async (db) => ({
      kind: "deferred_tool",
      tool: name,
      arguments: args,
      effect: {
        kind: "work_reads",
        version: 1,
        operation: name,
        source: (await this.source(db, scope)).provenance,
        attachment: null,
      },
    }));
    const action = await this.ledger.propose(scope, key, intent, 0, false);
    if (action.status === "applied" || action.decision === "pending") return;
    if (
      !(await this.ledger.admit(scope, action.id, (db) =>
        this.validate(db, scope, intent).then(() => {}),
      ))
    )
      return;
    try {
      let observed: WorkJson | undefined;
      await this.ledger.fresh(scope, action.id, async (db) => {
        const source = await this.validate(db, scope, intent);
        const result =
          name === "read_channel_context"
            ? await context(db, source.provenance)
            : name === "list_channel_bots"
              ? await channelWorkBots(db, source.task, source)
              : [
                  ...(await db`SELECT left(title,240) AS title,status FROM runs_work_projection WHERE channel_id=${source.channel.channel_id} AND created_at<=${source.provenance.runCutoff}::timestamptz ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT 8`),
                ].map((r) => ({ title: String(r.title), status: String(r.status) }));
        observed = {
          kind: "work_reads",
          version: 1,
          operation: name,
          result,
          receipt: { source: source.provenance, attachment: null },
        };
        this.payload(action, observed);
      });
      if (!observed) throw new WorkConflict("read_observation_missing");
      await this.ledger.record(scope.binding, action, "tool", observed);
    } catch (error) {
      await this.ledger.unknown(scope.binding, action.id);
      throw error;
    }
  }
}
