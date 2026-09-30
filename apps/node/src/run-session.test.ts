import type { NodeEnv } from "@openbot/config";
import { createSilentLogger } from "@openbot/logging";
import { protocolVersion, type RunOffer } from "@openbot/protocol";
import type {
  ApprovalOutcome,
  ComputerProvider,
  PreparedAction,
  ProviderFrame,
  ProviderProgress,
} from "@openbot/provider-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

const sockets = vi.hoisted(() => [] as MockSocket[]);
interface MockSocket {
  readyState: number;
  sent: string[];
  emit(event: string, ...args: unknown[]): boolean;
  close(): void;
}
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: class extends EventEmitter {
      static OPEN = 1;
      static CLOSED = 3;
      static CLOSING = 2;
      readyState = 1;
      bufferedAmount = 0;
      sent: string[] = [];
      constructor() {
        super();
        sockets.push(this);
      }
      send(value: string, callback?: (error?: Error) => void) {
        this.sent.push(value);
        callback?.();
      }
      close() {
        this.readyState = 3;
        this.emit("close");
      }
    },
  };
});

import { OpenBotNodeClient, runOfferRejectionReason } from "./client.js";
import { RunDrainRegistry, RunSession, type RunSessionSocket } from "./run-session.js";

const nodeId = "node";
const runId = "00000000-0000-4000-8000-000000000002";
const capabilityManifest = [
  { id: "browser.observe" as const, version: 1, providerId: "docker", constraints: {} },
  { id: "screen.capture" as const, version: 1, providerId: "docker", constraints: {} },
];
const offer: RunOffer = {
  type: "run.offer",
  protocolVersion,
  offerId: "00000000-0000-4000-8000-000000000001",
  runId,
  channelId: "00000000-0000-4000-8000-000000000003",
  botId: "00000000-0000-4000-8000-000000000004",
  title: "draining run",
  instruction: "do the thing",
  executionProfile: "docker-linux",
  requiredCapabilities: ["browser", "screenshot"],
  requiredCapabilityManifest: [
    { id: "browser.observe", version: 1 },
    { id: "screen.capture", version: 1 },
  ],
  sentAt: "2026-09-03T00:00:00.000Z",
};
const ack = { type: "server.ack", protocolVersion, accepted: true, receivedAt: offer.sentAt };
const assigned = { type: "run.assigned", protocolVersion, runId, nodeId, assignedAt: offer.sentAt };
const started = { type: "run.start", protocolVersion, runId, nodeId, startedAt: offer.sentAt };
const writeAction: PreparedAction = {
  actionId: "prepared-action-1",
  action: "form.submit",
  target: "https://example.test/form",
  summary: "Submit the test form",
  risk: "write",
  expiresInSeconds: 30,
};

interface Call {
  signal: AbortSignal;
  report: (progress: ProviderProgress) => void;
  reportFrame: ((frame: ProviderFrame) => void) | undefined;
  requestApproval: ((action: PreparedAction) => Promise<ApprovalOutcome>) | undefined;
  release(): void;
}
function controllableProvider() {
  const calls: Call[] = [];
  const provider: ComputerProvider = {
    id: "docker",
    displayName: "Controllable test computer",
    platforms: ["linux", "macos", "windows"],
    capabilities: ["browser", "screenshot"],
    capabilityManifest,
    async execute(context, _input, report, reportFrame, requestApproval) {
      let release!: () => void;
      // Cooperative cleanup finishes only when the test releases it, even after abort.
      const cleanup = new Promise<void>((resolve) => {
        release = resolve;
      });
      calls.push({ signal: context.signal, report, reportFrame, requestApproval, release });
      await cleanup;
      return { ok: true, summary: "done", artifacts: [] };
    },
  };
  return { provider, calls };
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing synthetic fixture");
  return value;
}
const emit = (socket: MockSocket, value: unknown) =>
  socket.emit("message", Buffer.from(JSON.stringify(value)), false);
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const types = (socket: MockSocket) =>
  socket.sent.map((raw) => (JSON.parse(raw) as { type: string }).type);
