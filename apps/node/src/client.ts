import { hostname } from "node:os";
import type { NodeEnv } from "@openbot/config";
import { createLogger, diagnosticFields, type OpenBotLogger } from "@openbot/logging";
import {
  firstCapabilityRequirementMismatch,
  type NodeCapability,
  type NodeCapabilityDescriptor,
  type NodeMessage,
  protocolVersion,
  type RunOffer,
  serverMessageSchema,
} from "@openbot/protocol";
import { assertProviderDeclarations, type ComputerProvider } from "@openbot/provider-sdk";
import WebSocket from "ws";
import { BrowserCommandHost } from "./browser-host.js";
import { CommandRelay, type CommandRelayInstallation } from "./command-relay.js";
import { createNodeCredentialStore, type NodeCredentialStore } from "./credential-store.js";
import { detectWorkerHost } from "./host.js";
import { NodeEnrollmentRequiredError, prepareNodeIdentity } from "./node-identity.js";
import {
  availableCapabilities,
  availableCapabilityManifest,
  configuredProviders,
} from "./providers.js";
import { RunDrainRegistry, RunSession } from "./run-session.js";

export { nodeEnrollmentUrl } from "./node-identity.js";

const heartbeatIntervalMs = 10_000;
const reconnectDelayMs = 2_000;
const maxServerMessageBytes = 1024 * 1024;

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
  /** Run lifetime of the current connection only; replaced on every new socket. */
  #session?: RunSession;
  /** Cross-connection execution reservations; suppresses same-Run overlap and drives draining. */
  readonly #drains = new RunDrainRegistry();
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
    this.#startPromise = prepareNodeIdentity(
      this.#env,
      this.#credentialStore,
      this.#logger,
      this.#identityController.signal,
    )
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
    this.#browser.disconnect();
    this.#session?.dispose();
    const executions = [this.#drains.drain(), ...this.#browserTasks];
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
    const session = new RunSession({
      socket,
      nodeId: this.#env.OPENBOT_NODE_ID,
      workDirectory: this.#env.OPENBOT_NODE_WORK_DIRECTORY,
      maxConcurrentRuns: this.#env.OPENBOT_NODE_MAX_CONCURRENT_RUNS,
      providers: this.#providers,
      logger: this.#logger,
      drains: this.#drains,
      admission: runOfferRejectionReason,
    });
    this.#session = session;
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
              activeRunIds: session.activeRunIds(),
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
        session.offer(message);
        return;
      }

      if (message.type === "run.assigned") {
        session.assigned(message);
        return;
      }

      if (message.type === "run.start") {
        session.start(message);
        return;
      }

      if (message.type === "approval.resolved") {
        session.approvalResolved(message);
        return;
      }

      session.release(message.runId);
    });

    socket.on("close", () => {
      commandSession.abort();
      commandRelay?.close();
      clearInterval(this.#heartbeat);
      this.#browser.disconnect();
      session.dispose();
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

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
