import { reactionEmojis } from "@openbot/domain";
import type { ModelProviderId } from "@openbot/domain";
import type {
  Approval,
  ApprovalDecision,
  ApprovalResolution,
  Artifact,
  AuthSessionSnapshot,
  Bot,
  Channel,
  ChannelRealtimeEvent,
  CreateBotInput,
  CreateChannelInput,
  CreateEmployeeMemoryInput,
  CreateMessageInput,
  DeleteEmployeeMemoryInput,
  EmployeeExportPreview,
  EmployeeImportActivationResult,
  EmployeeImportPreview,
  EmployeeMemoryDeletionResult,
  EmployeeMemoryMutationResult,
  EmployeeProfile,
  EmployeeProfileDetailsMutationResult,
  EmployeeProfileSection,
  EmployeeSkillMutationResult,
  ExecutionNode,
  KnowledgeProposal,
  Message,
  MessageReaction,
  ReactionEmoji,
  NodeEnrollmentToken,
  NodeIdentitySummary,
  ReviewKnowledgeProposalInput,
  Run,
  RunFrame,
  RunProgress,
  RunOutput,
  SubmitTaskResult,
  UpdateEmployeeMemoryInput,
  UpdateEmployeeProfileDetailsInput,
  UpdateEmployeeSkillStateInput,
  WorkspaceRealtimeEvent,
  WorkspaceSnapshot,
} from "@openbot/domain";

interface ErrorPayload {
  error?: string;
  fields?: Record<string, string[]>;
}

export class ApiError extends Error {
  readonly fields: Record<string, string[]>;
  readonly status: number;

  constructor(message: string, status: number, fields: Record<string, string[]> = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export async function getAuthSession(signal?: AbortSignal): Promise<AuthSessionSnapshot> {
  return request<AuthSessionSnapshot>("/api/v1/auth/session", signal ? { signal } : undefined);
}

export async function login(
  password: string,
): Promise<AuthSessionSnapshot & { authenticated: true }> {
  const result = await request<{ session: AuthSessionSnapshot & { authenticated: true } }>(
    "/api/v1/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    },
  );
  return result.session;
}

export async function logout(): Promise<void> {
  await request<void>("/api/v1/auth/logout", { method: "POST" });
}

export async function cancelNativeRun(runId: string): Promise<Run> {
  const result = await request<{ run: Run }>(`/api/v1/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  return result.run;
}

export async function listChannelReactions(
  channelId: string,
  signal?: AbortSignal,
): Promise<MessageReaction[]> {
  const result = await request<{ reactions: MessageReaction[] }>(
    `/api/v1/channels/${encodeURIComponent(channelId)}/reactions`,
    signal ? { signal } : undefined,
  );
  if (!isMessageReactions(result.reactions)) throw new Error("回应列表无效。");
  return result.reactions;
}
export async function setMessageReaction(
  channelId: string,
  messageId: string,
  emoji: ReactionEmoji,
  active: boolean,
): Promise<MessageReaction[]> {
  const result = await request<{ reactions: MessageReaction[] }>(
    `/api/v1/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji, active }),
    },
  );
  if (
    !isMessageReactions(result.reactions) ||
    result.reactions.some((item) => item.messageId !== messageId)
  )
    throw new Error("回应结果无效。");
  return result.reactions;
}
export async function removeChannelMember(
  channelId: string,
  botId: string,
): Promise<{ channel: Channel; cancelledRuns: Run[] }> {
  return request(
    `/api/v1/channels/${encodeURIComponent(channelId)}/bots/${encodeURIComponent(botId)}`,
    { method: "DELETE" },
  );
}
function isMessageReactions(value: unknown): value is MessageReaction[] {
  return (
    Array.isArray(value) &&
    value.length <= 1200 &&
    value.every(
      (item) =>
        item &&
        typeof item.messageId === "string" &&
        item.actor === "owner" &&
        reactionEmojis.includes(item.emoji),
    )
  );
}

