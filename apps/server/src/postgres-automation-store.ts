import { randomUUID } from "node:crypto";
import { automations, channelBots, runEvents, runs } from "@openbot/db";
import type { SubmitTaskResult } from "@openbot/domain";
import { and, asc, count, desc, eq, lte, sql } from "drizzle-orm";
import {
  type Automation,
  type AutomationOutcome,
  type AutomationStore,
  type CreateAutomationInput,
  createAutomationInputSchema,
  nextIntervalOccurrence,
} from "./automations.js";
import { AttachmentError } from "./channel-attachments.js";
import { StoreNotFoundError, StoreValidationError } from "./control-plane-store.js";
import { submitTaskInTransaction } from "./postgres-task-submission.js";
import { TaskAttachmentReferences } from "./task-attachment-references.js";

type Database = ReturnType<typeof import("@openbot/db")["createDatabase"]>["db"];
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type AutomationRow = typeof automations.$inferSelect;
const activeStatuses = new Set(["queued", "assigned", "running", "waiting_approval", "blocked"]);

export class PostgresAutomationStore implements AutomationStore {
  constructor(
    readonly database: Database,
    private readonly taskReferences = new TaskAttachmentReferences(),
  ) {}

  async list(): Promise<Automation[]> {
    return (
      await this.database.select().from(automations).orderBy(desc(automations.createdAt)).limit(50)
    ).map(toAutomation);
  }

  async create(input: CreateAutomationInput): Promise<Automation> {
    const parsed = createAutomationInputSchema.safeParse(input);
    if (!parsed.success) throw new StoreValidationError("Invalid automatic task settings.");
    const command = parsed.data;
    return this.taskReferences.withLock((validate) =>
      this.database.transaction(async (transaction) => {
        await boundedTransaction(transaction);
        await validate(command.channelId, command.prompt);
        // One global creation lock bounds the record count even under competing Owner requests.
        await transaction.execute(sql`select pg_advisory_xact_lock(1330660686, 1096111153)`);
        const now = await databaseTime(transaction);
        const firstRunAt = new Date(command.firstRunAt);
        if (firstRunAt <= now || firstRunAt.getTime() > now.getTime() + 366 * 86400000) {
          throw new StoreValidationError("Choose a first run in the next 366 days.");
        }
        const [total] = await transaction.select({ total: count() }).from(automations);
        if ((total?.total ?? 0) >= 50)
          throw new StoreValidationError("At most 50 automatic tasks are supported.");
        await assertMembership(transaction, command.channelId, command.botId);
        const [created] = await transaction
          .insert(automations)
          .values({
            id: randomUUID(),
            name: command.name,
            channelId: command.channelId,
            botId: command.botId,
            prompt: command.prompt,
            intervalMinutes: command.intervalMinutes,
            nextRunAt: firstRunAt,
          })
          .returning();
        if (!created) throw new Error("Automatic task was not stored.");
        await audit(transaction, created, "AUTOMATION_CREATED", {
          intervalMinutes: created.intervalMinutes,
          nextRunAt: firstRunAt.toISOString(),
          actor: "owner",
        });
        return toAutomation(created);
      }),
    );
  }

  async setEnabled(id: string, enabled: boolean): Promise<Automation> {
    return this.taskReferences.withLock((validate) =>
      this.database.transaction(async (transaction) => {
        await boundedTransaction(transaction);
        const [current] = await transaction
          .select()
          .from(automations)
          .where(eq(automations.id, id))
          .for("update")
          .limit(1);
        if (!current) throw new StoreNotFoundError("Automatic task not found.");
        if (enabled) await validate(current.channelId, current.prompt);
        if (current.enabled === enabled) return toAutomation(current);
        const now = await databaseTime(transaction);
        if (enabled) await assertMembership(transaction, current.channelId, current.botId);
        const [updated] = await transaction
          .update(automations)
          .set({
            enabled,
            nextRunAt: enabled
              ? nextIntervalOccurrence(current.nextRunAt, current.intervalMinutes, now)
              : current.nextRunAt,
            updatedAt: now,
          })
          .where(eq(automations.id, id))
          .returning();
        if (!updated) throw new StoreNotFoundError("Automatic task not found.");
        await audit(transaction, updated, enabled ? "AUTOMATION_RESUMED" : "AUTOMATION_PAUSED", {
          actor: "owner",
        });
        return toAutomation(updated);
      }),
    );
  }

