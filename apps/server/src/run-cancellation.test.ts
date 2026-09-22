import type { ApprovalResolution, ExecutionNode, Run } from "@openbot/domain";
import { protocolVersion } from "@openbot/protocol";
import { describe, expect, it, vi } from "vitest";
import type { NodeRunMessage } from "./node-registry.js";
import { type NodeGateway, RunDispatcher } from "./run-dispatcher.js";

const node: ExecutionNode = {
  id: "node",
  name: "Fixture",
  platform: "linux",
  osVersion: "fixture",
  architecture: "x64",
  deviceClass: "server",
  isolation: "unknown",
  trustTier: "development",
  capabilities: ["browser", "screenshot"],
  capabilityManifest: [
    { id: "browser.observe", version: 1, providerId: "docker", constraints: {} },
    { id: "screen.capture", version: 1, providerId: "docker", constraints: {} },
  ],
  maxConcurrentRuns: 1,
  activeRunIds: [],
  connectedAt: "2026-09-23T00:00:00Z",
  lastSeenAt: "2026-09-23T00:00:00Z",
};
function fixture() {
  const run: Run = {
    id: "run",
    channelId: "channel",
    botId: "bot",
    executionProfile: "docker-linux",
    instruction: "Open https://example.test",
    title: "Fixture",
    status: "running",
    nodeId: node.id,
    createdAt: node.connectedAt,
    updatedAt: node.connectedAt,
  };
  let current: ExecutionNode | undefined = node;
  let available: (node: ExecutionNode) => void = () => {};
  let unavailable: (node: ExecutionNode) => void = () => {};
  let message: (node: ExecutionNode, message: NodeRunMessage) => void = () => {};
  const delivered: string[] = [];
  const gateway: NodeGateway = {
    list: () => (current ? [current] : []),
    connectionState: (value) => (!current ? "offline" : value === current ? "current" : "replaced"),
    onAvailable: (handler) => {
      available = handler;
      return () => {};
    },
    onUnavailable: (handler) => {
      unavailable = handler;
      return () => {};
    },
    onRunMessage: (handler) => {
      message = handler;
      return () => {};
    },
    offerRun: vi.fn(async () => ({ status: "accepted" as const })),
    confirmRun: vi.fn(() => true),
    startRun: vi.fn(() => true),
    settleRun: vi.fn(),
    resolveApproval: vi.fn(() => {
      delivered.push("approved");
      return true;
    }),
    cancelRun: vi.fn(() => {
      delivered.push("cancel");
    }),
  };
  const store = {
    listDispatchableRuns: vi.fn(async () => (run.status === "queued" ? [{ ...run }] : [])),
    getRunningRunForNode: vi.fn(async () => (run.status === "running" ? { ...run } : undefined)),
    appendRunProgress: vi.fn(async () => undefined),
    completeRun: vi.fn(async () => undefined),
    failRun: vi.fn(async () => undefined),
    failRunningRuns: vi.fn(async () => []),
    requeueAssignedRuns: vi.fn(async () => []),
    assignRun: vi.fn(async () => {
      if (run.status !== "queued") return undefined;
      run.status = "assigned";
      return { ...run };
    }),
    startRun: vi.fn(async () => {
      run.status = "running";
      return { ...run };
    }),
    upsertNode: vi.fn(async () => {}),
    markNodeOffline: vi.fn(async () => {}),
    cancelWorkerRun: vi.fn(async () => {
      run.status = "cancelled";
      return { run: { ...run }, approvals: [] };
    }),
    getApprovalRunId: vi.fn(async () => run.id),
    decideApproval: vi.fn(async () => {
      run.status = "running";
      return resolution(run);
    }),
  };
  const artifacts = {
    persist: vi.fn(async () => []),
    read: vi.fn(async () => Buffer.alloc(0)),
    remove: vi.fn(async () => {}),
  };
  const dispatcher = new RunDispatcher(store, gateway, { publish() {} }, artifacts);
  return {
    run,
    store,
    gateway,
    artifacts,
    dispatcher,
    delivered,
    available: (value: ExecutionNode) => {
      current = value;
      available(value);
    },
    unavailable: (value: ExecutionNode) => {
      if (current === value) current = undefined;
      unavailable(value);
    },
    send: (value: ExecutionNode, input: NodeRunMessage) => message(value, input),
  };
}
function resolution(run: Run): ApprovalResolution {
  return {
    run: { ...run },
    approval: {
      id: "approval",
      runId: run.id,
      channelId: run.channelId,
      botId: run.botId,
      nodeId: node.id,
      action: "browser.click",
      target: "https://example.test",
      summary: "Click",
      risk: "privileged",
      status: "approved",
      targetFingerprint: "a".repeat(64),
      beforeState: {},
      createdAt: node.connectedAt,
      expiresAt: "2027-01-01T00:00:00Z",
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Worker cancellation dispatch ordering", () => {
  it("serializes approval delivery and Owner cancellation and never redelivers a stale decision", async () => {
    const f = fixture();
    const gate = deferred();
    f.run.status = "waiting_approval";
    f.store.decideApproval.mockImplementation(async () => {
      await gate.promise;
      f.run.status = "running";
      return resolution(f.run);
    });
    await f.dispatcher.start();
    try {
      const approved = f.dispatcher.decideApproval("approval", "approve");
      await vi.waitFor(() => expect(f.store.decideApproval).toHaveBeenCalledOnce());
      const cancelled = f.dispatcher.cancelWorkerRun(f.run.id);
      await Promise.resolve();
      expect(f.store.cancelWorkerRun).not.toHaveBeenCalled();
      gate.resolve();
      const decided = await approved;
      await cancelled;
      expect(f.delivered).toEqual(["approved", "cancel"]);
      expect(f.run.status).toBe("cancelled");
      await f.dispatcher.resolveApproval(decided);
      expect(f.gateway.resolveApproval).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await f.dispatcher.stop();
    }
  });
  it("cancels before an outstanding offer accepts without assigning or starting that Run", async () => {
    const f = fixture();
    const offered = deferred();
    f.run.status = "queued";
    f.store.assignRun.mockClear();
    f.gateway.offerRun = vi.fn(async () => {
      await offered.promise;
      return { status: "accepted" };
    });
    const started = f.dispatcher.start();
    await vi.waitFor(() => expect(f.gateway.offerRun).toHaveBeenCalledOnce());
    const cancel = f.dispatcher.cancelWorkerRun(f.run.id);
    await vi.waitFor(() => expect(f.run.status).toBe("cancelled"));
    offered.resolve();
    await Promise.all([started, cancel]);
    expect(f.gateway.confirmRun).not.toHaveBeenCalled();
    expect(f.gateway.startRun).not.toHaveBeenCalled();
    await f.dispatcher.stop();
  });
  it("rejects old socket callbacks and does not mark a replacement offline", async () => {
    const f = fixture();
    await f.dispatcher.start();
    const replacement = { ...node };
    const ready = deferred();
    f.store.upsertNode.mockImplementation(async () => {
      await ready.promise;
    });
    try {
      f.available(replacement);
      f.unavailable(node);
      f.send(node, {
        type: "run.start_request",
        protocolVersion,
        nodeId: node.id,
        runId: f.run.id,
        requestedAt: node.connectedAt,
      });
      await vi.waitFor(() => expect(f.store.upsertNode).toHaveBeenCalledOnce());
      f.run.status = "queued";
      await f.dispatcher.dispatchQueued();
      expect(f.gateway.offerRun).not.toHaveBeenCalled();
      ready.resolve();
      await vi.waitFor(() => expect(f.gateway.confirmRun).toHaveBeenCalledOnce());
      expect(f.store.markNodeOffline).not.toHaveBeenCalled();
      expect(f.store.startRun).not.toHaveBeenCalled();
      expect(f.store.failRunningRuns).toHaveBeenCalledTimes(2);
    } finally {
      ready.resolve();
      await f.dispatcher.stop();
    }
  });
  it("rejects a late completion after cancellation before writing any artifact", async () => {
    const f = fixture();
    await f.dispatcher.start();
    try {
      await f.dispatcher.cancelWorkerRun(f.run.id);
      f.send(node, {
        type: "run.completed",
        protocolVersion,
        nodeId: node.id,
        runId: f.run.id,
        summary: "Late result",
        artifacts: [],
        completedAt: node.connectedAt,
      });
      await vi.waitFor(() => expect(f.store.getRunningRunForNode).toHaveBeenCalled());
      await f.dispatcher.stop();
      expect(f.artifacts.persist).not.toHaveBeenCalled();
      expect(f.store.completeRun).not.toHaveBeenCalled();
      expect(f.run.status).toBe("cancelled");
    } finally {
      await f.dispatcher.stop();
    }
  });
  it("keeps a Node excluded after failed recovery until a successful connection reconciliation", async () => {
    const f = fixture();
    await f.dispatcher.start();
    f.run.status = "queued";
    f.store.upsertNode.mockRejectedValueOnce(new Error("fixture storage unavailable"));
    f.available(node);
    await vi.waitFor(() => expect(f.store.upsertNode).toHaveBeenCalledOnce());
    await new Promise((resolve) => setImmediate(resolve));
    await f.dispatcher.dispatchQueued();
    expect(f.gateway.offerRun).not.toHaveBeenCalled();
    f.available({ ...node });
    await vi.waitFor(() => expect(f.gateway.confirmRun).toHaveBeenCalledOnce());
    await f.dispatcher.stop();
  });
});
