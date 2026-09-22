// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  subscribeToChannelEvents,
  subscribeToWorkspaceEvents,
  subscribeToWorkspaceSnapshots,
} from "./api";
import { TestEventSource } from "./test/event-source";

const snapshot = {
  channels: [],
  bots: [],
  nodes: [],
  runs: [],
  approvals: [],
  artifacts: [],
  progress: [],
  counts: { channels: 0, bots: 0, connectedNodes: 0, activeRuns: 4 },
};
const frame = (sequence = 1, streamId = "one") => ({
  type: "workspace.snapshot",
  version: 1,
  sequence,
  streamId,
  snapshot,
});
let dispose: (() => void) | undefined;
const latest = () => {
  const source = TestEventSource.instances.at(-1);
  if (!source) throw new Error("Missing test stream");
  return source;
};
function subscribe() {
  const handlers = { onSnapshot: vi.fn(), onState: vi.fn(), onError: vi.fn() };
  dispose = subscribeToWorkspaceSnapshots(handlers);
  return handlers;
}
beforeEach(() => {
  vi.useFakeTimers();
  TestEventSource.instances = [];
  vi.stubGlobal("EventSource", TestEventSource);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("official complete workspace subscription", () => {
  it("requires a valid frame for live state, ignores duplicates and accepts sequence gaps", () => {
    const handlers = subscribe();
    latest().open();
    expect(handlers.onState).toHaveBeenLastCalledWith("connecting");
    for (const sequence of [1, 1, 0 + 1, 4, 3])
      latest().emit("workspace.snapshot", frame(sequence));
    expect(handlers.onSnapshot).toHaveBeenCalledTimes(2);
    expect(handlers.onState).toHaveBeenLastCalledWith("live");
    expect(handlers.onError).not.toHaveBeenCalled();
  });
  it("reconnects once with a new sequence scope and ignores late frames/errors from the old source", () => {
    const handlers = subscribe();
    const old = latest();
    old.emit("workspace.snapshot", frame(8));
    old.fail();
    old.fail();
    expect(old.closed).toBe(true);
    expect(handlers.onState).toHaveBeenLastCalledWith("retrying");
    vi.advanceTimersByTime(2000);
    expect(TestEventSource.instances).toHaveLength(2);
    old.emit("workspace.snapshot", frame(9));
    old.fail();
    old.open();
    latest().emit("workspace.snapshot", frame(1, "two"));
    expect(handlers.onSnapshot).toHaveBeenCalledTimes(2);
    expect(handlers.onState).toHaveBeenLastCalledWith("live");
  });
  it("does not let replayed frames keep a silent stream healthy and cleans a pending reconnect", () => {
    const handlers = subscribe();
    latest().emit("workspace.snapshot", frame());
    vi.advanceTimersByTime(34_000);
    latest().emit("workspace.snapshot", frame());
    vi.advanceTimersByTime(1000);
    expect(latest().closed).toBe(true);
    expect(handlers.onState).toHaveBeenLastCalledWith("retrying");
    dispose?.();
    vi.advanceTimersByTime(60_000);
    expect(TestEventSource.instances).toHaveLength(1);
  });
  it.each([
    { ...frame(), version: 2 },
    { ...frame(), streamId: "" },
    { ...frame(), sequence: -1 },
    { ...frame(), snapshot: { ...snapshot, counts: { ...snapshot.counts, activeRuns: -1 } } },
    { ...frame(), snapshot: { ...snapshot, channels: [null] } },
    {
      ...frame(),
      snapshot: { ...snapshot, runs: Array.from({ length: 51 }, () => ({ id: "overflow" })) },
    },
    { ...frame(), padding: "x".repeat(2 * 1024 * 1024) },
    { ...frame(), padding: "界".repeat(800_000) },
  ])("stops an incompatible or oversized frame without reconnecting or projecting", (invalid) => {
    const handlers = subscribe();
    latest().emit("workspace.snapshot", invalid);
    expect(handlers.onSnapshot).not.toHaveBeenCalled();
    expect(handlers.onError).toHaveBeenCalledWith("工作区快照格式不兼容，请刷新或更新客户端。");
    expect(latest().closed).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(TestEventSource.instances).toHaveLength(1);
  });
  it("rejects an identity change inside the same connection", () => {
    const handlers = subscribe();
    latest().emit("workspace.snapshot", frame());
    latest().emit("workspace.snapshot", frame(2, "unexpected"));
    expect(handlers.onSnapshot).toHaveBeenCalledTimes(1);
    expect(handlers.onError).toHaveBeenCalledTimes(1);
  });
});

describe("independent legacy event subscriptions", () => {
  it("retains profile notifications while blocking old workspace callbacks after replacement/disposal", () => {
    const handlers = {
      onApproval: vi.fn(),
      onEmployeeProfileChanged: vi.fn(),
      onNode: vi.fn(),
      onNodeRemoved: vi.fn(),
      onReady: vi.fn(),
      onRun: vi.fn(),
      onState: vi.fn(),
    };
    dispose = subscribeToWorkspaceEvents(handlers);
    const old = latest();
    old.fail();
    vi.advanceTimersByTime(2000);
    const profile = {
      type: "employee.profile.changed",
      botId: "bot",
      sections: ["skills"],
      occurredAt: "2026-09-23T00:00:00Z",
    };
    old.open();
    old.emit("workspace.ready", { type: "workspace.ready", nodes: [] });
    old.emit("employee.profile.changed", profile);
    expect(handlers.onReady).not.toHaveBeenCalled();
    expect(handlers.onEmployeeProfileChanged).not.toHaveBeenCalled();
    expect(handlers.onState).toHaveBeenLastCalledWith("retrying");
    latest().emit("employee.profile.changed", profile);
    expect(handlers.onEmployeeProfileChanged).toHaveBeenCalledWith("bot", ["skills"]);
    dispose?.();
    latest().emit("employee.profile.changed", profile);
    expect(handlers.onEmployeeProfileChanged).toHaveBeenCalledTimes(1);
  });
  it("blocks closed channel output callbacks without closing an independent snapshot", () => {
    const snapshots = subscribe();
    const snapshotSource = latest();
    const handlers = {
      onReady: vi.fn(),
      onMessage: vi.fn(),
      onRun: vi.fn(),
      onProgress: vi.fn(),
      onFrame: vi.fn(),
      onOutput: vi.fn(),
      onState: vi.fn(),
    };
    const closeChannel = subscribeToChannelEvents("channel", handlers);
    const old = latest();
    old.fail();
    vi.advanceTimersByTime(2000);
    old.open();
    old.emit("run.output", {
      type: "run.output",
      channelId: "channel",
      output: {
        channelId: "channel",
        runId: "run",
        botId: "bot",
        sequence: 1,
        reset: false,
        text: "late",
      },
    });
    expect(handlers.onOutput).not.toHaveBeenCalled();
    expect(snapshotSource.closed).toBe(false);
    snapshotSource.emit("workspace.snapshot", frame());
    expect(snapshots.onSnapshot).toHaveBeenCalledTimes(1);
    closeChannel();
  });
});
