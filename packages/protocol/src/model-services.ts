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
  .url({ protocol: /^https$/ })
  .max(2048)
  .regex(
    /^https:\/\/[^/?#@\\]+(?:\/[^?#\\]*)?$/,
    "Use an HTTPS API base URL without credentials, query, or fragment.",
  );
const modelApiKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .regex(/^[\x21-\x7e]+$/, "API keys must contain printable characters without spaces.");
export const createModelConnectionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    presetId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
    baseUrl: modelBaseUrlSchema,
    apiKey: modelApiKeySchema,
  })
  .strict();
export const updateModelConnectionInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    name: z.string().trim().min(1).max(80).optional(),
    apiKey: modelApiKeySchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined || value.apiKey !== undefined || value.enabled !== undefined,
    "Change at least one connection field.",
  );
export const updateEmployeeModelInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    model: modelSelectionSchema.nullable(),
  })
  .strict();
export const testModelConnectionInputSchema = z.object({ modelId: modelIdSchema }).strict();