export async function steerRun(runId: string, instruction: string): Promise<void> {
  await request(`/api/v1/runs/${encodeURIComponent(runId)}/steer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction }),
  });
}

export async function getRunOutput(runId: string, signal?: AbortSignal): Promise<RunOutput | null> {
  const result = await request<{ output: RunOutput | null }>(
    `/api/v1/runs/${encodeURIComponent(runId)}/output`,
    signal ? { signal } : undefined,
  );
  return result.output;
}

export function subscribeToUnauthorized(handler: () => void): () => void {
  window.addEventListener("openbot:unauthorized", handler);
  return () => window.removeEventListener("openbot:unauthorized", handler);
}

export async function getWorkspace(signal?: AbortSignal): Promise<WorkspaceSnapshot> {
  return request<WorkspaceSnapshot>("/api/v1/workspace", signal ? { signal } : undefined);
}

export async function listNodeIdentities(signal?: AbortSignal): Promise<NodeIdentitySummary[]> {
  const result = await request<{ identities: NodeIdentitySummary[] }>(
    "/api/v1/node-identities",
    signal ? { signal } : undefined,
  );
  return result.identities;
}

export async function createNodeEnrollmentToken(
  nodeId: string,
  expiresInSeconds = 600,
): Promise<NodeEnrollmentToken> {
  return request<NodeEnrollmentToken>("/api/v1/nodes/enrollment-tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId, expiresInSeconds }),
  });
}

export async function revokeNodeIdentity(nodeId: string): Promise<void> {
  await request<void>(`/api/v1/nodes/${encodeURIComponent(nodeId)}/revoke`, {
    method: "POST",
  });
}

export async function getEmployeeProfile(
  botId: string,
  signal?: AbortSignal,
): Promise<EmployeeProfile> {
  const result = await request<{ profile: EmployeeProfile }>(
    `/api/v1/bots/${botId}/profile`,
    signal ? { signal } : undefined,
  );
  return result.profile;
}

export async function updateEmployeeProfileDetails(
  botId: string,
  input: UpdateEmployeeProfileDetailsInput,
): Promise<EmployeeProfileDetailsMutationResult> {
  return request<EmployeeProfileDetailsMutationResult>(
    `/api/v1/bots/${encodeURIComponent(botId)}/profile`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function createEmployeeMemory(
  botId: string,
  input: CreateEmployeeMemoryInput,
): Promise<EmployeeMemoryMutationResult> {
  return request<EmployeeMemoryMutationResult>(
    `/api/v1/bots/${encodeURIComponent(botId)}/memories`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function updateEmployeeMemory(
  botId: string,
  memoryId: string,
  input: UpdateEmployeeMemoryInput,
): Promise<EmployeeMemoryMutationResult> {
  return request<EmployeeMemoryMutationResult>(
    `/api/v1/bots/${encodeURIComponent(botId)}/memories/${encodeURIComponent(memoryId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function deleteEmployeeMemory(
  botId: string,
  memoryId: string,
  input: DeleteEmployeeMemoryInput,
): Promise<EmployeeMemoryDeletionResult> {
  return request<EmployeeMemoryDeletionResult>(
    `/api/v1/bots/${encodeURIComponent(botId)}/memories/${encodeURIComponent(memoryId)}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function importEmployeeSkill(
  botId: string,
  input: { markdown: string; version: string; reason: string },
): Promise<EmployeeSkillMutationResult> {
  return request<EmployeeSkillMutationResult>(
    `/api/v1/bots/${encodeURIComponent(botId)}/skills/import`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function updateEmployeeSkillState(
  botId: string,
  skillId: string,
  input: UpdateEmployeeSkillStateInput,
): Promise<EmployeeSkillMutationResult> {
  return request<EmployeeSkillMutationResult>(
    `/api/v1/bots/${encodeURIComponent(botId)}/skills/${encodeURIComponent(skillId)}/state`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function getEmployeeExportPreview(
  botId: string,
  signal?: AbortSignal,
  includeSkillContent = false,
): Promise<EmployeeExportPreview> {
  const result = await request<{ preview: EmployeeExportPreview }>(
    `/api/v1/bots/${botId}/export/preview${includeSkillContent ? "?includeSkillContent=true" : ""}`,
    signal ? { signal } : undefined,
  );
  return result.preview;
}

export async function fetchEmployeeTemplate(
  botId: string,
  preview: EmployeeExportPreview,
): Promise<Blob> {
  const parameters = new URLSearchParams({
    packageId: preview.packageId,
    generatedAt: preview.generatedAt,
  });
  if (preview.format === "openbot.employee/v2") parameters.set("includeSkillContent", "true");
  const url = `/api/v1/bots/${encodeURIComponent(botId)}/export?${parameters.toString()}`;
  const response = await fetch(url, {
    credentials: "include",
    headers: { "If-Match": `"${preview.downloadReviewToken}"` },
  });
  if (!response.ok) throw await readApiError(response, url);

  const expectedTag = `"${preview.downloadReviewToken}"`;
  if (response.headers.get("etag") !== expectedTag) {
    throw new ApiError("下载响应未匹配已审核的员工模板，请刷新预览后重试。", 0);
  }
  const blob = await response.blob();
  if ((await browserSha256Hex(await blob.arrayBuffer())) !== preview.downloadReviewToken) {
    throw new ApiError("下载的员工模板未通过完整性检查，请刷新预览后重试。", 0);
  }

  return blob;
}

async function browserSha256Hex(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new ApiError("当前浏览器无法安全校验员工模板，请通过 HTTPS 或本机地址使用 OpenBot。", 0);
  }
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function previewEmployeeImport(
  file: File,
  signal?: AbortSignal,
): Promise<EmployeeImportPreview> {
  if (file.size > 2 * 1024 * 1024) {
    throw new ApiError("员工模板不能超过 2 MiB。", 422);
  }
  const result = await request<{ preview: EmployeeImportPreview }>(
    "/api/v1/employees/import/preview",
    {
      method: "POST",
      headers: { "Content-Type": "application/vnd.openbot.employee+json" },
      body: file,
      ...(signal ? { signal } : {}),
    },
  );
  return result.preview;
}

export async function activateEmployeeImport(
  file: File,
  preview: EmployeeImportPreview,
  input: {
    employeeName: string;
    allowUnsigned: boolean;
    idempotencyKey: string;
  },
): Promise<EmployeeImportActivationResult> {
  if (file.size > 2 * 1024 * 1024) {
    throw new ApiError("员工模板不能超过 2 MiB。", 422);
  }
  let employeePackage: unknown;
  try {
    employeePackage = JSON.parse(await file.text());
  } catch {
    throw new ApiError("员工模板必须是有效的 JSON 文件。", 422);
  }
  return request<EmployeeImportActivationResult>("/api/v1/employees/import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      package: employeePackage,
      expectedPackageId: preview.packageId,
      expectedDigest: preview.integrity.digest,
      ownerReviewed: true,
      allowUnsigned: input.allowUnsigned,
      idempotencyKey: input.idempotencyKey,
      employeeName: input.employeeName,
    }),
  });
}

export async function decideApproval(
  approvalId: string,
  decision: ApprovalDecision,
): Promise<ApprovalResolution> {
  return request<ApprovalResolution>(`/api/v1/approvals/${approvalId}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
}

export async function createBot(input: CreateBotInput): Promise<Bot> {
  const result = await request<{ bot: Bot }>("/api/v1/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return result.bot;
}

export async function openBotConversation(botId: string): Promise<Channel> {
  const result = await request<{ channel: Channel }>(
    `/api/v1/bots/${encodeURIComponent(botId)}/conversation`,
    { method: "POST" },
  );
  return result.channel;
}

export async function createChannel(input: CreateChannelInput): Promise<Channel> {
  const result = await request<{ channel: Channel }>("/api/v1/channels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return result.channel;
}

export async function joinBotToChannel(channelId: string, botId: string): Promise<Channel> {
  const result = await request<{ channel: Channel }>(`/api/v1/channels/${channelId}/bots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ botId }),
  });
  return result.channel;
}

export async function listMessages(channelId: string, signal?: AbortSignal): Promise<Message[]> {
  const result = await request<{ messages: Message[] }>(
    `/api/v1/channels/${channelId}/messages`,
    signal ? { signal } : undefined,
  );
  return result.messages;
}

export async function listRuns(channelId: string, signal?: AbortSignal): Promise<Run[]> {
  const result = await request<{ runs: Run[] }>(
    `/api/v1/channels/${channelId}/runs`,
    signal ? { signal } : undefined,
  );
  return result.runs;
}

export async function createMessage(
  channelId: string,
  input: CreateMessageInput,
): Promise<SubmitTaskResult> {
  return request<SubmitTaskResult>(`/api/v1/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export type RealtimeConnectionState = "connecting" | "live" | "retrying";

export function subscribeToChannelEvents(
  channelId: string,
  handlers: {
    onMessage(message: Message): void;
    onFrame(frame: RunFrame): void;
    onProgress(progress: RunProgress): void;
    onOutput?(output: RunOutput): void;
    onReactions?(messageId: string, reactions: MessageReaction[]): void;
    onChannel?(channel: Channel): void;
    onRun(run: Run, artifacts: Artifact[]): void;
    onReady(): void;
    onState(state: RealtimeConnectionState): void;
  },
): () => void {
  const reconnectDelayMs = 2000;
  const staleAfterMs = 35_000;
  let source: EventSource | undefined;
  let reconnectTimer: number | undefined;
  let closed = false;
  let lastActivityAt = Date.now();

  const markLive = () => {
    lastActivityAt = Date.now();
    handlers.onState("live");
  };
  const onReady = () => {
    markLive();
    handlers.onReady();
  };
  const onMessage = (event: Event) => {
    const payload = parseEventPayload(event);
    if (!isMessageCreatedEvent(payload, channelId)) return;
    markLive();
    handlers.onMessage(payload.message);
  };
  const onRun = (event: Event) => {
    const payload = parseEventPayload(event);
    if (!isRunProjectionEvent(payload, channelId)) return;
    markLive();
    handlers.onRun(payload.run, payload.type === "run.updated" ? (payload.artifacts ?? []) : []);
  };
  const onProgress = (event: Event) => {
    const payload = parseEventPayload(event);
    if (!isRunProgressProjectionEvent(payload, channelId)) return;
    markLive();
    handlers.onProgress(payload.progress);
  };
  const onFrame = (event: Event) => {
    const payload = parseEventPayload(event);
    if (!isRunFrameProjectionEvent(payload, channelId)) return;
    markLive();
    handlers.onFrame(payload.frame);
  };
  const onOutput = (event: Event) => {
    const payload = parseEventPayload(event);
    if (!isRunOutputProjection(payload, channelId)) return;
    markLive();
    handlers.onOutput?.(payload);
  };
  const onReactions = (event: Event) => {
    const value = parseEventPayload(event) as Record<string, unknown> | null;
    if (
      !value ||
      value.type !== "message.reactions" ||
      value.channelId !== channelId ||
      typeof value.messageId !== "string" ||
      !isMessageReactions(value.reactions) ||
      value.reactions.some((item) => item.messageId !== value.messageId)
    )
      return;
    markLive();
    handlers.onReactions?.(value.messageId, value.reactions);
  };
  const onChannel = (event: Event) => {
    const value = parseEventPayload(event) as {
      type?: string;
      channelId?: string;
      channel?: Channel;
    } | null;
    if (
      !value ||
      value.type !== "channel.updated" ||
      value.channelId !== channelId ||
      value.channel?.id !== channelId ||
      !Array.isArray(value.channel.botIds) ||
      value.channel.botIds.length > 100 ||
      !value.channel.botIds.every((id) => typeof id === "string")
    )
      return;
    markLive();
    handlers.onChannel?.(value.channel);
  };
  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== undefined) return;
    source?.close();
    source = undefined;
    handlers.onState("retrying");
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, reconnectDelayMs);
  };
  const connect = () => {
    if (closed) return;
    const nextSource = new EventSource(`/api/v1/channels/${channelId}/events`);
    source = nextSource;
    lastActivityAt = Date.now();
    nextSource.onopen = markLive;
    nextSource.onerror = () => {
      if (source === nextSource) scheduleReconnect();
    };
    nextSource.addEventListener("channel.ready", onReady);
    nextSource.addEventListener("heartbeat", markLive);
    nextSource.addEventListener("message.created", onMessage);
    nextSource.addEventListener("run.created", onRun);
    nextSource.addEventListener("run.updated", onRun);
    nextSource.addEventListener("run.progress", onProgress);
    nextSource.addEventListener("run.frame", onFrame);
    nextSource.addEventListener("run.output", onOutput);
    nextSource.addEventListener("message.reactions", onReactions);
    nextSource.addEventListener("channel.updated", onChannel);
  };

  handlers.onState("connecting");
  connect();
  const watchdog = window.setInterval(() => {
    if (Date.now() - lastActivityAt > staleAfterMs) scheduleReconnect();
  }, 5000);

  return () => {
    closed = true;
    source?.close();
    window.clearInterval(watchdog);
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  };
}

export function isRunOutputProjection(value: unknown, channelId: string): value is RunOutput {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    item.channelId === channelId &&
    typeof item.runId === "string" &&
    typeof item.botId === "string" &&
    typeof item.sequence === "number" &&
    Number.isSafeInteger(item.sequence) &&
    item.sequence >= 0 &&
    typeof item.text === "string" &&
    item.text.length <= 8000 &&
    typeof item.reset === "boolean" &&
    (!item.reset || item.text === "")
  );
}

export function subscribeToWorkspaceEvents(handlers: {
  onApproval(approval: Approval, run: Run): void;
  onEmployeeProfileChanged(botId: string, sections: EmployeeProfileSection[]): void;
  onNode(node: ExecutionNode): void;
  onNodeRemoved(nodeId: string): void;
  onReady(nodes: ExecutionNode[]): void;
  onRun(run: Run, artifacts: Artifact[]): void;
  onState(state: RealtimeConnectionState): void;
}): () => void {
  const reconnectDelayMs = 2000;
  const staleAfterMs = 35_000;
  let source: EventSource | undefined;
  let reconnectTimer: number | undefined;
  let closed = false;
  let lastActivityAt = Date.now();

  const markLive = () => {
    lastActivityAt = Date.now();
    handlers.onState("live");
  };
  const onReady = (event: Event) => {
    const payload = parseEventPayload(event);
    if (!isWorkspaceReadyEvent(payload)) return;
    markLive();
    handlers.onReady(payload.nodes);
  };
  const onNode = (event: Event) => {
    const payload = parseEventPayload(event);
    if (!isNodeUpsertedEvent(payload)) return;
    markLive();
    handlers.onNode(payload.node);
  };
  const onNodeRemoved = (event: Event) => {
    const payload = parseEventPayload(event);
    if (!isNodeRemovedEvent(payload)) return;
    markLive();
    handlers.onNodeRemoved(payload.nodeId);
  };
  const onApproval = (event: Event) => {
    const payload = parseEventPayload(event);
    if (!isApprovalUpdatedEvent(payload)) return;
    markLive();
    handlers.onApproval(payload.approval, payload.run);
  };
  const onEmployeeProfileChanged = (event: Event) => {
    const payload = parseEventPayload(event);
    if (!isEmployeeProfileChangedEvent(payload)) return;
    markLive();
    handlers.onEmployeeProfileChanged(payload.botId, payload.sections);
  };
  const onRun = (event: Event) => {
    const payload = parseEventPayload(event);
    if (!isWorkspaceRunUpdatedEvent(payload)) return;
    markLive();
    handlers.onRun(payload.run, payload.artifacts ?? []);
  };
  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== undefined) return;
    source?.close();
    source = undefined;
    handlers.onState("retrying");
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, reconnectDelayMs);
  };
  const connect = () => {
    if (closed) return;
    const nextSource = new EventSource("/api/v1/workspace/events");
    source = nextSource;
    lastActivityAt = Date.now();
    nextSource.onopen = markLive;
    nextSource.onerror = () => {
      if (source === nextSource) scheduleReconnect();
    };
    nextSource.addEventListener("workspace.ready", onReady);
    nextSource.addEventListener("heartbeat", markLive);
    nextSource.addEventListener("node.upserted", onNode);
    nextSource.addEventListener("node.removed", onNodeRemoved);
    nextSource.addEventListener("approval.updated", onApproval);
    nextSource.addEventListener("employee.profile.changed", onEmployeeProfileChanged);
    nextSource.addEventListener("run.updated", onRun);
  };

  handlers.onState("connecting");
  connect();
  const watchdog = window.setInterval(() => {
    if (Date.now() - lastActivityAt > staleAfterMs) scheduleReconnect();
  }, 5000);

  return () => {
    closed = true;
    source?.close();
    window.clearInterval(watchdog);
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init });
  if (!response.ok) throw await readApiError(response, url);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function readApiError(response: Response, url: string): Promise<ApiError> {
  const payload = (await response.json().catch(() => ({}))) as ErrorPayload;
  if (response.status === 401 && url !== "/api/v1/auth/login") {
    window.dispatchEvent(new Event("openbot:unauthorized"));
  }
  return new ApiError(
    payload.error ?? `OpenBot Server returned ${response.status}.`,
    response.status,
    payload.fields,
  );
}

function isRunProjectionEvent(
  value: unknown,
  channelId: string,
): value is Extract<ChannelRealtimeEvent, { type: "run.created" | "run.updated" }> {
  if (typeof value !== "object" || value === null) return false;
  if (!("type" in value) || (value.type !== "run.created" && value.type !== "run.updated")) {
    return false;
  }
  if (!("channelId" in value) || value.channelId !== channelId) return false;
  if (!("run" in value) || typeof value.run !== "object" || value.run === null) return false;
  if (
    "artifacts" in value &&
    (!Array.isArray(value.artifacts) || !value.artifacts.every(isArtifactProjection))
  ) {
    return false;
  }
  return (
    "id" in value.run &&
    typeof value.run.id === "string" &&
    "channelId" in value.run &&
    value.run.channelId === channelId &&
    "botId" in value.run &&
    typeof value.run.botId === "string" &&
    "title" in value.run &&
    typeof value.run.title === "string" &&
    "instruction" in value.run &&
    typeof value.run.instruction === "string" &&
    "status" in value.run &&
    typeof value.run.status === "string" &&
    "createdAt" in value.run &&
    typeof value.run.createdAt === "string" &&
    "updatedAt" in value.run &&
    typeof value.run.updatedAt === "string"
  );
}

function isRunProgressProjectionEvent(
  value: unknown,
  channelId: string,
): value is Extract<ChannelRealtimeEvent, { type: "run.progress" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "run.progress" &&
    "channelId" in value &&
    value.channelId === channelId &&
    "progress" in value &&
    isRunProgressProjection(value.progress, channelId)
  );
}

function isRunFrameProjectionEvent(
  value: unknown,
  channelId: string,
): value is Extract<ChannelRealtimeEvent, { type: "run.frame" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "run.frame" &&
    "channelId" in value &&
    value.channelId === channelId &&
    "frame" in value &&
    isRunFrameProjection(value.frame, channelId)
  );
}

