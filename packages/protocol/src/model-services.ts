import { z } from "zod";

export const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/,
    "Enter a model ID, including its provider prefix when required.",
  );
export const modelSelectionSchema = z
  .object({
    connectionId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    modelId: modelIdSchema,
  })
  .strict();
export const modelBaseUrlSchema = z
  .string()
  .max(2048)
  .regex(
    /^https:\/\/[^/?#@\\]+(?:\/[^?#\\]*)?$/,
    "Use an HTTPS API base URL without credentials, query, or fragment.",
  )
  .refine(
    (value) =>
      ![...value].some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      ),
  )
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  })
  .meta({ format: "uri" });
const modelApiKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .regex(/^[\x21-\x7e]+$/, "API keys must contain printable characters without spaces.");
// Retained connection inputs count UTF-16 units; other identity fields count code points.
const modelConnectionNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => value.length <= 80 && !/[\ud800-\udfff]/u.test(value))
  .meta({ "x-openbot-max-utf16-units": 80 });
export const createModelConnectionInputSchema = z
  .object({
    name: modelConnectionNameSchema,
    presetId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
    baseUrl: modelBaseUrlSchema,
    apiKey: modelApiKeySchema,
    defaultModel: modelIdSchema.nullable().optional(),
  })
  .strict();
export const updateModelConnectionInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    name: modelConnectionNameSchema.optional(),
    apiKey: modelApiKeySchema.optional(),
    enabled: z.boolean().optional(),
    defaultModel: modelIdSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.apiKey !== undefined ||
      value.enabled !== undefined ||
      value.defaultModel !== undefined,
    "Change at least one connection field.",
  );
export const updateEmployeeModelInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    model: modelSelectionSchema.nullable(),
  })
  .strict();
export const testModelConnectionInputSchema = z.object({ modelId: modelIdSchema }).strict();
export const verifyModelConnectionInputSchema = createModelConnectionInputSchema.omit({
  name: true,
  defaultModel: true,
});
export const deleteModelConnectionInputSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
});
export const modelConnectionPresetSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  protocol: z.enum(["openai-chat", "anthropic-messages"]),
  endpoints: z.array(z.strictObject({ name: z.string(), baseUrl: z.string() })),
  suggestedModels: z.array(z.string()),
  discovery: z.boolean(),
  description: z.string(),
  docsUrl: z.string(),
});
export const modelConnectionSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  presetId: z.string(),
  baseUrl: z.string(),
  protocol: z.enum(["openai-chat", "anthropic-messages"]),
  enabled: z.boolean(),
  hasApiKey: z.boolean(),
  revision: z.number().int().positive(),
  source: z.enum(["saved", "environment"]),
  defaultModel: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const modelServicesSnapshotSchema = z.strictObject({
  presets: z.array(modelConnectionPresetSchema),
  connections: z.array(modelConnectionSchema).max(33),
  customBaseUrls: z.array(z.string()).max(128),
});
export const modelConnectionResponseSchema = z.strictObject({ connection: modelConnectionSchema });
export const modelConnectionDeletionSchema = z.strictObject({
  deleted: z.literal(true),
  connectionId: z.string(),
});
export const modelConnectionDependenciesSchema = z.strictObject({
  bots: z.array(z.strictObject({ id: z.string(), name: z.string() })).max(1000),
  runIds: z.array(z.string()).max(1000),
  ownerDefault: z.boolean(),
  transcription: z.boolean(),
});
export const modelConnectionDeletionConflictSchema = modelConnectionDependenciesSchema.extend({
  error: z.literal("model_connection_in_use"),
});
export const discoveredModelsSchema = z.strictObject({ models: z.array(z.string()).max(256) });
export const modelConnectionTestSchema = z.strictObject({ ok: z.literal(true) });
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export type ModelConnection = z.infer<typeof modelConnectionSchema>;
export type ModelConnectionPreset = z.infer<typeof modelConnectionPresetSchema>;
export type ModelServicesSnapshot = z.infer<typeof modelServicesSnapshotSchema>;
export type CreateModelConnectionInput = z.infer<typeof createModelConnectionInputSchema>;
export type UpdateModelConnectionInput = z.infer<typeof updateModelConnectionInputSchema>;
export type VerifyModelConnectionInput = z.infer<typeof verifyModelConnectionInputSchema>;
export type DeleteModelConnectionInput = z.infer<typeof deleteModelConnectionInputSchema>;
export type UpdateEmployeeModelInput = z.infer<typeof updateEmployeeModelInputSchema>;
export type ModelConnectionDependencies = z.infer<typeof modelConnectionDependenciesSchema>;
