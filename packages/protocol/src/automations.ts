import { z } from "zod";

const boundedId = z.string().min(1).max(128);
export const createAutomationInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    channelId: boundedId,
    botId: boundedId,
    prompt: z.string().trim().min(1).max(8000),
    intervalMinutes: z.number().int().min(15).max(10080),
    firstRunAt: z.iso.datetime(),
  })
  .strict();
export const updateAutomationInputSchema = z.object({ enabled: z.boolean() }).strict();
export type CreateAutomationInput = z.infer<typeof createAutomationInputSchema>;
export const automationOutcomeSchema = z.enum([
  "submitted",
  "skipped_active",
  "target_unavailable",
  "attachment_unavailable",
]);
export const automationSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  channelId: z.string(),
  botId: z.string(),
  prompt: z.string(),
  intervalMinutes: z.number().int(),
  enabled: z.boolean(),
  nextRunAt: z.string(),
  lastRunAt: z.string().nullable(),
  lastRunId: z.string().nullable(),
  lastOutcome: automationOutcomeSchema.nullable(),
  createdAt: z.string(),
});
export type AutomationOutcome = z.infer<typeof automationOutcomeSchema>;
export type Automation = z.infer<typeof automationSchema>;
