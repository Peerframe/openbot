import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@openbot/domain";
import type { WindowsSecretAcl } from "@openbot/windows-secret-acl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startExamplePlugin } from "../../../packages/mcp-example/src/plugin-example.js";
import { PluginService } from "./plugin-service.js";
import { FilePluginStore } from "./plugin-store.js";
import type { PluginConnection } from "./plugin-transport.js";
import { pluginManifest } from "./plugin-types.js";

const run = { id: "run-one", botId: "bot-one", channelId: "channel-one", status: "running" } as Run;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
/** Lifecycle suites skip real PowerShell ACL; native coverage lives in *-windows-acl*.test.ts. */
const noopWindowsAcl: WindowsSecretAcl = {
  protectDirectory: async () => {},
  verifyDirectory: async () => {},
  protectAndVerifyFile: async () => {},
  verifyFile: async () => {},
};

async function fixture(owner = false) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "openbot-plugin-content-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const resources = [
    { uri: "notes://current", name: "Notes", description: "Read notes", mimeType: "text/plain" },
  ];
  const prompts = [
    {
      name: "review",
      description: "Review selected text",
      arguments: [{ name: "text", required: true }],
    },
  ];
  const read = vi.fn(async () => ({ contents: [{ uri: resources[0]?.uri, text: "notes" }] }));
  const prompt = vi.fn(async (_name: string, args: Record<string, string>) => ({
    messages: [{ role: "user", content: { type: "text", text: args.text } }],
  }));
  const connection: PluginConnection = {
    tools: async () => [],
    resources: async () => structuredClone(resources),
    prompts: async () => structuredClone(prompts),
    readResource: read,
    getPrompt: prompt,
    call: async () => ({}),
    close: async () => {},
  };
  const scope = vi.fn(async () => {});
  const service = new PluginService({
    store: new FilePluginStore(join(dir, "private", "plugins.json"), {
      windowsAcl: noopWindowsAcl,
      windowsTrustRoot: dir,
    }),
    assertScope: scope,
    ...(owner ? { assertOwnerContentScope: scope } : {}),
    botExists: async (id) => id === run.botId,
    connector: async () => connection,
  });
  cleanups.push(async () => service.close());
  const input = { name: "Content", endpoint: "https://plugin.example.com/mcp" };
  const preview = await service.preview(input, AbortSignal.timeout(1000));
  let plugin = await service.install(
    { ...input, reviewedDigest: preview.digest },
    AbortSignal.timeout(1000),
  );
  plugin = await service.grant(plugin.id, run.botId, {
    revision: plugin.revision,
    tools: [],
    resources: ["notes://current"],
    prompts: ["review"],
  });
  plugin = await service.setEnabled(plugin.id, { revision: plugin.revision, enabled: true });
  const readInput = {
    pluginId: plugin.id,
    revision: plugin.revision,
    kind: "resource",
    name: "notes://current",
  };
  return { service, plugin, readInput, resources, prompts, connection, read, prompt, scope };
}

