import type { RunModelUsage } from "@openbot/domain";
import { modelProviderIds } from "@openbot/domain";
import type { LanguageModelUsage } from "ai";
import { z } from "zod";

export const runModelUsageSchema = z
  .object({
    provider: z.enum(modelProviderIds),
    model: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)?$/u),
    steps: z.number().int().min(1).max(8),
    inputTokens: z.number().int().min(0).max(1_000_000_000).nullable(),
    outputTokens: z.number().int().min(0).max(1_000_000_000).nullable(),
  })
  .strict();

export function addReportedUsage(
  previous: RunModelUsage | undefined,
  step: LanguageModelUsage,
  identity: Pick<RunModelUsage, "provider" | "model">,
): RunModelUsage {
  const sum = (value: number | undefined, prior: number | null | undefined) => {
    if (
      value === undefined ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 1_000_000_000 ||
      prior === null
    )
      return null;
    const total = (prior ?? 0) + value;
    return total <= 1_000_000_000 ? total : null;
  };
  return runModelUsageSchema.parse({
    ...identity,
    steps: (previous?.steps ?? 0) + 1,
    inputTokens: sum(step.inputTokens, previous?.inputTokens),
    outputTokens: sum(step.outputTokens, previous?.outputTokens),
  });
}

export const nativeFailureMessages = {
  plugin_rejected:
    "The Owner rejected the plugin call. No approved execution was dispatched for that call.",
  plugin_approval_expired:
    "The plugin call approval expired before execution. Submit a new task if it is still needed.",
  plugin_changed:
    "Plugin tools or Bot grants changed. Review the installed plugin and submit a new task.",
  plugin_unavailable:
    "The plugin call could not be confirmed. Check the plugin service; OpenBot did not automatically retry it.",
  attachment_model_unsupported:
    "Image/PDF input is not enabled for this provider or model. Choose a compatible OpenAI or Anthropic model, or attach a text version.",
  attachment_unavailable:
    "A task attachment is missing, outside this channel, damaged or exceeds its limits. Attach the file again before submitting a new task.",
  model_credentials:
    "Model credentials were rejected. Verify the provider key in Settings before submitting a new task.",
  model_rate_limit: "The model provider rate limit was reached. Wait before submitting a new task.",
  model_unavailable:
    "The model provider is unavailable. Check the configured model and service status.",
  settings_changed:
    "Model settings changed during this task. Review the current configuration and submit a new task.",
  scope_revoked: "This Bot no longer has access to the task channel. Check its membership.",
  invalid_target:
    "This task referenced an unknown or ineligible target. Use only IDs returned by this task's tools.",
  conflict:
    "The task state changed before this update could be saved. Check the latest Run status before submitting a new task.",
  skills_changed:
    "Reviewed skills changed during this task. Review the current skill assignments and submit a new task.",
  memory_changed:
    "Employee memory changed during this task. Review current memory and submit a new task.",
  task_limit: "The task exceeded its execution limits. Split it into smaller tasks.",
  tool_unavailable:
    "A scoped tool could not complete. Check the task URLs and requested capability.",
  task_timeout:
    "The task reached its time limit. Try a smaller task or check the provider connection.",
  server_interrupted: "The Server interrupted this task. Submit a new task when it is ready.",
  execution_failed:
    "The Agent could not complete. Check model settings, channel access and task scope before submitting a new task.",
} as const;
export type NativeFailureCode = keyof typeof nativeFailureMessages;
export class NativeExecutionError extends Error {
  constructor(readonly code: NativeFailureCode) {
    super(nativeFailureMessages[code]);
  }
}
