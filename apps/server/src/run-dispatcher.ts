import type {
  ApprovalDecision,
  ApprovalResolution,
  ExecutionNode,
  Run,
  WorkspaceRealtimeEvent,
} from "@openbot/domain";
import { createSilentLogger, diagnosticFields, type OpenBotLogger } from "@openbot/logging";
import { evaluatePolicy, type PolicyRule } from "@openbot/policy";
import type { CompletedArtifact } from "@openbot/protocol";
import { browserClickApprovalMatches } from "@openbot/protocol";
import { approvalPolicyRules, isRiskDowngrade } from "./approval-policy.js";
import type { ArtifactStorage } from "./artifact-storage.js";
import type { ChannelRealtimeHub } from "./channel-realtime-hub.js";
import {
  type ArtifactRecord,
  type ControlPlaneStore,
  StoreConflictError,
  StoreNotFoundError,
} from "./control-plane-store.js";
import { selectExecutionNode } from "./execution-routing.js";
import type {
  NodeRegistry,
  NodeRunMessage,
  RunOfferInput,
  RunOfferResult,
} from "./node-registry.js";
import { publicRunFailure } from "./run-failure.js";
import type { RunFrameStore } from "./run-frame-store.js";

type DispatchStore = Pick<
  ControlPlaneStore,
  | "appendRunProgress"
  | "assignRun"
  | "completeRun"
  | "failRun"
  | "failRunningRuns"
  | "getRunningRunForNode"
  | "listDispatchableRuns"
  | "markNodeOffline"
  | "requeueAssignedRuns"
  | "startRun"
  | "upsertNode"
> &
  Partial<
    Pick<
      ControlPlaneStore,
      | "recordDispatchFailure"
      | "requestApproval"
      | "cancelWorkerRun"
      | "getApprovalRunId"
      | "decideApproval"
    >
  >;

export interface NodeGateway {
  list(): ExecutionNode[];
  connectionState?(node: ExecutionNode): "current" | "replaced" | "offline";
  onUpdated?(handler: (node: ExecutionNode) => void): () => void;
  onAvailable(handler: (node: ExecutionNode) => void): () => void;
  onUnavailable(handler: (node: ExecutionNode) => void): () => void;
  onRunMessage(handler: (node: ExecutionNode, message: NodeRunMessage) => void): () => void;
  offerRun(nodeId: string, input: RunOfferInput): Promise<RunOfferResult>;
  confirmRun(nodeId: string, runId: string): boolean;
  startRun(nodeId: string, runId: string): boolean;
  resolveApproval?(
    nodeId: string,
    runId: string,
    requestId: string,
    decision: "approved" | "rejected" | "expired",
  ): boolean;
  settleRun(nodeId: string, runId: string, status: "completed" | "failed"): void;
  cancelRun(nodeId: string, runId: string, reason: string): void;
}

type RunPublisher = Pick<ChannelRealtimeHub, "publish">;
interface WorkspacePublisher {
  publish(
    event: Extract<WorkspaceRealtimeEvent, { type: "approval.updated" | "run.updated" }>,
  ): void;
}
type FramePublisher = Pick<RunFrameStore, "publish">;

export class RunDispatcher {
  readonly #store: DispatchStore;
  readonly #nodes: NodeGateway;
  readonly #realtime: RunPublisher;
  readonly #artifacts: ArtifactStorage;
  readonly #frames: FramePublisher | undefined;
  readonly #workspace: WorkspacePublisher | undefined;
  readonly #approvalPolicyRules: readonly PolicyRule[];
  readonly #logger: OpenBotLogger;
  // Preserve protocol order per Run without serializing independent Runs or Nodes.
  readonly #runMessageTails = new Map<string, Promise<void>>();
  // Node lifecycle listeners are not part of a Run tail but still write authoritative state.
  readonly #listenerTasks = new Set<Promise<void>>();
  readonly #nodeLifecycleTails = new Map<string, Promise<void>>();
  readonly #reconcilingNodes = new Set<string>();
  #dispatchPromise: Promise<void> | undefined;
  #drainAgain = false;
  #stopped = true;
  #stopPromise: Promise<void> | undefined;
  #unsubscribeUpdated: (() => void) | undefined;
  #unsubscribeAvailable: (() => void) | undefined;
  #unsubscribeUnavailable: (() => void) | undefined;
  #unsubscribeRunMessage: (() => void) | undefined;

