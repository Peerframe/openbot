/** Implements product plugins behavior for the Server. */
import { randomUUID } from "node:crypto";
import { closeSync } from "node:fs";
import { dirname, basename } from "node:path";
import { z } from "zod";
import {
  applyPluginUpdateRequestSchema,
  decidePluginCallSchema,
  grantPluginRequestSchema,
  installPluginRequestSchema,
  pluginEndpointRequestSchema,
  previewPluginUpdateRequestSchema,
  readPluginContentRequestSchema,
  removePluginRequestSchema,
  updatePluginRequestSchema,
  reviewedPluginCatalogSchema,
} from "@openbot/protocol";
import { openDirectory } from "./posix-files.js";
import { readFileAt } from "./owner-files.js";
import { PluginStore } from "./plugin-store.js";
import {
  pluginAudit,
  pluginBytes,
  pluginError,
  pluginParse,
  publicPlugin,
  type Plugin,
  type PluginState,
} from "./plugin-values.js";
import {
  normalizePluginEndpoint,
  readPluginContent,
  readPluginManifest,
  withPlugin,
} from "./plugin-transport.js";
import type { AuthorizedProductOperation as Owner, ProductRoute } from "./product-identity.js";
import { HttpFailure } from "./http-errors.js";
import { hasIntegerTokens, parseJsonInput } from "./json-input.js";
import catalog from "./plugin_catalog.json" with { type: "json" };