describe(
  "MCP content authority and updates",
  process.platform === "win32" ? { timeout: 60_000 } : {},
  () => {
    it("discovers resource-only plugins and keeps old tool-only digests stable", async () => {
      const { service, plugin } = await fixture();
      expect(plugin.tools).toEqual([]);
      expect((await service.contentCatalog(run)).items.map((item) => item.kind)).toEqual([
        "resource",
        "prompt",
      ]);
      expect(
        pluginManifest("test", "https://x.example.com/mcp", [
          { name: "read", description: "", inputSchema: { type: "object" } },
        ]),
      ).not.toHaveProperty("resources");
    });
    it("allows Owner-selected material before a Run only through explicit membership authorization", async () => {
      const { service, readInput, scope } = await fixture(true);
      expect(
        (await service.ownerContentCatalog({ channelId: run.channelId, botId: run.botId })).items,
      ).toHaveLength(2);
      expect(
        await service.ownerReadContent(
          { channelId: run.channelId, botId: run.botId },
          readInput,
          AbortSignal.timeout(1000),
        ),
      ).toMatchObject({ untrusted: true });
      expect(scope).toHaveBeenCalledWith({ channelId: run.channelId, botId: run.botId });
      const denied = await fixture();
      await expect(
        denied.service.ownerReadContent(
          { channelId: run.channelId, botId: run.botId },
          denied.readInput,
          AbortSignal.timeout(1000),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(denied.read).not.toHaveBeenCalled();
    });

    it("reads exact granted resources and prompts as untrusted data", async () => {
      const { service, readInput, read, prompt } = await fixture();
      expect(await service.readContent(run, readInput, AbortSignal.timeout(1000))).toMatchObject({
        untrusted: true,
        result: { contents: [{ text: "notes" }] },
      });
      expect(
        await service.readContent(
          run,
          { ...readInput, kind: "prompt", name: "review", arguments: { text: "hello" } },
          AbortSignal.timeout(1000),
        ),
      ).toMatchObject({ result: { messages: [{ content: { text: "hello" } }] } });
      expect(read).toHaveBeenCalledOnce();
      expect(prompt).toHaveBeenCalledOnce();
    });
    it("rejects wrong Bot, channel authority, arbitrary URI and prompt arguments before access", async () => {
      const { service, readInput, read, prompt, scope } = await fixture();
      await expect(
        service.readContent({ ...run, botId: "other" }, readInput, AbortSignal.timeout(1000)),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        service.readContent(
          run,
          { ...readInput, name: "file:///private" },
          AbortSignal.timeout(1000),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      for (const args of [{}, { text: "hello", unknown: "data" }])
        await expect(
          service.readContent(
            run,
            { ...readInput, kind: "prompt", name: "review", arguments: args },
            AbortSignal.timeout(1000),
          ),
        ).rejects.toMatchObject({ code: "invalid" });
      scope.mockRejectedValueOnce(new Error("Channel membership revoked"));
      await expect(service.readContent(run, readInput, AbortSignal.timeout(1000))).rejects.toThrow(
        "Channel membership revoked",
      );
      expect(read).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
    });
    it("detects changed declarations before reads and requires exact fresh update review", async () => {
      const { service, plugin, readInput, resources, read } = await fixture();
      const resource = resources[0];
      if (!resource) throw new Error("Missing resource fixture");
      resource.description = "New declaration";
      await expect(
        service.readContent(run, readInput, AbortSignal.timeout(1000)),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(read).not.toHaveBeenCalled();
      const update = await service.previewUpdate(
        plugin.id,
        plugin.revision,
        AbortSignal.timeout(1000),
      );
      expect(update.changed).toBe(true);
      expect((await service.snapshot()).plugins[0]?.enabled).toBe(true);
      await expect(
        service.applyUpdate(
          plugin.id,
          { revision: plugin.revision, reviewedDigest: plugin.digest },
          AbortSignal.timeout(1000),
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      const next = await service.applyUpdate(
        plugin.id,
        { revision: plugin.revision, reviewedDigest: update.manifest.digest },
        AbortSignal.timeout(1000),
      );
      expect(next.enabled).toBe(false);
      expect(next.grants).toEqual([]);
      expect(next.revision).not.toBe(plugin.revision);
      await expect(
        service.readContent(run, readInput, AbortSignal.timeout(1000)),
      ).rejects.toMatchObject({ code: "conflict" });
    });
    it("rejects duplicate and undeclared content grants", async () => {
      const { service, plugin } = await fixture();
      for (const resources of [["unknown://resource"], ["notes://current", "notes://current"]])
        await expect(
          service.grant(plugin.id, run.botId, { revision: plugin.revision, tools: [], resources }),
        ).rejects.toMatchObject({ code: "invalid" });
    });
    it("rejects resource URI substitution, oversized content and non-text prompt content", async () => {
      const { service, readInput, read, prompt } = await fixture();
      read.mockResolvedValueOnce({ contents: [{ uri: "notes://private", text: "secret" }] });
      await expect(
        service.readContent(run, readInput, AbortSignal.timeout(1000)),
      ).rejects.toMatchObject({ code: "invalid" });
      read.mockResolvedValueOnce({
        contents: [{ uri: "notes://current", text: "x".repeat(13 * 1024) }],
      });
      await expect(
        service.readContent(run, readInput, AbortSignal.timeout(1000)),
      ).rejects.toMatchObject({ code: "invalid" });
      prompt.mockResolvedValueOnce({
        messages: [{ role: "system", content: { type: "text", text: "authority" } }],
      });
      await expect(
        service.readContent(
          run,
          { ...readInput, kind: "prompt", name: "review", arguments: { text: "hello" } },
          AbortSignal.timeout(1000),
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
    });
    it("discards an in-flight result when its grant is revoked", async () => {
      const { service, plugin, readInput, read } = await fixture();
      let finish!: (value: { contents: { uri: string; text: string }[] }) => void;
      read.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const running = service.readContent(run, readInput, AbortSignal.timeout(2000));
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
      await service.setEnabled(plugin.id, { revision: plugin.revision, enabled: false });
      finish({ contents: [{ uri: "notes://current", text: "must not escape" }] });
      await expect(running).rejects.toMatchObject({ code: "unavailable" });
    });
    it("reads resources and prompts through a real SDK HTTP server", async () => {
      const demo = await startExamplePlugin(0);
      cleanups.push(demo.close);
      const dir = await realpath(await mkdtemp(join(tmpdir(), "openbot-plugin-real-content-")));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      const service = new PluginService({
        store: new FilePluginStore(join(dir, "private", "plugins.json"), {
          windowsAcl: noopWindowsAcl,
          windowsTrustRoot: dir,
        }),
        assertScope: async () => {},
        botExists: async () => true,
        localEndpoints: [demo.endpoint],
      });
      cleanups.push(async () => service.close());
      const input = { name: "Example", endpoint: demo.endpoint };
      const preview = await service.preview(input, AbortSignal.timeout(3000));
      expect(preview.resources).toHaveLength(2);
      expect(preview.prompts).toHaveLength(1);
      let plugin = await service.install(
        { ...input, reviewedDigest: preview.digest },
        AbortSignal.timeout(3000),
      );
      plugin = await service.grant(plugin.id, run.botId, {
        revision: plugin.revision,
        tools: [],
        resources: ["notes://current", "ui://notebook/view.html"],
        prompts: ["review_note"],
      });
      plugin = await service.setEnabled(plugin.id, { revision: plugin.revision, enabled: true });
      const common = { pluginId: plugin.id, revision: plugin.revision };
      expect(
        await service.readContent(
          run,
          { ...common, kind: "resource", name: "notes://current" },
          AbortSignal.timeout(3000),
        ),
      ).toMatchObject({ result: { contents: [{ text: "No notes yet." }] } });
      expect(
        await service.readContent(
          run,
          { ...common, kind: "prompt", name: "review_note", arguments: { note: "Example" } },
          AbortSignal.timeout(3000),
        ),
      ).toMatchObject({
        result: { messages: [{ content: { text: "Review this note for clarity: Example" } }] },
      });
      expect(
        await service.readContent(
          run,
          { ...common, kind: "resource", name: "ui://notebook/view.html" },
          AbortSignal.timeout(3000),
        ),
      ).toMatchObject({ result: { contents: [{ mimeType: "text/html;profile=mcp-app" }] } });
    });
  },
);
