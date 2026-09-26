import { randomUUID } from "node:crypto";
import { bots, channelBots, channels, messages, runEvents, runs } from "@openbot/db";
import type { Bot, CreateMessageInput, Run, SubmitTaskResult } from "@openbot/domain";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { StoreNotFoundError, StoreValidationError } from "./control-plane-store.js";
import { toMessage } from "./postgres-task-records.js";
import { selectChannelAssignees } from "./task-routing.js";

type Database = ReturnType<typeof import("@openbot/db")["createDatabase"]>["db"];

/** The caller owns the transaction and any file-reference lock. SQL owns routing and audit. */
export async function submitTaskInTransaction(
  transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
  channelId: string,
  input: CreateMessageInput,
  automationId?: string,
): Promise<SubmitTaskResult> {
  const now = new Date();
  const runId = randomUUID();
  const message = {
    id: randomUUID(),
    channelId,
    authorType: automationId === undefined ? ("human" as const) : ("system" as const),
    authorId: null,
    replyToMessageId: input.replyToMessageId ?? null,
    runId,
    content: input.content,
    createdAt: now,
  };

  const channelRows = await transaction
    .select({ id: channels.id, directBotId: channels.directBotId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1)
    .for("update");
  if (channelRows.length === 0) {
    throw new StoreNotFoundError("Channel not found.");
  }

  // Serialize source timestamps within a channel so rapid queued inputs have an exact boundary.
  const [previousInput] = await transaction
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(eq(messages.channelId, channelId), inArray(messages.authorType, ["human", "system"])),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (previousInput && previousInput.createdAt.getTime() >= now.getTime())
    now.setTime(previousInput.createdAt.getTime() + 1);

  const directBotId = channelRows[0]?.directBotId ?? undefined;
  if (directBotId !== undefined && input.botId !== undefined && input.botId !== directBotId) {
    throw new StoreValidationError("A direct conversation can only address its Bot.");
  }

  if (input.replyToMessageId !== undefined) {
    const [replyTarget] = await transaction
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.id, input.replyToMessageId), eq(messages.channelId, channelId)))
      .limit(1);
    if (replyTarget === undefined) {
      throw new StoreValidationError("The replied message does not belong to this channel.");
    }
  }

  const candidates = await transaction
    .select({
      id: bots.id,
      name: bots.name,
      role: bots.role,
      computerProfile: bots.computerProfile,
    })
    .from(channelBots)
    .innerJoin(bots, eq(channelBots.botId, bots.id))
    .where(eq(channelBots.channelId, channelId))
    .orderBy(asc(channelBots.joinedAt), asc(bots.createdAt), asc(bots.id))
    .for("share");
  const assignees = selectChannelAssignees(candidates, input, directBotId);
  const createdRuns: Run[] = assignees.map((assignee, index) => ({
    id: index === 0 ? runId : randomUUID(),
    channelId,
    botId: assignee.id,
    sourceMessageId: message.id,
    executionProfile: assignee.computerProfile as Bot["computerProfile"],
    instruction: input.content,
    title: taskTitle(input.content),
    status: "queued",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }));
  await transaction.insert(messages).values(message);
  await transaction.insert(runs).values(
    createdRuns.map((run) => ({
      ...run,
      createdAt: now,
      updatedAt: now,
    })),
  );
  await transaction.insert(runEvents).values([
    {
      id: randomUUID(),
      channelId,
      type: "MESSAGE_CREATED",
      payload: {
        messageId: message.id,
        authorType: message.authorType,
        ...(automationId === undefined ? {} : { automationId }),
      },
    },
    ...createdRuns.map((run) => ({
      id: randomUUID(),
      runId: run.id,
      channelId,
      botId: run.botId,
      type: "RUN_CREATED",
      payload: {
        sourceMessageId: message.id,
        ...(automationId === undefined ? {} : { automationId }),
        title: run.title,
        executionProfile: run.executionProfile,
      },
    })),
  ]);
  const firstRun = createdRuns[0];
  if (!firstRun) throw new StoreValidationError("A task requires a Bot recipient.");
  return {
    message: toMessage(message),
    run: firstRun,
    ...(input.botIds === undefined ? {} : { runs: createdRuns }),
  };
}

function taskTitle(content: string): string {
  return content.length <= 80 ? content : `${content.slice(0, 77)}...`;
}
