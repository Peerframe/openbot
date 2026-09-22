import type { MessageReaction } from "./channel-interactions.js";
import type { ModelProviderId } from "./model-providers.js";

export * from "./model-providers.js";

import type {
  NodeArchitecture,
  NodeCapabilityDescriptor,
  NodeDeviceClass,
  NodeIsolation,
  NodePlatform,
  NodeTrustTier,
} from "@openbot/protocol";

export type EntityId = string;

export type BotStatus =
  | "idle"
  | "running"
  | "waiting_approval"
  | "blocked"
  | "human_takeover"
  | "offline"
  | "completed"
  | "failed";

export type RunStatus =
  | "queued"
  | "assigned"
  | "running"
  | "waiting_approval"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalRisk = "write" | "destructive" | "privileged";
export type ApprovalDecision = "approve" | "reject";

export interface Channel {
  id: EntityId;
  name: string;
  description: string;
  botIds: EntityId[];
  /** Server-owned fixed participant for a direct conversation. */
  directBotId?: EntityId;
  createdAt: string;
}

export type BotHeadShape = "round" | "square" | "cat";
export type BotBodyShape = "classic" | "tall" | "cape" | "armor" | "storage" | "quadruped";
export type BotMobility = "feet" | "single-wheel" | "dual-wheel" | "hover" | "four-legs";
export type BotAccessory = "none" | "headphones" | "backpack" | "trench" | "arm" | "toolbox";
export type BotAccent = "green" | "yellow" | "red" | "blue";

export interface BotAppearance {
  head: BotHeadShape;
  body: BotBodyShape;
  mobility: BotMobility;
  accessory: BotAccessory;
  accent: BotAccent;
}

export interface Bot {
  id: EntityId;
  name: string;
  role: string;
  status: BotStatus;
  computerProfile: "none" | "docker-linux" | "macos-cua" | "lume-vm" | "coder";
  appearance?: BotAppearance | undefined;
  createdAt: string;
}

export type EmployeeEvolutionEventType =
  | "created"
  | "role_changed"
  | "skill_discovered"
  | "skill_verified"
  | "skill_suspended"
  | "skill_revoked"
  | "configuration_changed"
  | "imported";

export type EmployeeEvidenceKind = "run" | "artifact" | "approval" | "manual" | "import";

/** A stable reference to evidence. Sensitive payloads stay in their source record. */
export interface EmployeeEvidenceReference {
  kind: EmployeeEvidenceKind;
  id: EntityId;
  label?: string | undefined;
}

/** Append-only, evidence-backed history used by the employee evolution view. */
export interface EmployeeEvolutionEvent {
  id: EntityId;
  botId: EntityId;
  type: EmployeeEvolutionEventType;
  title: string;
  summary: string;
  source: EmployeeEvidenceKind;
  sourceId?: EntityId;
  evidence: EmployeeEvidenceReference[];
  createdAt: string;
}

export type EmployeeSkillState = "candidate" | "verified" | "suspended" | "revoked";
export type EmployeeSkillSource = "built-in" | "installed" | "learned" | "imported" | "manual";

/** A versioned skill assignment. Confidence is evidence quality, never an authority grant. */
export interface EmployeeSkill {
  id: EntityId;
  slug: string;
  name: string;
  description: string;
  version: string;
  source: EmployeeSkillSource;
  state: EmployeeSkillState;
  confidence: number;
  requiredCapabilities: string[];
  dependencyIds: EntityId[];
  evidence: EmployeeEvidenceReference[];
  acquiredAt: string;
  updatedAt: string;
  /** Immutable reviewed instruction file; portable v2 packages include it only after explicit selection. */
  skillMarkdown?: string | undefined;
  contentSha256?: string | undefined;
  modelUseEnabled?: boolean | undefined;
}

export interface CreateEmployeeSkillInput {
  skillMarkdown?: string | undefined;
  slug: string;
  name: string;
  description: string;
  version: string;
  source: EmployeeSkillSource;
  requiredCapabilities: string[];
  dependencySkillIds: EntityId[];
  evidence: EmployeeEvidenceReference[];
  reason: string;
}

