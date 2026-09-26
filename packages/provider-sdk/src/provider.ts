import type {
  BrowserCommand,
  BrowserFrame,
  NodeCapability,
  NodeCapabilityDescriptor,
  NodePlatform,
} from "@openbot/protocol";

export interface ProviderContext {
  nodeId: string;
  workDirectory: string;
  signal: AbortSignal;
}

export interface ProviderRunInput {
  runId: string;
  channelId: string;
  botId: string;
  title: string;
  instruction: string;
  executionProfile: "docker-linux" | "macos-cua" | "lume-vm" | "coder";
}

export interface ProviderArtifact {
  name: string;
  mediaType: "image/png";
  base64: string;
  metadata?: Record<string, unknown>;
}

/**
 * A side effect frozen before approval. Providers must commit this exact action rather than
 * recomputing a target from mutable model output after approval.
 */
export interface PreparedAction {
  actionId: string;
  action: string;
  target: string;
  summary: string;
  risk: "read" | "write" | "destructive" | "privileged";
  beforeState?: Record<string, unknown>;
  expiresInSeconds?: number;
}

export interface ApprovalOutcome {
  approvalId: string;
  status: "approved" | "rejected" | "expired";
}

export interface ProviderResult {
  ok: boolean;
  summary: string;
  artifacts: ProviderArtifact[];
}

export interface ProviderProgress {
  stage: string;
  message: string;
}

export interface ProviderFrame {
  mediaType: "image/png";
  base64: string;
  width?: number;
  height?: number;
  capturedAt: string;
}

/**
 * A replaceable execution backend. Declared capabilities describe what the backend can do; they
 * never authorize a Run or bypass Server policy.
 */
export interface ComputerProvider {
  browser?(command: BrowserCommand, signal: AbortSignal): Promise<BrowserFrame>;
  id: string;
  displayName: string;
  platforms: NodePlatform[];
  capabilities: NodeCapability[];
  capabilityManifest: NodeCapabilityDescriptor[];
  execute?(
    context: ProviderContext,
    input: ProviderRunInput,
    report: (progress: ProviderProgress) => void,
    reportFrame?: (frame: ProviderFrame) => void,
    requestApproval?: (action: PreparedAction) => Promise<ApprovalOutcome>,
  ): Promise<ProviderResult>;
  prepare?(context: ProviderContext, action: unknown): Promise<PreparedAction>;
  commit?(context: ProviderContext, prepared: PreparedAction): Promise<ProviderResult>;
}
