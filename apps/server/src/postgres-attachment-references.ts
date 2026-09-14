import { automations, messages, runs } from "@openbot/db";
import { and, eq, ilike } from "drizzle-orm";

type Database = ReturnType<typeof import("@openbot/db")["createDatabase"]>["db"];

/** Persisted owners, including paused schedules, retain bytes until their own lifecycle ends. */
export async function attachmentIsReferenced(
  database: Database,
  channelId: string,
  id: string,
): Promise<boolean> {
  const [messageRows, runRows, scheduleRows] = await Promise.all([
    database
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.channelId, channelId), ilike(messages.content, `%${id}%`)))
      .limit(1),
    database
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.channelId, channelId), ilike(runs.instruction, `%${id}%`)))
      .limit(1),
    database
      .select({ id: automations.id })
      .from(automations)
      .where(and(eq(automations.channelId, channelId), ilike(automations.prompt, `%${id}%`)))
      .limit(1),
  ]);
  return messageRows.length > 0 || runRows.length > 0 || scheduleRows.length > 0;
}