export type UpdateEmployeeSkillStateInput =
  | {
      state: "verified";
      reviewedContentSha256?: string | undefined;
      confidence: number;
      reason: string;
      evidence: EmployeeEvidenceReference[];
      ownerReviewed: true;
    }
  | {
      state: "suspended" | "revoked";
      reason: string;
      evidence: EmployeeEvidenceReference[];
      ownerReviewed: true;
    };

export interface EmployeeSkillMutationResult {
  skill: EmployeeSkill;
  evolution: EmployeeEvolutionEvent;
}

export type EmployeeMemoryKind =
  | "working"
  | "episodic"
  | "semantic"
  | "procedural"
  | "secret-reference";
export type EmployeeMemorySensitivity = "public" | "internal" | "confidential" | "restricted";
export type EmployeeMemoryPortability = "never" | "owner-selectable" | "included";

/** Owner-visible memory metadata and content. Export policy is evaluated separately. */
export interface EmployeeMemory {
  id: EntityId;
  botId: EntityId;
  kind: EmployeeMemoryKind;
  title: string;
  content: string;
  sensitivity: EmployeeMemorySensitivity;
  portability: EmployeeMemoryPortability;
  provenance: Record<string, unknown>;
  modelUseEnabled?: boolean | undefined;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type EmployeeMemoryChangedField =
  | "kind"
  | "title"
  | "content"
  | "sensitivity"
  | "portability"
  | "modelUseEnabled";

/** Content-free, append-only audit metadata for one Owner memory mutation. */
export interface EmployeeMemoryEvent {
  id: EntityId;
  botId: EntityId;
  memoryId: EntityId;
  action: "created" | "updated" | "deleted";
  revision: number;
  changedFields: EmployeeMemoryChangedField[];
  actor: "owner";
  createdAt: string;
}

export interface CreateEmployeeMemoryInput {
  kind: EmployeeMemoryKind;
  title: string;
  content: string;
  sensitivity: EmployeeMemorySensitivity;
  portability: Exclude<EmployeeMemoryPortability, "included">;
  modelUseEnabled?: boolean | undefined;
}

export interface UpdateEmployeeMemoryInput {
  expectedRevision: number;
  kind?: EmployeeMemoryKind | undefined;
  title?: string | undefined;
  content?: string | undefined;
  sensitivity?: EmployeeMemorySensitivity | undefined;
  portability?: Exclude<EmployeeMemoryPortability, "included"> | undefined;
  modelUseEnabled?: boolean | undefined;
}

export interface DeleteEmployeeMemoryInput {
  expectedRevision: number;
  ownerReviewed: true;
}

export interface EmployeeMemoryMutationResult {
  memory: EmployeeMemory;
  event: EmployeeMemoryEvent;
}

export interface EmployeeMemoryDeletionResult {
  memoryId: EntityId;
  event: EmployeeMemoryEvent;
}

/** A safe runtime explanation derived from structured progress, not private chain-of-thought. */
export interface EmployeeDecisionTrace extends RunProgress {
  summary: string;
}

export interface EmployeeProfile {
  employee: Bot;
  details: {
    /** Owner-authored routing biography. It is descriptive and grants no authority. */
    description: string;
    /** Server-owned compare-and-swap revision for role and description edits. */
    revision: number;
    updatedAt: string;
  };
  evolution: EmployeeEvolutionEvent[];
  skills: EmployeeSkill[];
  memories: EmployeeMemory[];
  memoryEvents: EmployeeMemoryEvent[];
  records: {
    runs: Run[];
    approvals: Approval[];
    artifacts: Artifact[];
    decisions: EmployeeDecisionTrace[];
  };
  statistics: {
    totalRuns: number;
    completedRuns: number;
    failedRuns: number;
    verifiedSkills: number;
  };
  configuration: {
    executionProfile: Bot["computerProfile"];
    portabilityFormat: "openbot.employee/v1";
  };
}

export type EmployeeProfileChangedField = "role" | "description";

export interface UpdateEmployeeProfileDetailsInput {
  role: string;
  description: string;
  expectedRevision: number;
}

export interface EmployeeProfileDetailsMutationResult {
  employee: Bot;
  details: EmployeeProfile["details"];
  evolution: EmployeeEvolutionEvent;
}

export type EmployeeProfileSection =
  | "identity"
  | "evolution"
  | "skills"
  | "memory"
  | "records"
  | "configuration"
  | "portability"
  | "modelUseEnabled";

export type EmployeeExportFindingCode =
  | "credential-like-content"
  | "private-key-content"
  | "local-path-content"
  | "excluded-skill-dependency"
  | "invalid-skill-content"
  | "package-too-large";

/** A blocking finding discovered before portable employee data leaves the Server. */
export interface EmployeeExportFinding {
  code: EmployeeExportFindingCode;
  location: string;
  message: string;
}

export interface EmployeeExportExclusion {
  category: "identity" | "authority" | "memory" | "work-history";
  count: number;
  reason: string;
}

/** Descriptive, untrusted Employee data selected for a portable template. */
export type PortableEmployeeProfileSummary = Pick<Bot, "name" | "role" | "appearance"> & {
  description?: string;
};

/** Untrusted portable skill, optionally containing one bounded instruction file. */
export interface PortableEmployeeSkillSummary {
  slug: string;
  name: string;
  /** Required Agent Skills discovery metadata; still untrusted package content. */
  description: string;
  version: string;
  requiredCapabilities: string[];
  dependencySlugs: string[];
  content?: { markdown: string; sha256: string; license: string };
}

/** Owner-facing summary of exactly what a default employee template will contain. */
export interface EmployeeExportPreview {
  format: "openbot.employee/v1" | "openbot.employee/v2";
  kind: "template";
  /** Fresh package identity that must be returned when downloading this reviewed instance. */
  packageId: string;
  fileName: string;
  generatedAt: string;
  employee: PortableEmployeeProfileSummary;
  skills: PortableEmployeeSkillSummary[];
  /** @deprecated Use `employee.name`; retained through the v1 preview compatibility window. */
  employeeName: string;
  verifiedSkillCount: number;
  requestedCapabilities: string[];
  includedMemoryCount: 0;
  exclusions: EmployeeExportExclusion[];
  findings: EmployeeExportFinding[];
  blocked: boolean;
  checksum: string;
  /** Opaque SHA-256 strong validator for the exact serialized download bytes. */
  downloadReviewToken: string;
  signatureStatus: "unsigned" | "dsse";
  publisherKeyId?: string;
  identityOnImport: "new";
  hostAuthority: "none";
}

export type EmployeeImportIssueCode =
  | "checksum-mismatch"
  | "capability-set-mismatch"
  | "duplicate-skill"
  | "missing-skill-dependency"
  | "sensitive-content"
  | "missing-capability"
  | "no-compatible-host"
  | "invalid-skill-content";

export interface EmployeeImportIssue {
  code: EmployeeImportIssueCode;
  message: string;
  locations: string[];
}

/** A read-only, quarantined projection. Activation is a separate Owner-reviewed command. */
export interface EmployeeImportPreview {
  format: "openbot.employee/v1" | "openbot.employee/v2";
  packageId: string;
  generatedAt: string;
  employee: PortableEmployeeProfileSummary;
  recommendedExecutionProfile: Bot["computerProfile"];
  skills: PortableEmployeeSkillSummary[];
  requestedCapabilities: string[];
  integrity: {
    algorithm: "sha256";
    valid: boolean;
    /** Digest of the canonical, schema-valid package reviewed by the Owner. */
    digest: string;
  };
  signature:
    | {
        status: "unsigned";
        trusted: false;
      }
    | {
        status: "dsse";
        trusted: true;
        keyid: string;
      };
  compatibility: {
    hostRequired: boolean;
    compatibleHosts: Array<
      Pick<ExecutionNode, "id" | "name" | "platform" | "architecture" | "deviceClass">
    >;
    missingCapabilities: string[];
  };
  quarantine: {
    active: true;
    createsNewIdentity: true;
    importedSkillState: "disabled-pending-review";
    hostAuthority: "none";
    memoryCount: 0;
    canActivate: boolean;
  };
  issues: EmployeeImportIssue[];
  blocked: boolean;
}

/** Immutable evidence that one reviewed portable package created one local Employee. */
export interface EmployeeImportReceipt {
  id: EntityId;
  packageId: string;
  packageDigest: string;
  employeeId: EntityId;
  signatureStatus: "unsigned" | "dsse";
  publisherKeyId?: string | undefined;
  reviewedBy: "owner";
  reviewedAt: string;
  importedSkillCount: number;
  createdAt: string;
}

export interface EmployeeImportActivationResult {
  employee: Bot;
  receipt: EmployeeImportReceipt;
  replayed: boolean;
}

export interface ExecutionNode {
  id: EntityId;
  name: string;
  platform: NodePlatform;
  osVersion: string;
  architecture: NodeArchitecture;
  deviceClass: NodeDeviceClass;
  isolation: NodeIsolation;
  trustTier: NodeTrustTier;
  capabilities: string[];
  capabilityManifest: NodeCapabilityDescriptor[];
  activeRunIds: EntityId[];
  maxConcurrentRuns: number;
  connectedAt: string;
  lastSeenAt: string;
}

/** Safe Owner-facing identity metadata. Credential digests never cross the Server boundary. */
export interface NodeIdentitySummary {
  nodeId: EntityId;
  status: "active" | "revoked";
  connected: boolean;
  enrolledAt: string;
  lastAuthenticatedAt?: string | undefined;
  revokedAt?: string | undefined;
  node?: ExecutionNode | undefined;
}

/** A short-lived bootstrap value returned only by the issuance command. */
export interface NodeEnrollmentToken {
  nodeId: EntityId;
  token: string;
  expiresAt: string;
}

export interface Run {
  id: EntityId;
  parentRunId?: EntityId;
  rootRunId?: EntityId;
  delegatedByBotId?: EntityId;
  channelId: EntityId;
  botId: EntityId;
  sourceMessageId?: EntityId;
  nodeId?: EntityId;
  executionProfile: Bot["computerProfile"];
  instruction: string;
  title: string;
  status: RunStatus;
  resultSummary?: string;
  errorMessage?: string;
  errorCode?: string;
  modelUsage?: RunModelUsage;
  createdAt: string;
  updatedAt: string;
}

/** Provider-reported counts for observed steps; null means at least one count was unavailable. */
export interface RunModelUsage {
  provider: ModelProviderId;
  model: string;
  steps: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface Approval {
  id: EntityId;
  runId: EntityId;
  channelId: EntityId;
  botId: EntityId;
  nodeId: EntityId;
  action: string;
  target: string;
  summary: string;
  risk: ApprovalRisk;
  targetFingerprint: string;
  beforeState: Record<string, unknown>;
  status: ApprovalStatus;
  expiresAt: string;
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
}

export interface ApprovalResolution {
  approval: Approval;
  run: Run;
}

export interface Artifact {
  id: EntityId;
  runId: EntityId;
  name: string;
  mediaType: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
}

export interface RunProgress {
  id: EntityId;
  runId: EntityId;
  channelId: EntityId;
  nodeId?: EntityId;
  stage: string;
  message: string;
  createdAt: string;
}

export interface RunFrame {
  runId: EntityId;
  channelId: EntityId;
  nodeId: EntityId;
  revision: number;
  mediaType: "image/png";
  sizeBytes: number;
  width?: number;
  height?: number;
  capturedAt: string;
}

export type MessageAuthorType = "human" | "bot" | "system";

export interface Message {
  id: EntityId;
  channelId: EntityId;
  authorType: MessageAuthorType;
  authorId?: EntityId;
  replyToMessageId?: EntityId;
  runId?: EntityId;
  content: string;
  createdAt: string;
}

export interface OwnerIdentity {
  id: "owner";
  name: string;
}

export type AuthSessionSnapshot =
  | { authenticated: false }
  | {
      authenticated: true;
      owner: OwnerIdentity;
      expiresAt: string;
    };

export interface RunOutput {
  runId: EntityId;
  channelId: EntityId;
  botId: EntityId;
  sequence: number;
  text: string;
  reset: boolean;
}

export type ChannelRealtimeEvent =
  | {
      type: "message.reactions";
      channelId: EntityId;
      messageId: EntityId;
      reactions: MessageReaction[];
    }
  | { type: "channel.updated"; channelId: EntityId; channel: Channel }
  | ({ type: "run.output" } & RunOutput)
  | {
      type: "channel.ready";
      channelId: EntityId;
      occurredAt: string;
    }
  | {
      type: "message.created";
      channelId: EntityId;
      message: Message;
    }
  | {
      type: "run.created";
      channelId: EntityId;
      run: Run;
    }
  | {
      type: "run.updated";
      channelId: EntityId;
      run: Run;
      artifacts?: Artifact[];
    }
  | {
      type: "run.progress";
      channelId: EntityId;
      progress: RunProgress;
    }
  | {
      type: "run.frame";
      channelId: EntityId;
      frame: RunFrame;
    };

export type WorkspaceRealtimeEvent =
  | {
      type: "workspace.ready";
      nodes: ExecutionNode[];
      occurredAt: string;
    }
  | {
      type: "node.upserted";
      node: ExecutionNode;
    }
  | {
      type: "node.removed";
      nodeId: EntityId;
      occurredAt: string;
    }
  | {
      type: "approval.updated";
      approval: Approval;
      run: Run;
    }
  | {
      type: "run.updated";
      run: Run;
      artifacts?: Artifact[];
    }
  | {
      /** Content-free invalidation. The authenticated profile endpoint remains authoritative. */
      type: "employee.profile.changed";
      botId: EntityId;
      sections: EmployeeProfileSection[];
      occurredAt: string;
    };

export interface BootstrapSummary {
  project: "openbot";
  phase: "foundation" | "m0" | "m1";
  counts: {
    channels: number;
    bots: number;
    connectedNodes: number;
    activeRuns: number;
  };
}

export interface WorkspaceSnapshot {
  channels: Channel[];
  bots: Bot[];
  nodes: ExecutionNode[];
  runs: Run[];
  approvals: Approval[];
  artifacts: Artifact[];
  progress: RunProgress[];
  counts: BootstrapSummary["counts"];
}

/** Full replacement, ordered only within one subscription; never a durable replay cursor. */
export interface WorkspaceSnapshotFrame {
  type: "workspace.snapshot";
  version: 1;
  streamId: string;
  sequence: number;
  snapshot: WorkspaceSnapshot;
}

export interface CreateBotInput {
  name: string;
  role: string;
  computerProfile: Bot["computerProfile"];
  appearance?: BotAppearance | undefined;
}

export interface CreateChannelInput {
  name: string;
  description: string;
  botIds: EntityId[];
}

export interface CreateMessageInput {
  content: string;
  botId?: EntityId | undefined;
  botIds?: EntityId[] | undefined;
  replyToMessageId?: EntityId | undefined;
}

export interface SubmitTaskResult {
  message: Message;
  run: Run;
  runs?: Run[];
}

/** A model-authored proposal is never active memory before an Owner review. */
export interface KnowledgeProposalDraft {
  kind: "semantic" | "episodic" | "procedural";
  title: string;
  content: string;
}
export interface KnowledgeProposal extends KnowledgeProposalDraft {
  id: string;
  botId: string;
  sourceRunId: string;
  createdAt: string;
}
export type ReviewKnowledgeProposalInput =
  | { decision: "reject"; ownerReviewed: true }
  | {
      decision: "accept";
      ownerReviewed: true;
      title: string;
      content: string;
      modelUseEnabled: boolean;
    };

export * from "./channel-interactions.js";
