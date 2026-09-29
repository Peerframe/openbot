import { z } from "zod";
import { browserCommandSchema, browserResultSchema } from "./browser.js";
import {
  nodeArchitectureSchema,
  nodeCapabilitySchema,
  nodePlatformSchema,
  protocolVersion,
  versionedCapabilityIdSchema,
  type VersionedCapabilityId,
} from "./node-metadata.js";

export const nodeDeviceClassSchema = z.enum([
  "server",
  "desktop",
  "mobile",
  "vm",
  "container",
  "edge",
  "unknown",
]);
export type NodeDeviceClass = z.infer<typeof nodeDeviceClassSchema>;

export const nodeIsolationSchema = z.enum([
  "dedicated-host",
  "user-session",
  "vm",
  "container",
  "managed-device",
  "unknown",
]);
export type NodeIsolation = z.infer<typeof nodeIsolationSchema>;

export const nodeTrustTierSchema = z.enum(["development", "dedicated", "managed"]);
export type NodeTrustTier = z.infer<typeof nodeTrustTierSchema>;

export const nodeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Use a stable machine identifier.");

export const nodeEnrollmentTokenSchema = z
  .string()
  .min(48)
  .max(256)
  .regex(/^obenr_[A-Za-z0-9_-]+$/, "Use an OpenBot Node enrollment token.");

export const nodeCredentialSchema = z
  .string()
  .min(47)
  .max(256)
  .regex(/^obn_[A-Za-z0-9_-]+$/, "Use an OpenBot Node credential.");

const capabilityConstraintValueSchema = z.union([
  z.string().max(256),
  z.number().finite(),
  z.boolean(),
]);

/** A versioned capability claim. Server policy still decides whether a Run may use it. */
export const nodeCapabilityDescriptorSchema = z
  .object({
    id: versionedCapabilityIdSchema,
    version: z.number().int().min(1).max(100),
    providerId: z.string().trim().min(1).max(80),
    constraints: z
      .record(z.string().trim().min(1).max(64), capabilityConstraintValueSchema)
      .refine((value) => Object.keys(value).length <= 16, "Too many capability constraints.")
      .default({}),
  })
  .strict();
export type NodeCapabilityDescriptor = z.infer<typeof nodeCapabilityDescriptorSchema>;

/** An exact capability major required by the Server for one Run. */
export const nodeCapabilityRequirementSchema = z
  .object({
    id: versionedCapabilityIdSchema,
    version: z.number().int().min(1).max(100),
  })
  .strict();
export type NodeCapabilityRequirement = z.infer<typeof nodeCapabilityRequirementSchema>;

export interface CapabilityRequirementMismatch {
  capability: VersionedCapabilityId;
  expectedVersion: number;
  advertisedVersions: number[];
  reason: "capability-missing" | "capability-version-unsupported";
}

/** Compare exact capability majors so callers cannot silently downgrade an execution contract. */
export function firstCapabilityRequirementMismatch(
  required: NodeCapabilityRequirement[],
  advertised: NodeCapabilityDescriptor[],
): CapabilityRequirementMismatch | undefined {
  for (const requirement of required) {
    const advertisedVersions = advertised
      .filter((capability) => capability.id === requirement.id)
      .map((capability) => capability.version)
      .sort((left, right) => left - right);
    if (advertisedVersions.length === 0) {
      return {
        capability: requirement.id,
        expectedVersion: requirement.version,
        advertisedVersions,
        reason: "capability-missing",
      };
    }
    if (!advertisedVersions.includes(requirement.version)) {
      return {
        capability: requirement.id,
        expectedVersion: requirement.version,
        advertisedVersions,
        reason: "capability-version-unsupported",
      };
    }
  }
  return undefined;
}

export const nodeHelloSchema = z
  .object({
    type: z.literal("node.hello"),
    protocolVersion: z.literal(protocolVersion),
    nodeId: nodeIdSchema,
    name: z.string().trim().min(1).max(160),
    platform: nodePlatformSchema,
    osVersion: z.string().trim().min(1).max(160).default("unknown"),
    architecture: nodeArchitectureSchema.default("unknown"),
    deviceClass: nodeDeviceClassSchema.default("unknown"),
    isolation: nodeIsolationSchema.default("unknown"),
    trustTier: nodeTrustTierSchema.default("development"),
    capabilities: z
      .array(nodeCapabilitySchema)
      .max(nodeCapabilitySchema.options.length)
      .refine((value) => new Set(value).size === value.length, "Duplicate capabilities."),
    capabilityManifest: z.array(nodeCapabilityDescriptorSchema).max(32).default([]),
    maxConcurrentRuns: z.number().int().min(1).max(16),
    credential: nodeCredentialSchema,
    commandChannel: z
      .object({ protocolVersion: z.literal("0.10.0") })
      .strict()
      .optional(),
    sentAt: z.string().datetime(),
  })
  .strict();

