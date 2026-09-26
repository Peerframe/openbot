import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { NodeEnv } from "@openbot/config";
import { createLogger, diagnosticFields, type OpenBotLogger } from "@openbot/logging";
import {
  approvalRequestSchema,
  firstCapabilityRequirementMismatch,
  type NodeCapability,
  type NodeCapabilityDescriptor,
  type NodeMessage,
  nodeEnrollmentResultSchema,
  protocolVersion,
  type RunFailureCode,
  type RunOffer,
  runFailureMessages,
  runFrameSchema,
  serverMessageSchema,
} from "@openbot/protocol";
import {
  type ApprovalOutcome,
  assertProviderDeclarations,
  type ComputerProvider,
  type PreparedAction,
} from "@openbot/provider-sdk";
import WebSocket from "ws";
import { BrowserCommandHost } from "./browser-host.js";
import { CommandRelay, type CommandRelayInstallation } from "./command-relay.js";
import { createNodeCredentialStore, type NodeCredentialStore } from "./credential-store.js";
import { detectWorkerHost } from "./host.js";
import {
  availableCapabilities,
  availableCapabilityManifest,
  configuredProviders,
  providerForProfile,
} from "./providers.js";

const heartbeatIntervalMs = 10_000;
const reconnectDelayMs = 2_000;
const maxServerMessageBytes = 1024 * 1024;

class NodeEnrollmentRequiredError extends Error {
  constructor() {
    super(
      "Node is not enrolled. Start the Server, run npm run node:enrollment-token -- <node-id>, " +
        "set OPENBOT_NODE_ENROLLMENT_TOKEN once in .env, then restart the Node. See CONTRIBUTING.md.",
    );
  }
}

