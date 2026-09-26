import { z } from "zod";
import { protocolVersion } from "./node-metadata.js";

const browserKeySchema = z.enum([
  "Enter",
  "Tab",
  "Shift+Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ControlOrMeta+A",
]);

export const browserActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("observe") }).strict(),
  z.object({ kind: z.literal("take") }).strict(),
  z.object({ kind: z.literal("release") }).strict(),
  z.object({ kind: z.literal("navigate"), url: z.string().url().max(2048) }).strict(),
  z
    .object({
      kind: z.literal("click"),
      x: z.number().finite().min(0).max(8192),
      y: z.number().finite().min(0).max(8192),
    })
    .strict(),
  z.object({ kind: z.literal("type"), text: z.string().min(1).max(4096) }).strict(),
  z
    .object({
      kind: z.literal("key"),
      key: browserKeySchema,
    })
    .strict(),
  z.object({ kind: z.literal("scroll"), deltaY: z.number().int().min(-2000).max(2000) }).strict(),
]);
export type BrowserAction = z.infer<typeof browserActionSchema>;

// This internal Work action is deliberately excluded from the public Owner action schema.
const browserExpectedSchema = z
  .object({
    url: z.string().url().max(2048),
    snapshotId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    frameSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const browserRefSchema = z.string().regex(/^(?:f[0-9]{1,8})?e[0-9]{1,8}$/);
export const browserTaskActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read") }).strict(),
  z.object({ kind: z.literal("navigate"), url: z.string().url().max(2048) }).strict(),
  z
    .object({ kind: z.literal("click"), ref: browserRefSchema, expected: browserExpectedSchema })
    .strict(),
  z
    .object({
      kind: z.literal("type"),
      ref: browserRefSchema,
      text: z.string().max(4096),
      expected: browserExpectedSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("key"), key: browserKeySchema, expected: browserExpectedSchema })
    .strict(),
  z
    .object({
      kind: z.literal("scroll"),
      deltaY: z.number().int().min(-2000).max(2000),
      expected: browserExpectedSchema,
    })
    .strict(),
]);
export type BrowserTaskAction = z.infer<typeof browserTaskActionSchema>;
export const browserPageSchema = z
  .object({
    url: z.string().max(2048),
    title: z.string().max(1024),
    text: z.string().max(16000),
    truncated: z.boolean(),
    snapshotId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    elements: z
      .array(
        z
          .object({
            ref: browserRefSchema,
            role: z.string().min(1).max(64),
            name: z.string().max(1024),
            value: z.string().max(4096).optional(),
            disabled: z.boolean().optional(),
            checked: z.boolean().optional(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .refine(
    (page) =>
      new TextEncoder().encode(JSON.stringify(page)).length <= 65536 &&
      new Set(page.elements.map((element) => element.ref)).size === page.elements.length,
  );
export type BrowserPage = z.infer<typeof browserPageSchema>;

export const browserFrameSchema = z
  .object({
    base64: z
      .string()
      .min(12)
      .max(7_000_000)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192),
    capturedAt: z.string().datetime(),
    url: z.string().max(2048),
  })
  .strict();
export type BrowserFrame = z.infer<typeof browserFrameSchema>;

export const browserCommandSchema = z
  .object({
    type: z.literal("browser.command"),
    protocolVersion: z.literal(protocolVersion),
    nodeId: z.string().min(1).max(128),
    requestId: z.string().uuid(),
    sessionId: z.string().uuid(),
    botId: z.string().uuid(),
    expiresAt: z.string().datetime(),
    controlExpiresAt: z.string().datetime().optional(),
    action: z.union([
      browserActionSchema,
      z.object({ kind: z.literal("agent"), operation: browserTaskActionSchema }).strict(),
    ]),
  })
  .strict();
export type BrowserCommand = z.infer<typeof browserCommandSchema>;

export const browserResultSchema = z
  .object({
    type: z.literal("browser.result"),
    protocolVersion: z.literal(protocolVersion),
    nodeId: z.string().min(1).max(128),
    requestId: z.string().uuid(),
    sessionId: z.string().uuid(),
    ok: z.boolean(),
    frame: browserFrameSchema.optional(),
    page: browserPageSchema.optional(),
    error: z
      .enum([
        "unavailable",
        "busy",
        "expired",
        "control_required",
        "invalid_response",
        "action_failed",
      ])
      .optional(),
  })
  .strict();
export type BrowserResult = z.infer<typeof browserResultSchema>;

export interface BrowserSessionView {
  id: string;
  botId: string;
  nodeId: string;
  nodeName: string;
  control: "available" | "mine" | "other" | "paused";
  controlAvailable?: boolean;
  controlExpiresAt?: string;
  frame?: BrowserFrame;
}
