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
const id = z.string().min(1).max(128);
export const auditEventSchema = z.strictObject({
  id,
  type: z.string().max(64),
  category: auditCategorySchema,
  createdAt: z.iso.datetime(),
  details: z.partialRecord(
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
    ]),
    z.union([z.string().max(240), z.number().int(), z.boolean()]),
  ),
  channelId: id.optional(),
  channelName: z.string().max(162).optional(),
  channelDeleted: z.boolean().optional(),
  botId: id.optional(),
  botName: z.string().max(130).optional(),
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
