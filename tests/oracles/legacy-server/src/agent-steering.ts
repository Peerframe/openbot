import { randomUUID } from "node:crypto";
import { channelBots, runEvents, runs } from "@openbot/db";
import type { Run } from "@openbot/domain";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { NativeExecutionError } from "./agent-observations.js";
import { StoreConflictError, StoreNotFoundError } from "./control-plane-store.js";

export const steeringInstructionSchema = z.string().trim().min(1).max(4000);
export interface SteeringInstruction {
  id: string;
  runId: string;
  channelId: string;
  botId: string;
  instruction: string;
  createdAt: string;
}
export class PendingSteeringError extends Error {
  constructor() {
    super("A newer Owner instruction must be applied before completion.");
  }
}
type Database = ReturnType<typeof import("@openbot/db")["createDatabase"]>["db"];
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function submitSteering(db: Database, runId: string, raw: string) {
  const instruction = steeringInstructionSchema.parse(raw);
  return db.transaction(async (tx) => {
    // The same Run row is locked at completion: an accepted correction cannot be silently lost.
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for("update");
    if (!run) throw new StoreNotFoundError("Task not found.");
    if (
      run.executionProfile !== "none" ||
      run.nodeId !== null ||
      !["queued", "running"].includes(run.status)
    )
      throw new StoreConflictError("Only active native tasks accept additional instructions.");
    const [member] = await tx
      .select()
      .from(channelBots)
      .where(and(eq(channelBots.channelId, run.channelId), eq(channelBots.botId, run.botId)))
      .for("share");
    if (!member) throw new StoreConflictError("The Bot is no longer a channel member.");
    const prior = await readSteering(tx, run);
    if (prior.length >= 8)
      throw new StoreConflictError("A task accepts at most eight additional instructions.");
    const id = randomUUID(),
      createdAt = new Date();
    await tx.insert(runEvents).values({
      id,
      runId,
      channelId: run.channelId,
      botId: run.botId,
      type: "RUN_STEERING_SUBMITTED",
      payload: { instruction, actor: "owner" },
      createdAt,
    });
    return {
      id,
      runId,
      channelId: run.channelId,
      botId: run.botId,
      instruction,
      createdAt: createdAt.toISOString(),
    };
  });
}
export async function readSteering(
  db: Database | Transaction,
  run: Pick<Run, "id" | "channelId" | "botId">,
): Promise<SteeringInstruction[]> {
  const rows = await db
    .select()
    .from(runEvents)
    .where(
      and(
        eq(runEvents.runId, run.id),
        eq(runEvents.channelId, run.channelId),
        eq(runEvents.botId, run.botId),
        eq(runEvents.type, "RUN_STEERING_SUBMITTED"),
      ),
    )
    .orderBy(asc(runEvents.createdAt), asc(runEvents.id))
    .limit(9);
  if (rows.length > 8) throw new NativeExecutionError("task_limit");
  return rows.map((row) => ({
    id: row.id,
    runId: run.id,
    channelId: run.channelId,
    botId: run.botId,
    instruction: z.object({ instruction: steeringInstructionSchema }).parse(row.payload)
      .instruction,
    createdAt: row.createdAt.toISOString(),
  }));
}
export async function assertSteeringApplied(tx: Transaction, run: Run, appliedIds: string[]) {
  const [active] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
    .for("update");
  if (!active) throw new NativeExecutionError("conflict");
  const instructions = await readSteering(tx, run);
  if (instructions.some((instruction) => !appliedIds.includes(instruction.id)))
    throw new PendingSteeringError();
  if (instructions.length)
    await tx.insert(runEvents).values({
      id: randomUUID(),
      runId: run.id,
      channelId: run.channelId,
      botId: run.botId,
      type: "RUN_STEERING_APPLIED",
      payload: { instructionIds: instructions.map((item) => item.id), executor: "native-agent" },
    });
}