function client(provider: ComputerProvider) {
  return new OpenBotNodeClient(
    {
      OPENBOT_NODE_ID: nodeId,
      OPENBOT_NODE_SERVER_URL: "ws://synthetic.invalid/",
      OPENBOT_NODE_MAX_CONCURRENT_RUNS: 1,
      OPENBOT_NODE_WORK_DIRECTORY: "/tmp/openbot-node-test",
    } as NodeEnv,
    [provider],
    {
      load: async () => ({
        format: "openbot.node-identity/v1" as const,
        nodeId,
        credential: `obn_${"a".repeat(43)}`,
        enrolledAt: "2026-09-25T00:00:00.000Z",
      }),
      save: vi.fn(),
    },
    createSilentLogger(),
  );
}
/** Starts the client and drives socket 1 until the Provider execution is running. */
async function runningOnFirstSocket(c: OpenBotNodeClient, calls: Call[]) {
  await c.start();
  const first = required(sockets[0]);
  first.emit("open");
  emit(first, ack);
  emit(first, offer);
  emit(first, assigned);
  emit(first, started);
  await tick();
  expect(calls).toHaveLength(1);
  expect(types(first)).toEqual(["node.hello", "run.accept", "run.start_request"]);
  return first;
}
async function reconnect(first: MockSocket) {
  first.close();
  await vi.advanceTimersByTimeAsync(2001);
  const replacement = required(sockets[1]);
  replacement.emit("open");
  emit(replacement, ack);
  await tick();
  return replacement;
}