function isRunFrameProjection(value: unknown, channelId: string): value is RunFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    "runId" in value &&
    typeof value.runId === "string" &&
    "channelId" in value &&
    value.channelId === channelId &&
    "nodeId" in value &&
    typeof value.nodeId === "string" &&
    "revision" in value &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0 &&
    "mediaType" in value &&
    value.mediaType === "image/png" &&
    "sizeBytes" in value &&
    typeof value.sizeBytes === "number" &&
    "capturedAt" in value &&
    typeof value.capturedAt === "string"
  );
}

function isArtifactProjection(value: unknown): value is Artifact {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "runId" in value &&
    typeof value.runId === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "mediaType" in value &&
    typeof value.mediaType === "string" &&
    "sha256" in value &&
    typeof value.sha256 === "string" &&
    "sizeBytes" in value &&
    typeof value.sizeBytes === "number" &&
    "createdAt" in value &&
    typeof value.createdAt === "string"
  );
}

export function isRunProgressProjection(value: unknown, channelId: string): value is RunProgress {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "runId" in value &&
    typeof value.runId === "string" &&
    "channelId" in value &&
    value.channelId === channelId &&
    (!("nodeId" in value) || typeof value.nodeId === "string") &&
    "stage" in value &&
    typeof value.stage === "string" &&
    "message" in value &&
    typeof value.message === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "string"
  );
}

