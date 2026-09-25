import { randomUUID } from "node:crypto";
import { type BrowserAction, type BrowserCommand, protocolVersion } from "@openbot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserCoordinator } from "./browser.js";
import { createDockerProvider } from "./index.js";

const botId = randomUUID();
const sessionId = randomUUID();
const bytes = Buffer.alloc(24);
bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
bytes.writeUInt32BE(1280, 16);
bytes.writeUInt32BE(800, 20);
const frame = {
  base64: bytes.toString("base64"),
  width: 1280,
  height: 800,
  capturedAt: new Date().toISOString(),
  url: "about:blank",
};
function command(action: BrowserAction): BrowserCommand {
  return {
    type: "browser.command",
    protocolVersion,
    nodeId: "worker",
    requestId: randomUUID(),
    botId,
    sessionId,
    expiresAt: new Date(Date.now() + 25_000).toISOString(),
    controlExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    action,
  };
}
function fixture() {
  const calls: Array<{ path: string; body: unknown }> = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json(
      path === "/screenshot" ? frame : { url: "https://example.test", title: "Example" },
    );
  });
  const provider = createDockerProvider({
    computerUrl: "http://127.0.0.1:4100",
    computerToken: "test-browser-token",
    enableBrowserSessions: true,
    fetcher,
    resolveHost: async () => ["203.0.113.10"],
  });
  const browser = provider.browser;
  const execute = provider.execute;
  if (!browser || !execute) throw new Error("Browser fixture requires an executable Provider.");
  return { provider: { ...provider, browser, execute }, calls, fetcher };
}
afterEach(() => vi.useRealTimers());
describe("employee browser adapter", () => {
  it("refuses input without exclusive control and forwards Unicode through human endpoints", async () => {
    const { provider, calls } = fixture();
    const signal = new AbortController().signal;
    await expect(
      provider.browser(command({ kind: "type", text: "secret" }), signal),
    ).rejects.toThrow(/control/);
    expect(calls).toHaveLength(0);
    await provider.browser(command({ kind: "take" }), signal);
    await provider.browser(command({ kind: "type", text: "你好. 🌏" }), signal);
    expect(calls).toContainEqual({ path: "/human/type", body: { text: "你好. 🌏" } });
    await expect(
      provider.browser(
        { ...command({ kind: "click", x: 1, y: 1 }), sessionId: randomUUID() },
        signal,
      ),
    ).rejects.toThrow(/control/);
    await provider.browser(command({ kind: "release" }), signal);
    await expect(
      provider.browser(command({ kind: "type", text: "after-release" }), signal),
    ).rejects.toThrow(/control/);
  });
  it("keeps Agent work paused after human lease expiry until explicit return", async () => {
    vi.useFakeTimers();
    const { provider } = fixture();
    const signal = new AbortController().signal;
    await provider.browser(command({ kind: "take" }), signal);
    vi.advanceTimersByTime(31_000);
    await expect(provider.browser(command({ kind: "type", text: "late" }), signal)).rejects.toThrow(
      /control/,
    );
    const run = () =>
      provider.execute(
        { nodeId: "worker", workDirectory: "/tmp", signal },
        {
          runId: randomUUID(),
          channelId: randomUUID(),
          botId,
          title: "test",
          instruction: "https://example.test",
          executionProfile: "docker-linux",
        },
        () => {},
      );
    await expect(run()).rejects.toThrow(/paused/);
    await provider.browser(command({ kind: "take" }), signal);
    await provider.browser(command({ kind: "release" }), signal);
    expect((await run()).ok).toBe(true);
  });
  it("validates navigation before releasing upstream control and re-takes after failed navigation", async () => {
    const { provider, fetcher, calls } = fixture();
    const signal = new AbortController().signal;
    await provider.browser(command({ kind: "take" }), signal);
    calls.length = 0;
    await expect(
      provider.browser(command({ kind: "navigate", url: "http://127.0.0.1/admin" }), signal),
    ).rejects.toThrow(/Private/);
    await expect(
      provider.browser(command({ kind: "navigate", url: "file:///etc/passwd" }), signal),
    ).rejects.toThrow(/HTTP/);
    expect(calls).toHaveLength(0);
    fetcher
      .mockResolvedValueOnce(Response.json({}))
      .mockRejectedValueOnce(new Error("navigation lost"));
    await expect(
      provider.browser(command({ kind: "navigate", url: "https://example.test" }), signal),
    ).rejects.toThrow();
    expect(calls.at(-1)?.path).toBe("/control/take");
  });
  it("refuses invalid PNGs and bounds the backend body before JSON parsing", async () => {
    const { provider, fetcher } = fixture();
    const signal = new AbortController().signal;
    fetcher.mockResolvedValueOnce(Response.json({ ...frame, width: 2 }));
    await expect(provider.browser(command({ kind: "observe" }), signal)).rejects.toThrow(
      /Invalid browser frame/,
    );
    fetcher.mockResolvedValueOnce(
      new Response("x".repeat(8 * 1024 * 1024 + 1), {
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(provider.browser(command({ kind: "observe" }), signal)).rejects.toThrow(
      /over limit/,
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function reviewFixture() {
  const target = "https://fixture.example/";
  const approval = deferred<{ approvalId: string; status: "approved" | "rejected" | "expired" }>();
  const requested = deferred<void>();
  const takeSent = deferred<void>();
  const calls: string[] = [];
  const state = { holder: "bot", changed: false, click: "ok", pendingTake: false };
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path === "/control/take") {
      state.holder = "human";
      takeSent.resolve();
      if (state.pendingTake)
        await new Promise<void>((_resolve, reject) => {
          const aborted = () => reject(new Error("Synthetic lost takeover response"));
          if (init?.signal?.aborted) aborted();
          else init?.signal?.addEventListener("abort", aborted, { once: true });
        });
    }
    if (path === "/control/release") state.holder = "bot";
    if (path === "/control") return Response.json({ holder: state.holder });
    if (path === "/screenshot") {
      const image = Buffer.from(bytes);
      if (state.changed) image[8] = 1;
      return Response.json({ ...frame, url: target, base64: image.toString("base64") });
    }
    if (path === "/snapshot")
      return Response.json({
        url: target,
        snapshotId: 1,
        truncated: false,
        elements: [{ role: "button", name: "Show preview", ref: "e1" }],
      });
    if (path === "/click") {
      if (state.click === "unknown") throw new Error("Synthetic lost click response");
      if (state.click === "cancelled") controller.abort();
      return Response.json({
        action: "click",
        ref: state.click === "malformed" ? "e2" : "e1",
        url: target,
      });
    }
    return Response.json({ url: target, title: "Synthetic" });
  });
  const provider = createDockerProvider({
    computerUrl: "http://127.0.0.1:4100",
    computerToken: "synthetic-only",
    enableBrowserSessions: true,
    inputOrigins: [new URL(target).origin],
    resolveHost: async () => ["203.0.113.10"],
    fetcher,
  });
  const executeProvider = provider.execute;
  const browserProvider = provider.browser;
  if (!executeProvider || !browserProvider) throw new Error("Executable browser fixture required.");
  const execute = (id = botId) =>
    executeProvider(
      { nodeId: "worker", workDirectory: "/tmp", signal: controller.signal },
      {
        runId: randomUUID(),
        channelId: randomUUID(),
        botId: id,
        title: "Synthetic",
        instruction: `Open ${target} and click button "Show preview"`,
        executionProfile: "docker-linux",
      },
      () => {},
      undefined,
      async () => {
        requested.resolve();
        return approval.promise;
      },
    );
  const browser = (kind: "take" | "release", signal = new AbortController().signal) =>
    browserProvider(command({ kind }), signal);
  return { execute, browser, requested, takeSent, approval, calls, state, controller };
}

describe("approval wait releases the human-control queue", () => {
  it("finishes Owner take while approval is still pending, then refuses the approved click", async () => {
    const f = reviewFixture();
    const run = f.execute();
    const outcome = expect(run).rejects.toThrow(/paused/);
    await f.requested.promise;
    await f.browser("take");
    expect(f.calls).toContain("/control/take");
    expect(f.calls).not.toContain("/click");
    f.approval.resolve({ approvalId: "approved", status: "approved" });
    await outcome;
    expect(f.calls).not.toContain("/click");
  });
  it("does not revive a pending approval after take and explicit release", async () => {
    const f = reviewFixture();
    const outcome = expect(f.execute()).rejects.toThrow(/control changed/);
    await f.requested.promise;
    await f.browser("take");
    await f.browser("release");
    expect(f.state.holder).toBe("bot");
    f.approval.resolve({ approvalId: "old-approved", status: "approved" });
    await outcome;
    expect(f.calls).not.toContain("/click");
  });
  it("invalidates the generation before an uncertain timed-out take dispatch", async () => {
    const f = reviewFixture();
    const outcome = expect(f.execute()).rejects.toThrow(/control changed/);
    await f.requested.promise;
    f.state.pendingTake = true;
    const takeController = new AbortController();
    const takeover = expect(f.browser("take", takeController.signal)).rejects.toThrow(/cancelled/);
    await f.takeSent.promise;
    takeController.abort(new DOMException("Synthetic deadline", "TimeoutError"));
    await takeover;
    await f.browser("release");
    expect(f.state.holder).toBe("bot");
    f.approval.resolve({ approvalId: "old-approved", status: "approved" });
    await outcome;
    expect(f.calls).not.toContain("/click");
  });
  it("retains active-Bot exclusivity across the unlocked approval wait", async () => {
    const f = reviewFixture();
    const run = f.execute();
    await f.requested.promise;
    await expect(f.execute()).rejects.toThrow(/already has an active/);
    expect(f.calls.filter((p) => p === "/navigate")).toHaveLength(1);
    f.approval.resolve({ approvalId: "approved", status: "approved" });
    expect((await run).ok).toBe(true);
    expect(f.calls.filter((p) => p === "/click")).toHaveLength(1);
  });
  it.each(["cancel", "changed", "human", "rejected", "expired"])(
    "blocks commit after %s during approval",
    async (condition) => {
      const f = reviewFixture();
      const outcome = expect(f.execute()).rejects.toThrow();
      await f.requested.promise;
      if (condition === "cancel") f.controller.abort();
      if (condition === "changed") f.state.changed = true;
      if (condition === "human") f.state.holder = "human";
      f.approval.resolve({
        approvalId: "decision",
        status: condition === "rejected" || condition === "expired" ? condition : "approved",
      });
      await outcome;
      expect(f.calls).not.toContain("/click");
    },
  );
  it.each(["unknown", "malformed", "cancelled"])(
    "never resends a click after its %s response",
    async (condition) => {
      const f = reviewFixture();
      const outcome = expect(f.execute()).rejects.toThrow();
      await f.requested.promise;
      f.state.click = condition;
      f.approval.resolve({ approvalId: "approved", status: "approved" });
      await outcome;
      expect(f.calls.filter((p) => p === "/click")).toHaveLength(1);
    },
  );
});

it("keeps control generations separate between Bots", async () => {
  const coordinator = new BrowserCoordinator(
    async () => frame,
    async () => {},
  );
  const signal = new AbortController().signal;
  const otherBot = randomUUID();
  const first = await coordinator.run(botId, signal, async (generation) => generation);
  const other = await coordinator.run(otherBot, signal, async (generation) => generation);
  await coordinator.command(command({ kind: "take" }), signal);
  await coordinator.command(command({ kind: "release" }), signal);
  await expect(coordinator.resume(botId, signal, first, async () => true)).rejects.toThrow(
    "control changed",
  );
  await expect(coordinator.resume(otherBot, signal, other, async () => true)).resolves.toBe(true);
});
it("compares the generation after acquiring the queue, not before waiting for it", async () => {
  const coordinator = new BrowserCoordinator(
    async () => frame,
    async () => {},
  );
  const signal = new AbortController().signal;
  const generation = await coordinator.run(botId, signal, async (value) => value);
  const entered = deferred<void>();
  const release = deferred<void>();
  const shortOperation = coordinator.run(botId, signal, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const take = coordinator.command(command({ kind: "take" }), signal);
  const returned = coordinator.command(command({ kind: "release" }), signal);
  const effect = vi.fn(async () => true);
  const resumed = expect(coordinator.resume(botId, signal, generation, effect)).rejects.toThrow(
    "control changed",
  );
  release.resolve();
  await shortOperation;
  await take;
  await returned;
  await resumed;
  expect(effect).not.toHaveBeenCalled();
});