export const createNodeEnrollmentTokenInputSchema = z
  .object({
    nodeId: nodeIdSchema,
    expiresInSeconds: z.number().int().min(60).max(3600).default(600),
  })
  .strict();

export type CreateNodeEnrollmentTokenInput = z.infer<typeof createNodeEnrollmentTokenInputSchema>;

export const exchangeNodeEnrollmentInputSchema = z
  .object({
    nodeId: nodeIdSchema,
    token: nodeEnrollmentTokenSchema,
  })
  .strict();

export type ExchangeNodeEnrollmentInput = z.infer<typeof exchangeNodeEnrollmentInputSchema>;

export const nodeEnrollmentResultSchema = z
  .object({
    format: z.literal("openbot.node-identity/v1"),
    nodeId: nodeIdSchema,
    credential: nodeCredentialSchema,
    enrolledAt: z.string().datetime(),
  })
  .strict();

export type NodeEnrollmentResult = z.infer<typeof nodeEnrollmentResultSchema>;

export const nodeHeartbeatSchema = z
  .object({
    type: z.literal("node.heartbeat"),
    protocolVersion: z.literal(protocolVersion),
    nodeId: nodeIdSchema,
    activeRunIds: z.array(z.string().uuid()).max(16),
    sentAt: z.string().datetime(),
  })
  .strict();

export const runAcceptSchema = z
  .object({
    type: z.literal("run.accept"),
    protocolVersion: z.literal(protocolVersion),
    nodeId: nodeIdSchema,
    offerId: z.string().uuid(),
    runId: z.string().uuid(),
    acceptedAt: z.string().datetime(),
  })
  .strict();

export const runRejectSchema = z
  .object({
    type: z.literal("run.reject"),
    protocolVersion: z.literal(protocolVersion),
    nodeId: nodeIdSchema,
    offerId: z.string().uuid(),
    runId: z.string().uuid(),
    reason: z.string().trim().min(1).max(500),
    rejectedAt: z.string().datetime(),
  })
  .strict();

export const runStartRequestSchema = z
  .object({
    type: z.literal("run.start_request"),
    protocolVersion: z.literal(protocolVersion),
    nodeId: nodeIdSchema,
    runId: z.string().uuid(),
    requestedAt: z.string().datetime(),
  })
  .strict();

export const runProgressSchema = z
  .object({
    type: z.literal("run.progress"),
    protocolVersion: z.literal(protocolVersion),
    nodeId: nodeIdSchema,
    runId: z.string().uuid(),
    stage: z.string().trim().min(1).max(80),
    message: z.string().trim().min(1).max(500),
    occurredAt: z.string().datetime(),
  })
  .strict();

export const nativeRunOutputSchema = z
  .object({
    runId: z.string().uuid(),
    channelId: z.string().uuid(),
    botId: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    text: z.string().max(8000),
    reset: z.boolean(),
  })
  .strict();

export const steerNativeRunInputSchema = z
  .object({ instruction: z.string().trim().min(1).max(4000) })
  .strict();

export const runFrameSchema = z
  .object({
    type: z.literal("run.frame"),
    protocolVersion: z.literal(protocolVersion),
    nodeId: nodeIdSchema,
    runId: z.string().uuid(),
    mediaType: z.literal("image/png"),
    base64: z
      .string()
      .min(12)
      .max(2_800_000)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    width: z.number().int().positive().max(20_000).optional(),
    height: z.number().int().positive().max(20_000).optional(),
    capturedAt: z.string().datetime(),
  })
  .strict();

const approvalBeforeStateSchema = z
  .record(z.string().trim().min(1).max(80), z.unknown())
  .refine((value) => Object.keys(value).length <= 32, "Too many before-state fields.")
  .refine((value) => isBoundedJsonValue(value), "Before-state evidence exceeds safe bounds.");

