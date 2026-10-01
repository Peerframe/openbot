import { z } from "zod";

/** Owner-visible read projection; content is bounded by Unicode code points in SQL. */
export const channelMessagePreviewSchema = z.strictObject({
  id: z.string().min(1).max(128),
  authorType: z.enum(["human", "bot", "system"]),
  preview: z
    .string()
    .max(640)
    .refine((value) => Array.from(value).length <= 160),
  createdAt: z.iso.datetime(),
});

export const channelActivitySchema = z.strictObject({
  lastActivityAt: z.iso.datetime(),
  latestMessage: channelMessagePreviewSchema.optional(),
});

export type ChannelMessagePreview = z.infer<typeof channelMessagePreviewSchema>;