function parseEventPayload(event: Event): unknown {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") return undefined;
  try {
    return JSON.parse(event.data);
  } catch {
    // One malformed event must not tear down an otherwise healthy realtime stream.
    return undefined;
  }
}

function isWorkspaceReadyEvent(
  value: unknown,
): value is Extract<WorkspaceRealtimeEvent, { type: "workspace.ready" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "workspace.ready" &&
    "nodes" in value &&
    Array.isArray(value.nodes) &&
    value.nodes.every(isExecutionNodeProjection)
  );
}

function isNodeUpsertedEvent(
  value: unknown,
): value is Extract<WorkspaceRealtimeEvent, { type: "node.upserted" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "node.upserted" &&
    "node" in value &&
    isExecutionNodeProjection(value.node)
  );
}

function isNodeRemovedEvent(
  value: unknown,
): value is Extract<WorkspaceRealtimeEvent, { type: "node.removed" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "node.removed" &&
    "nodeId" in value &&
    typeof value.nodeId === "string"
  );
}

function isApprovalUpdatedEvent(
  value: unknown,
): value is Extract<WorkspaceRealtimeEvent, { type: "approval.updated" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "approval.updated" &&
    "approval" in value &&
    isApprovalProjection(value.approval) &&
    "run" in value &&
    isRunProjection(value.run)
  );
}

