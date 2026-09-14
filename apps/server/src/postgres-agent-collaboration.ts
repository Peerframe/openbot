import { randomUUID } from "node:crypto";
import { bots, channelBots, messages, runEvents, runs } from "@openbot/db";
import type { Run } from "@openbot/domain";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { type DelegateTaskInput, delegateTaskSchema } from "./agent-collaboration.js";
import { NativeExecutionError } from "./agent-observations.js";
import { taskAttachmentIds } from "./channel-attachments.js";
import { toMessage, toRun } from "./postgres-task-records.js";

type Database = ReturnType<typeof import("@openbot/db")["createDatabase"]>["db"];
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Database | Transaction;

/** Load ancestry from Server records, never from model-supplied identifiers. */
export async function activeCollaborationChain(
  db: Reader,
  run: Run,
  lock: boolean | "ancestors" = false,
) {
  const chain: Run[] = [];
  let id: string | undefined = run.id;
  while (id && chain.length < 4) {
    const query = db.select().from(runs).where(eq(runs.id, id));
    const [row] = await query;
    if (
      !row ||
      row.channelId !== run.channelId ||
      row.executionProfile !== "none" ||
      row.nodeId !== null
    )
      throw new NativeExecutionError("invalid_target");
    if (row.status !== "running") throw new NativeExecutionError("conflict");
    const memberQuery = db
      .select()
      .from(channelBots)
      .where(and(eq(channelBots.channelId, row.channelId), eq(channelBots.botId, row.botId)));
    const [member] = await memberQuery;
    if (!member) throw new NativeExecutionError("scope_revoked");
    chain.push(toRun(row));
    id = row.parentRunId ?? undefined;
  }
  if (id || chain.length > 3 || chain[0]?.botId !== run.botId)
    throw new NativeExecutionError("invalid_target");
  if (lock) {
    // Acquire root-to-leaf to match cancellation; lock upgrades must never invert the tree.
    for (const ancestor of [...(lock === "ancestors" ? chain.slice(1) : chain)].reverse()) {
      const [active] = await db
        .select()
        .from(runs)
        .where(and(eq(runs.id, ancestor.id), eq(runs.status, "running")))
        .for("share");
      const [member] = await db
        .select()
        .from(channelBots)
        .where(
          and(eq(channelBots.channelId, ancestor.channelId), eq(channelBots.botId, ancestor.botId)),
        )
        .for("share");
      if (!active) throw new NativeExecutionError("conflict");
      if (!member) throw new NativeExecutionError("scope_revoked");
    }
  }
  return chain;
}

export async function channelColleagues(db: Reader, run: Run) {
  const chain = await activeCollaborationChain(db, run);
  const rows = await db
    .select({ id: bots.id, name: bots.name, role: bots.role, description: bots.description })
    .from(bots)
    .innerJoin(channelBots, eq(channelBots.botId, bots.id))
    .where(
      and(
        eq(channelBots.channelId, run.channelId),
        eq(bots.computerProfile, "none"),
        ne(bots.id, run.botId),
      ),
    )
    .orderBy(asc(bots.name), asc(bots.id))
    .limit(33);
  const eligible = rows.filter((bot) => !chain.some((ancestor) => ancestor.botId === bot.id));
  const catalog: typeof eligible = [];
  let truncated = rows.length > 32;
  for (const bot of eligible.slice(0, 32)) {
    const entry = { ...bot, description: bot.description.slice(0, 240) };
    if (Buffer.byteLength(JSON.stringify([...catalog, entry])) > 12 * 1024) {
      truncated = true;
      break;
    }
    catalog.push(entry);
  }
  return { bots: catalog, truncated };
}

export async function createDelegatedRun(db: Database, parent: Run, raw: DelegateTaskInput) {
  const input = delegateTaskSchema.parse(raw);
  return db.transaction(async (tx) => {
    // The channel lease covers both ordinary root claims and child creation across processes.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${parent.channelId}, 731))`);
    const chain = await activeCollaborationChain(tx, parent, true);
    const root = chain.at(-1);
    const source = chain[0];
    if (!root || !source) throw new NativeExecutionError("invalid_target");
    const allowedAttachments = taskAttachmentIds(source.instruction);
    if (taskAttachmentIds(input.task).some((id) => !allowedAttachments.includes(id)))
      throw new NativeExecutionError("invalid_target");
    if (chain.length >= 3 || chain.some((run) => run.botId === input.botId))
      throw new NativeExecutionError("task_limit");
    const descendants = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.rootRunId, root.id))
      .limit(4);
    if (descendants.length >= 4) throw new NativeExecutionError("task_limit");
    const [target] = await tx
      .select({ id: bots.id, name: bots.name })
      .from(bots)
      .innerJoin(channelBots, eq(channelBots.botId, bots.id))
      .where(
        and(
          eq(bots.id, input.botId),
          eq(bots.computerProfile, "none"),
          eq(channelBots.channelId, parent.channelId),
        ),
      )
      .for("share");
    if (!target) throw new NativeExecutionError("invalid_target");
    const sourceId = randomUUID(),
      runId = randomUUID(),
      now = new Date();
    const [message] = await tx
      .insert(messages)
      .values({
        id: sourceId,
        channelId: parent.channelId,
        authorType: "bot",
        authorId: parent.botId,
        replyToMessageId: source.sourceMessageId,
        content: input.task,
        createdAt: now,
      })
      .returning();
    const [child] = await tx
      .insert(runs)
      .values({
        id: runId,
        channelId: parent.channelId,
        botId: target.id,
        sourceMessageId: sourceId,
        parentRunId: parent.id,
        rootRunId: root.id,
        delegatedByBotId: parent.botId,
        executionProfile: "none",
        instruction: input.task,
        title: input.task.slice(0, 160),
        status: "running",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!message || !child) throw new Error("Delegation was not persisted.");
    await tx.insert(runEvents).values([
      {
        id: randomUUID(),
        runId: parent.id,
        channelId: parent.channelId,
        botId: parent.botId,
        type: "TASK_DELEGATED",
        payload: { childRunId: child.id, targetBotId: target.id, rootRunId: root.id },
      },
      {
        id: randomUUID(),
        runId: child.id,
        channelId: parent.channelId,
        botId: target.id,
        type: "RUN_STARTED",
        payload: {
          executor: "native-agent",
          parentRunId: parent.id,
          delegatedByBotId: parent.botId,
        },
      },
      {
        id: randomUUID(),
        runId: child.id,
        channelId: parent.channelId,
        botId: parent.botId,
        type: "MESSAGE_CREATED",
        payload: { messageId: message.id, kind: "delegation" },
      },
    ]);
    return { run: toRun(child), message: toMessage(message) };
  });
}