afterEach(() => {
  sockets.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RunSession through the real client across reconnect", () => {
  it("never sends late Provider progress, frames, results or approvals on a replacement socket", async () => {
    vi.useFakeTimers();
    const { provider, calls } = controllableProvider();
    const c = client(provider);
    const first = await runningOnFirstSocket(c, calls);
    const call = required(calls[0]);
    const replacement = await reconnect(first);
    expect(call.signal.aborted).toBe(true);
    const sentBefore = first.sent.length;

    call.report({ stage: "late", message: "late progress" });
    call.reportFrame?.({
      mediaType: "image/png",
      base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"),
      capturedAt: offer.sentAt,
    });
    expect(() => required(call.requestApproval)(writeAction)).toThrow(
      "Approval request could not reach the Server.",
    );
    call.release();
    await tick();

    expect(types(replacement)).toEqual(["node.hello"]);
    expect(first.sent).toHaveLength(sentBefore);
    await c.stop();
  });

  it("rejects a pending approval on disconnect and never re-sends it after reconnect", async () => {
    vi.useFakeTimers();
    const { provider, calls } = controllableProvider();
    const c = client(provider);
    const first = await runningOnFirstSocket(c, calls);
    const call = required(calls[0]);
    const pending = required(call.requestApproval)(writeAction);
    const outcome = pending.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    expect(types(first).at(-1)).toBe("approval.request");
    const requestId = (JSON.parse(required(first.sent.at(-1))) as { requestId: string }).requestId;

    const replacement = await reconnect(first);
    // As in baseline, disconnect aborts the execution signal first, which settles the waiter.
    expect(await outcome).toBe("Approval request was cancelled.");
    // A stale decision on the replacement connection cannot revive the old waiter.
    emit(replacement, {
      type: "approval.resolved",
      protocolVersion,
      nodeId,
      runId,
      requestId,
      decision: "approved",
      decidedAt: offer.sentAt,
    });
    // Expiry timer was released: advancing past the lease sends nothing anywhere.
    await vi.advanceTimersByTimeAsync(31_000);
    call.release();
    await tick();
    expect(types(replacement).filter((type) => type !== "node.heartbeat")).toEqual(["node.hello"]);
    await c.stop();
  });

  it("suppresses a same-ID execution while the retired one drains, without cross-session corruption", async () => {
    vi.useFakeTimers();
    const { provider, calls } = controllableProvider();
    const c = client(provider);
    const first = await runningOnFirstSocket(c, calls);
    const callA = required(calls[0]);
    const replacement = await reconnect(first);

    // Baseline admission: accepted by capacity; start is suppressed while A drains.
    emit(replacement, offer);
    emit(replacement, assigned);
    emit(replacement, started);
    await tick();
    expect(types(replacement)).toEqual(["node.hello", "run.accept", "run.start_request"]);
    expect(calls).toHaveLength(1);

    let stopped = false;
    callA.release();
    await tick();
    // A's cleanup sent nothing and did not erase the replacement session's Run state.
    expect(types(replacement)).toEqual(["node.hello", "run.accept", "run.start_request"]);
    await vi.advanceTimersByTimeAsync(10_000);
    const heartbeat = JSON.parse(required(replacement.sent.at(-1))) as {
      type: string;
      activeRunIds: string[];
    };
    expect(heartbeat).toMatchObject({ type: "node.heartbeat", activeRunIds: [runId] });

    // The reservation is gone, and the replacement session still holds its accepted offer.
    emit(replacement, started);
    await tick();
    expect(calls).toHaveLength(2);
    required(calls[1]).release();
    await tick();
    expect(types(replacement).at(-1)).toBe("run.completed");
    void c.stop().then(() => {
      stopped = true;
    });
    await tick();
    expect(stopped).toBe(true);
  });

  it("suppresses callbacks and new approvals after same-connection cancellation", async () => {
    vi.useFakeTimers();
    const { provider, calls } = controllableProvider();
    const c = client(provider);
    const socket = await runningOnFirstSocket(c, calls);
    const call = required(calls[0]);
    const pending = required(call.requestApproval)(writeAction);
    const rejected = expect(pending).rejects.toThrow("Approval request was cancelled.");
    emit(socket, {
      type: "run.cancel",
      protocolVersion,
      runId,
      reason: "Owner cancelled the run",
      cancelledAt: offer.sentAt,
    });
    await rejected;
    expect(call.signal.aborted).toBe(true);
    const before = socket.sent.length;
    call.report({ stage: "late", message: "after cancellation" });
    call.reportFrame?.({
      mediaType: "image/png",
      base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"),
      capturedAt: offer.sentAt,
    });
    await expect(required(call.requestApproval)(writeAction)).rejects.toThrow(
      "Approval request was cancelled.",
    );
    call.release();
    await tick();
    expect(socket.sent).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(JSON.parse(required(socket.sent.at(-1)))).toMatchObject({
      type: "node.heartbeat",
      activeRunIds: [],
    });
    await c.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores offers and starts while stop waits for the socket close event", async () => {
    vi.useFakeTimers();
    const { provider, calls } = controllableProvider();
    const c = client(provider);
    await c.start();
    const socket = required(sockets[0]);
    socket.emit("open");
    emit(socket, ack);
    emit(socket, offer);
    emit(socket, assigned);
    // A real socket closes asynchronously; retain its pre-close event window.
    vi.spyOn(socket, "close").mockImplementation(() => {
      socket.readyState = 2;
    });
    const before = socket.sent.length;
    const stop = c.stop();
    emit(socket, started);
    emit(socket, offer);
    emit(socket, assigned);
    await tick();
    expect(calls).toEqual([]);
    expect(socket.sent).toHaveLength(before);
    socket.readyState = 3;
    socket.emit("close");
    await stop;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop waits for cooperative cleanup of work in a retired session", async () => {
    vi.useFakeTimers();
    const { provider, calls } = controllableProvider();
    const c = client(provider);
    const first = await runningOnFirstSocket(c, calls);
    const replacement = await reconnect(first);
    let stopped = false;
    const stop = c.stop();
    expect(c.stop()).toBe(stop);
    void stop.then(() => {
      stopped = true;
    });
    await tick();
    expect(replacement.readyState).toBe(3);
    expect(stopped).toBe(false);
    required(calls[0]).release();
    await stop;
    expect(stopped).toBe(true);
  });
});