  async delete(id: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await boundedTransaction(transaction);
      const [deleted] = await transaction
        .delete(automations)
        .where(eq(automations.id, id))
        .returning();
      if (!deleted) throw new StoreNotFoundError("Automatic task not found.");
      // Deletion stops future submissions; already-created Runs retain their normal authority/lifecycle.
      await audit(transaction, deleted, "AUTOMATION_DELETED", { actor: "owner" });
    });
  }

  async submitDue(): Promise<SubmitTaskResult[]> {
    return this.taskReferences.withLock((validate) =>
      this.database.transaction(async (transaction) => {
        await boundedTransaction(transaction);
        const now = await databaseTime(transaction);
        const due = await transaction
          .select()
          .from(automations)
          .where(and(eq(automations.enabled, true), lte(automations.nextRunAt, now)))
          .orderBy(asc(automations.nextRunAt), asc(automations.id))
          .limit(10)
          .for("update", { skipLocked: true });
        const submitted: SubmitTaskResult[] = [];
        for (const schedule of due) {
          let outcome: AutomationOutcome = "submitted";
          let result: SubmitTaskResult | undefined;
          const [previous] =
            schedule.lastRunId === null
              ? []
              : await transaction
                  .select({ status: runs.status })
                  .from(runs)
                  .where(eq(runs.id, schedule.lastRunId))
                  .limit(1);
          try {
            await validate(schedule.channelId, schedule.prompt);
            if (previous && activeStatuses.has(previous.status)) {
              outcome = "skipped_active";
            } else {
              result = await submitTaskInTransaction(
                transaction,
                schedule.channelId,
                {
                  content: schedule.prompt,
                  botId: schedule.botId,
                },
                schedule.id,
              );
            }
          } catch (error) {
            if (error instanceof AttachmentError) outcome = "attachment_unavailable";
            else if (error instanceof StoreValidationError || error instanceof StoreNotFoundError)
              outcome = "target_unavailable";
            else throw error;
          }
          const nextRunAt = nextIntervalOccurrence(
            schedule.nextRunAt,
            schedule.intervalMinutes,
            now,
          );
          await transaction
            .update(automations)
            .set({
              nextRunAt,
              lastRunAt: now,
              lastRunId: result?.run.id ?? schedule.lastRunId,
              lastOutcome: outcome,
              enabled: outcome !== "target_unavailable" && outcome !== "attachment_unavailable",
              updatedAt: now,
            })
            .where(eq(automations.id, schedule.id));
          await audit(
            transaction,
            schedule,
            "AUTOMATION_OCCURRENCE",
            {
              scheduledFor: schedule.nextRunAt.toISOString(),
              outcome,
              nextRunAt: nextRunAt.toISOString(),
              actor: "schedule",
            },
            result?.run.id,
          );
          if (result) submitted.push(result);
        }
        return submitted;
      }),
    );
  }
}

async function assertMembership(
  transaction: Transaction,
  channelId: string,
  botId: string,
): Promise<void> {
  const [member] = await transaction
    .select({ botId: channelBots.botId })
    .from(channelBots)
    .where(and(eq(channelBots.channelId, channelId), eq(channelBots.botId, botId)))
    .limit(1);
  if (!member) throw new StoreValidationError("The selected Bot must belong to this channel.");
}
async function boundedTransaction(transaction: Transaction): Promise<void> {
  await transaction.execute(sql`set local transaction_timeout = '10s'`);
  await transaction.execute(sql`set local statement_timeout = '10s'`);
  await transaction.execute(sql`set local lock_timeout = '3s'`);
}
async function databaseTime(transaction: Transaction): Promise<Date> {
  const rows = await transaction.execute<{ now: string }>(sql`select now()::text as now`);
  return new Date(rows[0]?.now ?? "");
}
async function audit(
  transaction: Transaction,
  schedule: AutomationRow,
  type: string,
  details: Record<string, unknown>,
  runId?: string,
): Promise<void> {
  await transaction.insert(runEvents).values({
    id: randomUUID(),
    channelId: schedule.channelId,
    botId: schedule.botId,
    ...(runId ? { runId } : {}),
    type,
    payload: { automationId: schedule.id, ...details },
  });
}
function toAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    name: row.name,
    channelId: row.channelId,
    botId: row.botId,
    prompt: row.prompt,
    intervalMinutes: row.intervalMinutes,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt.toISOString(),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastRunId: row.lastRunId,
    lastOutcome: row.lastOutcome as AutomationOutcome | null,
    createdAt: row.createdAt.toISOString(),
  };
}
