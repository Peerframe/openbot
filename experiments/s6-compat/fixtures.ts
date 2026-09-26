import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@openbot/db";
import type { Run } from "@openbot/domain";
import { startExamplePlugin } from "../../packages/mcp-example/src/plugin-example.js";
import { PluginService } from "../../tests/oracles/legacy-server/src/plugin-service.js";
import { FilePluginStore } from "../../tests/oracles/legacy-server/src/plugin-store.js";
import type { InstalledPlugin } from "../../tests/oracles/legacy-server/src/plugin-types.js";
import { PostgresAgentStore } from "../../tests/oracles/legacy-server/src/postgres-agent-store.js";
import { PostgresControlPlaneStore } from "../../tests/oracles/legacy-server/src/postgres-store.js";

export function fixtureDatabaseUrl(): string {
  const value = process.env.OPENBOT_S6_TEST_DATABASE_URL;
  if (!value) throw new Error("Run node experiments/s6-compat/run.mjs; no scenarios are skipped.");
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    !/^\/openbot_s6_test_[a-f0-9]{12}$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error("S6 tests require an owned disposable loopback database.");
  return value;
}

export async function createFixture() {
  const url = fixtureDatabaseUrl();
  const database = createDatabase(url);
  try {
    const control = new PostgresControlPlaneStore(database.db);
    const native = new PostgresAgentStore(database.db);
    // The harness creates this entire database solely for these synthetic records.
    await database.client`set client_min_messages = warning`;
    await database.client`truncate bots, channels cascade`;
    const parentBot = await control.createBot({
      name: "S6 Coordinator",
      role: "Coordinator",
      computerProfile: "none",
    });
    const childBot = await control.createBot({
      name: "S6 Researcher",
      role: "Researcher",
      computerProfile: "none",
    });
    const channel = await control.createChannel({
      name: "S6 synthetic compatibility",
      description: "Disposable fixture",
      botIds: [parentBot.id, childBot.id],
    });
    const { run: queued } = await control.submitTask(channel.id, {
      content: "Check synthetic evidence with an independently authorized colleague.",
      botId: parentBot.id,
    });
    const since = new Date(Date.now() - 60_000).toISOString();
    const parent = await native.claim(queued, since);
    if (!parent) throw new Error("Fixture root could not be claimed.");
    return { database, control, native, parentBot, childBot, channel, parent, since };
  } catch (error) {
    await database.close();
    throw error;
  }
}

export type Fixture = Awaited<ReturnType<typeof createFixture>>;

export async function reopen(f: Fixture): Promise<void> {
  await f.database.close();
  f.database = createDatabase(fixtureDatabaseUrl());
  f.control = new PostgresControlPlaneStore(f.database.db);
  f.native = new PostgresAgentStore(f.database.db);
}

export async function createMcpFixture(f: Fixture) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-s6-mcp-")));
  let demo: Awaited<ReturnType<typeof startExamplePlugin>> | undefined;
  let service: PluginService | undefined;
  const close = async () => {
    try {
      service?.close();
    } finally {
      try {
        await demo?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
  try {
    const instance = await startExamplePlugin(0);
    demo = instance;
    const token = "synthetic-s6-bearer";
    const fault = { unauthorized: false, deniedRequests: 0, acceptedRequests: 0 };
    const [handler] = instance.server.listeners("request") as RequestListener[];
    if (!handler) throw new Error("SDK example handler is missing.");
    instance.server.removeListener("request", handler);
    instance.server.on("request", (request, response) => {
      if (fault.unauthorized || request.headers.authorization !== `Bearer ${token}`) {
        fault.deniedRequests++;
        response.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
        return;
      }
      fault.acceptedRequests++;
      handler(request, response);
    });
    const path = join(directory, "private", "plugins.json");
    const open = () => {
      const store = new FilePluginStore(path, { windowsTrustRoot: directory });
      service = new PluginService({
        store,
        localEndpoints: [instance.endpoint],
        assertScope: (run) => f.native.assertScope(run),
        botExists: async (id) => [f.parentBot.id, f.childBot.id].includes(id),
      });
      return { service, store };
    };
    const state = open();
    const input = { name: "S6 synthetic MCP", endpoint: instance.endpoint, token };
    const preview = await state.service.preview(input, AbortSignal.timeout(5000));
    const installed = await state.service.install(
      { ...input, reviewedDigest: preview.digest },
      AbortSignal.timeout(5000),
    );
    return {
      ...state,
      installed,
      demo: instance,
      fault,
      path,
      token,
      reopen() {
        this.service.close();
        Object.assign(this, open());
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function grant(
  service: PluginService,
  plugin: InstalledPlugin,
  botId: string,
  write = false,
) {
  return service.grant(plugin.id, botId, {
    revision: plugin.revision,
    tools: write
      ? [{ name: "append_note", mode: "confirm" }]
      : [{ name: "sum_numbers", mode: "read" }],
  });
}

export function call(service: PluginService, run: Run, plugin: InstalledPlugin) {
  return service.call(
    run,
    {
      pluginId: plugin.id,
      revision: plugin.revision,
      toolName: "sum_numbers",
      arguments: { a: 13, b: 29 },
    },
    AbortSignal.timeout(5000),
  );
}
