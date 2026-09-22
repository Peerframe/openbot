import type { WorkspaceSnapshot, WorkspaceSnapshotFrame } from "@openbot/domain";
import { WorkspaceSnapshotReader } from "./workspace-snapshot-reader.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maximumWorkspaceSnapshotBytes, streamWorkspaceSnapshots } from "./workspace-snapshots.js";

const snapshot: WorkspaceSnapshot = {
  channels: [],
  bots: [],
  nodes: [],
  runs: [],
  approvals: [],
  artifacts: [],
  progress: [],
  counts: { channels: 0, bots: 0, connectedNodes: 0, activeRuns: 71 },
};

function fixture(read = vi.fn(async () => snapshot)) {
  const controller = new AbortController();
  let invalidate = () => {};
  const unsubscribe = vi.fn();
  const write = vi.fn<(frame: WorkspaceSnapshotFrame) => Promise<void>>(async () => {});
  const abort = vi.fn(() => controller.abort());
  const reader = new WorkspaceSnapshotReader(read);
  const done = streamWorkspaceSnapshots({
    read: (signal) => reader.read(signal),
    write,
    abort,
    signal: controller.signal,
    subscribe(listener) {
      invalidate = listener;
      return unsubscribe;
    },
  });
  return { controller, read, write, abort, done, unsubscribe, invalidate: () => invalidate() };
}

afterEach(() => vi.useRealTimers());

describe("authoritative workspace snapshot stream", () => {
  it("preserves global counts outside the recent page and coalesces repeated invalidations", async () => {
    vi.useFakeTimers();
    const stream = fixture();
    await vi.advanceTimersByTimeAsync(0);
    const initial = stream.write.mock.calls[0]?.[0];
    expect(initial).toMatchObject({
      version: 1,
      sequence: 1,
      snapshot: { runs: [], counts: { activeRuns: 71 } },
    });
    for (let i = 0; i < 1000; i++) stream.invalidate();
    await vi.advanceTimersByTimeAsync(999);
    expect(stream.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stream.write.mock.calls[1]?.[0]).toMatchObject({
      streamId: initial?.streamId,
      sequence: 2,
    });
    expect(stream.read).toHaveBeenCalledTimes(2);
    stream.controller.abort();
    await stream.done;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stream.read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serializes reads and retains an invalidation arriving during a read", async () => {
    vi.useFakeTimers();
    let resolveRead: ((value: WorkspaceSnapshot) => void) | undefined;
    const read = vi.fn(
      () =>
        new Promise<WorkspaceSnapshot>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const stream = fixture(read);
    stream.invalidate();
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(1);
    resolveRead?.(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    stream.controller.abort();
    await expect(stream.done).rejects.toThrow("workspace_snapshot_cancelled");
    resolveRead?.(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.write).toHaveBeenCalledTimes(1);
    expect(stream.unsubscribe).toHaveBeenCalled();
  });

  it("recovers unannounced changes periodically and starts a fresh ordering scope on reconnect", async () => {
    vi.useFakeTimers();
    const first = fixture();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(first.read).toHaveBeenCalledTimes(2);
    first.controller.abort();
    await first.done;
    const second = fixture();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.write.mock.calls[0]?.[0].sequence).toBe(1);
    expect(second.write.mock.calls[0]?.[0].streamId).not.toBe(
      first.write.mock.calls[0]?.[0].streamId,
    );
    second.controller.abort();
    await second.done;
  });

  it("rejects oversized output and releases subscriptions after read failure", async () => {
    vi.useFakeTimers();
    const large = {
      ...snapshot,
      channels: [{ id: "x".repeat(maximumWorkspaceSnapshotBytes) }],
    } as WorkspaceSnapshot;
    const stream = fixture(vi.fn(async () => large));
    await stream.done;
    expect(stream.abort).toHaveBeenCalledOnce();
    expect(stream.write).not.toHaveBeenCalled();
    const failed = fixture(
      vi.fn(async () => {
        throw new Error("private database failure");
      }),
    );
    await expect(failed.done).rejects.toThrow();
    expect(failed.write).not.toHaveBeenCalled();
    expect(failed.unsubscribe).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminates a stalled write and reauthenticates through bounded connection lifetime", async () => {
    vi.useFakeTimers();
    const stream = fixture();
    stream.write.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          stream.controller.signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    await stream.done;
    expect(stream.abort).toHaveBeenCalledOnce();
    const live = fixture();
    await vi.advanceTimersByTimeAsync(300_000);
    await live.done;
    expect(live.abort).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
