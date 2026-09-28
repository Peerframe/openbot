import { z } from "zod";
import { ApiError } from "./api";
import type { components, operations } from "./generated/work-contract";
import { nativeTaskScopeInputSchema } from "./native-task-api";

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
    tokenLimit: z.number().int().nonnegative(),
    reservedTokens: z.number().int().nonnegative(),
    spentTokens: z.number().int().nonnegative(),
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
      reservedTokens: z.number().int().nonnegative(),
      actualTokens: z.number().int().nonnegative().nullable(),
      evidence: z.record(z.string(), z.string()).nullable(),
      reconciliation: reconciliation.nullable().default(null),
    }),
  ),
  artifacts: z.array(
    z.object({
      id: z.string(),
      runId: z.string(),
      name: z.string(),
      mediaType: z.string(),
      sha256: z.string(),
      sizeBytes: z.number().int().nonnegative(),
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
}) satisfies z.ZodType<WorkSnapshot>;
export type WorkSnapshot = components["schemas"]["WorkSnapshot"];
export type CreateWorkInput =
  operations["createWorkTask"]["requestBody"]["content"]["application/json"];
export type CancelWorkInput =
  operations["cancelWorkTask"]["requestBody"]["content"]["application/json"];
// JSON Schema length counts Unicode code points, whereas JavaScript string.length counts UTF-16.
const boundedText = (max: number) =>
  z.string().refine((value) => {
    const length = [...value].length;
    return length >= 1 && length <= max;
  });
export const createWorkInputSchema = z
  .object({
    botId: boundedText(128),
    objective: boundedText(16384),
    tokenLimit: z.number().int().min(0).max(1_000_000_000),
    requestKey: boundedText(128),
    scope: nativeTaskScopeInputSchema.nullable().optional(),
  })
  .strict()
  .transform(({ scope, ...required }) =>
    scope === undefined ? required : { ...required, scope },
  ) satisfies z.ZodType<CreateWorkInput>;
const workErrorSchema = z.object({
  detail: z.union([z.string(), z.array(z.record(z.string(), z.json()))]),
}) satisfies z.ZodType<components["schemas"]["WorkError"]>;

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
    // Validate the documented error envelope, but keep diagnostics out of UI messages.
    const error = workErrorSchema.safeParse(
      await response.json().catch((cause: unknown) => {
        if (signal.aborted || (cause instanceof Error && cause.name === "AbortError")) throw cause;
        return null;
      }),
    );
    throw new ApiError(
      error.success
        ? `Work request failed (${response.status}).`
        : `Invalid Work error response (${response.status}).`,
      response.status,
    );
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
  return workSnapshotSchema.parse(
    await request("/api/v1/tasks", signal, createWorkInputSchema.parse(input)),
  );
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
    await request(
      `/api/v1/tasks/${encodeURIComponent(id)}/cancel`,
      signal,
      {} satisfies CancelWorkInput,
    ),
  );
  if (snapshot.id !== id) throw new Error("Task identity mismatch.");
  return snapshot;
}
