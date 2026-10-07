import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  pluginHttpOperations,
  pluginManifestHttpSchema,
  pluginSnapshotHttpSchema,
  pluginUpdatePreviewHttpSchema,
  installedPluginResponseSchema,
  pluginDeletedResponseSchema,
  pluginContentCatalogHttpSchema,
  pluginContentResultHttpSchema,
  reviewedPluginCatalogSchema,
  channelResponseSchema,
  controlHttpErrorSchema,
  type InstalledPluginHttp,
} from "@openbot/protocol";
import { contractClient, type RequestOptions } from "./client.ts";
import {
  contractTargetSchema,
  pluginScenarioSchema,
  type ContractTarget,
  type PluginScenario,
} from "./target.ts";

const statistics = z.strictObject({
  requests: z.number().int().nonnegative(),
  deletedSessions: z.number().int().nonnegative(),
  badAuth: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  resourceReads: z.number().int().nonnegative(),
  promptReads: z.number().int().nonnegative(),
  revision: z.union([z.literal(1), z.literal(2)]),
  large: z.boolean(),
});

/** Real MCP discovery/content; no tool execution or legacy Run approval is fabricated. */
export async function runPluginContracts(input: ContractTarget, fixture: PluginScenario) {
  const target = contractTargetSchema.parse(input),
    scenario = pluginScenarioSchema.parse(fixture);
  const { request } = contractClient(target),
    passed: string[] = [];
  const check = async (name: string, action: () => Promise<void>) => {
    await action();
    passed.push(name);
  };
  const error = async (path: string, status: number, options: RequestOptions = {}) => {
    const result = await request(path, options);
    assert.equal(result.response.status, status, `Plugin ${options.method ?? "GET"} ${path}`);
    controlHttpErrorSchema.parse(result.body);
  };
  const controller = async (body: { revision?: 1 | 2; large?: boolean } = {}) => {
    const response = await fetch(`${new URL(scenario.endpoint).origin}/fixture-control`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${scenario.controllerToken}`,
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    assert(response.body);
    const reader = response.body.getReader();
    let text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder("utf-8", { fatal: true }).decode(chunk.value);
        assert(Buffer.byteLength(text) <= 2048);
      }
      return statistics.parse(JSON.parse(text));
    } finally {
      await reader.cancel().catch(() => {});
    }
  };
  const snapshot = async () => {
    const result = await request("/api/v1/plugins");
    assert.equal(result.response.status, 200);
    const data = pluginSnapshotHttpSchema.parse(result.body);
    assert(!JSON.stringify(data).includes(scenario.token));
    return data;
  };
  for (const operation of pluginHttpOperations) {
    const path = operation.path.replaceAll(/\{[^}]+\}/g, randomUUID());
    await check(`plugin Owner ${operation.method} ${operation.path}`, async () => {
      await error(path, 401, {
        method: operation.method.toUpperCase(),
        cookie: false,
        ...(operation.method === "get" ? {} : { rawBody: "invalid" }),
      });
      if (operation.method !== "get")
        await error(path, 403, {
          method: operation.method.toUpperCase(),
          origin: "https://foreign.invalid",
          rawBody: "invalid",
        });
    });
  }
  await check("reviewed catalog has no installation authority; query extras refused", async () => {
    const result = await request("/api/v1/plugins/catalog");
    assert.equal(result.response.status, 200);
    reviewedPluginCatalogSchema.parse(result.body);
    await error("/api/v1/plugins/catalog?extra=true", 422);
    assert.deepEqual((await snapshot()).plugins, []);
  });
  const created = await request("/api/v1/channels", {
    method: "POST",
    body: { name: `Plugins ${randomUUID()}`, botIds: [target.botId] },
  });
  assert.equal(created.response.status, 201);
  const channelId = channelResponseSchema.parse(created.body).channel.id;
  const contentPath = `/api/v1/channels/${channelId}/bots/${target.botId}/plugin-content`;
  const endpoint = {
    name: " \u0085Fixture \u0085 ",
    endpoint: scenario.endpoint,
    token: scenario.token,
  };
  let plugin: InstalledPluginHttp | undefined;
  try {
    const preview = await request("/api/v1/plugins/preview", { method: "POST", body: endpoint });
    assert.equal(preview.response.status, 200);
    const manifest = pluginManifestHttpSchema.parse(preview.body);
    await check("real MCP preview is normalized, bounded and effect-free", async () => {
      assert.equal(manifest.name, "Fixture");
      assert.equal(manifest.endpoint, scenario.endpoint);
      assert.equal(manifest.tools.length, 2);
      assert.equal(manifest.resources?.length, 2);
      assert.equal(manifest.prompts?.length, 1);
      assert.equal((await controller()).toolCalls, 0);
      assert.deepEqual((await snapshot()).plugins, []);
    });
    await check(
      "strict plugin shape/body and endpoint policy fail before MCP discovery",
      async () => {
        const before = (await controller()).requests;
        for (const changes of [
          { extra: true },
          { name: "😀".repeat(41) },
          { token: null },
          { endpoint: "not a URL" },
          { endpoint: scenario.endpoint + "?redirect=true" },
          { name: "\ud800" },
        ])
          await error("/api/v1/plugins/preview", 400, {
            method: "POST",
            body: { ...endpoint, ...changes },
          });
        await error("/api/v1/plugins/preview", 413, {
          method: "POST",
          body: { ...endpoint, extra: "x".repeat(24576) },
        });
        assert.equal((await controller()).requests, before);
      },
    );
    await check("install requires the reviewed live manifest digest", async () => {
      await error("/api/v1/plugins", 409, {
        method: "POST",
        body: { ...endpoint, reviewedDigest: "0".repeat(64) },
      });
      assert.deepEqual((await snapshot()).plugins, []);
    });
    await check(
      "concurrent same-endpoint installs produce one disabled secret-free record",
      async () => {
        const results = await Promise.all(
          [1, 2].map(() =>
            request("/api/v1/plugins", {
              method: "POST",
              body: { ...endpoint, reviewedDigest: manifest.digest },
            }),
          ),
        );
        assert.deepEqual(results.map((value) => value.response.status).sort(), [201, 409]);
        const winner = results.find((value) => value.response.status === 201);
        assert(winner);
        plugin = installedPluginResponseSchema.parse(winner.body).plugin;
        assert.equal(plugin.enabled, false);
        assert.deepEqual(plugin.grants, []);
        assert.equal((await snapshot()).plugins[0]?.id, plugin.id);
        assert(!JSON.stringify(winner.body).includes(scenario.token));
      },
    );
    assert(plugin);
    const path = `/api/v1/plugins/${plugin.id}`;
    const mutate = async (suffix: string, method: string, body: unknown) => {
      const result = await request(path + suffix, { method, body });
      assert.equal(result.response.status, 200);
      const updated = installedPluginResponseSchema.parse(result.body).plugin;
      assert(updated.revision !== plugin?.revision);
      plugin = updated;
      return updated;
    };
    const selection = {
      tools: [
        { name: "read_value", mode: "read" },
        { name: "write_note", mode: "confirm" },
      ],
      resources: ["notes://public/info", "ui://fixture/card"],
      prompts: ["compose"],
    };
    const content = (kind: "resource" | "prompt", name: string, args?: Record<string, string>) => ({
      pluginId: plugin?.id,
      revision: plugin?.revision,
      kind,
      name,
      ...(args === undefined ? {} : { arguments: args }),
    });
    await check("disabled or ungranted content has no network effects", async () => {
      const before = (await controller()).requests;
      await error(contentPath, 403, {
        method: "POST",
        body: content("resource", "notes://public/info"),
      });
      assert.deepEqual(
        pluginContentCatalogHttpSchema.parse((await request(contentPath)).body).items,
        [],
      );
      assert.equal((await controller()).requests, before);
    });
    await check(
      "enable no-op rotates revision; stale and case-changed revisions conflict",
      async () => {
        assert(plugin);
        const previous = plugin.revision;
        await mutate("", "PATCH", { revision: previous, enabled: true });
        await error(path, 409, { method: "PATCH", body: { revision: previous, enabled: false } });
        const before = plugin.revision;
        await mutate("", "PATCH", { revision: before, enabled: true });
        assert(plugin);
        assert(/[a-f]/.test(plugin.revision));
        await error(path, 409, {
          method: "PATCH",
          body: { revision: plugin.revision.toUpperCase(), enabled: false },
        });
        await error(path, 409, {
          method: "PATCH",
          body: { revision: "11111111-1111-1111-1111-111111111111", enabled: false },
        });
      },
    );
    await check("grant declarations, duplicates and live Bot identity are checked", async () => {
      for (const changes of [
        { tools: [{ name: "unknown", mode: "read" }] },
        { resources: ["notes://public/info", "notes://public/info"] },
        { prompts: ["unknown"] },
        { resources: null },
      ])
        await error(path + `/grants/${target.botId}`, 400, {
          method: "PUT",
          body: { revision: plugin?.revision, ...selection, ...changes },
        });
      await error(path + `/grants/${randomUUID()}`, 404, {
        method: "PUT",
        body: { revision: plugin?.revision, ...selection },
      });
      await mutate(`/grants/${target.botId}`, "PUT", { revision: plugin?.revision, ...selection });
    });
    await check(
      "content catalog uses current channel membership and grants without MCP calls",
      async () => {
        const before = (await controller()).requests;
        const result = await request(contentPath);
        assert.equal(result.response.status, 200);
        const catalog = pluginContentCatalogHttpSchema.parse(result.body);
        assert.equal(catalog.items.length, 3);
        assert.equal(catalog.truncated, false);
        await error(`/api/v1/channels/${randomUUID()}/bots/${target.botId}/plugin-content`, 403);
        assert.equal((await controller()).requests, before);
      },
    );
    await check(
      "resource arguments and prompt requirements fail before content reads",
      async () => {
        const before = (await controller()).requests;
        for (const body of [
          content("resource", "notes://public/info", { topic: "invalid" }),
          content("prompt", "compose"),
          content("prompt", "compose", { topic: "valid", unknown: "invalid" }),
          content("prompt", "compose", { topic: "😀".repeat(4000) }),
        ])
          await error(contentPath, 400, { method: "POST", body });
        assert.equal((await controller()).requests, before);
      },
    );
    await check(
      "real MCP resource, prompt and app results retain the untrusted boundary",
      async () => {
        for (const body of [
          content("resource", "notes://public/info"),
          content("prompt", "compose", { topic: "证据 🧪" }),
          content("resource", "ui://fixture/card"),
        ]) {
          const result = await request(contentPath, { method: "POST", body });
          assert.equal(result.response.status, 200);
          const parsed = pluginContentResultHttpSchema.parse(result.body);
          assert.equal(parsed.untrusted, true);
          assert.equal(parsed.name, body.name);
          assert.equal(parsed.plugin, "Fixture");
          if (parsed.kind === "resource") assert.equal(parsed.result.contents[0]?.uri, body.name);
          else assert(parsed.result.messages.some((item) => item.content.text.includes("证据 🧪")));
        }
      },
    );
    await check("ordinary resource byte ceiling refuses an oversized MCP result", async () => {
      await controller({ large: true });
      try {
        await error(contentPath, 400, {
          method: "POST",
          body: content("resource", "notes://public/info"),
        });
      } finally {
        await controller({ large: false });
      }
    });
    await check("changed live declarations block reads until digest-bound review", async () => {
      await controller({ revision: 2 });
      const before = (await controller()).resourceReads;
      await error(contentPath, 409, {
        method: "POST",
        body: content("resource", "notes://public/info"),
      });
      assert.equal((await controller()).resourceReads, before);
      const result = await request(path + "/update/preview", {
        method: "POST",
        body: { revision: plugin?.revision },
      });
      assert.equal(result.response.status, 200);
      const update = pluginUpdatePreviewHttpSchema.parse(result.body);
      assert.equal(update.changed, true);
      assert.equal(update.currentDigest, manifest.digest);
      await error(path + "/update", 409, {
        method: "POST",
        body: { revision: plugin?.revision, reviewedDigest: manifest.digest },
      });
      const changed = await mutate("/update", "POST", {
        revision: plugin?.revision,
        reviewedDigest: update.manifest.digest,
      });
      assert.equal(changed.enabled, false);
      assert.deepEqual(changed.grants, []);
    });
    await check("unchanged update still clears grants, disables and rotates revision", async () => {
      await mutate("", "PATCH", { revision: plugin?.revision, enabled: true });
      await mutate(`/grants/${target.botId}`, "PUT", { revision: plugin?.revision, ...selection });
      const result = await request(path + "/update/preview", {
        method: "POST",
        body: { revision: plugin?.revision },
      });
      assert.equal(result.response.status, 200);
      const update = pluginUpdatePreviewHttpSchema.parse(result.body);
      assert.equal(update.changed, false);
      const changed = await mutate("/update", "POST", {
        revision: plugin?.revision,
        reviewedDigest: update.manifest.digest,
      });
      assert.equal(changed.enabled, false);
      assert.deepEqual(changed.grants, []);
    });
    await check("concurrent grant CAS has one winner; clearing removes the grant", async () => {
      const revision = plugin?.revision;
      const results = await Promise.all(
        [1, 2].map(() =>
          request(path + `/grants/${target.botId}`, {
            method: "PUT",
            body: { revision, ...selection },
          }),
        ),
      );
      assert.deepEqual(results.map((result) => result.response.status).sort(), [200, 409]);
      const winner = results.find((result) => result.response.status === 200);
      assert(winner);
      plugin = installedPluginResponseSchema.parse(winner.body).plugin;
      const cleared = await mutate(`/grants/${target.botId}`, "PUT", {
        revision: plugin.revision,
        tools: [],
      });
      assert.deepEqual(cleared.grants, []);
    });
    await check("legacy call decisions refuse unknown calls and malformed decisions", async () => {
      assert.deepEqual((await snapshot()).pendingCalls, []);
      const call = `/api/v1/plugin-calls/${randomUUID()}/decision`;
      await error(call, 404, { method: "POST", body: { decision: "approve" } });
      await error(call, 400, { method: "POST", body: { decision: "accept" } });
    });
    await check(
      "revision-bound deletion is single-use and removes only the owned plugin",
      async () => {
        const revision = plugin?.revision;
        const result = await request(path, { method: "DELETE", body: { revision } });
        assert.equal(result.response.status, 200);
        pluginDeletedResponseSchema.parse(result.body);
        plugin = undefined;
        await error(path, 404, { method: "DELETE", body: { revision } });
        assert.deepEqual((await snapshot()).plugins, []);
      },
    );
    await check(
      "MCP sessions terminate with correct bearer; no declared tool is executed",
      async () => {
        const stats = await controller();
        assert.equal(stats.badAuth, 0);
        assert.equal(stats.toolCalls, 0);
        assert(
          stats.requests > 0 &&
            stats.deletedSessions > 0 &&
            stats.resourceReads === 3 &&
            stats.promptReads === 1,
        );
      },
    );
  } finally {
    if (plugin)
      await request(`/api/v1/plugins/${plugin.id}`, {
        method: "DELETE",
        body: { revision: plugin.revision },
      });
    await request(`/api/v1/channels/${channelId}`, { method: "DELETE" });
  }
  return { count: passed.length, checks: passed };
}
