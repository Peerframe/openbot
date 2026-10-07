import type { MessageReaction } from "./channel-interactions.js";

export * from "./model-providers.js";
export * from "./model-services.js";

export type EntityId = string;

export type BotStatus = import("@openbot/protocol").BotWire["status"];

export type RunStatus = import("@openbot/protocol").RunWire["status"];

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalRisk = "write" | "destructive" | "privileged";
export type ApprovalDecision = "approve" | "reject";

export type { ChannelMessagePreview } from "@openbot/protocol";

export type Channel = import("@openbot/protocol").ChannelWire;

export type BotHeadShape = "round" | "square" | "cat";
export type BotBodyShape = "classic" | "tall" | "cape" | "armor" | "storage" | "quadruped";
export type BotMobility = "feet" | "single-wheel" | "dual-wheel" | "hover" | "four-legs";
export type BotAccessory = "none" | "headphones" | "backpack" | "trench" | "arm" | "toolbox";
export type BotAccent = "green" | "yellow" | "red" | "blue" | "violet" | "teal" | "pink" | "slate";

export interface QuickCreateBotInput {
  appearance: BotAppearance;
}

export interface QuickCreateBotResponse {
  bot: Bot;
  channel: Channel;
}

export type BotAppearance = NonNullable<import("@openbot/protocol").BotWire["appearance"]>;

export type Bot = import("@openbot/protocol").BotWire;

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
export type EmployeeEvidenceReference =
  import("@openbot/protocol").EmployeeEvolutionWire["evidence"][number];

/** Append-only, evidence-backed history used by the employee evolution view. */
export type EmployeeEvolutionEvent = import("@openbot/protocol").EmployeeEvolutionWire;

export type EmployeeSkillState = "candidate" | "verified" | "suspended" | "revoked";
export type EmployeeSkillSource = "built-in" | "installed" | "learned" | "imported" | "manual";

/** A versioned skill assignment. Confidence is evidence quality, never an authority grant. */
export type EmployeeSkill = import("@openbot/protocol").EmployeeSkillWire;

export type CreateEmployeeSkillInput = Omit<
  import("@openbot/protocol").EmployeeSkillCreateInputWire,
  "requiredCapabilities"
> & { requiredCapabilities: string[] };

export type UpdateEmployeeSkillStateInput = import("@openbot/protocol").EmployeeSkillStateInputWire;

export type EmployeeSkillMutationResult = import("@openbot/protocol").EmployeeSkillMutationWire;

export type EmployeeMemoryKind =
  | "working"
  | "episodic"
  | "semantic"
  | "procedural"
  | "secret-reference";
export type EmployeeMemorySensitivity = "public" | "internal" | "confidential" | "restricted";
export type EmployeeMemoryPortability = "never" | "owner-selectable" | "included";

/** Owner-visible memory metadata and content. Export policy is evaluated separately. */
export type EmployeeMemory = Omit<
  import("@openbot/protocol").EmployeeMemoryWire,
  "modelUseEnabled" | "provenance"
> & {
  /** Older additive consumers can omit the model flag and retain opaque provenance. */
  modelUseEnabled?: boolean | undefined;
  provenance: Record<string, unknown>;
};

export type EmployeeMemoryChangedField =
  | "kind"
  | "title"
  | "content"
  | "sensitivity"
  | "portability"
  | "modelUseEnabled";

/** Content-free, append-only audit metadata for one Owner memory mutation. */
export type EmployeeMemoryEvent = import("@openbot/protocol").EmployeeMemoryEventWire;

export type CreateEmployeeMemoryInput = import("@openbot/protocol").EmployeeMemoryCreateInputWire;

export type UpdateEmployeeMemoryInput = import("@openbot/protocol").EmployeeMemoryUpdateInputWire;

export type DeleteEmployeeMemoryInput = import("@openbot/protocol").EmployeeMemoryDeleteInputWire;

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

// Additive consumers retain opaque approval state; the HTTP parser still requires strict JSON.
export type EmployeeProfile = Omit<
  import("@openbot/protocol").EmployeeProfileWire,
  "memories" | "records"
> & {
  memories: EmployeeMemory[];
  records: Omit<import("@openbot/protocol").EmployeeProfileWire["records"], "approvals"> & {
    approvals: Approval[];
  };
};

export type EmployeeProfileChangedField = "role" | "description";

export type UpdateEmployeeProfileDetailsInput =
  import("@openbot/protocol").EmployeeProfileDetailsInputWire;

export type EmployeeProfileDetailsMutationResult = Omit<
  import("@openbot/protocol").EmployeeProfileMutationWire,
  "evolution"
> & { evolution: EmployeeEvolutionEvent };

export type EmployeeProfileSection =
  | "identity"
  | "evolution"
  | "skills"
  | "memory"
  | "records"
  | "configuration"
  | "portability"
  | "modelUseEnabled";