export class OpenBotNodeClient {
  readonly #env: NodeEnv;
  readonly #providers: ComputerProvider[];
  readonly #credentialStore: NodeCredentialStore;
  readonly #logger: OpenBotLogger;
  readonly #browser: BrowserCommandHost;
  readonly #commandInstallation: CommandRelayInstallation | undefined;
  #commandRelay?: CommandRelay;
  readonly #browserTasks = new Set<Promise<void>>();
  #credential?: string;
  #socket?: WebSocket;
  #heartbeat?: NodeJS.Timeout;
  #reconnect?: NodeJS.Timeout;
  readonly #assignedRunIds = new Set<string>();
  readonly #acceptedOffers = new Map<string, RunOffer>();
  readonly #executions = new Map<string, AbortController>();
  readonly #executionTasks = new Map<string, Promise<void>>();
  readonly #approvalWaiters = new Map<
    string,
    {
      runId: string;
      resolve(outcome: ApprovalOutcome): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  #stopped = false;
  #identityController?: AbortController;
  #startPromise?: Promise<void>;
  #stopPromise?: Promise<void>;

  constructor(
    env: NodeEnv,
    providers = configuredProviders(env),
    credentialStore: NodeCredentialStore = createNodeCredentialStore(env),
    logger: OpenBotLogger = createLogger({ level: env.OPENBOT_LOG_LEVEL }),
    commandInstallation?: CommandRelayInstallation,
  ) {
    this.#env = env;
    if (commandInstallation && commandInstallation.selection.nodeId !== env.OPENBOT_NODE_ID)
      throw new Error("Command enforcer selection belongs to a different Node.");
    this.#commandInstallation = commandInstallation;
    assertProviderDeclarations(providers);
    this.#providers = providers;
    this.#browser = new BrowserCommandHost(env.OPENBOT_NODE_ID, providers);
    this.#credentialStore = credentialStore;
    this.#logger = logger;
  }

  start(): Promise<void> {
    if (this.#startPromise !== undefined) return this.#startPromise;
    this.#stopped = false;
    this.#identityController = new AbortController();
    this.#startPromise = this.#prepareIdentity(this.#identityController.signal)
      .then((credential) => {
        if (this.#stopped) return;
        this.#credential = credential;
        this.#connect();
      })
      .catch((error: unknown) => {
        if (this.#stopped) return;
        const message =
          error instanceof NodeEnrollmentRequiredError
            ? error.message
            : "Node identity setup failed.";
        this.#logger.error("node.identity_setup_failed", message, {
          nodeId: this.#env.OPENBOT_NODE_ID,
          phase: "identity",
          ...(error instanceof NodeEnrollmentRequiredError
            ? { code: "node_enrollment_required" }
            : {}),
          ...diagnosticFields(error),
        });
        throw new Error(message, { cause: error });
      });
    return this.#startPromise;
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#stopPromise = this.#stopOnce();
    return this.#stopPromise;
  }

  async #stopOnce(): Promise<void> {
    this.#stopped = true;
    this.#commandRelay?.close();
    this.#identityController?.abort();
    clearInterval(this.#heartbeat);
    clearTimeout(this.#reconnect);
    this.#abortExecutions();
    this.#assignedRunIds.clear();
    this.#acceptedOffers.clear();
    const executions = [...this.#executionTasks.values(), ...this.#browserTasks];
    const startup = this.#startPromise?.catch(() => undefined) ?? Promise.resolve();
    await Promise.all([startup, this.#closeSocket(), ...executions]);
  }

  #connect(): void {
    const credential = this.#credential;
    if (credential === undefined) throw new Error("Node credential is unavailable.");
    const socket = new WebSocket(this.#env.OPENBOT_NODE_SERVER_URL, {
      // Server commands are small structured messages. Reject an unexpectedly large control frame.
      maxPayload: maxServerMessageBytes,
      // ws enables client compression by default; control messages do not justify its memory cost.
      perMessageDeflate: false,
    });
    this.#socket = socket;
    let authenticated = false;
    let authenticationRejected = false;
    const commandSession = new AbortController();
    let commandRelay: CommandRelay | undefined;

    socket.on("open", () => {
      const host = detectWorkerHost();
      const hello: NodeMessage = {
        type: "node.hello",
        protocolVersion,
        nodeId: this.#env.OPENBOT_NODE_ID,
        name: hostname(),
        ...host,
        capabilities: availableCapabilities(this.#providers),
        capabilityManifest: availableCapabilityManifest(this.#providers),
        maxConcurrentRuns: this.#env.OPENBOT_NODE_MAX_CONCURRENT_RUNS,
        credential,
        ...(this.#commandInstallation
          ? { commandChannel: { protocolVersion: "0.10.0" as const } }
          : {}),
        sentAt: new Date().toISOString(),
      };
      socket.send(JSON.stringify(hello));
    });

    socket.on("message", (raw, isBinary) => {
      const value = parseJson(raw.toString());
      if (
        value !== null &&
        typeof value === "object" &&
        "type" in value &&
        typeof value.type === "string" &&
        value.type.startsWith("work.command.")
      ) {
        if (!authenticated || !commandRelay || this.#socket !== socket) return;
        if (isBinary) {
          commandRelay.close("invalid_frame");
          return;
        }
        const input = Array.isArray(raw)
          ? Buffer.concat(raw)
          : raw instanceof ArrayBuffer
            ? new Uint8Array(raw)
            : raw;
        // The relay snapshots these bytes and never sends a result through a replacement socket.
        void commandRelay.receiveServer(input).catch(() => undefined);
        return;
      }
      const parsed = serverMessageSchema.safeParse(value);
      if (!parsed.success) {
        if (value !== null && typeof value === "object" && "commandChannel" in value) {
          authenticationRejected = true;
          commandSession.abort();
          socket.close(1008, "invalid-command-negotiation");
        }
        this.#logger.error("node.protocol_invalid", "Invalid Server protocol message.", {
          nodeId: this.#env.OPENBOT_NODE_ID,
          phase: "receive",
        });
        return;
      }

      const message = parsed.data;
      if (message.type === "server.ack") {
        if (!message.accepted) {
          if (!authenticated) authenticationRejected = true;
          this.#logger.error("node.message_rejected", "Server rejected the Node message.", {
            nodeId: this.#env.OPENBOT_NODE_ID,
            phase: authenticated ? "protocol" : "authentication",
          });
          return;
        }
        if (
          (authenticated && message.commandChannel !== undefined) ||
          (!authenticated && Boolean(this.#commandInstallation) !== Boolean(message.commandChannel))
        ) {
          authenticationRejected = true;
          commandSession.abort();
          socket.close(1008, "command-negotiation-required");
          return;
        }
        if (!authenticated) {
          authenticated = true;
          if (this.#commandInstallation && message.commandChannel) {
            commandRelay = new CommandRelay(
              this.#commandInstallation,
              socket,
              () => this.#socket === socket && authenticated && !this.#stopped,
              commandSession.signal,
              message.commandChannel.connectionId,
              (code) =>
                this.#logger.warn(
                  "node.command_relay_closed",
                  "Command relay closed; no uncertain request is retried.",
                  { nodeId: this.#env.OPENBOT_NODE_ID, code },
                ),
            );
            this.#commandRelay = commandRelay;
          }
          this.#heartbeat = setInterval(() => {
            if (socket.readyState !== WebSocket.OPEN) return;
            const heartbeat: NodeMessage = {
              type: "node.heartbeat",
              protocolVersion,
              nodeId: this.#env.OPENBOT_NODE_ID,
              activeRunIds: Array.from(this.#assignedRunIds),
              sentAt: new Date().toISOString(),
            };
            socket.send(JSON.stringify(heartbeat));
          }, heartbeatIntervalMs);
        }
        return;
      }

      if (message.type === "browser.command") {
        if (!authenticated || message.nodeId !== this.#env.OPENBOT_NODE_ID) return;
        const task = this.#browser.execute(message).then((result) => {
          // A late result never travels on a replacement authenticated connection.
          if (this.#socket === socket && socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify(result));
        });
        this.#browserTasks.add(task);
        void task.finally(() => this.#browserTasks.delete(task));
        return;
      }

      if (message.type === "run.offer") {
        const capabilities = availableCapabilities(this.#providers);
        const capabilityManifest = availableCapabilityManifest(this.#providers);
        const rejection = runOfferRejectionReason(
          message,
          capabilities,
          capabilityManifest,
          this.#assignedRunIds.size,
          this.#env.OPENBOT_NODE_MAX_CONCURRENT_RUNS,
        );
        const response: NodeMessage = rejection
          ? {
              type: "run.reject",
              protocolVersion,
              nodeId: this.#env.OPENBOT_NODE_ID,
              offerId: message.offerId,
              runId: message.runId,
              reason: rejection,
              rejectedAt: new Date().toISOString(),
            }
          : {
              type: "run.accept",
              protocolVersion,
              nodeId: this.#env.OPENBOT_NODE_ID,
              offerId: message.offerId,
              runId: message.runId,
              acceptedAt: new Date().toISOString(),
            };
        if (rejection === undefined) this.#acceptedOffers.set(message.runId, message);
        socket.send(JSON.stringify(response));
        return;
      }

      if (message.type === "run.assigned") {
        if (
          message.nodeId === this.#env.OPENBOT_NODE_ID &&
          this.#acceptedOffers.has(message.runId)
        ) {
          this.#assignedRunIds.add(message.runId);
          this.#send({
            type: "run.start_request",
            protocolVersion,
            nodeId: this.#env.OPENBOT_NODE_ID,
            runId: message.runId,
            requestedAt: new Date().toISOString(),
          });
        }
        return;
      }

      if (message.type === "run.start") {
        if (message.nodeId === this.#env.OPENBOT_NODE_ID) this.#startExecution(message.runId);
        return;
      }

      if (message.type === "approval.resolved") {
        const waiter = this.#approvalWaiters.get(message.requestId);
        if (waiter === undefined || waiter.runId !== message.runId) return;
        clearTimeout(waiter.timer);
        this.#approvalWaiters.delete(message.requestId);
        waiter.resolve({ approvalId: message.requestId, status: message.decision });
        return;
      }

      if (message.type === "run.cancel") this.#executions.get(message.runId)?.abort();
      this.#releaseRun(message.runId);
    });

    socket.on("close", () => {
      commandSession.abort();
      commandRelay?.close();
      clearInterval(this.#heartbeat);
      this.#abortExecutions();
      this.#assignedRunIds.clear();
      this.#acceptedOffers.clear();
      if (!this.#stopped && !authenticationRejected) {
        this.#reconnect = setTimeout(() => this.#connect(), reconnectDelayMs);
      }
    });

    socket.on("error", (error) => {
      this.#logger.warn("node.connection_failed", "Node connection failed.", {
        nodeId: this.#env.OPENBOT_NODE_ID,
        phase: "connect",
        ...diagnosticFields(error),
      });
    });
  }

  async #prepareIdentity(signal: AbortSignal): Promise<string> {
    if (this.#env.OPENBOT_NODE_CREDENTIAL !== undefined) {
      // Programmatic clients must obey the same identity-source boundary as the CLI schema.
      if (
        this.#env.OPENBOT_NODE_ALLOW_ENV_CREDENTIAL !== true ||
        this.#env.OPENBOT_NODE_CREDENTIAL_STORE !== "file"
      ) {
        throw new Error("Environment Node credentials are not enabled for this profile.");
      }
      this.#logger.warn(
        "node.environment_credential_enabled",
        "Using an explicitly enabled environment credential. Prefer enrollment with a persistent credential store.",
        { nodeId: this.#env.OPENBOT_NODE_ID, phase: "identity" },
      );
      return this.#env.OPENBOT_NODE_CREDENTIAL;
    }
    const stored = await this.#credentialStore.load(this.#env.OPENBOT_NODE_ID);
    if (stored !== undefined) return stored.credential;

    const token = this.#env.OPENBOT_NODE_ENROLLMENT_TOKEN;
    if (token === undefined) {
      throw new NodeEnrollmentRequiredError();
    }
    const response = await fetch(nodeEnrollmentUrl(this.#env.OPENBOT_NODE_SERVER_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: this.#env.OPENBOT_NODE_ID, token }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    const body = await readBoundedResponse(response, 8 * 1024);
    if (!response.ok) throw new Error("Server rejected the one-time Node enrollment token.");
    const parsed = nodeEnrollmentResultSchema.safeParse(JSON.parse(body));
    if (!parsed.success || parsed.data.nodeId !== this.#env.OPENBOT_NODE_ID) {
      throw new Error("Server returned an invalid Node identity.");
    }
    await this.#credentialStore.save(parsed.data);
    return parsed.data.credential;
  }

  async #executeRun(runId: string): Promise<void> {
    if (this.#executions.has(runId)) return;
    const offer = this.#acceptedOffers.get(runId);
    if (offer === undefined) return;
    const provider = providerForProfile(this.#providers, offer.executionProfile);
    if (provider?.execute === undefined) {
      this.#sendFailure(runId, "provider_unavailable");
      return;
    }

    const controller = new AbortController();
    this.#executions.set(runId, controller);
    try {
      const result = await provider.execute(
        {
          nodeId: this.#env.OPENBOT_NODE_ID,
          workDirectory: this.#env.OPENBOT_NODE_WORK_DIRECTORY,
          signal: controller.signal,
        },
        {
          runId: offer.runId,
          channelId: offer.channelId,
          botId: offer.botId,
          title: offer.title,
          instruction: offer.instruction,
          executionProfile: offer.executionProfile,
        },
        (progress) => {
          this.#send({
            type: "run.progress",
            protocolVersion,
            nodeId: this.#env.OPENBOT_NODE_ID,
            runId,
            stage: progress.stage.slice(0, 80),
            message: progress.message.slice(0, 500),
            occurredAt: new Date().toISOString(),
          });
        },
        (frame) => {
          const message = runFrameSchema.safeParse({
            type: "run.frame",
            protocolVersion,
            nodeId: this.#env.OPENBOT_NODE_ID,
            runId,
            mediaType: frame.mediaType,
            base64: frame.base64,
            ...(frame.width === undefined ? {} : { width: frame.width }),
            ...(frame.height === undefined ? {} : { height: frame.height }),
            capturedAt: frame.capturedAt,
          });
          if (message.success) {
            this.#send(message.data);
          } else {
            this.#logger.warn(
              "provider.frame_rejected",
              "Provider emitted an invalid or oversized live frame; frame skipped.",
              { runId, nodeId: this.#env.OPENBOT_NODE_ID, providerId: provider.id },
            );
          }
        },
        (action) => this.#requestApproval(runId, action, controller.signal),
      );
      if (controller.signal.aborted) return;
      if (!result.ok) {
        this.#logger.warn("provider.reported_failure", "Provider reported a failed result.", {
          runId,
          nodeId: this.#env.OPENBOT_NODE_ID,
          providerId: provider.id,
        });
        this.#sendFailure(runId, "provider_execution_failed");
        return;
      }
      this.#send({
        type: "run.completed",
        protocolVersion,
        nodeId: this.#env.OPENBOT_NODE_ID,
        runId,
        summary: result.summary.slice(0, 2000),
        artifacts: result.artifacts,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        this.#logger.error("provider.execution_failed", "Provider execution failed.", {
          runId,
          nodeId: this.#env.OPENBOT_NODE_ID,
          providerId: provider.id,
          phase: "execute",
          ...diagnosticFields(error),
        });
        this.#sendFailure(runId, "provider_execution_failed");
      }
    } finally {
      this.#executions.delete(runId);
    }
  }