function parseCatalog(source: string) {
  const value = parseJsonInput(source);
  const stack: ({ keys: Set<string>; key: boolean } | null)[] = [];
  for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]/g)) {
    const token = match[0],
      current = stack.at(-1);
    if (token === "{") stack.push({ keys: new Set(), key: true });
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && current) current.key = true;
    else if (token === ":" && current) current.key = false;
    else if (token.startsWith('"') && current?.key) {
      const key = JSON.parse(token);
      if (current.keys.has(key)) throw new Error("Duplicate catalog key.");
      current.keys.add(key);
    }
  }
  if (!hasIntegerTokens(value, ["revision"])) throw new Error("Integer catalog revision required.");
  return value;
}
type Scope = { channel: string; bot: string };
const find = (state: PluginState, id: string, revision: string) => {
  const plugin = state.plugins.find((v) => v.id === id);
  if (!plugin) return pluginError("not_found");
  if (plugin.revision !== revision) return pluginError("conflict");
  return plugin;
};
export class Plugins {
  readonly store: PluginStore;
  #closed = false;
  #requests = new Set<Promise<unknown>>();
  async request<T>(run: () => Promise<T>): Promise<T> {
    if (this.#closed) return pluginError("unavailable");
    const pending = Promise.resolve().then(run);
    this.#requests.add(pending);
    try {
      return await pending;
    } finally {
      this.#requests.delete(pending);
    }
  }
  #active = new Map<string, { plugin: string | undefined; abort: AbortController }>();
  constructor(
    path: string,
    readonly local: readonly string[],
    readonly catalogPath?: string,
  ) {
    this.store = new PluginStore(path);
  }
  async verify() {
    await this.store.verify();
  }
  async close() {
    this.#closed = true;
    for (const operation of this.#active.values()) operation.abort.abort();
    await Promise.allSettled([...this.#requests]);
  }
  #revoke(id: string) {
    for (const operation of this.#active.values())
      if (operation.plugin === id) operation.abort.abort();
  }
  async #operation<T>(
    id: string | undefined,
    signal: AbortSignal,
    run: (signal: AbortSignal, id: string) => Promise<T>,
  ) {
    if (this.#closed || this.#active.size >= 16) return pluginError("unavailable");
    const key = randomUUID(),
      abort = new AbortController(),
      bounded = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(30000)]);
    this.#active.set(key, { plugin: id, abort });
    try {
      bounded.throwIfAborted();
      return await run(bounded, key);
    } finally {
      this.#active.delete(key);
    }
  }
  async guard<T>(
    owner: Owner,
    operation: () => Promise<T>,
    scope?: Scope,
    bot?: string,
    deleted = false,
  ) {
    return owner(async (db) => {
      if (
        scope &&
        !(
          await db`SELECT bot_id FROM channel_bots WHERE channel_id=${scope.channel} AND bot_id=${scope.bot} FOR SHARE`
        ).length
      )
        return pluginError("forbidden");
      if (
        bot &&
        !(
          await db.unsafe(
            `SELECT id FROM bots WHERE id=$1 AND deleted_at IS ${deleted ? "NOT " : ""}NULL FOR SHARE`,
            [bot],
          )
        ).length
      )
        return pluginError("not_found");
      return operation();
    });
  }
  async change<T>(
    owner: Owner,
    run: (state: PluginState) => T | Promise<T>,
    signal: AbortSignal,
    scope?: Scope,
    bot?: string,
    deleted = false,
  ) {
    return this.store.transaction(
      (publish) => this.guard(owner, publish, scope, bot, deleted),
      run,
      signal,
    );
  }
  async preview(
    owner: Owner,
    value: z.infer<typeof pluginEndpointRequestSchema>,
    signal: AbortSignal,
    id?: string,
  ) {
    const endpoint = normalizePluginEndpoint(value.endpoint, this.local);
    await this.guard(owner, async () => undefined);
    const manifest = await this.#operation(id, signal, (s) =>
      withPlugin(endpoint, value.token, this.local, s, (client) =>
        readPluginManifest(client, value.name, endpoint, s),
      ),
    );
    await this.guard(owner, async () => undefined);
    return manifest;
  }
  async snapshot(owner: Owner, signal: AbortSignal) {
    return this.guard(owner, async () => ({
      plugins: (await this.store.read(signal)).plugins.map(publicPlugin),
      pendingCalls: [],
    }));
  }
  async catalog(owner: Owner) {
    return this.guard(owner, async () => {
      try {
        let value: unknown = catalog;
        if (this.catalogPath) {
          const root = openDirectory(dirname(this.catalogPath), false);
          try {
            value = parseCatalog(
              new TextDecoder("utf-8", { fatal: true }).decode(
                readFileAt(root, basename(this.catalogPath), 65536, true),
              ),
            );
          } finally {
            closeSync(root);
          }
        }
        return pluginParse(reviewedPluginCatalogSchema, value, 65536);
      } catch {
        throw new HttpFailure(503, { error: "plugin_catalog_unavailable" });
      }
    });
  }
  async install(owner: Owner, raw: unknown, signal: AbortSignal) {
    const value = pluginParse(installPluginRequestSchema, raw),
      manifest = await this.preview(owner, value, signal);
    if (manifest.digest !== value.reviewedDigest) return pluginError("conflict");
    return this.change(
      owner,
      (state) => {
        signal.throwIfAborted();
        if (
          state.plugins.length >= 16 ||
          state.plugins.some((p) => p.endpoint === manifest.endpoint)
        )
          return pluginError("conflict");
        const plugin: Plugin = {
          ...manifest,
          id: randomUUID(),
          revision: randomUUID(),
          enabled: false,
          grants: [],
          createdAt: new Date().toISOString(),
          ...(value.token ? { token: value.token } : {}),
        };
        state.plugins.push(plugin);
        pluginAudit(state, "installed", plugin.id);
        return publicPlugin(plugin);
      },
      signal,
    );
  }
  async previewUpdate(owner: Owner, id: string, revision: string, signal: AbortSignal) {
    await this.guard(owner, async () => undefined);
    const plugin = find(await this.store.read(signal), id, revision),
      manifest = await this.preview(owner, plugin, signal, id);
    return {
      currentDigest: plugin.digest,
      revision,
      changed: manifest.digest !== plugin.digest,
      manifest,
    };
  }
  async update(owner: Owner, id: string, raw: unknown, signal: AbortSignal) {
    const value = pluginParse(applyPluginUpdateRequestSchema, raw),
      preview = await this.previewUpdate(owner, id, value.revision, signal);
    if (preview.manifest.digest !== value.reviewedDigest) return pluginError("conflict");
    const result = await this.change(
      owner,
      (state) => {
        signal.throwIfAborted();
        const plugin = find(state, id, value.revision);
        delete plugin.resources;
        delete plugin.prompts;
        Object.assign(plugin, preview.manifest, {
          revision: randomUUID(),
          enabled: false,
          grants: [],
        });
        pluginAudit(state, "updated", id);
        return publicPlugin(plugin);
      },
      signal,
    );
    this.#revoke(id);
    return result;
  }
  async enabled(owner: Owner, id: string, raw: unknown, signal: AbortSignal) {
    const value = pluginParse(updatePluginRequestSchema, raw);
    const result = await this.change(
      owner,
      (state) => {
        const plugin = find(state, id, value.revision);
        plugin.enabled = value.enabled;
        plugin.revision = randomUUID();
        pluginAudit(state, value.enabled ? "enabled" : "disabled", id);
        return publicPlugin(plugin);
      },
      signal,
    );
    this.#revoke(id);
    return result;
  }
  async grant(owner: Owner, id: string, bot: string, raw: unknown, signal: AbortSignal) {
    const value = pluginParse(grantPluginRequestSchema, raw);
    for (const values of [value.tools.map((t) => t.name), value.resources, value.prompts])
      if (new Set(values).size !== values.length) return pluginError("invalid");
    const result = await this.change(
      owner,
      (state) => {
        const plugin = find(state, id, value.revision);
        for (const [selected, declared] of [
          [value.tools.map((t) => t.name), plugin.tools.map((t) => t.name)],
          [value.resources, (plugin.resources ?? []).map((r) => r.uri)],
          [value.prompts, (plugin.prompts ?? []).map((p) => p.name)],
        ])
          if (selected!.some((s) => !declared!.includes(s))) return pluginError("invalid");
        plugin.grants = plugin.grants.filter((g) => g.botId !== bot);
        if (value.tools.length || value.resources.length || value.prompts.length)
          plugin.grants.push({
            botId: bot,
            tools: value.tools,
            resources: value.resources,
            prompts: value.prompts,
          });
        if (plugin.grants.length > 128) return pluginError("invalid");
        plugin.revision = randomUUID();
        pluginAudit(state, "grants_changed", id, { botId: bot });
        return publicPlugin(plugin);
      },
      signal,
      undefined,
      bot,
    );
    this.#revoke(id);
    return result;
  }
  async forgetBot(owner: Owner, bot: string, signal: AbortSignal) {
    const changed = await this.change(
      owner,
      (state) => {
        const ids: string[] = [];
        for (const plugin of state.plugins) {
          const kept = plugin.grants.filter((g) => g.botId !== bot);
          if (kept.length === plugin.grants.length) continue;
          plugin.grants = kept;
          plugin.revision = randomUUID();
          ids.push(plugin.id);
          pluginAudit(state, "grants_changed", plugin.id, { botId: bot });
        }
        return ids;
      },
      signal,
      undefined,
      bot,
      true,
    );
    for (const id of changed) this.#revoke(id);
    return { removed: changed.length };
  }
  async remove(owner: Owner, id: string, raw: unknown, signal: AbortSignal) {
    const value = pluginParse(removePluginRequestSchema, raw);
    await this.change(
      owner,
      (state) => {
        find(state, id, value.revision);
        state.plugins = state.plugins.filter((p) => p.id !== id);
        pluginAudit(state, "removed", id);
      },
      signal,
    );
    this.#revoke(id);
    return { deleted: true };
  }
  async contentCatalog(owner: Owner, scope: Scope, signal: AbortSignal) {
    return this.guard(
      owner,
      async () => {
        const items: any[] = [];
        let truncated = false;
        for (const p of (await this.store.read(signal)).plugins) {
          if (!p.enabled) continue;
          const grant = p.grants.find((g) => g.botId === scope.bot);
          if (!grant) continue;
          const selected = [
            ...(p.resources ?? [])
              .filter((r) => grant.resources?.includes(r.uri))
              .map((r) => ({
                kind: "resource",
                name: r.uri,
                description: r.description,
                ...(r.mimeType ? { mimeType: r.mimeType } : {}),
              })),
            ...(p.prompts ?? [])
              .filter((t) => grant.prompts?.includes(t.name))
              .map((t) => ({
                kind: "prompt",
                name: t.name,
                description: t.description,
                arguments: t.arguments,
              })),
          ];
          for (const item of selected) {
            const entry = { pluginId: p.id, revision: p.revision, pluginName: p.name, ...item };
            if (items.length >= 32 || pluginBytes([...items, entry], 128 * 1024).length > 12288)
              truncated = true;
            else items.push(entry);
          }
        }
        return { items, truncated };
      },
      scope,
    );
  }
  async content(owner: Owner, scope: Scope, raw: unknown, signal: AbortSignal) {
    const value = pluginParse(readPluginContentRequestSchema, raw, 12288);
    const authorized = (state: PluginState) => {
      const plugin = find(state, value.pluginId, value.revision),
        grant = plugin.grants.find((g) => g.botId === scope.bot);
      if (
        !plugin.enabled ||
        !grant?.[value.kind === "resource" ? "resources" : "prompts"]?.includes(value.name)
      )
        return pluginError("forbidden");
      return plugin;
    };
    await this.guard(owner, async () => undefined, scope);
    const plugin = authorized(await this.store.read(signal));
    if (value.kind === "resource" && Object.keys(value.arguments).length)
      return pluginError("invalid");
    if (value.kind === "prompt") {
      const prompt = plugin.prompts?.find((p) => p.name === value.name);
      if (
        !prompt ||
        Object.keys(value.arguments).some((k) => !prompt.arguments.some((a) => a.name === k)) ||
        prompt.arguments.some((a) => a.required && !(a.name in value.arguments))
      )
        return pluginError("invalid");
    }
    return this.#operation(plugin.id, signal, async (s, id) =>
      withPlugin(plugin.endpoint, plugin.token, this.local, s, async (client) => {
        if (
          (await readPluginManifest(client, plugin.name, plugin.endpoint, s)).digest !==
          plugin.digest
        )
          return pluginError("conflict");
        const record = (phase: string) =>
          this.change(
            owner,
            (state) => {
              authorized(state);
              pluginAudit(state, phase, plugin.id, { botId: scope.bot, callId: id });
            },
            s,
            scope,
          );
        await record(value.kind + "_reading");
        const result = await readPluginContent(client, value.kind, value.name, value.arguments, s);
        const app =
          value.kind === "resource" &&
          plugin.resources?.some(
            (r) => r.uri === value.name && r.mimeType === "text/html;profile=mcp-app",
          );
        pluginBytes(result, app ? 160 * 1024 : 12288);
        if (
          "contents" in result &&
          result.contents.some(
            (c) => c.uri !== value.name || (c.mimeType === "text/html;profile=mcp-app" && !app),
          )
        )
          return pluginError("invalid");
        if (
          app &&
          (!value.name.startsWith("ui://") ||
            !("contents" in result) ||
            result.contents.length !== 1 ||
            result.contents[0]!.mimeType !== "text/html;profile=mcp-app")
        )
          return pluginError("invalid");
        await record(value.kind + "_read");
        return { plugin: plugin.name, kind: value.kind, name: value.name, result, untrusted: true };
      }),
    );
  }
}
export function pluginRoutes(service: Plugins): ProductRoute[] {
  const route = (
    method: string,
    path: string,
    run: NonNullable<ProductRoute["remote"]>,
    status = 200,
  ): ProductRoute => ({
    method,
    path,
    kind: "product",
    status,
    maxBytes: 24576,
    error: "unavailable",
    remote: async (...args) => {
      try {
        return await service.request(() => run(...args));
      } catch (error) {
        if (error instanceof HttpFailure) throw error;
        return pluginError("unavailable");
      }
    },
    execute: async () => {
      throw new Error("Plugin operation requires the file lease and bounded network lifecycle.");
    },
  });
  return [
    route("GET", "/api/v1/plugins", (owner, _ids, _body, signal) =>
      service.snapshot(owner, signal),
    ),
    route("GET", "/api/v1/plugins/catalog", (owner, _ids, _body, _signal, context) => {
      if (context.query.size)
        throw new HttpFailure(422, { error: "Catalog query parameters are not accepted." });
      return service.catalog(owner);
    }),
    route("POST", "/api/v1/plugins/preview", (owner, _ids, body, signal) =>
      service.preview(owner, pluginParse(pluginEndpointRequestSchema, body), signal),
    ),
    route(
      "POST",
      "/api/v1/plugins",
      async (owner, _ids, body, signal) => ({ plugin: await service.install(owner, body, signal) }),
      201,
    ),
    route("POST", "/api/v1/plugins/{plugin_id}/update/preview", (owner, ids, body, signal) =>
      service.previewUpdate(
        owner,
        ids[0]!,
        pluginParse(previewPluginUpdateRequestSchema, body).revision,
        signal,
      ),
    ),
    route("POST", "/api/v1/plugins/{plugin_id}/update", async (owner, ids, body, signal) => ({
      plugin: await service.update(owner, ids[0]!, body, signal),
    })),
    route("PATCH", "/api/v1/plugins/{plugin_id}", async (owner, ids, body, signal) => ({
      plugin: await service.enabled(owner, ids[0]!, body, signal),
    })),
    route(
      "PUT",
      "/api/v1/plugins/{plugin_id}/grants/{bot_id}",
      async (owner, ids, body, signal) => ({
        plugin: await service.grant(owner, ids[0]!, ids[1]!, body, signal),
      }),
    ),
    route("DELETE", "/api/v1/plugins/{plugin_id}", (owner, ids, body, signal) =>
      service.remove(owner, ids[0]!, body, signal),
    ),
    route(
      "GET",
      "/api/v1/channels/{channel_id}/bots/{bot_id}/plugin-content",
      (owner, ids, _body, signal) =>
        service.contentCatalog(owner, { channel: ids[0]!, bot: ids[1]! }, signal),
    ),
    route(
      "POST",
      "/api/v1/channels/{channel_id}/bots/{bot_id}/plugin-content",
      (owner, ids, body, signal) =>
        service.content(owner, { channel: ids[0]!, bot: ids[1]! }, body, signal),
    ),
    // The current product composition has no legacy Run callback and cannot create pending
    // in-memory plugin calls. Durable native approvals retain the P4 Work action endpoint.
    route("POST", "/api/v1/plugin-calls/{call_id}/decision", async (owner, _ids, body) => {
      pluginParse(decidePluginCallSchema, body);
      await service.guard(owner, async () => undefined);
      return pluginError("not_found");
    }),
  ];
}
