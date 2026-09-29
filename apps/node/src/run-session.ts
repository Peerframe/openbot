import { randomUUID } from "node:crypto";
import { diagnosticFields, type OpenBotLogger } from "@openbot/logging";
import {
  approvalRequestSchema,
  type NodeCapability,
  type NodeCapabilityDescriptor,
  type NodeMessage,
  protocolVersion,
  type RunFailureCode,
  type RunOffer,
  runFailureMessages,
  runFrameSchema,
  type ServerMessage,
} from "@openbot/protocol";
import type { ApprovalOutcome, ComputerProvider, PreparedAction } from "@openbot/provider-sdk";
import {
  availableCapabilities,
  availableCapabilityManifest,
  providerForProfile,
} from "./providers.js";

/** WebSocket readyState OPEN. */
const socketOpen = 1;

/** The only socket surface a Run session may use: the one socket it was created for. */
export interface RunSessionSocket {
  readonly readyState: number;
  send(data: string): void;
}

export type RunOfferAdmission = (
  offer: RunOffer,
  available: NodeCapability[],
  availableManifest: NodeCapabilityDescriptor[],
  activeRuns: number,
  maxConcurrentRuns: number,
) => string | undefined;

/**
 * Client-owned, cross-connection registry of Provider executions that are still running or
 * draining. It only suppresses duplicate execution of one Run ID and lets stop() drain; offers,
 * controllers and approvals stay connection-owned.
 */
export class RunDrainRegistry {
  readonly #tasks = new Map<string, Promise<void>>();

  has(runId: string): boolean {
    return this.#tasks.has(runId);
  }

