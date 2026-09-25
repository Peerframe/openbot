import { randomUUID } from "node:crypto";
import { type BrowserCommand, protocolVersion } from "@openbot/protocol";
import type { ComputerProvider } from "@openbot/provider-sdk";
import { describe, expect, it, vi } from "vitest";
import { BrowserCommandHost } from "./browser-host.js";

const frame = {
  base64: "iVBORw0KGgo=",
  width: 1,
  height: 1,
  capturedAt: new Date().toISOString(),
  url: "about:blank",
};
function command(): BrowserCommand {
  return {
    type: "browser.command",
    protocolVersion,
    nodeId: "worker",
    requestId: randomUUID(),
    sessionId: randomUUID(),
    botId: randomUUID(),
    expiresAt: new Date(Date.now() + 25_000).toISOString(),
    action: { kind: "observe" },
  };
}
function provider(): ComputerProvider {
  return {
    id: "docker",
    displayName: "Browser",
    platforms: ["linux"],
    capabilities: ["browser"],
    capabilityManifest: [
      { id: "browser.session", version: 1, providerId: "docker", constraints: {} },
    ],
    browser: vi.fn(async () => frame),
  };
}
describe("Node browser command host", () => {
  it("consumes each request once and rejects foreign/expired commands", async () => {
    const runtime = provider();
    const host = new BrowserCommandHost("worker", [runtime]);
    const c = command();
    expect((await host.execute(c)).ok).toBe(true);
    expect((await host.execute(c)).error).toBe("expired");
    expect((await host.execute({ ...command(), nodeId: "another" })).ok).toBe(false);
    expect((await host.execute({ ...command(), expiresAt: new Date(0).toISOString() })).ok).toBe(
      false,
    );
    expect(runtime.browser).toHaveBeenCalledTimes(1);
  });
  it("aborts in-flight work on disconnect and does not expose backend errors", async () => {
    const runtime = provider();
    runtime.browser = vi.fn(
      async (_command, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("secret body")), { once: true }),
        ),
    );
    const host = new BrowserCommandHost("worker", [runtime]);
    const work = host.execute(command());
    host.disconnect();
    expect(await work).toMatchObject({ ok: false, error: "expired" });
    runtime.browser = async () => {
      throw new Error("password=secret");
    };
    expect(JSON.stringify(await host.execute(command()))).not.toContain("password");
  });
});
