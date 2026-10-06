import { z } from "zod";
import {
  pluginEndpointInputSchema,
  installPluginSchema,
  updatePluginSchema,
  grantPluginSchema,
  removePluginSchema,
  applyPluginUpdateSchema,
  readPluginContentSchema,
  decidePluginCallSchema,
  pluginResourceSchema,
  pluginPromptSchema,
  pluginToolSchema,
} from "./plugins.js";
import { reviewedPluginCatalogSchema } from "./plugin-catalog.js";
import { type HttpOperation, productHttpOperation as product } from "./http-openapi.js";

// Python DTO string fields count UTF-16 units; annotated collection values count code points.
const string = z.string().refine((value) => !/[\ud800-\udfff]/u.test(value));
const codePoints = (max: number, min = 0) => string.min(min).max(max);
const text = (max: number, min = 0) =>
  codePoints(max, min)
    .refine((value) => value.length <= max)
    .meta({ "x-openbot-utf16-max-units": max });
const id = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const json = z.json().meta({ "x-openbot-json-value": true });
const object = z.record(z.string(), json);
const name = z
  .string()
  .transform((value) =>
    value.replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Exact Python str.strip whitespace.
      /^[\t-\r\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu,
      "",
    ),
  )
  .pipe(text(80, 1));
// Endpoint syntax/normalization and DNS/HTTPS/exact-local policy remain service-owned.
const endpointFields = { name, endpoint: text(2048, 1) };
export const pluginEndpointRequestSchema = pluginEndpointInputSchema.safeExtend(endpointFields);
export const installPluginRequestSchema = installPluginSchema.safeExtend(endpointFields);
export const updatePluginRequestSchema = updatePluginSchema.safeExtend({ revision: id });
export const previewPluginUpdateRequestSchema = removePluginSchema.safeExtend({ revision: id });
export const applyPluginUpdateRequestSchema = applyPluginUpdateSchema.safeExtend({ revision: id });
export const removePluginRequestSchema = removePluginSchema.safeExtend({ revision: id });
export const grantPluginRequestSchema = grantPluginSchema.safeExtend({
  revision: id,
  resources: z.array(codePoints(2048, 1)).max(32).default([]),
});
export const readPluginContentRequestSchema = readPluginContentSchema.safeExtend({
  pluginId: id,
  revision: id,
  name: text(2048, 1),
  arguments: z.record(toolName, codePoints(4000)).default({}),
});
export const pluginResourceHttpSchema = pluginResourceSchema.safeExtend({
  uri: text(2048, 1),
  name: text(128, 1),
  description: text(2000),
  mimeType: text(128).optional(),
});
export const pluginPromptArgumentHttpSchema = z.strictObject({
  name: toolName,
  description: text(1000).optional(),
  required: z.boolean().optional(),
});
export const pluginPromptHttpSchema = pluginPromptSchema.safeExtend({
  description: text(2000),
  arguments: z.array(pluginPromptArgumentHttpSchema).max(16),
});
export const pluginToolHttpSchema = pluginToolSchema.safeExtend({
  description: text(2000),
  inputSchema: object,
  annotations: object.optional(),
  resourceUri: text(2048)
    .regex(/^ui:\/\//)
    .optional(),
});
export const pluginManifestHttpSchema = z.strictObject({
  name: text(80),
  endpoint: text(2048),
  tools: z.array(pluginToolHttpSchema).max(32),
  resources: z.array(pluginResourceHttpSchema).max(32).optional(),
  prompts: z.array(pluginPromptHttpSchema).max(32).optional(),
  digest,
});
const grant = z.strictObject({
  botId: text(128),
  tools: z.array(z.strictObject({ name: toolName, mode: z.enum(["read", "confirm"]) })).max(32),
  resources: z.array(codePoints(2048, 1)).max(32).optional(),
  prompts: z.array(toolName).max(32).optional(),
});
export const installedPluginHttpSchema = pluginManifestHttpSchema.extend({
  id,
  revision: id,
  enabled: z.boolean(),
  // Retained Record.createdAt is an unconstrained Python string, unlike bounded text fields.
  createdAt: z.string(),
  grants: z.array(grant).max(128),
});
export const installedPluginResponseSchema = z.strictObject({ plugin: installedPluginHttpSchema });
export const pendingPluginCallHttpSchema = z.strictObject({
  id,
  pluginId: id,
  pluginName: text(80),
  toolName,
  botId: z.string(),
  channelId: z.string(),
  runId: z.string(),
  arguments: object,
  expiresAt: z.string().datetime(),
});
export const pluginSnapshotHttpSchema = z.strictObject({
  plugins: z.array(installedPluginHttpSchema).max(16),
  pendingCalls: z.array(pendingPluginCallHttpSchema).max(16),
});
export const pluginUpdatePreviewHttpSchema = z.strictObject({
  currentDigest: digest,
  revision: id,
  changed: z.boolean(),
  manifest: pluginManifestHttpSchema,
});
export const pluginDeletedResponseSchema = z.strictObject({ deleted: z.literal(true) });
export const pluginDecisionResponseSchema = z.strictObject({ decided: z.literal(true) });
export const pluginContentItemHttpSchema = z.strictObject({
  pluginId: id,
  revision: id,
  pluginName: text(80),
  kind: z.enum(["resource", "prompt"]),
  name: text(2048, 1),
  description: text(2000),
  mimeType: text(128).optional(),
  arguments: z.array(pluginPromptArgumentHttpSchema).max(16).optional(),
});
export const pluginContentCatalogHttpSchema = z.strictObject({
  items: z.array(pluginContentItemHttpSchema).max(32),
  truncated: z.boolean(),
});
export const pluginResourceResultHttpSchema = z.strictObject({
  contents: z
    .array(
      z.strictObject({
        uri: text(2048),
        mimeType: text(128).optional(),
        text: text(128 * 1024),
        _meta: object.optional(),
      }),
    )
    .min(1)
    .max(16),
});
export const pluginPromptResultHttpSchema = z.strictObject({
  description: text(2000).optional(),
  messages: z
    .array(
      z.strictObject({
        role: z.enum(["user", "assistant"]),
        content: z.strictObject({ type: z.literal("text"), text: text(12000) }),
      }),
    )
    .min(1)
    .max(16),
});
export const pluginContentResultHttpSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    plugin: text(80),
    kind: z.literal("resource"),
    name: text(2048, 1),
    untrusted: z.literal(true),
    result: pluginResourceResultHttpSchema,
  }),
  z.strictObject({
    plugin: text(80),
    kind: z.literal("prompt"),
    name: text(2048, 1),
    untrusted: z.literal(true),
    result: pluginPromptResultHttpSchema,
  }),
]);
export const pluginHttpSchemas = {
  PluginEndpointInput: pluginEndpointRequestSchema,
  InstallPluginInput: installPluginRequestSchema,
  UpdatePluginInput: updatePluginRequestSchema,
  PreviewPluginUpdateInput: previewPluginUpdateRequestSchema,
  ApplyPluginUpdateInput: applyPluginUpdateRequestSchema,
  RemovePluginInput: removePluginRequestSchema,
  GrantPluginInput: grantPluginRequestSchema,
  ReadPluginContentInput: readPluginContentRequestSchema,
  DecidePluginCallInput: decidePluginCallSchema,
  PluginManifest: pluginManifestHttpSchema,
  InstalledPlugin: installedPluginHttpSchema,
  InstalledPluginResponse: installedPluginResponseSchema,
  PluginSnapshot: pluginSnapshotHttpSchema,
  PluginUpdatePreview: pluginUpdatePreviewHttpSchema,
  PluginDeletedResponse: pluginDeletedResponseSchema,
  PluginDecisionResponse: pluginDecisionResponseSchema,
  PluginContentCatalog: pluginContentCatalogHttpSchema,
  PluginContentResult: pluginContentResultHttpSchema,
  PluginResource: pluginResourceHttpSchema,
  PluginPrompt: pluginPromptHttpSchema,
  PluginTool: pluginToolHttpSchema,
  PluginResourceResult: pluginResourceResultHttpSchema,
  PluginPromptResult: pluginPromptResultHttpSchema,
  ReviewedPluginCatalog: reviewedPluginCatalogSchema,
};
const errors = [400, 401, 403, 404, 408, 409, 413, 422, 503];
const operation = (
  path: string,
  method: HttpOperation["method"],
  response: string,
  request?: string,
  status = 200,
) =>
  product(path, method, response, request, {
    status,
    errors,
    ...(method === "get" ? {} : { maxBodyBytes: 24576 }),
  });
