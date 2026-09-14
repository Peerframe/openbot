import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@openbot/domain";
import type { WindowsSecretAcl } from "@openbot/windows-secret-acl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startExamplePlugin } from "./plugin-example.js";
import { createPluginRoutes } from "./plugin-routes.js";
import { PluginService } from "./plugin-service.js";
import { FilePluginStore } from "./plugin-store.js";
import { normalizePluginEndpoint, type PluginConnection } from "./plugin-transport.js";
import { checkPluginSchema, type InstalledPlugin, type PluginTool } from "./plugin-types.js";

const run = {
  id: "run-one",
  botId: "bot-one",
  channelId: "channel-one",
  executionProfile: "none",
  status: "running",
} as Run;
const tools: PluginTool[] = [
  {
    name: "echo",
    description: "Echo a string",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", maxLength: 100 } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Lifecycle suites skip real PowerShell ACL; native coverage lives in *-windows-acl*.test.ts. */
const noopWindowsAcl: WindowsSecretAcl = {
  protectDirectory: async () => {},
  verifyDirectory: async () => {},
  protectAndVerifyFile: async () => {},
  verifyFile: async () => {},
};

async function fixture(approvalTimeoutMs = 60_000) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-plugin-test-")));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new FilePluginStore(join(directory, "private", "plugins.json"), {
    windowsAcl: noopWindowsAcl,
    windowsTrustRoot: directory,
  });
  const call = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
    content: [{ type: "text", text: args.text }],
  }));
  const connection: PluginConnection = {
    tools: vi.fn(async () => structuredClone(tools)),
    call,
    close: vi.fn(async () => {}),
  };
  const assertScope = vi.fn(async () => {});
  const service = new PluginService({
    store,
    connector: async () => connection,
    assertScope,
    botExists: async (id) => id === run.botId,
    approvalTimeoutMs,
  });
  cleanup.push(async () => service.close());
  const input = {
    name: "Echo plugin",
    endpoint: "https://plugins.example.com/mcp",
    token: "test-plugin-bearer",
  };
  const preview = await service.preview(input, AbortSignal.timeout(2000));
  const plugin = await service.install(
    { ...input, reviewedDigest: preview.digest },
    AbortSignal.timeout(2000),
  );
  return { service, store, call, connection, assertScope, plugin, input, preview, directory };
}
async function authorize(
  service: PluginService,
  plugin: InstalledPlugin,
  mode: "read" | "confirm",
  toolName = "echo",
) {
  const granted = await service.grant(plugin.id, run.botId, {
    revision: plugin.revision,
    tools: [{ name: toolName, mode }],
  });
  return service.setEnabled(plugin.id, { revision: granted.revision, enabled: true });
}
const callInput = (plugin: InstalledPlugin, toolName = "echo") => ({
  pluginId: plugin.id,
  revision: plugin.revision,
  toolName,
  arguments: { text: "hello" },
});
async function pending(service: PluginService) {
  let calls = (await service.snapshot()).pendingCalls;
  await vi.waitFor(async () => {
    calls = (await service.snapshot()).pendingCalls;
    expect(calls).toHaveLength(1);
  });
  const request = calls[0];
  if (!request) throw new Error("Expected one pending plugin call");
  return request;
}

