import type { WorkspaceSnapshot } from "@openbot/domain";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceSnapshotReader } from "./workspace-snapshot-reader.js";

afterEach(() => vi.useRealTimers());

it("starts a fresh read for callers arriving after the prior query has started", async () => {
  vi.useFakeTimers();
  const resolvers: Array<(value: WorkspaceSnapshot) => void> = [];
  const read = vi.fn(() => new Promise<WorkspaceSnapshot>((resolve) => resolvers.push(resolve)));
  const reader = new WorkspaceSnapshotReader(read);
  const first = reader.read();
  await vi.advanceTimersByTimeAsync(0);
  const second = reader.read();
  const before = { counts: { channels: 1 } } as WorkspaceSnapshot;
  const after = { counts: { channels: 2 } } as WorkspaceSnapshot;
  resolvers[0]?.(before);
  expect(await first).toBe(before);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  resolvers[1]?.(after);
  expect(await second).toBe(after);
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels pool waiters promptly while retaining one bounded underlying read", async () => {
  vi.useFakeTimers();
  let finish: ((value: WorkspaceSnapshot) => void) | undefined;
  const read = vi.fn(
    () =>
      new Promise<WorkspaceSnapshot>((resolve) => {
        finish = resolve;
      }),
  );
  const reader = new WorkspaceSnapshotReader(read);
  const controller = new AbortController();
  const first = reader.read(controller.signal);
  const rejected = expect(first).rejects.toThrow("workspace_snapshot_cancelled");
  controller.abort();
  await rejected;
  for (let i = 0; i < 100; i++) {
    const attempt = new AbortController();
    const waiting = reader.read(attempt.signal);
    const cancelled = expect(waiting).rejects.toThrow("workspace_snapshot_cancelled");
    attempt.abort();
    await cancelled;
  }
  expect(read).toHaveBeenCalledOnce();
  const timed = expect(reader.read()).rejects.toThrow("workspace_snapshot_timeout");
  await vi.advanceTimersByTimeAsync(10_000);
  await timed;
  await expect(reader.read()).rejects.toThrow("workspace_snapshot_busy");
  expect(read).toHaveBeenCalledOnce();
  finish?.({} as WorkspaceSnapshot);
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  const next = reader.read();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  finish?.({} as WorkspaceSnapshot);
  await next;
});

it("bounds simultaneous waiters and removes private read errors", async () => {
  let fail: ((error: Error) => void) | undefined;
  const reader = new WorkspaceSnapshotReader(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const waiters = Array.from({ length: 32 }, () => reader.read());
  const outcomes = Promise.allSettled(waiters);
  await expect(reader.read()).rejects.toThrow("workspace_snapshot_busy");
  fail?.(new Error("private SQL or connection string"));
  for (const result of await outcomes) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected")
      expect(result.reason.message).toBe("workspace_snapshot_unavailable");
  }
});
