import type {
  Approval,
  ApprovalDecision,
  ApprovalResolution,
  ApprovalRisk,
  Artifact,
  Bot,
  Channel,
  CreateBotInput,
  CreateChannelInput,
  CreateEmployeeMemoryInput,
  CreateEmployeeSkillInput,
  CreateMessageInput,
  DeleteEmployeeMemoryInput,
  EmployeeImportActivationResult,
  EmployeeMemoryDeletionResult,
  EmployeeMemoryMutationResult,
  EmployeeProfile,
  EmployeeProfileDetailsMutationResult,
  EmployeeSkillMutationResult,
  ExecutionNode,
  Message,
  Run,
  RunProgress,
  SubmitTaskResult,
  UpdateEmployeeMemoryInput,
  UpdateEmployeeProfileDetailsInput,
  UpdateEmployeeSkillStateInput,
} from "@openbot/domain";
import type { EmployeeTemplatePackage, RunFailureCode } from "@openbot/protocol";

export interface RequestApprovalInput {
  requestId: string;
  action: string;
  target: string;
  summary: string;
  risk: ApprovalRisk;
  beforeState: Record<string, unknown>;
  expiresAt: string;
}

export interface ArtifactRecord extends Artifact {
  storageKey: string;
  metadata: Record<string, unknown>;
}

export interface RunCompletion {
  run: Run;
  artifacts: Artifact[];
  message: Message;
}

export interface PersistedCounts {
  channels: number;
  bots: number;
  activeRuns: number;
}

export interface DispatchFailureInput {
  runId: string;
  nodeId?: string | undefined;
  phase: string;
  code: "dispatch_failed";
}

export interface ActivateEmployeeImportCommand {
  document: EmployeeTemplatePackage;
  packageDigest: string;
  idempotencyKey: string;
  employeeName?: string | undefined;
  signature: { status: "unsigned" } | { status: "dsse"; trustedPublisherKeyId: string };
  reviewedBy: "owner";
  reviewedAt: string;
}

export interface ControlPlaneStore {
  channelExists(channelId: string): Promise<boolean>;
  listChannels(): Promise<Channel[]>;
  listBots(): Promise<Bot[]>;
  getEmployeeProfile(botId: string): Promise<EmployeeProfile>;
  updateEmployeeProfileDetails(
    botId: string,
    input: UpdateEmployeeProfileDetailsInput,
  ): Promise<EmployeeProfileDetailsMutationResult>;
  listMessages(channelId: string): Promise<Message[]>;
  listRuns(channelId?: string): Promise<Run[]>;
  listApprovals(): Promise<Approval[]>;
  listRunProgress(channelId?: string): Promise<RunProgress[]>;
  listArtifacts(runId?: string): Promise<Artifact[]>;
  getArtifact(artifactId: string): Promise<ArtifactRecord | undefined>;
  listDispatchableRuns(limit?: number): Promise<Run[]>;
  getRunningRunForNode(runId: string, nodeId: string): Promise<Run | undefined>;
  getCounts(): Promise<PersistedCounts>;
  createBot(input: CreateBotInput): Promise<Bot>;
  activateEmployeeImport(
    input: ActivateEmployeeImportCommand,
  ): Promise<EmployeeImportActivationResult>;
  createEmployeeSkill(
    botId: string,
    input: CreateEmployeeSkillInput,
  ): Promise<EmployeeSkillMutationResult>;
  updateEmployeeSkillState(
    botId: string,
    skillId: string,
    input: UpdateEmployeeSkillStateInput,
  ): Promise<EmployeeSkillMutationResult>;
  createEmployeeMemory(
    botId: string,
    input: CreateEmployeeMemoryInput,
  ): Promise<EmployeeMemoryMutationResult>;
  updateEmployeeMemory(
    botId: string,
    memoryId: string,
    input: UpdateEmployeeMemoryInput,
  ): Promise<EmployeeMemoryMutationResult>;
  deleteEmployeeMemory(
    botId: string,
    memoryId: string,
    input: DeleteEmployeeMemoryInput,
  ): Promise<EmployeeMemoryDeletionResult>;
  createChannel(input: CreateChannelInput): Promise<Channel>;
  getOrCreateDirectConversation(botId: string): Promise<Channel>;
  submitTask(channelId: string, input: CreateMessageInput): Promise<SubmitTaskResult>;
  assignRun(runId: string, nodeId: string): Promise<Run | undefined>;
  startRun(runId: string, nodeId: string): Promise<Run | undefined>;
  requestApproval(
    runId: string,
    nodeId: string,
    input: RequestApprovalInput,
  ): Promise<ApprovalResolution | undefined>;
  decideApproval(
    approvalId: string,
    decision: ApprovalDecision,
    decidedBy: string,
  ): Promise<ApprovalResolution>;
  appendRunProgress(
    runId: string,
    nodeId: string,
    stage: string,
    message: string,
  ): Promise<RunProgress | undefined>;
  completeRun(
    runId: string,
    nodeId: string,
    summary: string,
    artifacts: ArtifactRecord[],
  ): Promise<RunCompletion | undefined>;
  failRun(
    runId: string,
    nodeId: string,
    error: string,
    code?: RunFailureCode,
  ): Promise<Run | undefined>;
  failRunningRuns(nodeId?: string): Promise<Run[]>;
  recordDispatchFailure?(input: DispatchFailureInput): Promise<void>;
  requeueAssignedRuns(nodeId?: string): Promise<Run[]>;
  upsertNode(node: ExecutionNode): Promise<void>;
  markNodeOffline(nodeId: string): Promise<void>;
  joinBotToChannel(channelId: string, botId: string): Promise<Channel>;
}

export class StoreConflictError extends Error {}
export class StoreNotFoundError extends Error {}
export class StoreValidationError extends Error {}