function isWorkspaceRunUpdatedEvent(
  value: unknown,
): value is Extract<WorkspaceRealtimeEvent, { type: "run.updated" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "run.updated" &&
    "run" in value &&
    isRunProjection(value.run) &&
    (!("artifacts" in value) ||
      value.artifacts === undefined ||
      (Array.isArray(value.artifacts) && value.artifacts.every(isArtifactProjection)))
  );
}

const employeeProfileSections = new Set<EmployeeProfileSection>([
  "identity",
  "evolution",
  "skills",
  "memory",
  "records",
  "configuration",
  "portability",
]);

export function isEmployeeProfileChangedEvent(
  value: unknown,
): value is Extract<WorkspaceRealtimeEvent, { type: "employee.profile.changed" }> {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    !keys.every((key) => ["type", "botId", "sections", "occurredAt"].includes(key))
  ) {
    return false;
  }
  if (
    !("type" in value) ||
    value.type !== "employee.profile.changed" ||
    !("botId" in value) ||
    typeof value.botId !== "string" ||
    !("sections" in value) ||
    !Array.isArray(value.sections) ||
    value.sections.length === 0 ||
    value.sections.length > employeeProfileSections.size ||
    !value.sections.every(
      (section): section is EmployeeProfileSection =>
        typeof section === "string" &&
        employeeProfileSections.has(section as EmployeeProfileSection),
    ) ||
    new Set(value.sections).size !== value.sections.length ||
    !("occurredAt" in value) ||
    typeof value.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(value.occurredAt))
  ) {
    return false;
  }
  return true;
}

