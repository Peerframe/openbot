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
  it("projects only a boolean and observes health without starting a browser", async () => {
    const request = vi.fn(async () => ({
      status: "ok",
      browser: false,
      profile: { path: "private" },
      identity: "secret",
    }));
    const coordinator = new BrowserCoordinator(request, async () => {});
    expect(await coordinator.maintenance(command("status"), new AbortController().signal)).toEqual({
      running: false,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      "/health",
      expect.any(AbortSignal),
      undefined,
    );
  });
});