export const pluginHttpOperations: readonly HttpOperation[] = [
  operation("/api/v1/plugins", "get", "PluginSnapshot"),
  operation("/api/v1/plugins/catalog", "get", "ReviewedPluginCatalog"),
  operation("/api/v1/plugins/preview", "post", "PluginManifest", "PluginEndpointInput"),
  operation("/api/v1/plugins", "post", "InstalledPluginResponse", "InstallPluginInput", 201),
  operation(
    "/api/v1/plugins/{plugin_id}/update/preview",
    "post",
    "PluginUpdatePreview",
    "PreviewPluginUpdateInput",
  ),
  operation(
    "/api/v1/plugins/{plugin_id}/update",
    "post",
    "InstalledPluginResponse",
    "ApplyPluginUpdateInput",
  ),
  operation("/api/v1/plugins/{plugin_id}", "patch", "InstalledPluginResponse", "UpdatePluginInput"),
  operation(
    "/api/v1/plugins/{plugin_id}/grants/{bot_id}",
    "put",
    "InstalledPluginResponse",
    "GrantPluginInput",
  ),
  operation("/api/v1/plugins/{plugin_id}", "delete", "PluginDeletedResponse", "RemovePluginInput"),
  operation(
    "/api/v1/plugin-calls/{call_id}/decision",
    "post",
    "PluginDecisionResponse",
    "DecidePluginCallInput",
  ),
  operation(
    "/api/v1/channels/{channel_id}/bots/{bot_id}/plugin-content",
    "get",
    "PluginContentCatalog",
  ),
  operation(
    "/api/v1/channels/{channel_id}/bots/{bot_id}/plugin-content",
    "post",
    "PluginContentResult",
    "ReadPluginContentInput",
  ),
];
export type PluginManifestHttp = z.infer<typeof pluginManifestHttpSchema>;
export type InstalledPluginHttp = z.infer<typeof installedPluginHttpSchema>;
export type PluginSnapshotHttp = z.infer<typeof pluginSnapshotHttpSchema>;
export type PendingPluginCallHttp = z.infer<typeof pendingPluginCallHttpSchema>;
export type PluginResourceHttp = z.infer<typeof pluginResourceHttpSchema>;
export type PluginPromptHttp = z.infer<typeof pluginPromptHttpSchema>;
export type PluginToolHttp = z.infer<typeof pluginToolHttpSchema>;
export type PluginContentItemHttp = z.infer<typeof pluginContentItemHttpSchema>;
export type PluginContentCatalogHttp = z.infer<typeof pluginContentCatalogHttpSchema>;
export type PluginContentResultHttp = z.infer<typeof pluginContentResultHttpSchema>;
