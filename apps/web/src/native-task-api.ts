import {
  attachmentByteLimit,
  attachmentMetadataSchema,
  type AttachmentOperation,
  MAX_TASK_ATTACHMENT_BYTES,
  MAX_TASK_ATTACHMENTS,
} from "@openbot/protocol";
import { z } from "zod";
import { ApiError } from "./api";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const identities = (max: number) =>
  z
    .array(z.string().uuid())
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length);
export const nativeTaskScopeInputSchema = z
  .object({
    version: z.literal(1),
    attachmentIds: identities(MAX_TASK_ATTACHMENTS),
    collaboratorBotIds: identities(32),
    knowledge: z.boolean(),
    plugins: z.boolean(),
    web: z.boolean(),
  })
  .strict();
export type NativeTaskScopeInput = z.infer<typeof nativeTaskScopeInputSchema>;
export function emptyNativeTaskScope(): NativeTaskScopeInput {
  return {
    version: 1,
    attachmentIds: [],
    collaboratorBotIds: [],
    knowledge: false,
    plugins: false,
    web: false,
  };
}

// Reuse the retained file/processing fields while refusing channel metadata in this namespace.
export const ownerAttachmentSchema = z
  .object({
    ...attachmentMetadataSchema.shape,
    scopeKind: z.literal("owner"),
    ownerId: z.literal("owner"),
  })
  .omit({ channelId: true })
  .strict()
  .refine((file) => file.sizeBytes <= attachmentByteLimit(file.mediaType));
export type OwnerAttachment = z.infer<typeof ownerAttachmentSchema>;
export const nativeTaskScopeSchema = nativeTaskScopeInputSchema
  .extend({
    sha256: hash,
    attachments: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            name: attachmentMetadataSchema.shape.name,
            mediaType: attachmentMetadataSchema.shape.mediaType,
            sizeBytes: attachmentMetadataSchema.shape.sizeBytes,
            sha256: hash,
            metadataSha256: hash,
          })
          .strict()
          .refine((file) => file.sizeBytes <= attachmentByteLimit(file.mediaType)),
      )
      .max(MAX_TASK_ATTACHMENTS),
  })
  .refine(
    (scope) =>
      scope.attachments.length === scope.attachmentIds.length &&
      new Set(scope.attachments.map((file) => file.id)).size === scope.attachmentIds.length &&
      scope.attachments.every((file) => scope.attachmentIds.includes(file.id)) &&
      scope.attachments.reduce((sum, file) => sum + file.sizeBytes, 0) <= MAX_TASK_ATTACHMENT_BYTES,
  );
export type NativeTaskScope = z.infer<typeof nativeTaskScopeSchema>;

async function request(path: string, signal: AbortSignal, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    cache: "no-store",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("openbot:unauthorized"));
    throw new ApiError(`Task resource request failed (${response.status}).`, response.status);
  }
  return response.json() as Promise<unknown>;
}
export async function getNativeTaskScope(taskId: string, signal: AbortSignal) {
  return z
    .object({ scope: nativeTaskScopeSchema.nullable() })
    .strict()
    .parse(await request(`/api/v1/tasks/${encodeURIComponent(taskId)}/scope`, signal)).scope;
}
export async function listOwnerAttachments(signal: AbortSignal) {
  return z
    .object({ attachments: z.array(ownerAttachmentSchema) })
    .strict()
    .parse(await request("/api/v1/task-attachments", signal)).attachments;
}
export async function uploadOwnerAttachment(file: File, signal: AbortSignal) {
  return z
    .object({ attachment: ownerAttachmentSchema })
    .strict()
    .parse(
      await request("/api/v1/task-attachments", signal, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-OpenBot-Filename": encodeURIComponent(file.name),
        },
        body: file,
      }),
    ).attachment;
}
export async function updateOwnerAttachment(
  id: string,
  operation: AttachmentOperation | "delete" | "restore",
  signal: AbortSignal,
  password?: string,
) {
  const lifecycle = operation === "delete" || operation === "restore";
  const suffix = operation === "delete" ? "" : operation === "restore" ? "/restore" : "/process";
  const result = z
    .object({ attachment: ownerAttachmentSchema })
    .strict()
    .parse(
      await request(`/api/v1/task-attachments/${encodeURIComponent(id)}${suffix}`, signal, {
        method: operation === "delete" ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lifecycle ? {} : { operation, ...(password ? { password } : {}) }),
      }),
    ).attachment;
  if (result.id !== id) throw new Error("Task attachment identity mismatch.");
  return result;
}
