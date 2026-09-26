import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type BrowserCommand,
  type BrowserTaskAction,
  browserActionSchema,
} from "@openbot/protocol";
import { runBrowserTask } from "./browser-task.js";
import { createDockerProvider } from "./index.js";

const bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQf8AAAAASUVORK5CYII=",
  "base64",
);
const url = "https://example.test/form";
const frame = {
  url,
  base64: bytes.toString("base64"),
  width: 1,
  height: 1,
  capturedAt: new Date().toISOString(),
};
const expected = {
  url,
  snapshotId: 1,
  frameSha256: createHash("sha256").update(bytes).digest("hex"),
};
const page = { url, title: "Synthetic", text: "Observed page", truncated: false };
const snapshot = {
  url,
  snapshotId: 2,
  truncated: false,
  elements: [{ ref: "f1e2", role: "textbox", name: "Name" }],
};
function fixture(overrides: Record<string, unknown> = {}) {
  const calls: { path: string; body: unknown }[] = [];
  const request = async (path: string, body?: unknown) => {
    calls.push({ path, body });
    const result =
      path in overrides
        ? overrides[path]
        : ({
            "/control": { holder: "bot" },
            "/screenshot": frame,
            "/read": page,
            "/snapshot": snapshot,
          }[path] ?? {});
    if (result instanceof Error) throw result;
    return result;
  };
  return {
    calls,
    request,
    run: (action: BrowserTaskAction) =>
      runBrowserTask({
        request,
        checkUrl: async () => {},
        origins: ["https://example.test"],
        action,
        signal: new AbortController().signal,
      }),
  };
}

describe("approved page adapter", () => {
  it("reads bounded text/references through the existing computer, with no input", async () => {
    const f = fixture();
    expect(await f.run({ kind: "read" })).toEqual({
      frame,
      page: { ...page, snapshotId: 2, elements: snapshot.elements },
    });
    expect(f.calls.map((x) => x.path)).toEqual([
      "/control",
      "/screenshot",
      "/read",
      "/snapshot",
      "/screenshot",
    ]);
    expect(
      browserActionSchema.safeParse({ kind: "agent", operation: { kind: "read" } }).success,
    ).toBe(false);
  });
  it.each([
    { kind: "click", ref: "f1e2", expected },
    { kind: "type", ref: "f1e2", text: "你好 🌏", expected },
    { kind: "key", key: "Enter", expected },
    { kind: "scroll", deltaY: 500, expected },
  ] as BrowserTaskAction[])(
    "dispatches original $kind once before refreshing the snapshot",
    async (action) => {
      const f = fixture();
      await f.run(action);
      const input = f.calls.findIndex((x) => x.path === "/" + action.kind);
      expect(input).toBe(2);
      expect(f.calls.filter((x) => x.path === "/" + action.kind)).toHaveLength(1);
      expect(f.calls.findIndex((x) => x.path === "/snapshot")).toBeGreaterThan(input);
      if (action.kind === "click" || action.kind === "type")
        expect(f.calls[input]?.body).toMatchObject({ ref: "f1e2", snapshotId: 1 });
    },
  );
  it("retains uncertainty and never retries an input with a lost response", async () => {
    const f = fixture({ "/click": new Error("private content") });
    await expect(f.run({ kind: "click", ref: "f1e2", expected })).rejects.toMatchObject({
      message: "Browser task failed.",
      uncertain: true,
    });
    expect(f.calls.filter((x) => x.path === "/click")).toHaveLength(1);
    expect(f.calls.some((x) => x.path === "/snapshot")).toBe(false);
  });
  it.each([
    { "/control": { holder: "human" } },
    { "/screenshot": { ...frame, url: "https://other.test/" } },
    { "/screenshot": { ...frame, width: 2 } },
  ])("refuses input before dispatch when control or observation changes", async (overrides) => {
    const f = fixture(overrides);
    await expect(f.run({ kind: "click", ref: "f1e2", expected })).rejects.toThrow(
      "Browser task failed.",
    );
    expect(f.calls.some((x) => x.path === "/click")).toBe(false);
  });
  it.each([
    { "/read": { ...page, text: "x".repeat(16001) } },
    { "/snapshot": { ...snapshot, elements: [snapshot.elements[0], snapshot.elements[0]] } },
    { "/snapshot": { ...snapshot, elements: [{ ...snapshot.elements[0], selector: "body" }] } },
    { "/snapshot": { ...snapshot, snapshotId: 0 } },
    { "/read": { ...page, url: "https://other.test/" } },
  ])("refuses malformed, oversized or mixed-page observations", async (overrides) => {
    await expect(fixture(overrides).run({ kind: "read" })).rejects.toThrow("Browser task failed.");
  });
  it("rejects navigation outside the exact origin before sending it", async () => {
    const f = fixture();
    await expect(
      f.run({ kind: "navigate", url: "https://example.test.attacker.test/" }),
    ).rejects.toThrow();
    expect(f.calls.some((x) => x.path === "/navigate")).toBe(false);
  });
  it("shares the human-control latch and requires independent Node opt-in", async () => {
    const f = fixture();
    const provider = createDockerProvider({
      computerUrl: "http://127.0.0.1:4100",
      computerToken: "synthetic-token-123",
      enableBrowserSessions: true,
      enableBrowserTasks: true,
      inputOrigins: ["https://example.test"],
      resolveHost: async () => ["203.0.113.1"],
      fetcher: async (input, init) =>
        Response.json(
          await f.request(
            new URL(String(input)).pathname,
            init?.body ? JSON.parse(String(init.body)) : undefined,
          ),
        ),
    });
    const base = {
      type: "browser.command",
      protocolVersion: "0.9.0",
      nodeId: "node",
      requestId: randomUUID(),
      sessionId: randomUUID(),
      botId: randomUUID(),
      expiresAt: new Date(Date.now() + 25000).toISOString(),
      controlExpiresAt: new Date(Date.now() + 30000).toISOString(),
    } as const;
    await provider.browser!({ ...base, action: { kind: "take" } }, new AbortController().signal);
    f.calls.length = 0;
    await expect(
      provider.browserTask!(
        {
          ...base,
          requestId: randomUUID(),
          action: { kind: "agent", operation: { kind: "read" } },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("paused");
    expect(f.calls).toHaveLength(0);
    expect(
      createDockerProvider({
        computerUrl: "http://127.0.0.1:4100",
        computerToken: "synthetic-token-123",
        enableBrowserSessions: true,
      }).browserTask,
    ).toBeUndefined();
  });
});
