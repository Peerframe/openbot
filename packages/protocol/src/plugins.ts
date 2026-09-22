import { z } from "zod";

/** Shared plugin data contracts do not grant authority or contain Server runtime services. */
export const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/u);
export const pluginEndpointInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    endpoint: z.string().url().max(2048),
    token: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[\x21-\x7e]+$/u)
      .optional(),
  })
  .strict();
export const installPluginSchema = pluginEndpointInputSchema
  .extend({
    reviewedDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export const pluginResourceSchema = z
  .object({
    uri: z.string().min(1).max(2048),
    name: z.string().min(1).max(128),
    description: z.string().max(2000),
    mimeType: z.string().max(128).optional(),
  })
  .strict();
export const pluginPromptSchema = z
  .object({
    name: toolName,
    description: z.string().max(2000),
    arguments: z
      .array(
        z
          .object({
            name: toolName,
            description: z.string().max(1000).optional(),
            required: z.boolean().optional(),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
export const pluginResourceResultSchema = z
  .object({
    contents: z
      .array(
        z
          .object({
            uri: z.string().max(2048),
            mimeType: z.string().max(128).optional(),
            text: z.string().max(128 * 1024),
            _meta: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
export const pluginPromptResultSchema = z
  .object({
    description: z.string().max(2000).optional(),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.object({ type: z.literal("text"), text: z.string().max(12000) }).strict(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
export type PluginResource = z.infer<typeof pluginResourceSchema>;
export type PluginPrompt = z.infer<typeof pluginPromptSchema>;
export const readPluginContentSchema = z
  .object({
    pluginId: z.string().uuid(),
    revision: z.string().uuid(),
    kind: z.enum(["resource", "prompt"]),
    name: z.string().min(1).max(2048),
    arguments: z.record(toolName, z.string().max(4000)).default({}),
  })
  .strict();
export const applyPluginUpdateSchema = z
  .object({ revision: z.string().uuid(), reviewedDigest: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
export const pluginToolSchema = z
  .object({
    name: toolName,
    description: z.string().max(2000),
    inputSchema: z.record(z.string(), z.unknown()),
    annotations: z.record(z.string(), z.unknown()).optional(),
    resourceUri: z.string().startsWith("ui://").max(2048).optional(),
  })
  .strict();
export const pluginToolGrantSchema = z
  .object({
    name: toolName,
    mode: z.enum(["read", "confirm"]),
  })
  .strict();
export const updatePluginSchema = z
  .object({
    revision: z.string().uuid(),
    enabled: z.boolean(),
  })
  .strict();
export const grantPluginSchema = z
  .object({
    revision: z.string().uuid(),
    tools: z.array(pluginToolGrantSchema).max(32),
    resources: z.array(z.string().min(1).max(2048)).max(32).default([]),
    prompts: z.array(toolName).max(32).default([]),
  })
  .strict();
export const removePluginSchema = z.object({ revision: z.string().uuid() }).strict();
export const decidePluginCallSchema = z
  .object({ decision: z.enum(["approve", "reject"]) })
  .strict();

export type PluginEndpointInput = z.infer<typeof pluginEndpointInputSchema>;
export type PluginTool = z.infer<typeof pluginToolSchema>;
export type PluginToolGrant = z.infer<typeof pluginToolGrantSchema>;
export interface PluginManifest {
  name: string;
  endpoint: string;
  tools: PluginTool[];
  resources?: PluginResource[] | undefined;
  prompts?: PluginPrompt[] | undefined;
  digest: string;
}
export interface InstalledPlugin extends PluginManifest {
  id: string;
  revision: string;
  enabled: boolean;
  createdAt: string;
  grants: {
    botId: string;
    tools: PluginToolGrant[];
    resources?: string[] | undefined;
    prompts?: string[] | undefined;
  }[];
}
export interface PendingPluginCall {
  id: string;
  pluginId: string;
  pluginName: string;
  toolName: string;
  botId: string;
  channelId: string;
  runId: string;
  arguments: Record<string, unknown>;
  expiresAt: string;
}
/** Transport/approval evidence only; it never certifies a third party's external state. */
export const pluginCallReceiptSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().min(1).max(128),
    channelId: z.string().min(1).max(128),
    botId: z.string().min(1).max(128),
    pluginId: z.string().uuid(),
    pluginName: z.string().min(1).max(80),
    pluginRevision: z.string().uuid(),
    toolName,
    mode: z.enum(["read", "confirm"]),
    state: z.enum([
      "preparing",
      "awaiting_approval",
      "dispatching",
      "response_received",
      "not_dispatched",
      "outcome_unknown",
    ]),
    approvalDecision: z.enum(["approved", "rejected", "expired", "interrupted"]).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    approvalRequestedAt: z.iso.datetime().optional(),
    approvalDecidedAt: z.iso.datetime().optional(),
    dispatchedAt: z.iso.datetime().optional(),
    responseReceivedAt: z.iso.datetime().optional(),
  })
  .strict();
export type PluginCallReceipt = z.infer<typeof pluginCallReceiptSchema>;
export const pluginCallReceiptListSchema = z
  .object({
    calls: z.array(pluginCallReceiptSchema).max(256),
  })
  .strict();
export interface PluginCatalogItem {
  pluginId: string;
  revision: string;
  pluginName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mode: PluginToolGrant["mode"];
}
export const callPluginSchema = z
  .object({
    pluginId: z.string().uuid(),
    revision: z.string().uuid(),
    toolName,
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

export interface PluginSnapshot {
  plugins: InstalledPlugin[];
  pendingCalls: PendingPluginCall[];
}
export interface PluginContentScope {
  channelId: string;
  botId: string;
  runId?: string;
}
export interface PluginContentItem {
  pluginId: string;
  revision: string;
  pluginName: string;
  kind: "resource" | "prompt";
  name: string;
  description: string;
  mimeType?: string;
  arguments?: PluginPrompt["arguments"];
}
export interface PluginContentCatalog {
  items: PluginContentItem[];
  truncated: boolean;
}
export interface PluginContentResult {
  plugin: string;
  kind: "resource" | "prompt";
  name: string;
  untrusted: true;
  result: {
    contents?: z.infer<typeof pluginResourceResultSchema>["contents"];
    messages?: z.infer<typeof pluginPromptResultSchema>["messages"];
  };
}