export const approvalRequestSchema = z
  .object({
    type: z.literal("approval.request"),
    protocolVersion: z.literal(protocolVersion),
    nodeId: nodeIdSchema,
    runId: z.string().uuid(),
    requestId: z.string().uuid(),
    action: z.string().trim().min(1).max(120),
    target: z.string().trim().min(1).max(2048),
    summary: z.string().trim().min(1).max(500),
    risk: z.enum(["write", "destructive", "privileged"]),
    beforeState: approvalBeforeStateSchema.default({}),
    expiresInSeconds: z.number().int().min(30).max(900).default(300),
    requestedAt: z.string().datetime(),
  })
  .strict();

const screenshotMetadataSchema = z
  .object({
    width: z.number().int().positive().max(20_000).optional(),
    height: z.number().int().positive().max(20_000).optional(),
    capturedAt: z.string().datetime().optional(),
    url: z.string().url().max(2048).optional(),
  })
  .strict();

export const completedArtifactSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    mediaType: z.literal("image/png"),
    base64: z
      .string()
      .min(12)
      .max(7_000_000)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    metadata: screenshotMetadataSchema.optional(),
  })
  .strict();

export type CompletedArtifact = z.infer<typeof completedArtifactSchema>;

export const runCompletedSchema = z
  .object({
    type: z.literal("run.completed"),
    protocolVersion: z.literal(protocolVersion),
    nodeId: nodeIdSchema,
    runId: z.string().uuid(),
    summary: z.string().trim().min(1).max(2000),
    artifacts: z.array(completedArtifactSchema).max(4),
    completedAt: z.string().datetime(),
  })
  .strict();

export const runFailureCodeSchema = z.enum([
  "provider_unavailable",
  "provider_execution_failed",
  "artifact_persistence_failed",
  "execution_interrupted",
  "node_disconnected",
  "approval_policy_denied",
  "dispatch_failed",
]);
export type RunFailureCode = z.infer<typeof runFailureCodeSchema>;

export const runFailureMessages = {
  provider_unavailable: "No executable Provider is available for this Run.",
  provider_execution_failed: "Provider execution failed.",
  artifact_persistence_failed: "The result artifact could not be persisted.",
  execution_interrupted: "Execution was interrupted before the Server received a result.",
  node_disconnected: "The execution Node disconnected before the operation completed.",
  approval_policy_denied: "Server policy did not permit the requested action.",
  dispatch_failed: "The Server could not dispatch this Run.",
} as const satisfies Record<RunFailureCode, string>;

export const runFailedSchema = z
  .object({
    type: z.literal("run.failed"),
    protocolVersion: z.literal(protocolVersion),
    nodeId: nodeIdSchema,
    runId: z.string().uuid(),
    code: runFailureCodeSchema.default("provider_execution_failed"),
    error: z.string().trim().min(1).max(2000),
    failedAt: z.string().datetime(),
  })
  .strict();

export const nodeMessageSchema = z.discriminatedUnion("type", [
  browserResultSchema,
  nodeHelloSchema,
  nodeHeartbeatSchema,
  runAcceptSchema,
  runRejectSchema,
  runStartRequestSchema,
  runProgressSchema,
  runFrameSchema,
  approvalRequestSchema,
  runCompletedSchema,
  runFailedSchema,
]);

export type NodeMessage = z.infer<typeof nodeMessageSchema>;