function fakeSocket(): RunSessionSocket & { sent: string[]; readyState: number } {
  const socket = {
    readyState: 1,
    sent: [] as string[],
    send(data: string) {
      socket.sent.push(data);
    },
  };
  return socket;
}
function session(socket: RunSessionSocket, drains = new RunDrainRegistry()) {
  return new RunSession({
    socket,
    nodeId,
    workDirectory: "/tmp/openbot-node-test",
    maxConcurrentRuns: 1,
    providers: [controllableProvider().provider],
    logger: createSilentLogger(),
    drains,
    admission: runOfferRejectionReason,
  });
}
function trackedSignal() {
  const controller = new AbortController();
  const add = vi.spyOn(controller.signal, "addEventListener");
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  return { controller, add, remove };
}
function requestIdOf(socket: { sent: string[] }): string {
  return (JSON.parse(required(socket.sent.at(-1))) as { requestId: string }).requestId;
}

describe("RunSession approval waiters", () => {
  it("rejects an already-aborted approval before sending, arming a timer or a listener", async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const { controller, add } = trackedSignal();
    controller.abort();
    await expect(
      session(socket).requestApproval(runId, writeAction, controller.signal),
    ).rejects.toThrow("Approval request was cancelled.");
    expect(socket.sent).toEqual([]);
    expect(add).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases the timer and abort listener on Server resolution", async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const owner = session(socket);
    const { controller, add, remove } = trackedSignal();
    const pending = owner.requestApproval(runId, writeAction, controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    owner.approvalResolved({
      type: "approval.resolved",
      protocolVersion,
      nodeId,
      runId,
      requestId: requestIdOf(socket),
      decision: "rejected",
      decidedAt: offer.sentAt,
    });
    await expect(pending).resolves.toEqual({ approvalId: requestIdOf(socket), status: "rejected" });
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
  });

  it("releases the timer and abort listener on abort", async () => {
    vi.useFakeTimers();
    const owner = session(fakeSocket());
    const { controller, add, remove } = trackedSignal();
    const pending = owner.requestApproval(runId, writeAction, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("Approval request was cancelled.");
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
  });

  it("releases the timer and abort listener on expiry", async () => {
    vi.useFakeTimers();
    const owner = session(fakeSocket());
    const { controller, add, remove } = trackedSignal();
    const pending = owner.requestApproval(runId, writeAction, controller.signal);
    const outcome = pending.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toBe("Approval request expired before it was decided.");
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
  });

  it("releases the timer and abort listener on disconnect", async () => {
    vi.useFakeTimers();
    const owner = session(fakeSocket());
    const { controller, add, remove } = trackedSignal();
    const pending = owner.requestApproval(runId, writeAction, controller.signal);
    owner.dispose();
    await expect(pending).rejects.toThrow("Node connection closed while approval was pending.");
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
  });
});

describe("RunDrainRegistry", () => {
  it("never lets an older task release a newer reservation for the same Run ID", async () => {
    const drains = new RunDrainRegistry();
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    drains.track(
      runId,
      new Promise<void>((resolve) => {
        releaseOld = resolve;
      }),
    );
    drains.track(
      runId,
      new Promise<void>((resolve) => {
        releaseNew = resolve;
      }),
    );
    releaseOld();
    await tick();
    expect(drains.has(runId)).toBe(true);
    releaseNew();
    await tick();
    expect(drains.has(runId)).toBe(false);
  });

  it("keeps a retired session's cleanup from erasing the same Run ID in a new session", async () => {
    const drains = new RunDrainRegistry();
    const oldSocket = fakeSocket();
    const old = session(oldSocket, drains);
    old.offer(offer);
    old.assigned({
      type: "run.assigned",
      protocolVersion,
      runId,
      nodeId,
      assignedAt: offer.sentAt,
    });
    old.dispose();
    const replacementSocket = fakeSocket();
    const replacement = session(replacementSocket, drains);
    replacement.offer(offer);
    replacement.assigned({
      type: "run.assigned",
      protocolVersion,
      runId,
      nodeId,
      assignedAt: offer.sentAt,
    });
    old.release(runId);
    old.dispose();
    expect(replacement.activeRunIds()).toEqual([runId]);
    expect(old.activeRunIds()).toEqual([]);
  });
});
