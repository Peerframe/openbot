import { randomUUID } from "node:crypto";
import {
  approvals,
  channelBots,
  channels,
  messageReactions,
  messages,
  runEvents,
  runs,
} from "@openbot/db";
import type { Channel, MessageReaction, ReactionEmoji, Run } from "@openbot/domain";
import { reactionEmojiSchema, setMessageReactionSchema } from "@openbot/protocol";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { StoreConflictError, StoreNotFoundError } from "./control-plane-store.js";
import { toRun } from "./postgres-task-records.js";

type Database = ReturnType<typeof import("@openbot/db")["createDatabase"]>["db"];
export interface ChannelInteractionStore {
  listReactions(channelId: string): Promise<MessageReaction[]>;
  setReaction(
    channelId: string,
    messageId: string,
    input: { emoji: ReactionEmoji; active: boolean },
  ): Promise<MessageReaction[]>;
  removeMember(
    channelId: string,
    botId: string,
  ): Promise<{ channel: Channel; cancelledRuns: Run[] }>;
}
export class PostgresChannelInteractions implements ChannelInteractionStore {
  constructor(readonly db: Database) {}
  async listReactions(channelId: string): Promise<MessageReaction[]> {
    const [channel] = await this.db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, channelId));
    if (!channel) throw new StoreNotFoundError("Channel not found.");
    const recent = this.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.channelId, channelId))
      .orderBy(desc(messages.createdAt))
      .limit(100);
    const rows = await this.db
      .select()
      .from(messageReactions)
      .where(
        and(eq(messageReactions.channelId, channelId), inArray(messageReactions.messageId, recent)),
      )
      .limit(600);
    return rows.map((row) => ({
      messageId: row.messageId,
      emoji: reactionEmojiSchema.parse(row.emoji),
      actor: "owner",
    }));
  }
  async setReaction(
    channelId: string,
    messageId: string,
    raw: { emoji: ReactionEmoji; active: boolean },
  ): Promise<MessageReaction[]> {
    const input = setMessageReactionSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const [message] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.channelId, channelId)))
        .for("update");
      if (!message) throw new StoreNotFoundError("Message not found in this channel.");
      const changed = input.active
        ? await tx
            .insert(messageReactions)
            .values({ messageId, channelId, emoji: input.emoji })
            .onConflictDoNothing()
            .returning()
        : await tx
            .delete(messageReactions)
            .where(
              and(
                eq(messageReactions.messageId, messageId),
                eq(messageReactions.channelId, channelId),
                eq(messageReactions.emoji, input.emoji),
              ),
            )
            .returning();
      if (changed.length)
        await tx.insert(runEvents).values({
          id: randomUUID(),
          channelId,
          type: "MESSAGE_REACTION_CHANGED",
          payload: { messageId, emoji: input.emoji, active: input.active, actor: "owner" },
        });
      const rows = await tx
        .select()
        .from(messageReactions)
        .where(
          and(eq(messageReactions.channelId, channelId), eq(messageReactions.messageId, messageId)),
        );
      return rows.map((row) => ({
        messageId,
        emoji: reactionEmojiSchema.parse(row.emoji),
        actor: "owner" as const,
      }));
    });
  }
  async removeMember(channelId: string, botId: string) {
    return this.db.transaction(async (tx) => {
      // Match native claim/delegation/completion order; cancel authority before releasing membership.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${channelId},731))`);
      // Audit inserts on locked Runs need a compatible channel foreign-key KEY SHARE lock.
      const [channel] = await tx
        .select()
        .from(channels)
        .where(eq(channels.id, channelId))
        .for("no key update");
      if (!channel) throw new StoreNotFoundError("Channel not found.");
      if (channel.directBotId)
        throw new StoreConflictError("Direct conversation membership cannot be changed.");
      const active = await tx
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.channelId, channelId),
            inArray(runs.status, ["queued", "assigned", "running", "waiting_approval", "blocked"]),
          ),
        )
        .orderBy(asc(runs.createdAt), asc(runs.id))
        .limit(1001)
        .for("update");
      if (active.length > 1000)
        throw new StoreConflictError(
          "Too many active tasks to remove this member safely. Stop queued work first.",
        );
      const revoked = new Set(active.filter((run) => run.botId === botId).map((run) => run.id));
      for (let depth = 0; depth < 3; depth++)
        for (const run of active)
          if (
            (run.parentRunId && revoked.has(run.parentRunId)) ||
            (run.rootRunId && revoked.has(run.rootRunId))
          )
            revoked.add(run.id);
      const ids = [...revoked];
      const cancelled = ids.length
        ? await tx
            .update(runs)
            .set({ status: "cancelled", updatedAt: new Date() })
            .where(inArray(runs.id, ids))
            .returning()
        : [];
      if (ids.length) {
        await tx
          .update(approvals)
          .set({ status: "expired", decidedAt: new Date(), decidedBy: "owner" })
          .where(and(inArray(approvals.runId, ids), eq(approvals.status, "pending")));
        await tx.insert(runEvents).values(
          cancelled.map((run) => ({
            id: randomUUID(),
            runId: run.id,
            channelId,
            botId: run.botId,
            type: "RUN_CANCELLED",
            payload: { actor: "owner", reason: "channel_member_removed", removedBotId: botId },
          })),
        );
      }
      const removed = await tx
        .delete(channelBots)
        .where(and(eq(channelBots.channelId, channelId), eq(channelBots.botId, botId)))
        .returning();
      if (removed.length)
        await tx.insert(runEvents).values({
          id: randomUUID(),
          channelId,
          botId,
          type: "BOT_REMOVED_FROM_CHANNEL",
          payload: { actor: "owner", cancelledRunIds: ids },
        });
      const members = await tx
        .select({ botId: channelBots.botId })
        .from(channelBots)
        .where(eq(channelBots.channelId, channelId))
        .orderBy(asc(channelBots.joinedAt), asc(channelBots.botId));
      return {
        channel: {
          id: channel.id,
          name: channel.name,
          description: channel.description,
          createdAt: channel.createdAt.toISOString(),
          botIds: members.map((member) => member.botId),
        },
        cancelledRuns: cancelled.map(toRun),
      };
    });
  }
}
