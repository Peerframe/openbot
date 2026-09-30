import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const forkMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ fork: forkMock }));
// Fake time must also drive the promise-based delay used by the shutdown observer.
vi.mock("node:timers/promises", () => ({
  setTimeout: (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
}));
import { launchThroughDisposableParent } from "./python-product-probe.ts";
const SECRET_ENV = { OPENBOT_PORT: "48123", OPENBOT_OWNER_PASSWORD: "synthetic-secret" };
class FakeParent extends EventEmitter {
  readonly sent: unknown[] = [];
  readonly kills: string[] = [];
  sendThrows = false;
  onSend: ((message: unknown) => void) | undefined;
  send(message: unknown): boolean {
    if (this.sendThrows) throw new Error("channel closed");
    this.sent.push(message);
    this.onSend?.(message);
    return true;
  }
  kill(signal: string): boolean {
    this.kills.push(signal);
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}
function install(parent: FakeParent): void {
  forkMock.mockReturnValue(parent);
}
function listenerCounts(parent: FakeParent): Record<string, number> {
  return {
    message: parent.listenerCount("message"),
    error: parent.listenerCount("error"),
    close: parent.listenerCount("close"),
  };
}
beforeEach(() => forkMock.mockReset());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("launchThroughDisposableParent startup", () => {
  it("forks itself with fixed env and IPC-only stdio, sending env over IPC only", async () => {
    const parent = new FakeParent();
    parent.onSend = () => queueMicrotask(() => parent.emit("message", { ready: true }));
    install(parent);
    const managed = await launchThroughDisposableParent("/runtime", "/dist", SECRET_ENV);
    const [modulePath, argv, options] = forkMock.mock.calls[0] ?? [];
    expect(String(modulePath)).toMatch(/python-product-probe\.ts$/u);
    expect(argv).toEqual(["--parent-child"]);
    expect(options).toEqual({
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    expect(JSON.stringify([argv, options])).not.toContain("synthetic-secret");
    expect(parent.sent).toEqual([
      { runtimeRoot: "/runtime", desktopDist: "/dist", env: SECRET_ENV },
    ]);
    expect(managed.isAlive()).toBe(true);
    expect(listenerCounts(parent)).toEqual({ message: 0, error: 0, close: 1 });
  });
  it.each([
    ["refused", (p: FakeParent) => p.emit("message", { ready: false }), "Disposable API failed."],
    ["unknown message", (p: FakeParent) => p.emit("message", "ready"), "Disposable API failed."],
    [
      "truthy non-true ready",
      (p: FakeParent) => p.emit("message", { ready: "true" }),
      "Disposable API failed.",
    ],
    ["error", (p: FakeParent) => p.emit("error", new Error("spawn")), "Disposable parent failed."],
    ["early close", (p: FakeParent) => p.emit("close", 1, null), "Disposable parent exited."],
  ])("rejects on %s and kills then waits for close", async (_name, act, message) => {
    const parent = new FakeParent();
    parent.onSend = () => queueMicrotask(() => act(parent));
    install(parent);
    await expect(launchThroughDisposableParent("/runtime", "/dist", SECRET_ENV)).rejects.toThrow(
      message,
    );
    expect(parent.kills).toEqual(["SIGKILL"]);
    expect(listenerCounts(parent).message).toBe(0);
    expect(listenerCounts(parent).error).toBe(0);
  });
  it("rejects when send throws and cleans up", async () => {
    const parent = new FakeParent();
    parent.sendThrows = true;
    install(parent);
    await expect(launchThroughDisposableParent("/runtime", "/dist", SECRET_ENV)).rejects.toThrow(
      "Disposable parent failed.",
    );
    expect(parent.kills).toEqual(["SIGKILL"]);
    expect(listenerCounts(parent)).toEqual({ message: 0, error: 0, close: 0 });
  });
  it("times out after 90 seconds without real waiting and clears its timer", async () => {
    vi.useFakeTimers();
    const parent = new FakeParent();
    install(parent);
    const pending = launchThroughDisposableParent("/runtime", "/dist", SECRET_ENV);
    const outcome = expect(pending).rejects.toThrow("Disposable candidate parent timed out.");
    await vi.advanceTimersByTimeAsync(89_999);
    expect(parent.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(parent.kills).toEqual(["SIGKILL"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears the readiness timer after ready", async () => {
    vi.useFakeTimers();
    const parent = new FakeParent();
    parent.onSend = () => queueMicrotask(() => parent.emit("message", { ready: true }));
    install(parent);
    await launchThroughDisposableParent("/runtime", "/dist", SECRET_ENV);
    expect(vi.getTimerCount()).toBe(0);
  });
});
describe("managed stop", () => {
  async function ready(): Promise<{
    parent: FakeParent;
    managed: Awaited<ReturnType<typeof launchThroughDisposableParent>>;
  }> {
    const parent = new FakeParent();
    parent.onSend = () => queueMicrotask(() => parent.emit("message", { ready: true }));
    install(parent);
    return {
      parent,
      managed: await launchThroughDisposableParent("/runtime", "/dist", SECRET_ENV),
    };
  }
  it("kills, waits for close, then confirms health is unreachable; repeat stop is safe", async () => {
    const { parent, managed } = await ready();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await managed.stop();
    expect(parent.kills).toEqual(["SIGKILL"]);
    expect(managed.isAlive()).toBe(false);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:48123/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await managed.stop();
    expect(managed.isAlive()).toBe(false);
  });
  it("fails when the API stays reachable for 15 seconds", async () => {
    const { managed } = await ready();
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    const outcome = expect(managed.stop()).rejects.toThrow(
      "Python API survived its disposable parent.",
    );
    await vi.advanceTimersByTimeAsync(15_100);
    await outcome;
    expect(managed.isAlive()).toBe(false);
  });
});
