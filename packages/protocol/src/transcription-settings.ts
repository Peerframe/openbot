import { z } from "zod";
export const transcriptionSettingsSchema = z
  .object({
    revision: z.number().int().min(1).max(2147483647),
    connectionId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .nullable(),
  })
  .strict();
export const transcriptionSettingsInputSchema = z
  .object({
    expectedRevision: z.number().int().min(1).max(2147483647),
    connectionId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .nullable(),
  })
  .strict();
export type TranscriptionSettings = z.infer<typeof transcriptionSettingsSchema>;
export type TranscriptionSettingsInput = z.infer<typeof transcriptionSettingsInputSchema>;
