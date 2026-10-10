/** Atomically bridges channel messages and Runs into durable Work admissions. */
import { LOCK_NAMESPACE } from "./database-locks.js";
import { randomUUID } from "node:crypto";
import {
  createMessageInputSchema,
  modelSelectionSchema,
  cancelRunRequestSchema,
  steerNativeRunInputSchema,
} from "@openbot/protocol";
import { WorkConflict } from "@openbot/work";
import { z } from "zod";
import type { FileSession, OwnerFiles } from "./owner-files.js";
import { refuse } from "./owner-transaction.js";
import type { ProductRoute } from "./product-identity.js";
import { messageProjection, runProjection, channelIdentity } from "./channel-read-projection.js";
import { automationReferences } from "./product-automations.js";
import { requestCorrection } from "./work-commands.js";
import { type WorkDb, workEvent } from "./work-handoff.js";
import { createWork, workParse } from "./work-public.js";
import { workAttachmentIds } from "./work-source.js";
import { cascadeWork } from "./work-tree.js";
import { workText } from "./work-values.js";
import type { WorkBrowserProfiles } from "./work-browser-profiles.js";
import { lockWorkTask } from "./work-handoff.js";
import type { WorkCommandProfiles } from "./work-command-profiles.js";
type Row = Record<string, any>;
export function taskTitle(content: string) {
  if (content.length <= 80) return content;
  let head = content.slice(0, 77);
  if (/[\ud800-\udbff]/.test(head.at(-1) ?? "")) head = head.slice(0, -1);
  return head + "...";
}
export async function workSelection(db: WorkDb, bot: Row) {
  let selection = bot.configuration?.model ?? null;
  if (selection === null) {
    const [p] =
      await db`SELECT default_model FROM owner_preferences WHERE owner_id='owner' FOR SHARE`;
    selection = p?.default_model ?? null;
  }
  return selection === null ? null : workParse(modelSelectionSchema, selection);
}
export async function channelAudit(
  db: WorkDb,
  run: Row,
  type: string,
  payload: Record<string, unknown>,
) {
  await db`INSERT INTO run_events(id,run_id,channel_id,bot_id,type,payload) VALUES(${randomUUID()},${run.id ?? null},${run.channel_id},${run.bot_id ?? null},${type},${db.json(payload as never)})`;
}
export async function admitChannelWork(
  db: WorkDb,
  run: Row,
  tokenLimit: number,
  browser?: WorkBrowserProfiles,
  commands?: WorkCommandProfiles,
) {
  const browserTask = run.execution_profile === "docker-linux" && browser?.has(run.bot_id);
  const isolated = browserTask || (run.execution_profile === "docker-linux" && !!commands);
  const profiles = browserTask ? browser : commands;
  if (!["none", "model"].includes(run.execution_profile) && !isolated)
    throw new WorkConflict("isolated_execution_unqualified");
  const task = await createWork(
    db,
    { botId: run.bot_id, objective: run.instruction, tokenLimit, requestKey: "source:" + run.id },
    undefined,
    true,
  );
  const [prior] = await db`SELECT * FROM work_sources WHERE task_id=${task.id}`;
  if (prior) {
    if (
      prior.legacy_run_id !== run.id ||
      prior.channel_id !== run.channel_id ||
      prior.source_message_id !== run.source_message_id
    )
      throw new WorkConflict("source_content_changed");
    if (isolated) await profiles!.resolve(db, await lockWorkTask(db, task.id));
    return task;
  }
  await db`INSERT INTO work_sources(task_id,legacy_run_id,channel_id,source_message_id) VALUES(${task.id},${run.id},${run.channel_id},${run.source_message_id})`;
  if (isolated) await profiles!.capture(db, await lockWorkTask(db, task.id));
  await workEvent(db, task.id, "source.admitted", { sourceRunId: run.id });
  return task;
}
export async function publishWorkSource(db: WorkDb, taskId: string, summary: string) {
  const [s] =
    await db`SELECT s.*,t.bot_id FROM work_sources s JOIN work_tasks t ON t.id=s.task_id WHERE s.task_id=${taskId}`;
  if (!s) return;
  const id = "work-result:" + taskId;
  await db`INSERT INTO messages(id,channel_id,author_type,author_id,run_id,reply_to_message_id,content)
    VALUES(${id},${s.channel_id},'bot',${s.bot_id},${s.legacy_run_id},${s.source_message_id},${summary})`;
  await channelAudit(
    db,
    { id: s.legacy_run_id, channel_id: s.channel_id, bot_id: s.bot_id },
    "RUN_COMPLETED",
    { taskId, messageId: id },
  );
}
function recipients(
  candidates: Row[],
  value: z.infer<typeof createMessageInputSchema>,
  direct: string | null,
  primary: string | null,
) {
  const requested = value.botIds ?? (value.botId ? [value.botId] : null);
  if (direct && requested?.some((id) => id !== direct))
    refuse(422, "A direct conversation can only address its Bot.");
  const selected =
    requested ??
    (direct ? [direct] : primary && candidates.some((b) => b.id === primary) ? [primary] : null);
  const ids = selected ?? [
    candidates.find((b) =>
      ["chief", "总管", "协调", "调度"].some((m) =>
        (b.name + " " + b.role).toLowerCase().includes(m),
      ),
    )?.id ?? candidates[0]?.id,
  ];
  return ids.map((id) => {
    const bot = candidates.find((b) => b.id === id);
    if (!bot)
      return refuse(
        422,
        selected
          ? "The selected Bot is not a member of this channel."
          : "Add a Bot to this channel before assigning a task.",
      );
    return bot;
  });
}
export async function submitChannelWork(
  db: WorkDb,
  session: FileSession | undefined,
  channelId: string,
  body: unknown,
  tokenLimit: number,
  automationId?: string,
  browser?: WorkBrowserProfiles,
  commands?: WorkCommandProfiles,
) {
  channelIdentity(channelId);
  const value = workParse(createMessageInputSchema, body);
  workText(value.content, 32768);
  const [workspace] = automationId
    ? []
    : await db`SELECT primary_bot_id FROM workspace_settings WHERE workspace_id='workspace' FOR UPDATE`;
  let refs: string[];
  try {
    refs = workAttachmentIds(value.content);
  } catch (error) {
    if (error instanceof WorkConflict && error.message === "task_attachment_limit")
      return refuse(413, "At most 8 attachments may be used per task.");
    throw error;
  }
  if (refs.length) {
    if (!session) return refuse(503, "Attachment reference validation is unavailable.");
    automationReferences(session, channelId, value.content);
  }
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${channelId},${LOCK_NAMESPACE.taskSource}))`;
  const [channel] =
    await db`SELECT id,direct_bot_id FROM channels WHERE id=${channelId} AND deleted_at IS NULL FOR UPDATE`;
  if (!channel) return refuse(404, "Channel not found.");
  if (
    value.replyToMessageId &&
    !(
      await db`SELECT 1 FROM messages WHERE id=${value.replyToMessageId} AND channel_id=${channelId}`
    ).length
  )
    return refuse(422, "The replied message does not belong to this channel.");
  const bots =
    await db`SELECT b.* FROM channel_bots cb JOIN bots b ON b.id=cb.bot_id WHERE cb.channel_id=${channelId} AND b.deleted_at IS NULL ORDER BY cb.joined_at,b.created_at,b.id LIMIT 10001 FOR SHARE OF cb,b`;
  if (bots.length > 10000) throw new WorkConflict("task_membership_limit");
  const selected = recipients(
    bots,
    value,
    channel.direct_bot_id,
    workspace?.primary_bot_id ?? null,
  );
  const [clock] =
    await db`SELECT greatest(date_trunc('milliseconds',statement_timestamp()),coalesce(date_trunc('milliseconds',max(created_at))+interval '1 millisecond','-infinity'::timestamptz)) AS created_at FROM messages WHERE channel_id=${channelId} AND author_type IN ('human','system')`;
  const messageId = randomUUID(),
    firstRunId = randomUUID(),
    title = taskTitle(value.content);
  const [message] =
    await db`INSERT INTO messages(id,channel_id,author_type,reply_to_message_id,run_id,content,created_at) VALUES(${messageId},${channelId},${automationId ? "system" : "human"},${value.replyToMessageId ?? null},${firstRunId},${value.content},${clock!.created_at}) RETURNING *`;
  const runs = [];
  for (const [index, bot] of selected.entries()) {
    const selection = bot.computer_profile === "docker-linux" ? null : await workSelection(db, bot);
    const [run] =
      await db`INSERT INTO runs(id,channel_id,bot_id,source_message_id,execution_profile,instruction,title,status,model_selection,created_at,updated_at)
      VALUES(${index === 0 ? firstRunId : randomUUID()},${channelId},${bot.id},${messageId},${bot.computer_profile},${value.content},${title},'queued',${selection === null ? null : db.json(selection)},${clock!.created_at},${clock!.created_at}) RETURNING *`;
    const task = await admitChannelWork(db, run!, tokenLimit, browser, commands);
    runs.push(runProjection({ ...run, work_task_id: task.id }));
    await channelAudit(db, run!, "RUN_CREATED", {
      sourceMessageId: messageId,
      ...(automationId ? { automationId } : {}),
      title,
      executionProfile: bot.computer_profile,
    });
  }
  await channelAudit(db, { channel_id: channelId }, "MESSAGE_CREATED", {
    messageId,
    authorType: automationId ? "system" : "human",
    ...(automationId ? { automationId } : {}),
  });
  return { message: messageProjection(message!), run: runs[0], ...(value.botIds ? { runs } : {}) };
}
async function commandTarget(db: WorkDb, id: string) {
  channelIdentity(id);
  await db`SELECT pg_advisory_xact_lock(hashtextextended(channel_id,${LOCK_NAMESPACE.taskSource})) FROM runs WHERE id=${id}`;
  await db`SELECT c.id FROM channels c JOIN runs r ON r.channel_id=c.id WHERE r.id=${id} FOR KEY SHARE OF c`;
  await db`SELECT id FROM runs WHERE id=${id} FOR UPDATE`;
  const [row] =
    await db`SELECT r.id,r.channel_id,r.bot_id,r.execution_profile,r.node_id,p.status,p.work_task_id FROM runs r JOIN runs_work_projection p ON p.id=r.id WHERE r.id=${id}`;
  if (!row) return refuse(404, "Task not found.");
  return row;
}
async function cancelChannelRun(db: WorkDb, id: string) {
  const row = await commandTarget(db, id);
  if (!["none", "model"].includes(row.execution_profile) || row.node_id !== null)
    return refuse(409, "Only native Agent tasks can be stopped here.");
  if (!["cancelled", "queued", "running", "waiting_approval", "blocked"].includes(row.status))
    return refuse(409, "This task has already ended.");
  if (row.status !== "cancelled") {
    const descendants =
      await db`SELECT id,channel_id,bot_id FROM runs WHERE channel_id=${row.channel_id} AND id<>${id}
      AND execution_profile IN ('none','model') AND node_id IS NULL AND id IN (SELECT id FROM runs_work_projection WHERE status IN ('queued','running','waiting_approval','blocked'))
      AND (root_run_id=${id} OR parent_run_id=${id}) ORDER BY created_at,id COLLATE "C" LIMIT 1001 FOR UPDATE`;
    if (descendants.length > 1000) throw new WorkConflict("cancellation_descendant_limit");
    for (const item of [row, ...descendants]) {
      const [live] = await db`SELECT status FROM runs_work_projection WHERE id=${item.id}`;
      if (
        item.id !== id &&
        !["queued", "running", "waiting_approval", "blocked"].includes(live?.status)
      )
        continue;
      const [source] = await db`SELECT task_id FROM work_sources WHERE legacy_run_id=${item.id}`;
      if (source) await cascadeWork(db, source.task_id, "cancel");
      await db`UPDATE runs SET status='cancelled',updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=${item.id}`;
      await channelAudit(db, item, "RUN_CANCELLED", {
        executor: "native-agent",
        actor: "owner",
        ...(item.id === id ? {} : { ancestorRunId: id }),
      });
    }
  }
  const [run] = await db`SELECT * FROM runs_work_projection WHERE id=${id}`;
  return { run: runProjection(run!) };
}
async function steerChannelRun(db: WorkDb, id: string, body: unknown) {
  workParse(z.string().uuid(), id);
  const { instruction } = workParse(steerNativeRunInputSchema, body);
  workText(instruction, 16384);
  if (/\[OpenBot attachment: [0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\]/i.test(instruction))
    return refuse(400, "Additional attachments require a new task; steering accepts text only.");
  const row = await commandTarget(db, id);
  if (
    !["none", "model"].includes(row.execution_profile) ||
    row.node_id !== null ||
    !["queued", "running", "waiting_approval"].includes(row.status)
  )
    return refuse(409, "Only active native tasks accept additional instructions.");
  if (
    !(
      await db`SELECT 1 FROM channel_bots WHERE channel_id=${row.channel_id} AND bot_id=${row.bot_id} FOR SHARE`
    ).length
  )
    return refuse(409, "The Bot is no longer a channel member.");
  const [count] =
    await db`SELECT count(*) AS n FROM run_events WHERE run_id=${id} AND type='RUN_STEERING_SUBMITTED'`;
  if (Number(count!.n) >= 8)
    return refuse(409, "A task accepts at most eight additional instructions.");
  const [event] =
    await db`INSERT INTO run_events(id,run_id,channel_id,bot_id,type,payload,created_at) VALUES(${randomUUID()},${id},${row.channel_id},${row.bot_id},'RUN_STEERING_SUBMITTED',${db.json({ instruction, actor: "owner" })},date_trunc('milliseconds',clock_timestamp())) RETURNING *`;
  if (row.work_task_id) {
    const [run] =
      await db`SELECT id FROM work_runs WHERE task_id=${row.work_task_id} ORDER BY ordinal DESC LIMIT 1`;
    if (!run) throw new WorkConflict("work_not_found");
    const [sequence] = await db`SELECT count(*) AS n FROM work_corrections WHERE run_id=${run.id}`;
    await requestCorrection(
      db,
      row.work_task_id,
      {
        runId: run.id,
        instruction,
        requestKey: "source:" + event!.id,
        expectedSequence: Number(sequence!.n),
      },
      true,
    );
  }
  return {
    steering: {
      id: event!.id,
      runId: id,
      channelId: row.channel_id,
      botId: row.bot_id,
      instruction,
      createdAt: event!.created_at.toISOString(),
    },
  };
}
export function workChannelRoutes(
  files: OwnerFiles | undefined,
  tokenLimit: number,
  browser?: WorkBrowserProfiles,
  commands?: WorkCommandProfiles,
): ProductRoute[] {
  const guard = async <T>(operation: () => Promise<T>) => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof WorkConflict)
        return refuse(error.message === "work_not_found" ? 404 : error.message === "invalid_work_input" ? 422 : 409, error.message);
      throw error;
    }
  };
  return [
    {
      method: "POST",
      path: "/api/v1/channels/{channel_id}/messages",
      kind: "typed",
      maxBytes: 131072,
      status: 201,
      remote: (owner, ids, body, signal) =>
        guard(() =>
          files
            ? files.withLock(
                (session) =>
                  owner(
                    (db) =>
                      submitChannelWork(
                        db,
                        session,
                        ids[0]!,
                        body,
                        tokenLimit,
                        undefined,
                        browser,
                        commands,
                      ),
                    session.signal,
                  ),
                signal,
              )
            : owner((db) =>
                submitChannelWork(
                  db,
                  undefined,
                  ids[0]!,
                  body,
                  tokenLimit,
                  undefined,
                  browser,
                  commands,
                ),
              ),
        ),
      execute: async () => {
        throw new Error("Channel admission requires the file authority lease.");
      },
    },
    {
      method: "POST",
      path: "/api/v1/runs/{run_id}/cancel",
      kind: "typed",
      maxBytes: 128,
      status: 200,
      execute: (db, ids, body) =>
        guard(async () => {
          workParse(cancelRunRequestSchema, body);
          return cancelChannelRun(db, ids[0]!);
        }),
    },
    {
      method: "POST",
      path: "/api/v1/runs/{run_id}/steer",
      kind: "typed",
      maxBytes: 18000,
      status: 202,
      execute: (db, ids, body) => guard(() => steerChannelRun(db, ids[0]!, body)),
    },
  ];
}
