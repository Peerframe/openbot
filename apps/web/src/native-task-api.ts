import {
  type AttachmentOperation,
  nativeTaskScopeSchema,
  ownerAttachmentSchema,
} from "@openbot/protocol";
import { z } from "zod";
import { ApiError } from "./api";

export type { NativeTaskScope, NativeTaskScopeInput, OwnerAttachment } from "@openbot/protocol";
export {
  emptyNativeTaskScope,
  nativeTaskScopeInputSchema,
  nativeTaskScopeSchema,
  ownerAttachmentSchema,
} from "@openbot/protocol";

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
