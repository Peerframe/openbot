import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { PluginCallReceipt } from "@openbot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginService } from "./plugin-service.js";
import { FilePluginStore } from "./plugin-store.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function counterServer() {
  let counter = 0;
  let holdManifest = false;
  let manifestHeld = false;
  const responseGate = Promise.withResolvers<void>();
  const manifestGate = Promise.withResolvers<void>();
  const server = createServer(async (request, response) => {
    if (request.url !== "/mcp" || request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 24 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.method === "tools/list" && holdManifest) {
        manifestHeld = true;
        await manifestGate.promise;
      }
      const mcp = new McpServer({ name: "receipt-counter", version: "1.0.0" });
      mcp.registerTool(
        "increment",
        {
          description: "Increment a synthetic counter once and withhold its response.",
          inputSchema: {},
        },
        async () => {
          counter++;
          await responseGate.promise;
          return { content: [{ type: "text", text: String(counter) }] };
        },
      );
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      response.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport as Parameters<McpServer["connect"]>[0]);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind.");
  cleanup.push(async () => {
    responseGate.resolve();
    manifestGate.resolve();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    counter: () => counter,
    holdManifest: () => {
      holdManifest = true;
    },
    manifestHeld: () => manifestHeld,
  };
}

interface ChildMessage {
  type: string;
  id?: string;
  calls?: PluginCallReceipt[];
  repeatRejected?: boolean;
}
function child(mode: "call" | "inspect", path: string, endpoint: string) {
  const processChild: ChildProcess = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./__fixtures__/plugin-receipt-child.ts", import.meta.url)),
      mode,
      path,
      endpoint,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const messages: ChildMessage[] = [];
  let stderr = "";
  processChild.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4000);
  });
  processChild.on("message", (message) => messages.push(message as ChildMessage));
  const exited = new Promise<void>((resolve, reject) => {
    processChild.once("error", reject);
    processChild.once("exit", () => resolve());
  });
  const kill = async () => {
    if (processChild.exitCode === null) processChild.kill("SIGKILL");
    await exited;
  };
  cleanup.push(kill);
  return {
    kill,
    exited,
    approve: (id: string) => processChild.send({ id }),
    message: async (type: string) => {
      let found: ChildMessage | undefined;
      await vi.waitFor(
        () => {
          found = messages.find((item) => item.type === type);
          expect(found, stderr).toBeDefined();
        },
        { timeout: 10_000, interval: 20 },
      );
      if (!found) throw new Error("Missing fixture message.");
      return found;
    },
  };
}

describe("real MCP process-crash receipts", () => {
  it.each(["approved_before_dispatch", "effect_without_response"] as const)(
    "recovers %s without a second external write",
    { timeout: 30_000 },
    async (stage) => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-receipt-crash-")));
      cleanup.push(() => rm(directory, { recursive: true, force: true }));
      const remote = await counterServer();
      const path = join(directory, "private", "plugins.json");
      const store = new FilePluginStore(path, {
        windowsTrustRoot: directory,
        windowsAcl: {
          protectDirectory: async () => {},
          verifyDirectory: async () => {},
          protectAndVerifyFile: async () => {},
          verifyFile: async () => {},
        },
      });
      const setup = new PluginService({
        store,
        localEndpoints: [remote.endpoint],
        assertScope: async () => {},
        botExists: async () => true,
      });
      const input = { name: "Synthetic counter", endpoint: remote.endpoint };
      const preview = await setup.preview(input, AbortSignal.timeout(5000));
      const installed = await setup.install(
        { ...input, reviewedDigest: preview.digest },
        AbortSignal.timeout(5000),
      );
      const granted = await setup.grant(installed.id, "crash-bot", {
        revision: installed.revision,
        tools: [{ name: "increment", mode: "confirm" }],
      });
      await setup.setEnabled(installed.id, { revision: granted.revision, enabled: true });
      const running = child("call", path, remote.endpoint);
      const pending = await running.message("pending");
      if (!pending.id) throw new Error("Missing pending call id.");
      if (stage === "approved_before_dispatch") remote.holdManifest();
      running.approve(pending.id);
      await running.message("approved");
      await vi.waitFor(() => {
        expect(
          stage === "approved_before_dispatch" ? remote.manifestHeld() : remote.counter() === 1,
        ).toBe(true);
      });
      const beforeCrash = (await store.read()).callReceipts?.[0];
      expect(beforeCrash?.approvalDecision).toBe("approved");
      expect(beforeCrash?.state).toBe(
        stage === "approved_before_dispatch" ? "awaiting_approval" : "dispatching",
      );
      await running.kill();
      // These are separate processes, not fresh service objects within the original isolate.
      for (let restart = 0; restart < 2; restart++) {
        const recovered = child("inspect", path, remote.endpoint);
        const result = await recovered.message("recovered");
        await recovered.exited;
        expect(result.repeatRejected).toBe(true);
        expect(result.calls).toHaveLength(1);
        expect(result.calls?.[0]).toMatchObject({
          id: pending.id,
          approvalDecision: "approved",
          state: stage === "approved_before_dispatch" ? "not_dispatched" : "outcome_unknown",
        });
        expect(remote.counter()).toBe(stage === "approved_before_dispatch" ? 0 : 1);
      }
    },
  );
});
