import { z } from "zod";
import { modelSelectionSchema } from "./model-services.js";
export const ownerTimezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/)
  .refine((value) => !value.split("/").some((part) => part === "." || part === ".."));
export const ownerPreferencesInputSchema = z
  .object({
    expectedRevision: z.number().int().min(1).max(2147483647),
    timezone: ownerTimezoneSchema,
    defaultModel: modelSelectionSchema.nullable(),
  })
  .strict();
export const ownerPreferencesSchema = z
  .object({
    revision: z.number().int().min(1).max(2147483647),
    timezone: ownerTimezoneSchema,
    defaultModel: modelSelectionSchema.nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type OwnerPreferencesInput = z.infer<typeof ownerPreferencesInputSchema>;
export type OwnerPreferences = z.infer<typeof ownerPreferencesSchema>;
