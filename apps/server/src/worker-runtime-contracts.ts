/** Internal Worker snapshots and dispatch authority shared by Server components, never an HTTP proxy. */
import { executionNodeSchema, nodeIdSchema } from "@openbot/protocol";
import { z } from "zod";
import { workBrowserRoutesSchema } from "./work-browser-profiles.js";

export const workerRuntimeConfiguration = z.strictObject({
  browserRoutes: z
    .record(z.string().uuid(), nodeIdSchema)
    .refine((routes) => Object.keys(routes).length <= 32),
  pageOrigins: workBrowserRoutesSchema.shape.pageOrigins,
  command: z.string().min(1).max(4096).optional(),
  humanControl: z.boolean(),
  legacyHumanControl: z.boolean(),
});
export type WorkerRuntimeOptions = z.infer<typeof workerRuntimeConfiguration>;


const binding = z.strictObject({
  nodeId: z.string().max(128),
  connectionId: z.string().uuid(),
  credentialDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const runtimeSnapshotSchema = z.strictObject({
  nodes: z.array(executionNodeSchema).max(4096),
  revision: z.number().int().nonnegative(),
  bindings: z.array(binding).max(4096),
  browserRoutes: z.record(z.string().max(128), z.string().max(128)),
  humanControl: z.boolean(),
  legacyHumanControl: z.boolean(),
});
export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>;
export type RuntimeBinding = z.infer<typeof binding>;
export interface RuntimeAccess {
  command(
    dispatch: { ticketId: string; wire: string },
    signal: AbortSignal,
  ): Promise<import("@openbot/protocol").BrowserResult>;
  snapshot(signal: AbortSignal): Promise<RuntimeSnapshot>;
  detach(nodeId: string, enrollmentToken: string | undefined, signal: AbortSignal): Promise<void>;
}