  /** Reserves a Run ID until this exact task settles; a later reservation is never removed. */
  track(runId: string, task: Promise<void>): void {
    this.#tasks.set(runId, task);
    const release = () => {
      if (this.#tasks.get(runId) === task) this.#tasks.delete(runId);
    };
    void task.then(release, release);
  }

  drain(): Promise<void> {
    return Promise.all(this.#tasks.values()).then(() => undefined);
  }
}

export interface RunSessionOptions {
  socket: RunSessionSocket;
  nodeId: string;
  workDirectory: string;
  maxConcurrentRuns: number;
  providers: ComputerProvider[];
  logger: OpenBotLogger;
  drains: RunDrainRegistry;
  admission: RunOfferAdmission;
}

interface ApprovalWaiter {
  runId: string;
  resolve(outcome: ApprovalOutcome): void;
  reject(error: Error): void;
}

/**
 * Owns every Run lifetime for exactly one WebSocket connection: accepted offers, assigned IDs,
 * executions and approval waiters. It sends only on its own socket and never after dispose().
 */
export class RunSession {
  readonly #socket: RunSessionSocket;
  readonly #options: RunSessionOptions;
  readonly #assignedRunIds = new Set<string>();
  readonly #acceptedOffers = new Map<string, RunOffer>();
  readonly #executions = new Map<string, AbortController>();
  readonly #approvalWaiters = new Map<string, ApprovalWaiter>();
  #disposed = false;

  constructor(options: RunSessionOptions) {
    this.#socket = options.socket;
    this.#options = options;
  }

  activeRunIds(): string[] {
    return Array.from(this.#assignedRunIds);
  }

  offer(message: RunOffer): void {
    if (this.#disposed) return;
    const { providers, nodeId } = this.#options;
    const rejection = this.#options.admission(
      message,
      availableCapabilities(providers),
      availableCapabilityManifest(providers),
      this.#assignedRunIds.size,
      this.#options.maxConcurrentRuns,
    );
    const response: NodeMessage = rejection
      ? {
          type: "run.reject",
          protocolVersion,
          nodeId,
          offerId: message.offerId,
          runId: message.runId,
          reason: rejection,
          rejectedAt: new Date().toISOString(),
        }
      : {
          type: "run.accept",
          protocolVersion,
          nodeId,
          offerId: message.offerId,
          runId: message.runId,
          acceptedAt: new Date().toISOString(),
        };
    if (rejection === undefined) this.#acceptedOffers.set(message.runId, message);
    this.#socket.send(JSON.stringify(response));
  }

  assigned(message: Extract<ServerMessage, { type: "run.assigned" }>): void {
    if (this.#disposed) return;
    const { nodeId } = this.#options;
    if (message.nodeId !== nodeId || !this.#acceptedOffers.has(message.runId)) return;
    this.#assignedRunIds.add(message.runId);
    this.#send({
      type: "run.start_request",
      protocolVersion,
      nodeId,
      runId: message.runId,
      requestedAt: new Date().toISOString(),
    });
  }

  start(message: Extract<ServerMessage, { type: "run.start" }>): void {
    if (this.#disposed || message.nodeId !== this.#options.nodeId) return;
    const runId = message.runId;
    // An older execution of this Run ID, possibly from a retired connection, is still draining.
    if (this.#options.drains.has(runId)) return;
    this.#options.drains.track(runId, this.#executeRun(runId));
  }

  approvalResolved(message: Extract<ServerMessage, { type: "approval.resolved" }>): void {
    const waiter = this.#approvalWaiters.get(message.requestId);
    if (waiter === undefined || waiter.runId !== message.runId) return;
    waiter.resolve({ approvalId: message.requestId, status: message.decision });
  }

  /** run.cancel / run.settled: abort any local execution and forget this Run (baseline semantics). */
  release(runId: string): void {
    this.#executions.get(runId)?.abort();
    this.#executions.delete(runId);
    this.#assignedRunIds.delete(runId);
    this.#acceptedOffers.delete(runId);
  }

  /** Retires this connection: aborts executions, rejects approvals and forgets all Run state. */
  dispose(): void {
    this.#disposed = true;
    for (const controller of this.#executions.values()) controller.abort();
    this.#executions.clear();
    for (const waiter of [...this.#approvalWaiters.values()])
      waiter.reject(new Error("Node connection closed while approval was pending."));
    this.#approvalWaiters.clear();
    this.#assignedRunIds.clear();
    this.#acceptedOffers.clear();
  }

  async #executeRun(runId: string): Promise<void> {
    if (this.#executions.has(runId)) return;
    const offer = this.#acceptedOffers.get(runId);
    if (offer === undefined) return;
    const { nodeId, logger } = this.#options;
    const provider = providerForProfile(this.#options.providers, offer.executionProfile);
    if (provider?.execute === undefined) {
      this.#sendFailure(runId, "provider_unavailable");
      return;
    }

    const controller = new AbortController();
    this.#executions.set(runId, controller);
    try {
      const result = await provider.execute(
        { nodeId, workDirectory: this.#options.workDirectory, signal: controller.signal },
        {
          runId: offer.runId,
          channelId: offer.channelId,
          botId: offer.botId,
          title: offer.title,
          instruction: offer.instruction,
          executionProfile: offer.executionProfile,
        },
        (progress) => {
          if (controller.signal.aborted) return;
          this.#send({
            type: "run.progress",
            protocolVersion,
            nodeId,
            runId,
            stage: progress.stage.slice(0, 80),
            message: progress.message.slice(0, 500),
            occurredAt: new Date().toISOString(),
          });
        },
        (frame) => {
          if (controller.signal.aborted) return;
          const message = runFrameSchema.safeParse({
            type: "run.frame",
            protocolVersion,
            nodeId,
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
            logger.warn(
              "provider.frame_rejected",
              "Provider emitted an invalid or oversized live frame; frame skipped.",
              { runId, nodeId, providerId: provider.id },
            );
          }
        },
        (action) => this.requestApproval(runId, action, controller.signal),
      );
      if (controller.signal.aborted) return;
      if (!result.ok) {
        logger.warn("provider.reported_failure", "Provider reported a failed result.", {
          runId,
          nodeId,
          providerId: provider.id,
        });
        this.#sendFailure(runId, "provider_execution_failed");
        return;
      }
      this.#send({
        type: "run.completed",
        protocolVersion,
        nodeId,
        runId,
        summary: result.summary.slice(0, 2000),
        artifacts: result.artifacts,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        logger.error("provider.execution_failed", "Provider execution failed.", {
          runId,
          nodeId,
          providerId: provider.id,
          phase: "execute",
          ...diagnosticFields(error),
        });
        this.#sendFailure(runId, "provider_execution_failed");
      }
    } finally {
      if (this.#executions.get(runId) === controller) this.#executions.delete(runId);
    }
  }

  /** Server authority: the Node only asks; the Server decides and may let the request expire. */
  requestApproval(
    runId: string,
    action: PreparedAction,
    signal: AbortSignal,
  ): Promise<ApprovalOutcome> {
    if (action.risk === "read") {
      throw new Error("Read-only actions must not request an approval lease.");
    }
    if (!this.#canSend()) {
      throw new Error("Approval request could not reach the Server.");
    }
    if (signal.aborted) return Promise.reject(new Error("Approval request was cancelled."));
    const requestId = randomUUID();
    const expiresInSeconds = Math.floor(
      Math.min(900, Math.max(30, action.expiresInSeconds ?? 300)),
    );
    const message = approvalRequestSchema.parse({
      type: "approval.request",
      protocolVersion,
      nodeId: this.#options.nodeId,
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

    return new Promise<ApprovalOutcome>((resolve, reject) => {
      let settled = false;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (this.#approvalWaiters.get(requestId) === waiter)
          this.#approvalWaiters.delete(requestId);
        return true;
      };
      const waiter: ApprovalWaiter = {
        runId,
        resolve: (outcome) => {
          if (settle()) resolve(outcome);
        },
        reject: (error) => {
          if (settle()) reject(error);
        },
      };
      const onAbort = () => waiter.reject(new Error("Approval request was cancelled."));
      const timer = setTimeout(
        () => waiter.reject(new Error("Approval request expired before it was decided.")),
        expiresInSeconds * 1000,
      );
      this.#approvalWaiters.set(requestId, waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      this.#send(message);
    });
  }

  #sendFailure(runId: string, code: RunFailureCode): void {
    this.#send({
      type: "run.failed",
      protocolVersion,
      nodeId: this.#options.nodeId,
      runId,
      code,
      error: runFailureMessages[code],
      failedAt: new Date().toISOString(),
    });
  }

  #canSend(): boolean {
    return !this.#disposed && this.#socket.readyState === socketOpen;
  }

  #send(message: NodeMessage): void {
    if (this.#canSend()) this.#socket.send(JSON.stringify(message));
  }
}
