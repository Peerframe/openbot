import { z } from "zod";

export const modelProviderIds = [
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "moonshot",
  "openrouter",
  "siliconflow",
  "dashscope",
  "zai",
  "minimax",
  "ark",
] as const;
export const modelProviderIdSchema = z.enum(modelProviderIds);
export type ModelProviderId = z.infer<typeof modelProviderIdSchema>;
