import { z } from "zod";

export const auditCategorySchema = z.enum([
  "authentication",
  "settings",
  "hosts",
  "approvals",
  "channels",
  "bots",
  "runs",
  "plugins",
  "other",
]);
// Zod 4.6.2 string bounds count code points, matching PostgreSQL left().
const projectedText = (maximum: number) => z.string().max(maximum);
const id = projectedText(128).min(1);
export const auditEventSchema = z.strictObject({
  id,
  type: projectedText(64),
  category: auditCategorySchema,
  createdAt: z.iso.datetime(),
  details: z
    .partialRecord(
      z.enum([
        "name",
        "from",
        "to",
        "actor",
        "reason",
        "emoji",
        "active",
        "decision",
        "removedBotId",
        "deletedMessages",
        "redactedMessages",
        "directBotId",
        "revokedSessions",
        "nodeId",
        "revision",
        "operationId",
        "attachmentId",
        "fileName",
        "sizeBytes",
        "freedBytes",
        "removed",
        "retainedCount",
        "trashAutoPurgeDays",
        "outcome",
        "previousBotId",
        "primaryBotId",
      ]),
      z.union([projectedText(160), z.number().int(), z.boolean(), z.null()]),
    )
    .refine((details) =>
      Object.entries(details).every(([key, value]) => {
        if (value === null) return key === "previousBotId" || key === "primaryBotId";
        return (
          typeof value !== "string" ||
          [...value].length <=
            (key === "fileName" ? 160 : ["previousBotId", "primaryBotId"].includes(key) ? 128 : 120)
        );
      }),
    ),
  channelId: id.optional(),
  channelName: projectedText(81).optional(),
  channelDeleted: z.boolean().optional(),
  botId: id.optional(),
  botName: projectedText(65).optional(),
  botDeleted: z.boolean().optional(),
  runId: id.optional(),
});
export const auditPageSchema = z.strictObject({
  events: z.array(auditEventSchema).max(100),
  nextBefore: z.string().max(200).optional(),
});
export const auditQuerySchema = z.strictObject({
  category: auditCategorySchema.optional(),
  before: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const auditExportQuerySchema = auditQuerySchema.extend({
  limit: z.number().int().min(1).max(1000).optional(),
});
export type AuditCategory = z.infer<typeof auditCategorySchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditPage = z.infer<typeof auditPageSchema>;
