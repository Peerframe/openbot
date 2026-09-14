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
export type AutomationOutcome =
  | "submitted"
  | "skipped_active"
  | "target_unavailable"
  | "attachment_unavailable";
export interface Automation {
  id: string;
  name: string;
  channelId: string;
  botId: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastOutcome: AutomationOutcome | null;
  createdAt: string;
}
