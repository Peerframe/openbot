import { z } from "zod";
import { approvalSettingsInputSchema, approvalSettingsSchema } from "./approval-settings.js";
import { auditCategorySchema, auditPageSchema } from "./audit.js";
import {
  approvalDecisionInputSchema,
  renameBotInputSchema,
  renameChannelInputSchema,
} from "./channel-inputs.js";
import { reactionEmojiSchema, setMessageReactionSchema } from "./channel-interactions.js";
import { approvalSchema, channelSchema, runSchema } from "./control-http.js";
import { type HttpOperation, productHttpOperation as product } from "./http-openapi.js";
import { steerNativeRunInputSchema } from "./node.js";

const id = z.string().min(1).max(128);
export const renamedBotResponseSchema = z.strictObject({
  bot: z.strictObject({ botId: id, name: z.string() }),
});
export const renamedChannelResponseSchema = z.strictObject({
  channel: z.strictObject({ channelId: id, name: z.string() }),
});
export const deletedBotResponseSchema = z.strictObject({
  deleted: z.literal(true),
  botId: id,
  pluginGrantsRemoved: z.boolean(),
  attachmentsRemoved: z.boolean(),
});
export const deletedChannelResponseSchema = z.strictObject({
  deleted: z.literal(true),
  channelId: id,
  attachmentsRemoved: z.boolean(),
});
export const channelReadResponseSchema = z.strictObject({
  channelId: id,
  lastReadAt: z.iso.datetime(),
});
export const unreadResponseSchema = z.strictObject({
  unread: z
    .record(id, z.number().int().min(1).max(99))
    .refine((entries) => Object.keys(entries).length <= 10000)
    .meta({ maxProperties: 10000 }),
});
// The persisted public reaction reader supports retained text IDs; request admission uses UUIDs.
const publicReactionSchema = z.strictObject({
  messageId: id,
  emoji: reactionEmojiSchema,
  actor: z.literal("owner"),
});
export const reactionsResponseSchema = z.strictObject({
  reactions: z.array(publicReactionSchema).max(600),
});
export const reactionMutationResponseSchema = z.strictObject({
  reactions: z.array(publicReactionSchema).max(6),
});
export const removeChannelMemberResponseSchema = z.strictObject({
  channel: channelSchema,
  cancelledRuns: z.array(runSchema).max(1000),
});
export const cancelRunRequestSchema = z.strictObject({});
export const cancelledRunResponseSchema = z.strictObject({ run: runSchema });
export const steeringInstructionSchema = z.strictObject({
  id: z.string(),
  runId: z.string(),
  channelId: z.string(),
  botId: z.string(),
  instruction: z.string(),
  createdAt: z.string(),
});
export const steeringResponseSchema = z.strictObject({ steering: steeringInstructionSchema });
export const approvalDecisionResponseSchema = z.strictObject({
  approval: approvalSchema,
  run: runSchema,
});
export const healthResponseSchema = z.strictObject({
  ok: z.literal(true),
  service: z.literal("openbot-server"),
  phase: z.string(),
  time: z.iso.datetime(),
});
export const unhealthyResponseSchema = z.strictObject({
  ok: z.literal(false),
  service: z.literal("openbot-server"),
  execution: z.strictObject({
    state: z.enum(["unstarted", "running", "failed", "stopped"]),
    lastPass: z.record(z.string(), z.number().int().nonnegative()).nullable(),
  }),
});
export const lifecycleHttpSchemas = {
  RenameBotInput: renameBotInputSchema,
  RenameChannelInput: renameChannelInputSchema,
  RenamedBotResponse: renamedBotResponseSchema,
  RenamedChannelResponse: renamedChannelResponseSchema,
  DeletedBotResponse: deletedBotResponseSchema,
  DeletedChannelResponse: deletedChannelResponseSchema,
  ChannelReadResponse: channelReadResponseSchema,
  UnreadResponse: unreadResponseSchema,
  SetMessageReactionInput: setMessageReactionSchema,
  ReactionsResponse: reactionsResponseSchema,
  ReactionMutationResponse: reactionMutationResponseSchema,
  RemoveChannelMemberResponse: removeChannelMemberResponseSchema,
  CancelRunInput: cancelRunRequestSchema,
  CancelRunResponse: cancelledRunResponseSchema,
  SteerRunInput: steerNativeRunInputSchema,
  SteeringResponse: steeringResponseSchema,
  ApprovalDecisionInput: approvalDecisionInputSchema,
  ApprovalDecisionResponse: approvalDecisionResponseSchema,
  ApprovalSettingsInput: approvalSettingsInputSchema,
  ApprovalSettings: approvalSettingsSchema,
  AuditPage: auditPageSchema,
  HealthResponse: healthResponseSchema,
  UnhealthyResponse: unhealthyResponseSchema,
} as const;
const errors = [400, 401, 403, 404, 408, 409, 413, 415, 422, 503];
const auditQuery = (maximum: number, defaultLimit: number) => [
  {
    name: "before",
    schema: {
      type: "string",
      maxLength: 200,
      description: "Timezone-aware timestamp|event ID cursor",
    },
  },
  { name: "category", schema: { type: "string", enum: auditCategorySchema.options } },
  { name: "limit", schema: { type: "integer", minimum: 1, maximum, default: defaultLimit } },
];
export const lifecycleHttpOperations: readonly HttpOperation[] = [
  product("/api/v1/bots/{bot_id}", "patch", "RenamedBotResponse", "RenameBotInput", {
    maxBodyBytes: 1024,
  }),
  product("/api/v1/bots/{bot_id}", "delete", "DeletedBotResponse", undefined, {
    maxBodyBytes: 1024,
  }),
  product(
    "/api/v1/channels/{channel_id}",
    "patch",
    "RenamedChannelResponse",
    "RenameChannelInput",
    { maxBodyBytes: 1024 },
  ),
  product("/api/v1/channels/{channel_id}", "delete", "DeletedChannelResponse", undefined, {
    maxBodyBytes: 1024,
  }),
  product("/api/v1/channels/{channel_id}/read", "post", "ChannelReadResponse", undefined, {
    maxBodyBytes: 1024,
  }),
  product("/api/v1/channels/unread", "get", "UnreadResponse"),
  product(
    "/api/v1/channels/{channel_id}/bots/{bot_id}",
    "delete",
    "RemoveChannelMemberResponse",
    undefined,
    { maxBodyBytes: 32768 },
  ),
  product("/api/v1/channels/{channel_id}/reactions", "get", "ReactionsResponse"),
  product(
    "/api/v1/channels/{channel_id}/messages/{message_id}/reactions",
    "put",
    "ReactionMutationResponse",
    "SetMessageReactionInput",
    { maxBodyBytes: 1024 },
  ),
  {
    method: "post",
    path: "/api/v1/runs/{run_id}/cancel",
    operationId: "cancelNativeRun",
    status: 200,
    request: "CancelRunInput",
    response: "CancelRunResponse",
    maxBodyBytes: 128,
    errors,
  },
  {
    method: "post",
    path: "/api/v1/runs/{run_id}/steer",
    operationId: "steerNativeRun",
    status: 202,
    request: "SteerRunInput",
    response: "SteeringResponse",
    maxBodyBytes: 18000,
    errors,
  },
  product(
    "/api/v1/approvals/{approval_id}/decision",
    "post",
    "ApprovalDecisionResponse",
    "ApprovalDecisionInput",
    { maxBodyBytes: 32768 },
  ),
  product("/api/v1/settings/approvals", "get", "ApprovalSettings"),
  product("/api/v1/settings/approvals", "put", "ApprovalSettings", "ApprovalSettingsInput", {
    maxBodyBytes: 16384,
  }),
  product("/api/v1/audit", "get", "AuditPage", undefined, { query: auditQuery(100, 50) }),
  product("/api/v1/audit/export", "get", undefined, undefined, {
    mediaType: "text/csv",
    query: auditQuery(1000, 1000),
  }),
  {
    method: "get",
    path: "/health",
    operationId: "getHealth",
    status: 200,
    response: "HealthResponse",
    owner: false,
    origin: false,
    errors: [503],
    errorSchemas: { 503: "UnhealthyResponse" },
  },
];