describe(
  "Server-owned MCP plugin lifecycle",
  process.platform === "win32" ? { timeout: 60_000 } : {},
  () => {
    it("retains concurrency admission until session cleanup finishes", async () => {
      const { service, plugin, connection } = await fixture();
      const enabled = await authorize(service, plugin, "read");
      let release!: () => void;
      const closing = new Promise<void>((resolve) => {
        release = resolve;
      });
      const close = vi.fn(() => closing);
      connection.close = close;
      const calls = Array.from({ length: 16 }, () =>
        service.call(run, callInput(enabled), AbortSignal.timeout(5000)),
      );
      try {
        await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(16));
        await expect(
          service.call(run, callInput(enabled), AbortSignal.timeout(5000)),
        ).rejects.toMatchObject({ code: "unavailable" });
      } finally {
        release();
        await Promise.all(calls);
      }
    });

    it("installs reviewed declarations disabled without authority and keeps credentials encrypted", async () => {
      const { service, store, plugin, directory, call } = await fixture();
      expect(plugin.enabled).toBe(false);
      expect(plugin.grants).toEqual([]);
      expect(await service.catalog(run)).toEqual({ tools: [], truncated: false });
      expect(JSON.stringify(await service.snapshot())).not.toContain("test-plugin-bearer");
      expect(await readFile(join(directory, "private", "plugins.json"), "utf8")).not.toContain(
        "test-plugin-bearer",
      );
      expect(
        (
          await new FilePluginStore(store.path, {
            windowsAcl: noopWindowsAcl,
            windowsTrustRoot: directory,
          }).read()
        ).plugins[0]?.token,
      ).toBe("test-plugin-bearer");
      await expect(
        service.call(run, callInput(plugin), AbortSignal.timeout(1000)),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(call).not.toHaveBeenCalled();
    });

    it("requires exact review digest and a real Bot; annotations cannot authorize calls", async () => {
      const { service, input, preview, plugin } = await fixture();
      await expect(
        service.install(
          { ...input, endpoint: "https://other.example.com/mcp", reviewedDigest: preview.digest },
          AbortSignal.timeout(1000),
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        service.grant(plugin.id, "other", {
          revision: plugin.revision,
          tools: [{ name: "echo", mode: "read" }],
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      const enabled = await service.setEnabled(plugin.id, {
        revision: plugin.revision,
        enabled: true,
      });
      await expect(
        service.call(run, callInput(enabled), AbortSignal.timeout(1000)),
      ).rejects.toMatchObject({ code: "forbidden" });
    });

    it("calls only the granted Bot/tool with valid arguments and rejects changed catalogs", async () => {
      const { service, plugin, call, connection } = await fixture();
      const enabled = await authorize(service, plugin, "read");
      expect((await service.catalog(run)).tools[0]).toMatchObject({
        pluginId: plugin.id,
        revision: enabled.revision,
        mode: "read",
      });
      await expect(
        service.call({ ...run, botId: "other" }, callInput(enabled), AbortSignal.timeout(1000)),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        service.call(
          run,
          { ...callInput(enabled), arguments: { text: 5 } },
          AbortSignal.timeout(1000),
        ),
      ).rejects.toMatchObject({ code: "invalid" });
      expect(await service.call(run, callInput(enabled), AbortSignal.timeout(2000))).toMatchObject({
        untrusted: true,
      });
      expect(call).toHaveBeenCalledTimes(1);
      const originalTool = tools[0];
      if (!originalTool) throw new Error("Expected the fixture tool");
      vi.mocked(connection.tools).mockResolvedValue([
        { ...originalTool, description: "Changed tool" },
      ]);
      await expect(
        service.call(run, callInput(enabled), AbortSignal.timeout(1000)),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(call).toHaveBeenCalledTimes(1);
    });

    it("persists intent and waits for exact Owner approval before one side effect", async () => {
      const { service, plugin, call, store } = await fixture();
      const enabled = await authorize(service, plugin, "confirm");
      const completion = service.call(run, callInput(enabled), AbortSignal.timeout(3000));
      const request = await pending(service);
      expect(request).toMatchObject({
        runId: run.id,
        channelId: run.channelId,
        botId: run.botId,
        arguments: { text: "hello" },
      });
      expect(call).not.toHaveBeenCalled();
      const decisions = await Promise.allSettled([
        service.decide(request.id, "approve"),
        service.decide(request.id, "approve"),
      ]);
      expect(decisions.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      await completion;
      expect(call).toHaveBeenCalledTimes(1);
      await expect(service.decide(request.id, "approve")).rejects.toMatchObject({
        code: "not_found",
      });
      const audit = (await store.read()).audit;
      expect(audit.map((event) => event.phase)).toContain("dispatching");
      expect(JSON.stringify(audit)).not.toContain("hello");
    });

    it("rejects or aborts a pending call without execution", async () => {
      const { service, plugin, call } = await fixture();
      const enabled = await authorize(service, plugin, "confirm");
      const rejected = service.call(run, callInput(enabled), AbortSignal.timeout(3000));
      const assertion = expect(rejected).rejects.toMatchObject({ code: "rejected" });
      await service.decide((await pending(service)).id, "reject");
      await assertion;
      const abort = new AbortController();
      const cancelled = service.call(run, callInput(enabled), abort.signal);
      const cancellation = expect(cancelled).rejects.toMatchObject({ code: "unavailable" });
      const request = await pending(service);
      abort.abort();
      await cancellation;
      await expect(service.decide(request.id, "approve")).rejects.toMatchObject({
        code: "not_found",
      });
      expect(call).not.toHaveBeenCalled();
    });

    it("expires pending approval and disables/revokes in-flight calls", async () => {
      const { service, plugin, call } = await fixture(20);
      const enabled = await authorize(service, plugin, "confirm");
      // Expiry must follow its timeout even if the wall clock stops or moves backward.
      const wallClock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
      try {
        await expect(
          service.call(run, callInput(enabled), AbortSignal.timeout(1000)),
        ).rejects.toMatchObject({ code: "expired" });
        expect(call).not.toHaveBeenCalled();
      } finally {
        wallClock.mockRestore();
      }
    });

    it("revokes a waiting approval immediately when the plugin is disabled", async () => {
      const { service, plugin, call } = await fixture();
      const enabled = await authorize(service, plugin, "confirm");
      const next = service.call(run, callInput(enabled), AbortSignal.timeout(3000));
      const assertion = expect(next).rejects.toMatchObject({ code: "unavailable" });
      await pending(service);
      await service.setEnabled(plugin.id, { revision: enabled.revision, enabled: false });
      await assertion;
      expect(call).not.toHaveBeenCalled();
    });

    it("rejects stale concurrent updates instead of overwriting grants", async () => {
      const { service, plugin } = await fixture();
      const results = await Promise.allSettled([
        service.grant(plugin.id, run.botId, {
          revision: plugin.revision,
          tools: [{ name: "echo", mode: "read" }],
        }),
        service.setEnabled(plugin.id, { revision: plugin.revision, enabled: true }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    });

    it("rechecks Run scope at Owner approval and rejects oversize results", async () => {
      const { service, plugin, assertScope, call } = await fixture();
      const enabled = await authorize(service, plugin, "confirm");
      const abort = new AbortController();
      const task = service.call(run, callInput(enabled), abort.signal);
      const rejected = expect(task).rejects.toMatchObject({ code: "unavailable" });
      const request = await pending(service);
      assertScope.mockRejectedValueOnce(new Error("Run cancelled"));
      await expect(service.decide(request.id, "approve")).rejects.toThrow();
      expect(call).not.toHaveBeenCalled();
      abort.abort();
      await rejected;
      const read = await service.grant(enabled.id, run.botId, {
        revision: enabled.revision,
        tools: [{ name: "echo", mode: "read" }],
      });
      call.mockResolvedValueOnce({ content: [{ type: "text", text: "x".repeat(13 * 1024) }] });
      await expect(
        service.call(run, callInput(read), AbortSignal.timeout(1000)),
      ).rejects.toMatchObject({ code: "invalid" });
      expect(call).toHaveBeenCalledTimes(1);
    });

    it("keeps plugin body limits isolated from neighboring parent routes", async () => {
      const { Hono } = await import("hono");
      const { service } = await fixture();
      const app = new Hono().route("/api/v1", createPluginRoutes(service));
      app.post("/api/v1/employees/import/preview", async (context) =>
        context.text(String((await context.req.text()).length)),
      );
      expect(
        (
          await app.request("/api/v1/employees/import/preview", {
            method: "POST",
            body: "x".repeat(30 * 1024),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request("/api/v1/plugins/preview", {
            method: "POST",
            body: "x".repeat(30 * 1024),
          })
        ).status,
      ).toBe(413);
    });
  },
);

describe("real MCP SDK network journey", () => {
  it("discovers, grants, reads, reviews, writes once and revokes against a live local plugin", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-plugin-live-")));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const demo = await startExamplePlugin(0);
    cleanup.push(() => demo.close());
    const service = new PluginService({
      store: new FilePluginStore(join(directory, "private", "plugins.json"), {
        windowsAcl: noopWindowsAcl,
        windowsTrustRoot: directory,
      }),
      localEndpoints: [demo.endpoint],
      assertScope: async () => {},
      botExists: async () => true,
    });
    cleanup.push(async () => service.close());
    const input = { name: "Local demo", endpoint: demo.endpoint };
    const preview = await service.preview(input, AbortSignal.timeout(5000));
    expect(preview.tools.map((tool) => tool.name)).toEqual(["append_note", "sum_numbers"]);
    const installed = await service.install(
      { ...input, reviewedDigest: preview.digest },
      AbortSignal.timeout(5000),
    );
    const granted = await service.grant(installed.id, run.botId, {
      revision: installed.revision,
      tools: [
        { name: "sum_numbers", mode: "read" },
        { name: "append_note", mode: "confirm" },
      ],
    });
    const enabled = await service.setEnabled(installed.id, {
      revision: granted.revision,
      enabled: true,
    });
    const sum = await service.call(
      run,
      {
        pluginId: enabled.id,
        revision: enabled.revision,
        toolName: "sum_numbers",
        arguments: { a: 13, b: 29 },
      },
      AbortSignal.timeout(5000),
    );
    expect(JSON.stringify(sum)).toContain("42");
    const task = service.call(
      run,
      {
        pluginId: enabled.id,
        revision: enabled.revision,
        toolName: "append_note",
        arguments: { text: "Approved demo note" },
      },
      AbortSignal.timeout(5000),
    );
    const request = await pending(service);
    expect(demo.notes).toEqual([]);
    await service.decide(request.id, "approve");
    await task;
    expect(demo.notes).toEqual(["Approved demo note"]);
    const disabled = await service.setEnabled(enabled.id, {
      revision: enabled.revision,
      enabled: false,
    });
    await expect(
      service.call(
        run,
        {
          pluginId: disabled.id,
          revision: disabled.revision,
          toolName: "sum_numbers",
          arguments: { a: 1, b: 1 },
        },
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  }, 20_000);
});

describe("plugin network/schema admission", () => {
  it("rejects private targets and authority-bearing schema extensions", () => {
    const userInfo = new URL("https://example.com/mcp");
    userInfo.username = "user";
    userInfo.password = "pass";
    for (const endpoint of [
      "http://example.com/mcp",
      "https://127.0.0.1/mcp",
      "https://10.0.0.1/mcp",
      "https://metadata.internal/mcp",
      userInfo.href,
      "https://example.com/mcp?key=secret",
    ])
      expect(() => normalizePluginEndpoint(endpoint)).toThrow();
    expect(
      normalizePluginEndpoint("http://127.0.0.1:4318/mcp", ["http://127.0.0.1:4318/mcp"]).href,
    ).toBe("http://127.0.0.1:4318/mcp");
    for (const field of ["$ref", "pattern", "x-mcp-header"])
      expect(() =>
        checkPluginSchema({
          type: "object",
          properties: { arg: { type: "string", [field]: "anything" } },
        }),
      ).toThrow();
  });
});