  #startExecution(runId: string): void {
    if (this.#executionTasks.has(runId)) return;
    const task = this.#executeRun(runId);
    this.#executionTasks.set(runId, task);
    const remove = () => {
      if (this.#executionTasks.get(runId) === task) this.#executionTasks.delete(runId);
    };
    void task.then(remove, remove);
  }

  #sendFailure(runId: string, code: RunFailureCode): void {
    this.#send({
      type: "run.failed",
      protocolVersion,
      nodeId: this.#env.OPENBOT_NODE_ID,
      runId,
      code,
      error: runFailureMessages[code],
      failedAt: new Date().toISOString(),
    });
  }

  #send(message: NodeMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(message));
    }
  }

  #requestApproval(
    runId: string,
    action: PreparedAction,
    signal: AbortSignal,
  ): Promise<ApprovalOutcome> {
    if (action.risk === "read") {
      throw new Error("Read-only actions must not request an approval lease.");
    }
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Approval request could not reach the Server.");
    }
    const requestId = randomUUID();
    const expiresInSeconds = Math.floor(
      Math.min(900, Math.max(30, action.expiresInSeconds ?? 300)),
    );
    const message = approvalRequestSchema.parse({
      type: "approval.request",
      protocolVersion,
      nodeId: this.#env.OPENBOT_NODE_ID,
      runId,
      requestId,
      action: action.action,
      target: action.target,
      summary: action.summary,
      risk: action.risk,
      beforeState: action.beforeState ?? {},
      expiresInSeconds,
      requestedAt: new Date().toISOString(),
    });

    return new Promise((resolve, reject) => {
      const finishWithError = (error: Error) => {
        const waiter = this.#approvalWaiters.get(requestId);
        if (waiter === undefined) return;
        clearTimeout(waiter.timer);
        this.#approvalWaiters.delete(requestId);
        waiter.reject(error);
      };
      const timer = setTimeout(
        () => finishWithError(new Error("Approval request expired before it was decided.")),
        expiresInSeconds * 1000,
      );
      this.#approvalWaiters.set(requestId, { runId, resolve, reject, timer });
      signal.addEventListener(
        "abort",
        () => finishWithError(new Error("Approval request was cancelled.")),
        { once: true },
      );
      this.#send(message);
    });
  }

  #releaseRun(runId: string): void {
    this.#executions.get(runId)?.abort();
    this.#executions.delete(runId);
    this.#assignedRunIds.delete(runId);
    this.#acceptedOffers.delete(runId);
  }

  #abortExecutions(): void {
    this.#browser.disconnect();
    for (const controller of this.#executions.values()) controller.abort();
    this.#executions.clear();
    for (const [requestId, waiter] of this.#approvalWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Node connection closed while approval was pending."));
      this.#approvalWaiters.delete(requestId);
    }
  }

  #closeSocket(): Promise<void> {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      socket.once("close", resolve);
      try {
        if (socket.readyState === WebSocket.OPEN) socket.close(1000, "node-shutdown");
        else if (socket.readyState === WebSocket.CONNECTING) socket.close();
      } catch {
        socket.terminate();
      }
    });
  }
}

export function runOfferRejectionReason(
  offer: RunOffer,
  available: NodeCapability[],
  availableManifest: NodeCapabilityDescriptor[],
  activeRuns: number,
  maxConcurrentRuns: number,
): string | undefined {
  if (activeRuns >= maxConcurrentRuns) return "Node is at capacity.";
  const capabilities = new Set(available);
  const missing = offer.requiredCapabilities.filter((capability) => !capabilities.has(capability));
  if (missing.length > 0) return `Missing legacy capabilities: ${missing.join(", ")}.`;
  const mismatch = firstCapabilityRequirementMismatch(
    offer.requiredCapabilityManifest,
    availableManifest,
  );
  if (mismatch === undefined) return undefined;
  if (mismatch.reason === "capability-missing") {
    return `Missing capability: ${mismatch.capability}@${mismatch.expectedVersion}.`;
  }
  return `Unsupported capability version: ${mismatch.capability}@${mismatch.expectedVersion}; advertised ${mismatch.advertisedVersions.join(", ")}.`;
}

export function nodeEnrollmentUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/api/v1/nodes/enroll";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maximumBytes) {
    throw new Error("Node enrollment response is too large.");
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("Node enrollment response is too large.");
    }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
