import { z } from "zod";
import { protocolVersion } from "./node-metadata.js";

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
      key: z.enum([
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
      ]),
    })
    .strict(),
  z.object({ kind: z.literal("scroll"), deltaY: z.number().int().min(-2000).max(2000) }).strict(),
]);
export type BrowserAction = z.infer<typeof browserActionSchema>;

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
    action: browserActionSchema,
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
  controlExpiresAt?: string;
  frame?: BrowserFrame;
}