  constructor(
    store: DispatchStore,
    nodes: NodeRegistry | NodeGateway,
    realtime: RunPublisher,
    artifacts: ArtifactStorage,
    frames?: FramePublisher,
    workspace?: WorkspacePublisher,
    policyRules: readonly PolicyRule[] = approvalPolicyRules,
    logger: OpenBotLogger = createSilentLogger(),
  ) {
    this.#store = store;
    this.#nodes = nodes;
    this.#realtime = realtime;
    this.#artifacts = artifacts;
    this.#frames = frames;
    this.#workspace = workspace;
    this.#approvalPolicyRules = policyRules;
    this.#logger = logger;
  }

  async start(): Promise<void> {
    if (!this.#stopped || this.#stopPromise !== undefined) {
      throw new Error("RunDispatcher instances cannot be restarted.");
    }
    this.#stopped = false;
    this.#unsubscribeUpdated = this.#nodes.onUpdated?.(() => {
      void this.dispatchQueued().catch((error) =>
        this.#reportDispatchError(error, { phase: "node-capacity", runId: "node-lifecycle" }),
      );
    });
    this.#unsubscribeAvailable = this.#nodes.onAvailable((node) => {
      this.#queueNodeLifecycle(node, "node-available", () => this.#handleNodeAvailable(node));
    });
    this.#unsubscribeUnavailable = this.#nodes.onUnavailable((node) => {
      this.#queueNodeLifecycle(node, "node-unavailable", () => this.#handleNodeUnavailable(node));
    });
    this.#unsubscribeRunMessage = this.#nodes.onRunMessage((node, message) => {
      this.#enqueueRunMessage(node, message);
    });

    const [requeued, failed] = await Promise.all([
      this.#store.requeueAssignedRuns(),
      this.#store.failRunningRuns(),
    ]);
    this.#publishUpdates([...requeued, ...failed]);
    await this.dispatchQueued();
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#stopped = true;
    this.#unsubscribeUpdated?.();
    this.#unsubscribeUpdated = undefined;
    this.#unsubscribeAvailable?.();
    this.#unsubscribeUnavailable?.();
    this.#unsubscribeRunMessage?.();
    this.#unsubscribeAvailable = undefined;
    this.#unsubscribeUnavailable = undefined;
    this.#unsubscribeRunMessage = undefined;
    this.#stopPromise = this.#drainInFlight();
    return this.#stopPromise;
  }

  enqueue(run: Run): void {
    if (run.status !== "queued" || run.executionProfile === "none") return;
    void this.dispatchQueued().catch((error) =>
      this.#reportDispatchError(error, { phase: "enqueue", runId: run.id, nodeId: run.nodeId }),
    );
  }

  async cancelWorkerRun(runId: string): Promise<Run> {
    if (!this.#store.cancelWorkerRun)
      throw new StoreConflictError("Worker cancellation is unavailable.");
    const cancel = this.#store.cancelWorkerRun.bind(this.#store);
    const run = await this.#withRunCommand(runId, async () => {
      const result = await cancel(runId);
      if (result.run.nodeId)
        this.#nodes.cancelRun(
          result.run.nodeId,
          runId,
          "Owner stopped this task; external effects may already have occurred.",
        );
      this.#publishUpdates([result.run]);
      for (const approval of result.approvals)
        this.#workspace?.publish({ type: "approval.updated", approval, run: result.run });
      return result.run;
    });
    await this.dispatchQueued();
    return run;
  }

  async decideApproval(
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalResolution> {
    if (!this.#store.getApprovalRunId || !this.#store.decideApproval)
      throw new StoreConflictError("Worker approval is unavailable.");
    const runId = await this.#store.getApprovalRunId(approvalId);
    if (!runId) throw new StoreNotFoundError("Approval not found.");
    const decide = this.#store.decideApproval.bind(this.#store);
    return this.#withRunCommand(runId, async () => {
      const resolution = await decide(approvalId, decision, "owner");
      this.#publishUpdates([resolution.run]);
      this.#workspace?.publish({ type: "approval.updated", ...resolution });
      await this.#deliverApproval(resolution);
      return resolution;
    });
  }

  async resolveApproval(resolution: ApprovalResolution): Promise<void> {
    return this.#withRunCommand(resolution.run.id, () => this.#deliverApproval(resolution));
  }

  async #deliverApproval(resolution: ApprovalResolution): Promise<void> {
    const { approval, run } = resolution;
    const decision = approval.status;
    if (decision === "pending") return;
    if (
      decision === "approved" &&
      !(await this.#store.getRunningRunForNode(run.id, approval.nodeId))
    ) {
      this.#nodes.cancelRun(
        approval.nodeId,
        run.id,
        "Approval no longer belongs to a running task.",
      );
      return;
    }
    const delivered =
      this.#nodes.resolveApproval?.(approval.nodeId, run.id, approval.id, decision) ?? false;

    if (decision === "approved") {
      if (delivered) return;
      const failure = publicRunFailure("node_disconnected");
      const failed = await this.#store.failRun(
        run.id,
        approval.nodeId,
        failure.message,
        failure.code,
      );
      if (failed !== undefined) {
        this.#nodes.settleRun(approval.nodeId, run.id, "failed");
        this.#publishUpdates([failed]);
      }
      await this.dispatchQueued();
      return;
    }

    this.#nodes.cancelRun(
      approval.nodeId,
      run.id,
      decision === "expired" ? "Approval expired." : "Owner rejected the requested action.",
    );
    await this.dispatchQueued();
  }

  async dispatchQueued(): Promise<void> {
    if (this.#stopped) return;
    if (this.#dispatchPromise !== undefined) {
      // Coalesce concurrent wakeups instead of running overlapping dispatch loops.
      this.#drainAgain = true;
      await this.#dispatchPromise;
      return;
    }

    const dispatch = this.#drainQueued();
    this.#dispatchPromise = dispatch;
    try {
      await dispatch;
    } finally {
      if (this.#dispatchPromise === dispatch) this.#dispatchPromise = undefined;
    }
  }

  async #drainQueued(): Promise<void> {
    do {
      this.#drainAgain = false;
      const queued = await this.#store.listDispatchableRuns();
      for (const run of queued) {
        if (this.#stopped) return;
        await this.#offer(run);
      }
    } while (this.#drainAgain && !this.#stopped);
  }

  async #offer(run: Run): Promise<void> {
    const route = selectExecutionNode(
      run,
      this.#nodes.list().filter((node) => !this.#reconcilingNodes.has(node.id)),
    );
    if (route === undefined) return;
    const { node, requirements } = route;
    const result = await this.#nodes.offerRun(node.id, {
      runId: run.id,
      channelId: run.channelId,
      botId: run.botId,
      title: run.title,
      instruction: run.instruction,
      executionProfile: requirements.executionProfile,
      requiredCapabilities: requirements.capabilities,
      requiredCapabilityManifest: requirements.capabilityManifest,
    });
    if (result.status !== "accepted") return;
    await this.#withRunCommand(run.id, async () => {
      if (this.#reconcilingNodes.has(node.id) || this.#connectionState(node) !== "current") {
        this.#nodes.cancelRun(node.id, run.id, "Node connection changed before assignment.");
        return;
      }
      // An offer reserves local capacity; the database transition remains the global claim.
      const assigned = await this.#store.assignRun(run.id, node.id);
      if (assigned === undefined) {
        this.#nodes.cancelRun(node.id, run.id, "Run was claimed or cancelled before assignment.");
        return;
      }
      if (
        this.#reconcilingNodes.has(node.id) ||
        this.#connectionState(node) !== "current" ||
        !this.#nodes.confirmRun(node.id, run.id)
      ) {
        const requeued = await this.#store.requeueAssignedRuns(node.id);
        this.#publishUpdates(requeued);
        return;
      }
      this.#publishUpdates([assigned]);
    });
  }

  #connectionState(node: ExecutionNode): "current" | "replaced" | "offline" {
    if (this.#nodes.connectionState) return this.#nodes.connectionState(node);
    const current = this.#nodes.list().find((candidate) => candidate.id === node.id);
    return !current ? "offline" : current.connectedAt === node.connectedAt ? "current" : "replaced";
  }

  async #handleNodeAvailable(node: ExecutionNode): Promise<void> {
    if (this.#connectionState(node) !== "current") return;
    await this.#store.upsertNode(node);
    const [requeued, failed] = await Promise.all([
      this.#store.requeueAssignedRuns(node.id),
      this.#store.failRunningRuns(node.id),
    ]);
    this.#publishUpdates([...requeued, ...failed]);
    await this.dispatchQueued();
  }

  async #handleNodeUnavailable(node: ExecutionNode): Promise<void> {
    if (this.#connectionState(node) === "replaced") return;
    await this.#store.markNodeOffline(node.id);
    const [requeued, failed] = await Promise.all([
      this.#store.requeueAssignedRuns(node.id),
      this.#store.failRunningRuns(node.id),
    ]);
    this.#publishUpdates([...requeued, ...failed]);
    await this.dispatchQueued();
  }

  #withRunCommand<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#runMessageTails.get(runId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#runMessageTails.set(runId, tail);
    void tail.then(() => {
      if (this.#runMessageTails.get(runId) === tail) this.#runMessageTails.delete(runId);
    });
    return result;
  }

  #enqueueRunMessage(node: ExecutionNode, message: NodeRunMessage): void {
    if (this.#stopped) return;
    void this.#withRunCommand(message.runId, () => this.#handleRunMessage(node, message)).catch(
      (error) =>
        this.#reportDispatchError(error, {
          phase: "node-message",
          runId: message.runId,
          nodeId: node.id,
        }),
    );
  }

  #queueNodeLifecycle(node: ExecutionNode, phase: string, operation: () => Promise<void>): void {
    this.#reconcilingNodes.add(node.id);
    const previous = this.#nodeLifecycleTails.get(node.id) ?? Promise.resolve();
    const work = previous.then(operation);
    const tail = work.then(
      () => undefined,
      () => undefined,
    );
    this.#nodeLifecycleTails.set(node.id, tail);
    this.#trackListener(work, phase, node.id);
    void work.then(
      () => {
        if (this.#nodeLifecycleTails.get(node.id) !== tail) return;
        this.#nodeLifecycleTails.delete(node.id);
        this.#reconcilingNodes.delete(node.id);
        void this.dispatchQueued().catch((error) =>
          this.#reportDispatchError(error, {
            phase: "node-ready",
            runId: "node-lifecycle",
            nodeId: node.id,
          }),
        );
      },
      () => {
        // Keep this Node excluded until a later successful reconciliation repairs authority.
        if (this.#nodeLifecycleTails.get(node.id) === tail)
          this.#nodeLifecycleTails.delete(node.id);
      },
    );
  }

  #trackListener(work: Promise<void>, phase: string, nodeId: string): void {
    const handled = work.catch((error) =>
      this.#reportDispatchError(error, { phase, runId: "node-lifecycle", nodeId }),
    );
    this.#listenerTasks.add(handled);
    void handled.finally(() => this.#listenerTasks.delete(handled));
  }

  async #drainInFlight(): Promise<void> {
    const pending = [
      this.#dispatchPromise,
      ...this.#listenerTasks.values(),
      ...this.#runMessageTails.values(),
    ].filter((work): work is Promise<void> => work !== undefined);
    await Promise.all(pending);
    this.#runMessageTails.clear();
  }

  async #handleRunMessage(node: ExecutionNode, message: NodeRunMessage): Promise<void> {
    // A queued callback from an old authenticated socket cannot affect its replacement's work.
    if (this.#connectionState(node) !== "current") return;
    switch (message.type) {
      case "run.start_request": {
        const started = await this.#store.startRun(message.runId, node.id);
        if (started === undefined) {
          this.#nodes.cancelRun(node.id, message.runId, "Run is no longer assignable.");
          return;
        }
        if (
          this.#connectionState(node) !== "current" ||
          !this.#nodes.startRun(node.id, message.runId)
        ) {
          const failure = publicRunFailure("node_disconnected");
          const failed = await this.#store.failRun(
            message.runId,
            node.id,
            failure.message,
            failure.code,
          );
          if (failed !== undefined) {
            this.#nodes.settleRun(node.id, message.runId, "failed");
            this.#publishUpdates([failed]);
            await this.dispatchQueued();
          }
          return;
        }
        this.#publishUpdates([started]);
        return;
      }
      case "run.progress": {
        const progress = await this.#store.appendRunProgress(
          message.runId,
          node.id,
          message.stage,
          message.message,
        );
        if (progress !== undefined) {
          this.#realtime.publish({
            type: "run.progress",
            channelId: progress.channelId,
            progress,
          });
        }
        return;
      }
      case "run.frame": {
        if (this.#frames === undefined) return;
        const run = await this.#store.getRunningRunForNode(message.runId, node.id);
        if (run === undefined) return;
        const frame = this.#frames.publish(run.channelId, message);
        if (frame !== undefined) {
          this.#realtime.publish({ type: "run.frame", channelId: run.channelId, frame });
        }
        return;
      }
      case "approval.request": {
        const clickRun =
          message.action === "browser.click"
            ? await this.#store.getRunningRunForNode(message.runId, node.id)
            : undefined;
        const clickMatches =
          message.action !== "browser.click" ||
          Boolean(
            clickRun &&
              clickRun.executionProfile === "docker-linux" &&
              browserClickApprovalMatches(
                clickRun.instruction,
                message.target,
                message.beforeState,
              ),
          );
        const policy = evaluatePolicy(
          { action: message.action, target: message.target },
          this.#approvalPolicyRules,
        );
        if (
          !clickMatches ||
          policy.effect !== "require_approval" ||
          policy.minimumRisk === undefined ||
          isRiskDowngrade(message.risk, policy.minimumRisk)
        ) {
          const nodeReason = !clickMatches
            ? "Browser approval does not match the Server task."
            : policy.effect !== "require_approval"
              ? "Execution requested an action that Server policy does not permit."
              : "Execution reported a risk below the Server policy minimum.";
          const failure = publicRunFailure("approval_policy_denied");
          this.#nodes.cancelRun(node.id, message.runId, nodeReason);
          const failed = await this.#store.failRun(
            message.runId,
            node.id,
            failure.message,
            failure.code,
          );
          if (failed !== undefined) {
            this.#nodes.settleRun(node.id, message.runId, "failed");
            this.#publishUpdates([failed]);
            await this.dispatchQueued();
          }
          return;
        }
        const resolution = await this.#store.requestApproval?.(message.runId, node.id, {
          requestId: message.requestId,
          action: message.action,
          target: message.target,
          summary: message.summary,
          risk: policy.minimumRisk,
          beforeState: message.beforeState,
          expiresAt: new Date(Date.now() + message.expiresInSeconds * 1000).toISOString(),
        });
        if (resolution === undefined) {
          this.#nodes.cancelRun(node.id, message.runId, "Run cannot request an approval now.");
          return;
        }
        this.#publishUpdates([resolution.run]);
        this.#workspace?.publish({
          type: "approval.updated",
          approval: resolution.approval,
          run: resolution.run,
        });
        return;
      }
      case "run.completed":
        await this.#completeRun(node.id, message.runId, message.summary, message.artifacts);
        return;
      case "run.failed": {
        const failure = publicRunFailure(message.code);
        const failed = await this.#store.failRun(
          message.runId,
          node.id,
          failure.message,
          failure.code,
        );
        if (failed !== undefined) {
          this.#nodes.settleRun(node.id, message.runId, "failed");
          this.#publishUpdates([failed]);
          await this.dispatchQueued();
        }
      }
    }
  }

  async #completeRun(
    nodeId: string,
    runId: string,
    summary: string,
    inputs: CompletedArtifact[],
  ): Promise<void> {
    // Known terminal/foreign results must not reach file storage. The transaction below still
    // rejects authority revoked while an in-flight artifact write is completing.
    if (!(await this.#store.getRunningRunForNode(runId, nodeId))) {
      this.#nodes.cancelRun(nodeId, runId, "Run is no longer running on this Node.");
      return;
    }
    let persisted: ArtifactRecord[] = [];
    try {
      persisted = (await this.#artifacts.persist(runId, inputs)).map((record) => ({
        ...record.artifact,
        storageKey: record.storageKey,
        metadata: record.metadata,
      }));
      const completion = await this.#store.completeRun(runId, nodeId, summary, persisted);
      if (completion === undefined) {
        await this.#removeArtifacts(persisted, runId, nodeId);
        this.#nodes.cancelRun(nodeId, runId, "Run is no longer running on this Node.");
        return;
      }
      this.#nodes.settleRun(nodeId, runId, "completed");
      this.#realtime.publish({
        type: "run.updated",
        channelId: completion.run.channelId,
        run: completion.run,
        artifacts: completion.artifacts,
      });
      this.#realtime.publish({
        type: "message.created",
        channelId: completion.message.channelId,
        message: completion.message,
      });
      this.#workspace?.publish({
        type: "run.updated",
        run: completion.run,
        artifacts: completion.artifacts,
      });
      await this.dispatchQueued();
    } catch (error) {
      await this.#removeArtifacts(persisted, runId, nodeId);
      this.#logger.error("run.artifact_persistence_failed", "Run artifact persistence failed.", {
        runId,
        nodeId,
        phase: "artifact-persist",
        ...diagnosticFields(error),
      });
      const failure = publicRunFailure("artifact_persistence_failed");
      const failed = await this.#store.failRun(runId, nodeId, failure.message, failure.code);
      if (failed !== undefined) {
        this.#nodes.settleRun(nodeId, runId, "failed");
        this.#publishUpdates([failed]);
        await this.dispatchQueued();
      }
    }
  }

  async #removeArtifacts(
    artifacts: ArtifactRecord[],
    runId: string,
    nodeId: string,
  ): Promise<void> {
    try {
      await this.#artifacts.remove(artifacts.map((artifact) => artifact.storageKey));
    } catch (error) {
      this.#logger.error("run.artifact_cleanup_failed", "Run artifact cleanup failed.", {
        runId,
        nodeId,
        phase: "artifact-cleanup",
        ...diagnosticFields(error),
      });
    }
  }

  async #reportDispatchError(
    error: unknown,
    context: { phase: string; runId: string; nodeId?: string | undefined },
  ): Promise<void> {
    this.#logger.error("run.dispatch_failed", "Run dispatcher background work failed.", {
      ...context,
      code: "dispatch_failed",
      ...diagnosticFields(error),
    });
    try {
      await this.#store.recordDispatchFailure?.({
        ...context,
        code: "dispatch_failed",
      });
    } catch (auditError) {
      this.#logger.error(
        "run.dispatch_audit_failed",
        "Run dispatch failure audit could not be persisted.",
        {
          ...context,
          code: "dispatch_failed",
          ...diagnosticFields(auditError),
        },
      );
    }
  }

  #publishUpdates(runs: Run[]): void {
    for (const run of runs) {
      this.#realtime.publish({ type: "run.updated", channelId: run.channelId, run });
      this.#workspace?.publish({ type: "run.updated", run });
    }
  }
}
