import { z } from "zod";
import {
  browserActionSchema,
  browserMaintenanceInputSchema,
  browserFrameSchema,
  browserMaintenanceResultSchema,
} from "./browser.js";
import type { HttpOperation } from "./http-openapi.js";
import { calendarUtcTimestampSchema } from "./portability-http.js";

// HTTP actions follow retained Python code-point strings and preserve raw URL spelling.
const text = (maximum: number, minimum = 0) =>
  z
    .string()
    .min(minimum)
    .max(maximum)
    .refine((value) => !/[\ud800-\udfff]/u.test(value));
export const browserOwnerActionHttpSchema = z.discriminatedUnion("kind", [
  browserActionSchema.options[0],
  browserActionSchema.options[1],
  browserActionSchema.options[2],
  z.strictObject({
    kind: z.literal("navigate"),
    url: text(2048, 1).refine((value) => {
      // AnyUrl admits non-HTTP schemes; egress/admissible browser actions remain Provider policy.
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }),
  }),
  z.strictObject({
    kind: z.literal("click"),
    x: z.number().finite().min(0).max(8192),
    y: z.number().finite().min(0).max(8192),
  }),
  z.strictObject({ kind: z.literal("type"), text: text(4096, 1) }),
  browserActionSchema.options[6],
  browserActionSchema.options[7],
]);
export const browserMaintenanceRequestSchema = browserMaintenanceInputSchema;
const timestamp = calendarUtcTimestampSchema.regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
);
export const browserFrameHttpSchema = browserFrameSchema.safeExtend({
  url: text(2048),
  capturedAt: timestamp,
});
export const browserSessionHttpSchema = z.strictObject({
  id: z.string().uuid(),
  botId: z.string().uuid(),
  nodeId: z.string().min(1).max(128),
  nodeName: z.string(),
  control: z.enum(["available", "mine", "other", "paused"]),
  controlAvailable: z.boolean(),
  controlExpiresAt: timestamp.optional(),
  frame: browserFrameHttpSchema.optional(),
});
export const browserHttpSchemas = {
  BrowserOwnerAction: browserOwnerActionHttpSchema,
  BrowserMaintenanceInput: browserMaintenanceRequestSchema,
  BrowserFrame: browserFrameHttpSchema,
  BrowserSession: browserSessionHttpSchema,
  BrowserMaintenanceResult: browserMaintenanceResultSchema,
};
const errors = [401, 403, 404, 408, 409, 413, 422, 503];
export const browserHttpOperations: readonly HttpOperation[] = [
  {
    method: "post",
    path: "/api/v1/bots/{bot_id}/browser/maintenance",
    operationId: "maintainEmployeeBrowser",
    status: 200,
    request: "BrowserMaintenanceInput",
    response: "BrowserMaintenanceResult",
    maxBodyBytes: 1024,
    errors,
  },
  {
    method: "post",
    path: "/api/v1/bots/{bot_id}/browser",
    operationId: "openEmployeeBrowser",
    status: 201,
    response: "BrowserSession",
    errors,
  },
  {
    method: "post",
    path: "/api/v1/browser-sessions/{session_id}/commands",
    operationId: "commandEmployeeBrowser",
    status: 200,
    request: "BrowserOwnerAction",
    response: "BrowserSession",
    maxBodyBytes: 20000,
    errors,
  },
  {
    method: "delete",
    path: "/api/v1/browser-sessions/{session_id}",
    operationId: "closeEmployeeBrowser",
    status: 204,
    errors,
  },
];
export type BrowserSessionHttp = z.infer<typeof browserSessionHttpSchema>;