export const serverAckSchema = z
  .object({
    type: z.literal("server.ack"),
    protocolVersion: z.literal(protocolVersion),
    accepted: z.boolean(),
    reason: z.string().trim().min(1).max(500).optional(),
    receivedAt: z.string().datetime(),
    commandChannel: z
      .object({
        protocolVersion: z.literal("0.10.0"),
        connectionId: z
          .string()
          .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.commandChannel === undefined || value.accepted,
    "Command negotiation requires an accepted identity.",
  );

export type ServerAck = z.infer<typeof serverAckSchema>;

export const runOfferSchema = z
  .object({
    type: z.literal("run.offer"),
    protocolVersion: z.literal(protocolVersion),
    offerId: z.string().uuid(),
    runId: z.string().uuid(),
    channelId: z.string().uuid(),
    botId: z.string().uuid(),
    title: z.string().trim().min(1).max(80),
    instruction: z.string().trim().min(1).max(8000),
    executionProfile: z.enum(["docker-linux", "macos-cua", "lume-vm", "coder"]),
    requiredCapabilities: z
      .array(nodeCapabilitySchema)
      .min(1)
      .max(nodeCapabilitySchema.options.length)
      .refine((value) => new Set(value).size === value.length, "Duplicate capabilities."),
    requiredCapabilityManifest: z.array(nodeCapabilityRequirementSchema).min(1).max(32),
    sentAt: z.string().datetime(),
  })
  .strict();

export type RunOffer = z.infer<typeof runOfferSchema>;

export const runAssignedSchema = z
  .object({
    type: z.literal("run.assigned"),
    protocolVersion: z.literal(protocolVersion),
    runId: z.string().uuid(),
    nodeId: nodeIdSchema,
    assignedAt: z.string().datetime(),
  })
  .strict();

export const runCancelSchema = z
  .object({
    type: z.literal("run.cancel"),
    protocolVersion: z.literal(protocolVersion),
    runId: z.string().uuid(),
    reason: z.string().trim().min(1).max(500),
    cancelledAt: z.string().datetime(),
  })
  .strict();

export const runStartSchema = z
  .object({
    type: z.literal("run.start"),
    protocolVersion: z.literal(protocolVersion),
    runId: z.string().uuid(),
    nodeId: nodeIdSchema,
    startedAt: z.string().datetime(),
  })
  .strict();

export const runSettledSchema = z
  .object({
    type: z.literal("run.settled"),
    protocolVersion: z.literal(protocolVersion),
    runId: z.string().uuid(),
    nodeId: nodeIdSchema,
    status: z.enum(["completed", "failed"]),
    settledAt: z.string().datetime(),
  })
  .strict();

export const approvalResolvedSchema = z
  .object({
    type: z.literal("approval.resolved"),
    protocolVersion: z.literal(protocolVersion),
    nodeId: nodeIdSchema,
    runId: z.string().uuid(),
    requestId: z.string().uuid(),
    decision: z.enum(["approved", "rejected", "expired"]),
    decidedAt: z.string().datetime(),
  })
  .strict();

export const serverMessageSchema = z.discriminatedUnion("type", [
  browserCommandSchema,
  serverAckSchema,
  runOfferSchema,
  runAssignedSchema,
  runCancelSchema,
  runStartSchema,
  runSettledSchema,
  approvalResolvedSchema,
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;

export const runEventTypeSchema = z.enum([
  "CHANNEL_CREATED",
  "BOT_CREATED",
  "BOT_JOINED_CHANNEL",
  "BOT_REMOVED_FROM_CHANNEL",
  "MESSAGE_REACTION_CHANGED",
  "MESSAGE_CREATED",
  "RUN_CREATED",
  "RUN_ASSIGNED",
  "RUN_REQUEUED",
  "RUN_STARTED",
  "RUN_PROGRESS",
  "RUN_STEERING_SUBMITTED",
  "RUN_STEERING_APPLIED",
  "RUN_PLAN_UPDATED",
  "NODE_BOUND",
  "APPROVAL_REQUESTED",
  "APPROVAL_APPROVED",
  "APPROVAL_REJECTED",
  "APPROVAL_EXPIRED",
  "FRAME_UPDATED",
  "ARTIFACT_CREATED",
  "RUN_BLOCKED",
  "RUN_COMPLETED",
  "RUN_FAILED",
  "DISPATCH_FAILED",
]);

export const runEventSchema = z.object({
  id: z.string().min(1),
  type: runEventTypeSchema,
  runId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional(),
  botId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
});

export type RunEvent = z.infer<typeof runEventSchema>;

/** Bound approval evidence before it can become a durable audit record. */
function isBoundedJsonValue(root: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || ++nodes > 256) return false;
    const { value, depth } = current;
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value === "string") {
      if (value.length > 4096) return false;
      continue;
    }
    if (typeof value !== "object" || depth >= 6 || seen.has(value)) return false;
    seen.add(value);

    if (Array.isArray(value)) {
      if (value.length > 64) return false;
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const entries = Object.entries(value);
    if (entries.length > 32) return false;
    for (const [key, item] of entries) {
      if (key.length === 0 || key.length > 80) return false;
      stack.push({ value: item, depth: depth + 1 });
    }
  }

  return true;
}