/** Shared strict portability contracts; previews contain untrusted descriptive data only. */
export type EmployeeExportFinding = import("@openbot/protocol").EmployeeExportFindingHttp;
export type EmployeeExportFindingCode = EmployeeExportFinding["code"];
export type EmployeeExportExclusion = import("@openbot/protocol").EmployeeExportExclusionHttp;
export type PortableEmployeeProfileSummary = import("@openbot/protocol").PortableEmployeeHttp;
export type PortableEmployeeSkillSummary = import("@openbot/protocol").PortableSkillHttp;
export type EmployeeExportPreview = import("@openbot/protocol").EmployeeExportPreviewHttp;
export type EmployeeImportIssue = import("@openbot/protocol").EmployeeImportIssueHttp;
export type EmployeeImportIssueCode = EmployeeImportIssue["code"];
export type EmployeeImportPreview = import("@openbot/protocol").EmployeeImportPreviewHttp;
export type EmployeeImportReceipt = import("@openbot/protocol").EmployeeImportReceiptHttp;
export type EmployeeImportActivationResult =
  import("@openbot/protocol").EmployeeImportActivationHttp;

export type ExecutionNode = import("@openbot/protocol").ExecutionNodeWire;

/** Safe Owner-facing identity metadata. Credential digests never cross the Server boundary. */
export type NodeIdentitySummary = import("@openbot/protocol").NodeIdentitySummaryWire;

/** A short-lived bootstrap value returned only by the issuance command. */
export type NodeEnrollmentToken = import("@openbot/protocol").NodeEnrollmentTokenWire;

export type Run = import("@openbot/protocol").RunWire;

/** Provider-reported counts for observed steps; null means at least one count was unavailable. */
export type RunModelUsage = NonNullable<import("@openbot/protocol").RunWire["modelUsage"]>;

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

/** A persisted public checkpoint; never model reasoning or provider/tool output. */
export interface RunProgressStep {
  id: EntityId;
  stepNumber: number;
  stageName: string | null;
  description: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface RunProgressSummary {
  runId: EntityId;
  status: RunStatus;
  /** Exact number of persisted Work actions or historical public checkpoints, independent of the snapshot window. */
  totalSteps: number;
  currentStepNumber: number | null;
  plannedTotalSteps: number | null;
  completedSteps: number | null;
  stageName: string | null;
  description: string | null;
  startedAt: string | null;
  endedAt: string | null;
  failureReasonCode: string | null;
}

export interface RunProgressDetails extends RunProgressSummary {
  steps: RunProgressStep[];
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

export type Message = import("@openbot/protocol").MessageWire;

/** Newest bounded page, chronological within the page; nextCursor reads older messages. */
export interface MessagesResponse {
  messages: Message[];
  hasMore: boolean;
  nextCursor?: string | undefined;
}

export interface MessagePaginationInput {
  before?: string | undefined;
  limit?: number | undefined;
}

export type OwnerIdentity = Extract<
  import("@openbot/protocol").AuthSessionWire,
  { authenticated: true }
>["owner"];

export type AuthSessionSnapshot = import("@openbot/protocol").AuthSessionWire;

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
      occurredAt?: string;
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
      occurredAt?: string;
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
  /** Current Server always returns both fields; absent only in pre-C26 Servers/oracle fixtures. */
  primaryBotId?: EntityId | null;
  revision?: number;
  channels: Channel[];
  bots: Bot[];
  nodes: ExecutionNode[];
  runs: Run[];
  approvals: Approval[];
  artifacts: Artifact[];
  progress: RunProgress[];
  /** Additive Server projection; optional for older Server versions and synthetic fixtures. */
  runProgress?: Record<EntityId, RunProgressSummary>;
  counts: BootstrapSummary["counts"];
}

export interface WorkspacePrimaryBot {
  primaryBotId: EntityId | null;
  revision: number;
}

export interface CreateBotInput {
  name: string;
  role: string;
  computerProfile: Bot["computerProfile"];
  appearance?: BotAppearance | undefined;
  model?: import("./model-services.js").ModelSelection | undefined;
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
export type KnowledgeProposalDraft = Pick<
  import("@openbot/protocol").KnowledgeProposalWire,
  "kind" | "title" | "content"
>;
type KnowledgeProposalRecord = KnowledgeProposalDraft &
  Pick<import("@openbot/protocol").KnowledgeProposalWire, "id" | "botId" | "createdAt">;
/** Native Work Runs and legacy channel Runs are distinct source identities. */
export type KnowledgeProposal = KnowledgeProposalRecord &
  (
    | { sourceRunId: string; source?: never }
    | { source: { kind: "task"; taskId: string; runId: string }; sourceRunId?: never }
  );
export type ReviewKnowledgeProposalInput = import("@openbot/protocol").KnowledgeProposalReviewInput;

export type {
  ApprovalException,
  ApprovalSettings,
  ApprovalSettingsInput,
  AuditCategory,
  AuditEvent,
  AuditPage,
  BrowserMaintenanceInput,
  BrowserMaintenanceResult,
  BrowserRuntimeState,
  DesktopPlatformPreferences,
  DesktopPlatformState,
  DesktopUpdateState,
  OwnerPasswordChangeInput,
  OwnerPasswordChangeResponse,
  OwnerPreferences,
  OwnerPreferencesInput,
  OwnerSessionDevice,
  ReviewedPluginCatalog,
  ReviewedPluginEntry,
} from "@openbot/protocol";
export * from "./channel-interactions.js";
