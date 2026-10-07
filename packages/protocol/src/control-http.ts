import { z } from "zod";
import { botAppearanceSchema, computerProfileSchema } from "./employee.js";
import { modelSelectionSchema } from "./model-services.js";
import { modelProviderIdSchema } from "./model-providers.js";
import { loginInputSchema } from "./channel-inputs.js";
import { ownerPasswordChangeInputSchema } from "./owner-security.js";
import { nodeArchitectureSchema, nodePlatformSchema } from "./node-metadata.js";
import {
  nodeCapabilityDescriptorSchema,
  nodeDeviceClassSchema,
  nodeIsolationSchema,
  nodeTrustTierSchema,
} from "./node.js";
import { workspacePrimaryBotSchema } from "./workspace-primary-bot.js";

export const botStatusSchema = z.enum([
  "idle",
  "running",
  "waiting_approval",
  "blocked",
  "human_takeover",
  "offline",
  "completed",
  "failed",
]);
export const runStatusSchema = z.enum([
  "queued",
  "assigned",
  "running",
  "waiting_approval",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
export const ownerIdentitySchema = z.strictObject({ id: z.literal("owner"), name: z.string() });
export const authenticatedSessionSchema = z.strictObject({
  authenticated: z.literal(true),
  owner: ownerIdentitySchema,
  expiresAt: z.string(),
});
export const authSessionSchema = z.discriminatedUnion("authenticated", [
  z.strictObject({ authenticated: z.literal(false) }),
  authenticatedSessionSchema,
]);
export const loginResponseSchema = z.strictObject({ session: authenticatedSessionSchema });
const utf8Text = (value: string) => !/[\ud800-\udfff]/u.test(value);
export const loginRequestSchema = loginInputSchema.refine((value) => utf8Text(value.password));
export const ownerPasswordChangeRequestSchema = ownerPasswordChangeInputSchema.refine(
  (value) => utf8Text(value.currentPassword) && utf8Text(value.newPassword),
);

// These are serialized product projections: Python's exclude_none omits optional nulls.
// Dates/IDs remain strings where the existing DTO has no format constraint. The selected model
// is validated by the real projection before serialization, using the retained shared contract.
export const botSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  status: botStatusSchema,
  computerProfile: computerProfileSchema,
  appearance: botAppearanceSchema.strict().optional(),
  model: modelSelectionSchema.optional(),
  createdAt: z.string(),
});
export const channelPreviewWireSchema = z.strictObject({
  id: z.string(),
  authorType: z.enum(["human", "bot", "system"]),
  preview: z.string().max(160),
  createdAt: z.string(),
});
export const channelSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  botIds: z.array(z.string()),
  lastActivityAt: z.string().optional(),
  latestMessage: channelPreviewWireSchema.optional(),
  directBotId: z.string().optional(),
  createdAt: z.string(),
});
export const botResponseSchema = z.strictObject({ bot: botSchema });
export const channelResponseSchema = z.strictObject({ channel: channelSchema });
export const quickBotResponseSchema = z.strictObject({ bot: botSchema, channel: channelSchema });
export const botsResponseSchema = z.strictObject({ bots: z.array(botSchema) });
export const channelsResponseSchema = z.strictObject({ channels: z.array(channelSchema) });
export const messageSchema = z.strictObject({
  id: z.string(),
  channelId: z.string(),
  authorType: z.enum(["human", "bot", "system"]),
  authorId: z.string().optional(),
  replyToMessageId: z.string().optional(),
  runId: z.string().optional(),
  origin: z.literal("greeting").optional(),
  content: z.string(),
  createdAt: z.string(),
});
export const messagesResponseSchema = z.strictObject({
  messages: z.array(messageSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().optional(),
});

export const runModelUsageSchema = z.strictObject({
  provider: modelProviderIdSchema,
  model: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)?$/),
  steps: z.number().int().min(1).max(8),
  inputTokens: z.number().int().min(0).max(1_000_000_000).nullable(),
  outputTokens: z.number().int().min(0).max(1_000_000_000).nullable(),
});
export const runSchema = z.strictObject({
  id: z.string(),
  workTaskId: z.string().optional(),
  model: modelSelectionSchema.optional(),
  parentRunId: z.string().optional(),
  rootRunId: z.string().optional(),
  delegatedByBotId: z.string().optional(),
  channelId: z.string(),
  botId: z.string(),
  sourceMessageId: z.string().optional(),
  nodeId: z.string().optional(),
  executionProfile: computerProfileSchema,
  instruction: z.string(),
  title: z.string(),
  status: runStatusSchema,
  resultSummary: z.string().optional(),
  errorMessage: z.string().optional(),
  errorCode: z.string().optional(),
  modelUsage: runModelUsageSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const runsResponseSchema = z.strictObject({ runs: z.array(runSchema) });
export const submitTaskResponseSchema = z.strictObject({
  message: messageSchema,
  run: runSchema,
  runs: z.array(runSchema).optional(),
});
export const executionNodeSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  platform: nodePlatformSchema,
  osVersion: z.string(),
  architecture: nodeArchitectureSchema,
  deviceClass: nodeDeviceClassSchema,
  isolation: nodeIsolationSchema,
  trustTier: nodeTrustTierSchema,
  capabilities: z.array(z.string()),
  capabilityManifest: z.array(nodeCapabilityDescriptorSchema),
  activeRunIds: z.array(z.string()),
  maxConcurrentRuns: z.number().int().min(1),
  connectedAt: z.string(),
  lastSeenAt: z.string(),
});
export const approvalSchema = z.strictObject({
  id: z.string(),
  runId: z.string(),
  channelId: z.string(),
  botId: z.string(),
  nodeId: z.string(),
  action: z.string(),
  target: z.string(),
  summary: z.string(),
  risk: z.enum(["write", "destructive", "privileged"]),
  targetFingerprint: z.string(),
  beforeState: z.record(z.string(), z.json().meta({ "x-openbot-json-value": true })),
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  expiresAt: z.string(),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  createdAt: z.string(),
});
export const artifactSchema = z.strictObject({
  id: z.string(),
  runId: z.string(),
  name: z.string(),
  mediaType: z.string(),
  sha256: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export const publicRunProgressSchema = z.strictObject({
  id: z.string(),
  runId: z.string(),
  channelId: z.string(),
  nodeId: z.string().optional(),
  stage: z.string(),
  message: z.string(),
  createdAt: z.string(),
});
export const runProgressSummarySchema = z.strictObject({
  runId: z.string(),
  status: runStatusSchema,
  totalSteps: z.number().int().nonnegative(),
  currentStepNumber: z.number().int().nonnegative().nullable(),
  plannedTotalSteps: z.number().int().nonnegative().nullable(),
  completedSteps: z.number().int().nonnegative().nullable(),
  stageName: z.string().nullable(),
  description: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  failureReasonCode: z.string().nullable(),
});
export const runProgressDetailsSchema = runProgressSummarySchema.extend({
  steps: z.array(
    z.strictObject({
      id: z.string(),
      stepNumber: z.number().int().min(1),
      stageName: z.string().nullable(),
      description: z.string().nullable(),
      startedAt: z.string().nullable(),
      endedAt: z.string().nullable(),
    }),
  ),
});
export const workspaceCountsSchema = z.strictObject({
  channels: z.number().int().nonnegative(),
  bots: z.number().int().nonnegative(),
  connectedNodes: z.number().int().nonnegative(),
  activeRuns: z.number().int().nonnegative(),
});
export const bootstrapSchema = z.strictObject({
  project: z.literal("openbot"),
  phase: z.enum(["foundation", "m0", "m1"]),
  counts: workspaceCountsSchema,
});
export const workspaceSnapshotSchema = workspacePrimaryBotSchema.extend({
  bots: z.array(botSchema).max(1000),
  channels: z.array(channelSchema).max(10000),
  nodes: z.array(executionNodeSchema),
  runs: z.array(runSchema).max(50),
  approvals: z.array(approvalSchema).max(100),
  artifacts: z.array(artifactSchema).max(100),
  progress: z.array(publicRunProgressSchema).max(200),
  runProgress: z.record(z.string(), runProgressSummarySchema),
  counts: workspaceCountsSchema,
});
// Polling readiness invalidates projections; bounded message events also deliver committed content.
export const workspaceReadySchema = z.strictObject({
  type: z.literal("workspace.ready"),
  nodes: z.array(executionNodeSchema),
});
export const channelReadySchema = z.strictObject({
  type: z.literal("channel.ready"),
  channelId: z.string(),
});
export const channelMessageCreatedSchema = z
  .strictObject({
    type: z.literal("message.created"),
    channelId: z.string(),
    message: messageSchema,
  })
  .refine((event) => event.channelId === event.message.channelId);
export const employeeProfileChangedSchema = z.strictObject({
  type: z.literal("employee.profile.changed"),
  botId: z.string(),
  sections: z.tuple([z.literal("identity")]),
  occurredAt: z.iso.datetime(),
});
export const controlHttpErrorSchema = z.strictObject({
  error: z.string(),
  referenceCount: z
    .strictObject({
      messages: z.number().int().nonnegative(),
      tasks: z.number().int().nonnegative(),
    })
    .optional(),
  purged: z.boolean().optional(),
});
export type BotWire = z.infer<typeof botSchema>;
export type ChannelWire = z.infer<typeof channelSchema>;
export type RunWire = z.infer<typeof runSchema>;
export type MessageWire = z.infer<typeof messageSchema>;
export type AuthSessionWire = z.infer<typeof authSessionSchema>;
export type WorkspaceWire = z.infer<typeof workspaceSnapshotSchema>;
