import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@openbot/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CompatibilityScenario,
  startCompatibilityFixture,
} from "./plugin-preflight-fixture.js";
import { createPluginRoutes } from "./plugin-routes.js";
import { PluginService } from "./plugin-service.js";
import { FilePluginStore } from "./plugin-store.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(scenario: CompatibilityScenario) {
  const peer = await startCompatibilityFixture(scenario);
  cleanup.push(() => peer.close());
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-preflight-test-")));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new FilePluginStore(join(directory, "private", "plugins.json"), {
    windowsTrustRoot: directory,
    windowsAcl: {
      protectDirectory: async () => {},
      verifyDirectory: async () => {},
      protectAndVerifyFile: async () => {},
      verifyFile: async () => {},
    },
  });
  const service = new PluginService({
    store,
    localEndpoints: [peer.endpoint],
    assertScope: async () => {},
    botExists: async () => true,
  });
  cleanup.push(() => service.close());
  return {
    peer,
    service,
    routes: createPluginRoutes(service),
    input: { name: "Fixture", endpoint: peer.endpoint },
  };
}

describe("installation compatibility preflight", () => {
  it.each<[CompatibilityScenario, string]>([
    ["input-schema", "schema_unsupported"],
    ["output-schema", "schema_unsupported"],
    ["required-task", "execution_unsupported"],
    ["auth", "authentication_required"],
    ["forbidden", "access_denied"],
    ["transport", "transport_unsupported"],
    ["reset-content", "transport_unsupported"],
    ["protocol", "protocol_unsupported"],
    ["pagination", "catalog_unsupported"],
  ])(
    "blocks %s preview and installation without grants or tool calls",
    async (scenario, compatibility) => {
      const { peer, service, routes, input } = await fixture(scenario);
      for (const path of ["/plugins/preview", "/plugins"]) {
        const response = await routes.request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...input,
            ...(path === "/plugins" ? { reviewedDigest: "a".repeat(64) } : {}),
          }),
        });
        expect(response.ok).toBe(false);
        const text = await response.text();
        expect(JSON.parse(text)).toMatchObject({ compatibility });
        expect(text).not.toMatch(/private-response|unsupported-private|untrusted.invalid/u);
      }
      expect((await service.snapshot()).plugins).toEqual([]);
      expect(peer.methods).not.toContain("tools/call");
    },
  );

  it("reports the parent's timeout without turning it into an authentication failure", async () => {
    const { service, input, peer } = await fixture("timeout");
    await expect(service.preview(input, AbortSignal.timeout(100))).rejects.toMatchObject({
      compatibility: "timeout",
    });
    expect((await service.snapshot()).plugins).toEqual([]);
    expect(peer.methods).not.toContain("tools/call");
  });

  it("accepts bearer-authenticated discovery but starts disabled without grants", async () => {
    const { service, input, peer } = await fixture("auth");
    const credentials = { ...input, token: "fixture-token" };
    const preview = await service.preview(credentials, AbortSignal.timeout(5000));
    const installed = await service.install(
      { ...credentials, reviewedDigest: preview.digest },
      AbortSignal.timeout(5000),
    );
    expect(installed.enabled).toBe(false);
    expect(installed.grants).toEqual([]);
    expect(peer.methods).not.toContain("tools/call");
  });

  it("rejects a newly required-task declaration even for a previously granted installation", async () => {
    const { service, input, peer } = await fixture("valid");
    const preview = await service.preview(input, AbortSignal.timeout(5000));
    let plugin = await service.install(
      { ...input, reviewedDigest: preview.digest },
      AbortSignal.timeout(5000),
    );
    plugin = await service.grant(plugin.id, "bot-one", {
      revision: plugin.revision,
      tools: [{ name: "echo", mode: "read" }],
    });
    plugin = await service.setEnabled(plugin.id, { revision: plugin.revision, enabled: true });
    peer.setScenario("required-task");
    await expect(
      service.call(
        {
          id: "run-one",
          botId: "bot-one",
          channelId: "channel-one",
          status: "running",
          executionProfile: "none",
        } as Run,
        { pluginId: plugin.id, revision: plugin.revision, toolName: "echo", arguments: {} },
        AbortSignal.timeout(5000),
      ),
    ).rejects.toMatchObject({ compatibility: "execution_unsupported" });
    await expect(
      service.applyUpdate(
        plugin.id,
        { revision: plugin.revision, reviewedDigest: preview.digest },
        AbortSignal.timeout(5000),
      ),
    ).rejects.toMatchObject({ compatibility: "execution_unsupported" });
    expect(peer.methods).not.toContain("tools/call");
  });
});
