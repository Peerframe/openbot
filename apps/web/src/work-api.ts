import { z } from "zod";
import { ApiError } from "./api";
import type { NativeTaskScopeInput } from "./native-task-api";

// Public projection from Python work_models.py; engine history is never client authority.
const reconciliation = z.object({
  id: z.string(),
  actionId: z.string(),
  sequence: z.number().int().nonnegative(),
  requestedBy: z.literal("owner"),
  reason: z.string(),
  createdAt: z.string(),
  delivered: z.boolean(),
  outcome: z.enum(["resolved", "unresolved"]).nullable(),
});
export const workSnapshotSchema = z.object({
  id: z.string().min(1),
  botId: z.string(),
  objective: z.string(),
  status: z.enum(["queued", "open", "completed", "cancelled", "failed"]),
  revision: z.number().int().nonnegative(),
  resultSummary: z.string().nullable(),
  authorityActive: z.boolean(),
  cancelRequested: z.boolean(),
  attention: z.enum(["approval", "reconciliation", "budget"]).nullable(),
  usage: z.object({
    tokenLimit: z.number().nonnegative(),
    reservedTokens: z.number().nonnegative(),
    spentTokens: z.number().nonnegative(),
  }),
  runs: z.array(
    z.object({
      id: z.string(),
      ordinal: z.number().int(),
      status: z.enum(["queued", "running", "completed", "cancelled", "failed"]),
    }),
  ),
  actions: z.array(
    z.object({
      id: z.string(),
      runId: z.string(),
      intent: z.record(z.string(), z.json()),
      intentDigest: z.string().regex(/^[0-9a-f]{64}$/),
      decision: z.enum(["not_required", "pending", "approved", "denied"]),
      status: z.enum(["proposed", "admitted", "unknown", "applied", "not_applied", "superseded"]),
      expiresAt: z.string(),
      reservedTokens: z.number().nonnegative(),
      actualTokens: z.number().nonnegative().nullable(),
      evidence: z.record(z.string(), z.string()).nullable(),
      reconciliation: reconciliation.nullable().optional(),
    }),
  ),
  artifacts: z.array(
    z.object({
      id: z.string(),
      runId: z.string(),
      name: z.string(),
      mediaType: z.string(),
      sha256: z.string(),
      sizeBytes: z.number().nonnegative(),
      downloadUrl: z.string(),
    }),
  ),
  events: z.array(
    z.object({
      revision: z.number().int(),
      kind: z.string(),
      payload: z.record(z.string(), z.json()),
    }),
  ),
  eventsTruncated: z.boolean(),
});
export type WorkSnapshot = z.infer<typeof workSnapshotSchema>;
export interface CreateWorkInput {
  botId: string;
  objective: string;
  tokenLimit: number;
  requestKey: string;
  scope?: NativeTaskScopeInput;
}

async function request(path: string, signal: AbortSignal, body?: object): Promise<unknown> {
  const response = await fetch(path, {
    credentials: "include",
    cache: "no-store",
    signal,
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("openbot:unauthorized"));
    throw new ApiError(`Work request failed (${response.status}).`, response.status);
  }
  return response.json();
}
export async function listWorkBots(signal: AbortSignal) {
  const result = await request("/api/v1/bots", signal);
  return z
    .object({
      bots: z.array(
        z.object({
          id: z.string().min(1),
          name: z.string(),
          computerProfile: z.enum([
            "none",
            "model",
            "docker-linux",
            "macos-cua",
            "lume-vm",
            "coder",
          ]),
        }),
      ),
    })
    .parse(result).bots;
}
export async function createWorkTask(input: CreateWorkInput, signal: AbortSignal) {
  return workSnapshotSchema.parse(await request("/api/v1/tasks", signal, input));
}
export async function getWorkTask(id: string, signal: AbortSignal) {
  const snapshot = workSnapshotSchema.parse(
    await request(`/api/v1/tasks/${encodeURIComponent(id)}`, signal),
  );
  if (snapshot.id !== id) throw new Error("Task identity mismatch.");
  return snapshot;
}
export async function cancelWorkTask(id: string, signal: AbortSignal) {
  const snapshot = workSnapshotSchema.parse(
    await request(`/api/v1/tasks/${encodeURIComponent(id)}/cancel`, signal, {}),
  );
  if (snapshot.id !== id) throw new Error("Task identity mismatch.");
  return snapshot;
}
