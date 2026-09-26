import type { messages, runs } from "@openbot/db";
import type { Message, Run } from "@openbot/domain";
import { runModelUsageSchema } from "./agent-observations.js";

export function toMessage(
  row: typeof messages.$inferSelect | typeof messages.$inferInsert,
): Message {
  return {
    id: row.id,
    channelId: row.channelId,
    authorType: row.authorType as Message["authorType"],
    ...(row.authorId === null || row.authorId === undefined ? {} : { authorId: row.authorId }),
    ...(row.replyToMessageId === null || row.replyToMessageId === undefined
      ? {}
      : { replyToMessageId: row.replyToMessageId }),
    ...(row.runId === null || row.runId === undefined ? {} : { runId: row.runId }),
    content: row.content,
    createdAt: (row.createdAt ?? new Date()).toISOString(),
  };
}

export function toRun(row: typeof runs.$inferSelect | typeof runs.$inferInsert): Run {
  const usage = runModelUsageSchema.safeParse(row.modelUsage);
  return {
    ...(usage.success ? { modelUsage: usage.data } : {}),
    ...(row.parentRunId ? { parentRunId: row.parentRunId } : {}),
    ...(row.rootRunId ? { rootRunId: row.rootRunId } : {}),
    ...(row.delegatedByBotId ? { delegatedByBotId: row.delegatedByBotId } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    id: row.id,
    channelId: row.channelId,
    botId: row.botId,
    ...(row.sourceMessageId === null || row.sourceMessageId === undefined
      ? {}
      : { sourceMessageId: row.sourceMessageId }),
    ...(row.nodeId === null || row.nodeId === undefined ? {} : { nodeId: row.nodeId }),
    executionProfile: row.executionProfile as Run["executionProfile"],
    instruction: row.instruction ?? row.title,
    title: row.title,
    status: row.status as Run["status"],
    ...(row.resultSummary === null || row.resultSummary === undefined
      ? {}
      : { resultSummary: row.resultSummary }),
    ...(row.errorMessage === null || row.errorMessage === undefined
      ? {}
      : { errorMessage: row.errorMessage }),
    createdAt: (row.createdAt ?? new Date()).toISOString(),
    updatedAt: (row.updatedAt ?? new Date()).toISOString(),
  };
}
