import { z } from "zod";

export const createChannelInputSchema = z.object({
  name: z.string().trim().min(1, "Channel name is required.").max(80),
  description: z.string().trim().max(500).default(""),
  botIds: z
    .array(z.string().uuid())
    .max(32)
    .default([])
    .transform((ids) => [...new Set(ids)]),
});

export const joinChannelBotInputSchema = z.object({
  botId: z.string().uuid(),
});

export const createMessageInputSchema = z
  .object({
    content: z.string().trim().min(1, "Message is required.").max(8000),
    botId: z.string().uuid().optional(),
    botIds: z.array(z.string().uuid()).min(1).max(6).optional(),
    replyToMessageId: z.string().uuid().optional(),
  })
  .refine((input) => input.botId === undefined || input.botIds === undefined, {
    message: "Choose botId or botIds, not both.",
  })
  .refine(
    (input) => input.botIds === undefined || new Set(input.botIds).size === input.botIds.length,
    {
      message: "Bot recipients must be unique.",
    },
  );

export const approvalDecisionInputSchema = z.object({
  decision: z.enum(["approve", "reject"]),
});

export const loginInputSchema = z.object({
  password: z.string().min(1, "Password is required.").max(1024),
});
