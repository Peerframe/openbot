import { randomUUID } from "node:crypto";
import type { BrowserCommand } from "@openbot/protocol";
import { describe, expect, it, vi } from "vitest";
import { BrowserCoordinator } from "./browser.js";
import { createDockerProvider } from "./index.js";

function command(operation: "status" | "restart" | "clear"): BrowserCommand {
  return {
    type: "browser.command",
    protocolVersion: "0.9.0",
    nodeId: "worker",
    requestId: randomUUID(),
    sessionId: randomUUID(),
    botId: randomUUID(),
    expiresAt: new Date(Date.now() + 25000).toISOString(),
    action: { kind: "maintenance", operation },
  };
}
const png = Buffer.alloc(24);
png.set([137, 80, 78, 71, 13, 10, 26, 10]);
png.writeUInt32BE(1, 16);
png.writeUInt32BE(1, 20);
const frame = {
  base64: png.toString("base64"),
  width: 1,
  height: 1,
  capturedAt: new Date().toISOString(),
  url: "about:blank",
};
describe("original browser lifecycle adapter", () => {
  it("has an explicit disabled-by-default capability", () => {
    const options = {
      computerUrl: "http://127.0.0.1:4100",
      computerToken: "fixture",
      enableBrowserSessions: true,
    };
    expect(createDockerProvider(options).browserMaintenance).toBeUndefined();
    expect(
      createDockerProvider({ ...options, enableBrowserMaintenance: true }).capabilityManifest,
    ).toContainEqual({
      id: "browser.maintenance",
      version: 1,
      providerId: "docker",
      constraints: {},
    });
    expect(() =>
      createDockerProvider({
        ...options,
        enableBrowserSessions: false,
        enableBrowserMaintenance: true,
      }),
    ).toThrow();
  });
  it("stops/restarts through existing endpoints and retains pause after confirmed lifecycle", async () => {
    const paths: string[] = [];
    const request = vi.fn(async (_bot: string, path: string) => {
      paths.push(path);
      return path === "/computers/stop"
        ? { stopped: true }
        : path === "/screenshot"
          ? frame
          : { status: "ok", browser: true };
    });
    const coordinator = new BrowserCoordinator(request, async () => {});
    const c = command("restart");
    expect(await coordinator.maintenance(c, new AbortController().signal)).toEqual({
      running: true,
      profileBytes: null,
    });
    expect(paths).toEqual(["/computers/stop", "/screenshot", "/health"]);
    await expect(
      coordinator.run(c.botId, new AbortController().signal, async () => true),
    ).rejects.toThrow("paused");
  });
  it("requires the exact reset acknowledgment and never retries or resumes on uncertainty", async () => {
    const request = vi.fn(async () => ({ reset: true, botId: "other", password: "untrusted" }));
    const coordinator = new BrowserCoordinator(request, async () => {});
    const c = command("clear");
    await expect(coordinator.maintenance(c, new AbortController().signal)).rejects.toThrow(
      "unconfirmed",
    );
    expect(request).toHaveBeenCalledTimes(1);
    await expect(
      coordinator.run(c.botId, new AbortController().signal, async () => true),
    ).rejects.toThrow("paused");
  });
  it("projects only health and bounded usage without starting a browser", async () => {
    const request = vi.fn(async () => ({
      status: "ok",
      browser: false,
      profile: { path: "private" },
      identity: "secret",
    }));
    const coordinator = new BrowserCoordinator(request, async () => {});
    expect(await coordinator.maintenance(command("status"), new AbortController().signal)).toEqual({
      running: false,
      profileBytes: null,
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      "/health",
      expect.any(AbortSignal),
      undefined,
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      "/computers/profile-usage",
      expect.any(AbortSignal),
      undefined,
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    0,
    12345,
    Number.MAX_SAFE_INTEGER,
    null,
    -1,
    1.5,
    true,
    "123",
    Number.NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    undefined,
  ])("reports only a safe measured byte count: %s", async (profileBytes) => {
    const request = vi.fn(async (_bot: string, path: string) =>
      path === "/health"
        ? { status: "ok", browser: true }
        : { profileBytes, path: "/private/profile", cookies: "private" },
    );
    const c = command("status");
    const coordinator = new BrowserCoordinator(request, async () => {});
    expect(await coordinator.maintenance(c, new AbortController().signal)).toEqual({
      running: true,
      profileBytes:
        typeof profileBytes === "number" && Number.isSafeInteger(profileBytes) && profileBytes >= 0
          ? profileBytes
          : null,
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      c.botId,
      "/computers/profile-usage",
      expect.any(AbortSignal),
      undefined,
    );
  });

  it("keeps unavailable usage unknown while preserving cancellation", async () => {
    const abort = new AbortController();
    const request = vi.fn(async (_bot: string, path: string) => {
      if (path === "/health") return { status: "ok", browser: false };
      throw new Error("Older upstream returned 404");
    });
    const coordinator = new BrowserCoordinator(request, async () => {});
    expect(await coordinator.maintenance(command("status"), abort.signal)).toEqual({
      running: false,
      profileBytes: null,
    });
    request.mockImplementation(async (_bot: string, path: string) => {
      if (path === "/health") return { status: "ok", browser: false };
      abort.abort();
      throw new Error("Cancelled measurement");
    });
    await expect(coordinator.maintenance(command("status"), abort.signal)).rejects.toThrow();
  });
});
