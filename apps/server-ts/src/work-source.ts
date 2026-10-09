import { modelSelectionSchema } from "@openbot/protocol";
import { WorkConflict } from "@openbot/work";
import type { WorkDb, WorkTaskRow } from "./work-handoff.js";
import { currentWork, withCurrentWork, type WorkScope } from "./work-ledger.js";
import type { FileSession } from "./owner-files.js";
import { descriptor, nativeWorkScope } from "./work-scope.js";
import { channelWorkRow, workTree } from "./work-tree.js";
import { sha256, workCanonical } from "./work-values.js";

import type { WorkBrowserProfiles } from "./work-browser-profiles.js";
import type { WorkCommandProfiles } from "./work-command-profiles.js";
const validationSources = new WeakMap<
  WorkTaskRow,
  {
    db: WorkDb;
    profiles?: WorkBrowserProfiles | undefined;
    commands?: WorkCommandProfiles | undefined;
    source: Awaited<ReturnType<typeof readWorkSource>>;
  }
>();
/** Immutable source facts share the same read-only pass and held identity locks as its Task.
 * No grants, files, plugin state, receipts, child status or clock checks are cached here. */
export function withWorkSource<T>(
  db: WorkDb,
  scope: WorkScope,
  operation: (scope: WorkScope) => Promise<T>,
) {
  return withCurrentWork(db, scope, async (validationScope, task) => {
    const source = await resolveWorkSource(db, task, scope.browserProfiles, scope.commandProfiles);
    validationSources.set(task, {
      db,
      source,
      profiles: scope.browserProfiles,
      commands: scope.commandProfiles,
    });
    try {
      return await operation(validationScope);
    } finally {
      validationSources.delete(task);
    }
  });
}
/** Resolve persisted provenance under the existing source-before-Task locks. Never create scope from model input. */
export async function resolveWorkSource(
  db: WorkDb,
  task: WorkTaskRow,
  profiles?: WorkBrowserProfiles,
  commands?: WorkCommandProfiles,
) {
  const locked = validationSources.get(task);
  if (locked?.db === db && locked.profiles === profiles && locked.commands === commands)
    return locked.source;
  return readWorkSource(db, task, profiles, commands);
}
async function readWorkSource(
  db: WorkDb,
  task: WorkTaskRow,
  profiles?: WorkBrowserProfiles,
  commands?: WorkCommandProfiles,
) {
  const [mapping] = await db`SELECT * FROM work_sources WHERE task_id=${task.id} FOR SHARE`;
  const [profile] = await db`SELECT * FROM work_task_profiles WHERE task_id=${task.id} FOR SHARE`;
  const isolated = (
    await db`SELECT 1 FROM work_command_profiles WHERE task_id=${task.id} UNION ALL SELECT 1 FROM work_browser_profiles WHERE task_id=${task.id}`
  ).length;
  if ((mapping && profile) || isolated > 1 || (isolated && !mapping))
    throw new WorkConflict("product_source_ambiguous");
  if (mapping) {
    const channel = await channelWorkRow(db, task.id);
    if (
      !channel ||
      channel.bot_id !== task.bot_id ||
      channel.instruction !== task.objective ||
      channel.run_channel !== mapping.channel_id ||
      channel.message_channel !== mapping.channel_id ||
      channel.run_message !== mapping.source_message_id ||
      channel.node_id !== null
    )
      throw new WorkConflict("product_source_changed");
    const browser =
      channel.execution_profile === "docker-linux" && profiles?.has(task.bot_id)
        ? await profiles.resolve(db, task)
        : null;
    const command =
      channel.execution_profile === "docker-linux" && !browser && commands
        ? await commands.resolve(db, task)
        : null;
    if (
      (!["none", "model"].includes(channel.execution_profile) && !browser && !command) ||
      (isolated && !browser && !command)
    )
      throw new WorkConflict("isolated_execution_unqualified");
    const [member] =
      await db`SELECT cb.bot_id FROM channel_bots cb JOIN channels c ON c.id=cb.channel_id
      JOIN bots b ON b.id=cb.bot_id WHERE cb.channel_id=${mapping.channel_id} AND cb.bot_id=${task.bot_id}
      AND c.deleted_at IS NULL AND b.deleted_at IS NULL FOR SHARE OF cb,c,b`;
    if (!member) throw new WorkConflict("product_model_scope_changed");
    const selection =
      browser?.profile.modelSelection ??
      command?.profile.modelSelection ??
      (channel.model_selection === null
        ? null
        : modelSelectionSchema.parse(channel.model_selection));
    const tree = workTree(task),
      root = tree.sources.get(tree.rootTaskId) ?? channel;
    const provenance = {
      kind: "channel" as const,
      taskId: task.id,
      sourceRunId: channel.legacy_run_id,
      channelId: channel.channel_id,
      messageId: channel.source_message_id,
      messageCutoff: root.message_cutoff,
      runCutoff: root.run_cutoff,
      replyTo: channel.reply_to_message_id,
      instructionSha256: sha256(task.objective),
    };
    return {
      kind: "channel" as const,
      channel,
      native: null,
      browser,
      command,
      selection,
      provenance,
      profileSha256: workCanonical({
        ...provenance,
        executionProfile: channel.execution_profile,
        modelSelection: selection,
        ...(command ? { commandProfileSha256: command.sha256 } : {}),
        ...(browser
          ? {
              browserProfileSha256: browser.sha256,
              browserPageScopeSha256: browser.page?.sha256 ?? null,
            }
          : {}),
      }).digest,
    };
  }
  if (
    !profile ||
    profile.bot_id !== task.bot_id ||
    !["none", "model"].includes(profile.execution_profile)
  )
    throw new WorkConflict("product_source_changed");
  const selection =
    profile.model_selection === null ? null : modelSelectionSchema.parse(profile.model_selection);
  if (profile.execution_profile === "model" && !selection)
    throw new WorkConflict("product_task_model_required");
  if (
    workCanonical({
      kind: "work_task_profile",
      version: 1,
      taskId: task.id,
      botId: task.bot_id,
      executionProfile: profile.execution_profile,
      modelSelection: selection,
    }).digest !== profile.profile_digest
  )
    throw new WorkConflict("product_task_profile_changed");
  const native = await nativeWorkScope(db, task);
  return {
    kind: "task" as const,
    channel: null,
    native,
    browser: null,
    command: null,
    selection,
    profileSha256: String(profile.profile_digest),
    provenance: {
      kind: "task" as const,
      taskId: task.id,
      profileSha256: String(profile.profile_digest),
      scopeSha256: native?.sha256 ?? null,
    },
  };
}
export async function resourceWorkSource(
  db: WorkDb,
  scope: WorkScope,
  capability: "attachments" | "knowledge" | "plugins" | "web" | "collaboration" | "channel_reads",
) {
  const task = await currentWork(db, scope),
    source = await resolveWorkSource(db, task, scope.browserProfiles, scope.commandProfiles);
  if ((source.browser || source.command) && !["attachments", "channel_reads"].includes(capability))
    throw new WorkConflict("isolated_task_capability_unavailable");
  if (source.kind === "task") {
    const request = source.native?.value.request;
    if (
      !request ||
      capability === "channel_reads" ||
      !(capability === "attachments"
        ? request.attachmentIds.length
        : capability === "collaboration"
          ? request.collaboratorBotIds.length
          : request[capability])
    )
      throw new WorkConflict("native_task_capability_unavailable");
  }
  return { task, ...source };
}
export function workAttachmentIds(objective: string) {
  const ids = [
    ...new Set(
      [
        ...objective.matchAll(
          /\[OpenBot attachment: ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\]/gi,
        ),
      ].map((m) => m[1]!.toLowerCase()),
    ),
  ];
  if (ids.length > 8) throw new WorkConflict("task_attachment_limit");
  return ids;
}

export function sourceWorkAttachments(
  source: Awaited<ReturnType<typeof resolveWorkSource>>,
  objective: string,
  session?: FileSession,
) {
  const channelId = source.channel?.channel_id ?? null;
  const attachmentIds =
    source.kind === "task"
      ? (source.native?.value.request.attachmentIds ?? [])
      : workAttachmentIds(objective);
  if (attachmentIds.length && !session) throw new WorkConflict("attachment_storage_required");
  const attachments = attachmentIds.map((id) => descriptor(session!.content(channelId, id).item));
  if (attachments.reduce((n, a) => n + a.sizeBytes, 0) > 20 * 1024 * 1024)
    throw new WorkConflict("task_attachment_limit");
  if (
    source.kind === "task" &&
    source.native &&
    workCanonical(attachments).wire !== workCanonical(source.native.value.attachments).wire
  )
    throw new WorkConflict("native_attachment_changed");
  return { channelId, attachmentIds, attachments };
}