function isApprovalProjection(value: unknown): value is Approval {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "runId" in value &&
    typeof value.runId === "string" &&
    "nodeId" in value &&
    typeof value.nodeId === "string" &&
    "status" in value &&
    typeof value.status === "string" &&
    "summary" in value &&
    typeof value.summary === "string" &&
    "expiresAt" in value &&
    typeof value.expiresAt === "string"
  );
}

function isRunProjection(value: unknown): value is Run {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "channelId" in value &&
    typeof value.channelId === "string" &&
    "botId" in value &&
    typeof value.botId === "string" &&
    "status" in value &&
    typeof value.status === "string" &&
    "updatedAt" in value &&
    typeof value.updatedAt === "string"
  );
}

function isExecutionNodeProjection(value: unknown): value is ExecutionNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "platform" in value &&
    ["linux", "windows", "macos", "android", "ios", "freebsd", "unknown"].includes(
      String(value.platform),
    ) &&
    "osVersion" in value &&
    typeof value.osVersion === "string" &&
    "architecture" in value &&
    ["x64", "arm64", "armv7", "riscv64", "unknown"].includes(String(value.architecture)) &&
    "deviceClass" in value &&
    ["server", "desktop", "mobile", "vm", "container", "edge", "unknown"].includes(
      String(value.deviceClass),
    ) &&
    "isolation" in value &&
    ["dedicated-host", "user-session", "vm", "container", "managed-device", "unknown"].includes(
      String(value.isolation),
    ) &&
    "trustTier" in value &&
    ["development", "dedicated", "managed"].includes(String(value.trustTier)) &&
    "capabilities" in value &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((item) => typeof item === "string") &&
    "capabilityManifest" in value &&
    Array.isArray(value.capabilityManifest) &&
    value.capabilityManifest.every(isCapabilityDescriptorProjection) &&
    "activeRunIds" in value &&
    Array.isArray(value.activeRunIds) &&
    value.activeRunIds.every((item) => typeof item === "string") &&
    "maxConcurrentRuns" in value &&
    typeof value.maxConcurrentRuns === "number" &&
    "connectedAt" in value &&
    typeof value.connectedAt === "string" &&
    "lastSeenAt" in value &&
    typeof value.lastSeenAt === "string"
  );
}

