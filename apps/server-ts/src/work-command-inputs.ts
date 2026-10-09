import { WorkConflict } from "@openbot/work";
import { z } from "zod";
import type { FileSession } from "./owner-files.js";
import { attachmentRead } from "./work-attachment.js";
import { type WorkCommand, workCommandSchema } from "./work-command-contract.js";
import { commandSource } from "./work-command-profiles.js";
import { commandValue } from "./work-command-values.js";
import { checkWorkContext } from "./work-commands.js";
import type { WorkDb, WorkTaskRow } from "./work-handoff.js";
import type { WorkScope } from "./work-ledger.js";
import { descriptor } from "./work-scope.js";
import { workAttachmentIds } from "./work-source.js";
import { sha256, workCanonical } from "./work-values.js";
export const commandAttachmentSchema = z
  .array(
    z
      .object({
        path: workCommandSchema.shape.inputManifest.element.shape.path,
        attachmentId: z.string().uuid(),
      })
      .strict(),
  )
  .max(8);
export type CommandAttachment = z.infer<typeof commandAttachmentSchema>[number];
export async function freezeCommandInputs(
  db: WorkDb,
  scope: WorkScope,
  task: WorkTaskRow,
  command: WorkCommand,
  bindings: CommandAttachment[],
  session?: FileSession,
) {
  const attachments = commandAttachmentSchema.parse(bindings);
  if (task.id !== scope.binding.input.taskId || command.inputManifest.length !== attachments.length)
    throw new WorkConflict("command_input_scope_changed");
  await checkWorkContext(db, task, scope.binding.input.runId, scope.contextId);
  const source = await commandSource(db, task),
    refs = workAttachmentIds(task.objective);
  if (refs.length && !session) throw new WorkConflict("command_input_scope_changed");
  const scopeFiles = {
    channelId: String(source.channel_id),
    attachmentIds: refs,
    attachments: refs.map((id) => descriptor(session!.content(String(source.channel_id), id).item)),
  };
  const items = attachments.map((item) => {
    if (!refs.includes(item.attachmentId)) throw new WorkConflict("command_input_scope_changed");
    const read = attachmentRead(session, scopeFiles, {
      attachmentId: item.attachmentId,
      offset: 0,
      limit: 12000,
    });
    const original = scopeFiles.attachments.find((a) => a.id === item.attachmentId)!;
    return {
      ...item,
      snapshot: read.snapshot,
      size: original.sizeBytes,
      sha256: read.snapshot.sha256,
    };
  });
  const names = attachments.map((a) => a.path);
  if (
    new Set(attachments.map((a) => a.attachmentId)).size !== attachments.length ||
    names.some((name, i) => i > 0 && name <= names[i - 1]!) ||
    workCanonical(items.map(({ path, size, sha256 }) => ({ path, size, sha256 }))).wire !==
      workCanonical(command.inputManifest).wire
  )
    throw new WorkConflict("command_input_manifest_changed");
  const receipt = {
    kind: "work_command_inputs",
    version: 1,
    taskId: task.id,
    runId: scope.binding.input.runId,
    generation: Number(task.authority_generation),
    correctionContextId: scope.contextId,
    sourceRunId: String(source.legacy_run_id),
    channelId: String(source.channel_id),
    messageId: String(source.source_message_id),
    instructionDigest: sha256(task.objective),
    inputDigest: command.inputDigest,
    items,
  };
  commandValue(receipt);
  return receipt;
}
export async function revalidateCommandInputs(
  db: WorkDb,
  scope: WorkScope,
  task: WorkTaskRow,
  command: WorkCommand,
  receipt: unknown,
  session?: FileSession,
) {
  commandValue(receipt);
  if (
    !receipt ||
    typeof receipt !== "object" ||
    !("items" in receipt) ||
    !Array.isArray(receipt.items)
  )
    throw new WorkConflict("command_input_scope_changed");
  const attachments = receipt.items.map((item) => ({
    path: item?.path,
    attachmentId: item?.attachmentId,
  }));
  const actual = await freezeCommandInputs(db, scope, task, command, attachments, session);
  if (workCanonical(actual).wire !== workCanonical(receipt).wire)
    throw new WorkConflict("command_input_scope_changed");
  return actual;
}
