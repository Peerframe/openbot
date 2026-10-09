import { nativeTaskScopeRequestSchema } from "@openbot/protocol";
import { WorkConflict } from "@openbot/work";
import type { Attachment, FileSession } from "./owner-files.js";
import type { WorkDb, WorkTaskRow } from "./work-handoff.js";
import { workCanonical } from "./work-values.js";
export function descriptor(item: Attachment) {
  if (item.deletedAt) throw new WorkConflict("native_attachment_unavailable");
  return {
    id: item.id,
    name: item.name,
    mediaType: item.mediaType,
    sizeBytes: item.sizeBytes,
    sha256: item.sha256,
    metadataSha256: workCanonical(item).digest,
  };
}
export async function captureWorkScope(
  db: WorkDb,
  taskId: string,
  botId: string,
  raw: unknown,
  session?: FileSession,
) {
  if (raw === null) return;
  const parsed = nativeTaskScopeRequestSchema.parse(raw);
  if (parsed.collaboratorBotIds.includes(botId)) throw new WorkConflict("native_collaborator_self");
  for (const id of [...parsed.collaboratorBotIds].sort()) {
    const [bot] =
      await db`SELECT computer_profile FROM bots WHERE id=${id} AND deleted_at IS NULL FOR SHARE`;
    if (!bot || !["none", "model"].includes(bot.computer_profile))
      throw new WorkConflict("collaboration_target_unavailable");
  }
  if (parsed.attachmentIds.length && !session)
    throw new WorkConflict("native_attachment_storage_required");
  const attachments = parsed.attachmentIds.map((id) => descriptor(session!.content(null, id).item));
  if (attachments.reduce((total, item) => total + item.sizeBytes, 0) > 20 * 1024 * 1024)
    throw new WorkConflict("native_attachment_limit");
  const scope = { version: 1, taskId, botId, request: parsed, attachments };
  await db`INSERT INTO work_task_scopes(task_id,scope,scope_digest) VALUES(${taskId},${db.json(scope)}::jsonb,${workCanonical(scope, 131072).digest})`;
}
export async function nativeWorkScope(db: WorkDb, task: WorkTaskRow) {
  const [row] =
    await db`SELECT scope,scope_digest FROM work_task_scopes WHERE task_id=${task.id} FOR SHARE`;
  if (!row) return null;
  const value = row.scope;
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "attachments,botId,request,taskId,version" ||
    value.version !== 1 ||
    value.taskId !== task.id ||
    value.botId !== task.bot_id ||
    workCanonical(value, 131072).digest !== row.scope_digest
  )
    throw new WorkConflict("native_task_scope_changed");
  const parsed = nativeTaskScopeRequestSchema.parse(value.request);
  if (
    workCanonical(parsed).wire !== workCanonical(value.request).wire ||
    !Array.isArray(value.attachments) ||
    value.attachments.length !== parsed.attachmentIds.length ||
    parsed.collaboratorBotIds.includes(task.bot_id) ||
    value.attachments.some(
      (a: Record<string, unknown>, i: number) => a.id !== parsed.attachmentIds[i],
    )
  )
    throw new WorkConflict("native_task_scope_changed");
  return {
    value: {
      version: 1,
      taskId: task.id,
      botId: task.bot_id,
      request: parsed,
      attachments: value.attachments as ReturnType<typeof descriptor>[],
    },
    sha256: String(row.scope_digest),
  };
}