function isCapabilityDescriptorProjection(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "version" in value &&
    typeof value.version === "number" &&
    Number.isInteger(value.version) &&
    value.version >= 1 &&
    "providerId" in value &&
    typeof value.providerId === "string" &&
    "constraints" in value &&
    typeof value.constraints === "object" &&
    value.constraints !== null &&
    !Array.isArray(value.constraints)
  );
}

function isMessageCreatedEvent(
  value: unknown,
  channelId: string,
): value is Extract<ChannelRealtimeEvent, { type: "message.created" }> {
  if (typeof value !== "object" || value === null) return false;
  if (!("type" in value) || value.type !== "message.created") return false;
  if (!("channelId" in value) || value.channelId !== channelId) return false;
  if (!("message" in value) || typeof value.message !== "object" || value.message === null) {
    return false;
  }
  return (
    "id" in value.message &&
    typeof value.message.id === "string" &&
    "channelId" in value.message &&
    value.message.channelId === channelId &&
    "content" in value.message &&
    typeof value.message.content === "string" &&
    "createdAt" in value.message &&
    typeof value.message.createdAt === "string"
  );
}

export type ModelSettingsSummary =
  | { status: "unavailable" }
  | { status: "unconfigured"; revision: null }
  | {
      status: "configured";
      provider: ModelProviderId;
      baseUrl?: string;
      verification?: "metadata" | "not_checked";
      model: string;
      revision: string;
      agentEnabled?: boolean;
    };
