// Client for the Work task routes used by 任务监督: list Bots, create, read and cancel a task.
import {
  type CancelWorkInput,
  type CreateWorkInput,
  createWorkInputSchema,
  workErrorSchema,
  workSnapshotSchema,
} from "@openbot/protocol";
import { z } from "zod";
import { ApiError } from "./api";

export type { CancelWorkInput, CreateWorkInput, WorkSnapshot } from "@openbot/protocol";
export { createWorkInputSchema, workSnapshotSchema } from "@openbot/protocol";

// The client projection remains additive; diagnostics stay out of UI messages.
const clientWorkErrorSchema = workErrorSchema.strip();

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
    const error = clientWorkErrorSchema.safeParse(
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