export function getModelSettings(): Promise<ModelSettingsSummary> {
  return request<ModelSettingsSummary>("/api/v1/settings/model");
}
export function saveModelSettings(input: {
  agentEnabled: boolean;
  provider: ModelProviderId;
  baseUrl?: string;
  model: string;
  apiKey: string;
  revision: string | null;
}): Promise<ModelSettingsSummary> {
  return request<ModelSettingsSummary>("/api/v1/settings/model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function getKnowledgeProposals(botId: string): Promise<KnowledgeProposal[]> {
  const result = await request<{ proposals: KnowledgeProposal[] }>(
    `/api/v1/bots/${encodeURIComponent(botId)}/knowledge-proposals`,
  );
  return result.proposals;
}
export async function reviewKnowledgeProposal(
  botId: string,
  proposalId: string,
  input: ReviewKnowledgeProposalInput,
): Promise<{ proposalId: string; decision: string; memoryId: string | null }> {
  return request(
    `/api/v1/bots/${encodeURIComponent(botId)}/knowledge-proposals/${encodeURIComponent(proposalId)}/review`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export function discoverModelSettings(
  input: { provider: ModelProviderId; baseUrl: string; apiKey: string },
  signal?: AbortSignal,
): Promise<{ models: string[] }> {
  return request("/api/v1/settings/model/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
}
