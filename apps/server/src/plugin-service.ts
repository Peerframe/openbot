import { randomUUID } from "node:crypto";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { Run } from "@openbot/domain";
import type { PluginContentCatalog, PluginContentItem, PluginSnapshot } from "@openbot/protocol";
import type { z } from "zod";
import {
  callReceipt,
  insertCallReceipt,
  receiptNeedsRetention,
  recoverCallReceipts,
  sortedCallReceipts,
} from "./plugin-call-receipts.js";
import {
  type FilePluginStore,
  type PluginRecord,
  type PluginState,
  publicPlugin,
  recordPluginAudit,
} from "./plugin-store.js";
import {
  abortPluginOperation,
  mcpPluginConnector,
  normalizePluginEndpoint,
  type PluginConnector,
} from "./plugin-transport.js";
import {
  applyPluginUpdateSchema,
  boundedJson,
  callPluginSchema,
  checkPluginSchema,
  grantPluginSchema,
  type InstalledPlugin,
  installPluginSchema,
  type PendingPluginCall,
  type PluginCatalogItem,
  PluginError,
  type PluginManifest,
  pluginEndpointInputSchema,
  pluginManifest,
  pluginPromptResultSchema,
  pluginResourceResultSchema,
  readPluginContentSchema,
  updatePluginSchema,
} from "./plugin-types.js";

interface WaitingCall {
  view: PendingPluginCall;
  run: Run;
  revision: string;
  signal: AbortSignal;
  settle(decision: "approve" | "reject"): void;
}
export interface OwnerContentScope {
  channelId: string;
  botId: string;
}

export interface PluginServiceOptions {
  store: FilePluginStore;
  assertScope(run: Run): Promise<void>;
  botExists(botId: string): Promise<boolean>;
  runExists?(runId: string): Promise<boolean>;
  assertOwnerContentScope?(scope: OwnerContentScope): Promise<void>;
  localEndpoints?: readonly string[];
  connector?: PluginConnector;
  approvalTimeoutMs?: number;
}

export class PluginService {
  readonly #connector: PluginConnector;
  readonly #pending = new Map<string, WaitingCall>();
  readonly #active = new Map<string, { pluginId: string; abort: AbortController }>();
  readonly #approvalTimeout: number;
  #recovery: Promise<void> | undefined;
  constructor(readonly options: PluginServiceOptions) {
    this.#connector = options.connector ?? mcpPluginConnector(options.localEndpoints);
    this.#approvalTimeout = Math.min(60_000, Math.max(1, options.approvalTimeoutMs ?? 60_000));
  }

  /** One invocation per Server lifetime, before accepting new calls. Never resume an old call. */
  recover(): Promise<void> {
    this.#recovery ??= this.options.store.transaction(recoverCallReceipts);
    return this.#recovery;
  }

  async receipt(id: string) {
    return callReceipt(await this.#receiptState(), id);
  }

  async receiptsForRun(runId: string) {
    if (!this.options.runExists) throw new PluginError("unavailable");
    if (!(await this.options.runExists(runId))) throw new PluginError("not_found");
    return sortedCallReceipts(
      (await this.#receiptState()).callReceipts?.filter((call) => call.runId === runId) ?? [],
    );
  }

  async #receiptState(): Promise<PluginState> {
    await this.recover();
    const state = await this.options.store.read();
    const abandoned = (call: NonNullable<PluginState["callReceipts"]>[number]) =>
      call.state !== "outcome_unknown" && receiptNeedsRetention(call) && !this.#active.has(call.id);
    if (!state.callReceipts?.some(abandoned)) return state;
    // An error-recording write can fail while the process survives. Once storage recovers,
    // report that ended call conservatively instead of displaying an eternal in-flight intent.
    return this.options.store.transaction((current) => {
      recoverCallReceipts(current, abandoned);
      return current;
    });
  }

  async snapshot(): Promise<PluginSnapshot> {
    return {
      plugins: (await this.options.store.read()).plugins.map(publicPlugin),
      pendingCalls: [...this.#pending.values()]
        .filter((call) => !call.signal.aborted && Date.parse(call.view.expiresAt) > Date.now())
        .map((call) => structuredClone(call.view)),
    };
  }

  async preview(value: unknown, signal: AbortSignal): Promise<PluginManifest> {
    const input = pluginEndpointInputSchema.parse(value);
    const endpoint = normalizePluginEndpoint(input.endpoint, this.options.localEndpoints).href;
    const client = await this.#connector(endpoint, input.token, signal);
    try {
      return await this.#manifest(input.name, endpoint, client, signal);
    } catch (error) {
      throw error instanceof PluginError ? error : new PluginError("unavailable");
    } finally {
      await client.close().catch(() => {});
    }
  }

  async #manifest(
    name: string,
    endpoint: string,
    client: Awaited<ReturnType<PluginConnector>>,
    signal: AbortSignal,
  ): Promise<PluginManifest> {
    const tools = await client.tools(signal);
    const resources = (await client.resources?.(signal)) ?? [];
    const prompts = (await client.prompts?.(signal)) ?? [];
    return pluginManifest(name, endpoint, tools, resources, prompts);
  }

  async previewUpdate(id: string, revision: string, signal: AbortSignal) {
    const plugin = this.#find(await this.options.store.read(), id, revision);
    const manifest = await this.preview(
      {
        name: plugin.name,
        endpoint: plugin.endpoint,
        ...(plugin.token ? { token: plugin.token } : {}),
      },
      signal,
    );
    return {
      currentDigest: plugin.digest,
      revision,
      changed: manifest.digest !== plugin.digest,
      manifest,
    };
  }

  async applyUpdate(id: string, value: unknown, signal: AbortSignal): Promise<InstalledPlugin> {
    const input = applyPluginUpdateSchema.parse(value);
    const preview = await this.previewUpdate(id, input.revision, signal);
    if (preview.manifest.digest !== input.reviewedDigest) throw new PluginError("conflict");
    const result = await this.options.store.transaction((state) => {
      signal.throwIfAborted();
      const plugin = this.#find(state, id, input.revision);
      // Every changed capability is newly reviewed; old grants must never migrate implicitly.
      delete plugin.resources;
      delete plugin.prompts;
      Object.assign(plugin, preview.manifest, {
        revision: randomUUID(),
        enabled: false,
        grants: [],
      });
      recordPluginAudit(state, { phase: "updated", pluginId: id });
      return publicPlugin(plugin);
    });
    this.#revoke(id);
    return result;
  }

  async contentCatalog(run: Run) {
    await this.options.assertScope(run);
    return this.#contentCatalog(run.botId);
  }
  async ownerContentCatalog(scope: OwnerContentScope) {
    await this.#assertOwnerScope(scope);
    return this.#contentCatalog(scope.botId);
  }
  async #assertOwnerScope(scope: OwnerContentScope): Promise<void> {
    if (!this.options.assertOwnerContentScope) throw new PluginError("forbidden");
    await this.options.assertOwnerContentScope(scope);
  }
  async #contentCatalog(botId: string): Promise<PluginContentCatalog> {
    const items: PluginContentItem[] = [];
    let truncated = false;
    for (const plugin of (await this.options.store.read()).plugins.filter((item) => item.enabled)) {
      const grant = plugin.grants.find((item) => item.botId === botId);
      const declared = [
        ...(plugin.resources ?? [])
          .filter((item) => grant?.resources?.includes(item.uri))
          .map((item) => ({
            kind: "resource" as const,
            name: item.uri,
            description: item.description,
            ...(item.mimeType ? { mimeType: item.mimeType } : {}),
          })),
        ...(plugin.prompts ?? [])
          .filter((item) => grant?.prompts?.includes(item.name))
          .map((item) => ({
            kind: "prompt" as const,
            name: item.name,
            description: item.description,
            arguments: item.arguments,
          })),
      ];
      for (const item of declared) {
        const entry = {
          pluginId: plugin.id,
          revision: plugin.revision,
          pluginName: plugin.name,
          ...item,
        };
        if (
          items.length >= 32 ||
          Buffer.byteLength(JSON.stringify([...items, entry])) > 12 * 1024
        ) {
          truncated = true;
          continue;
        }
        items.push(entry);
      }
    }
    return { items, truncated };
  }

  async readContent(run: Run, value: unknown, signal: AbortSignal) {
    return this.#readContent(run, value, signal, () => this.options.assertScope(run));
  }
  async ownerReadContent(scope: OwnerContentScope, value: unknown, signal: AbortSignal) {
    return this.#readContent(scope, value, signal, () => this.#assertOwnerScope(scope));
  }
  async #readContent(
    run: OwnerContentScope & { id?: string },
    value: unknown,
    signal: AbortSignal,
    assertScope: () => Promise<void>,
  ) {
    const input = readPluginContentSchema.parse(JSON.parse(boundedJson(value, 12 * 1024)));
    await assertScope();
    const authorize = (state: PluginState) => {
      const plugin = this.#find(state, input.pluginId, input.revision);
      const grant = plugin.grants.find((item) => item.botId === run.botId);
      if (
        !plugin.enabled ||
        !(input.kind === "resource"
          ? grant?.resources?.includes(input.name)
          : grant?.prompts?.includes(input.name))
      )
        throw new PluginError("forbidden");
      return plugin;
    };
    const plugin = authorize(await this.options.store.read());
    if (input.kind === "resource" && Object.keys(input.arguments).length)
      throw new PluginError("invalid");
    if (input.kind === "prompt") {
      const args = plugin.prompts?.find((item) => item.name === input.name)?.arguments;
      if (
        !args ||
        Object.keys(input.arguments).some((key) => !args.some((arg) => arg.name === key)) ||
        args.some((arg) => arg.required && !(arg.name in input.arguments))
      )
        throw new PluginError("invalid");
    }
    if (this.#active.size >= 16) throw new PluginError("unavailable");
    const id = randomUUID();
    const abort = new AbortController();
    const deadline = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(30_000)]);
    this.#active.set(id, { pluginId: plugin.id, abort });
    let client: Awaited<ReturnType<PluginConnector>> | undefined;
    try {
      client = await this.#connector(plugin.endpoint, plugin.token, deadline);
      const current = await this.#manifest(plugin.name, plugin.endpoint, client, deadline);
      if (current.digest !== plugin.digest) throw new PluginError("conflict");
      await assertScope();
      await this.options.store.transaction((state) => {
        deadline.throwIfAborted();
        authorize(state);
        recordPluginAudit(state, {
          phase: `${input.kind}_reading`,
          pluginId: plugin.id,
          botId: run.botId,
          runId: run.id,
          callId: id,
        });
      });
      const raw =
        input.kind === "resource"
          ? await client.readResource?.(input.name, deadline)
          : await client.getPrompt?.(input.name, input.arguments, deadline);
      const result =
        input.kind === "resource"
          ? pluginResourceResultSchema.parse(raw)
          : pluginPromptResultSchema.parse(raw);
      const isApp =
        input.kind === "resource" &&
        plugin.resources?.some(
          (item) => item.uri === input.name && item.mimeType === "text/html;profile=mcp-app",
        );
      boundedJson(result, isApp ? 160 * 1024 : 12 * 1024);
      if (
        "contents" in result &&
        result.contents.some(
          (item) =>
            item.uri !== input.name || (item.mimeType === "text/html;profile=mcp-app" && !isApp),
        )
      )
        throw new PluginError("invalid");
      if (
        isApp &&
        (!input.name.startsWith("ui://") ||
          !("contents" in result) ||
          result.contents.length !== 1 ||
          result.contents[0]?.mimeType !== "text/html;profile=mcp-app")
      )
        throw new PluginError("invalid");
      deadline.throwIfAborted();
      await assertScope();
      await this.options.store.transaction((state) => {
        deadline.throwIfAborted();
        authorize(state);
        recordPluginAudit(state, {
          phase: `${input.kind}_read`,
          pluginId: plugin.id,
          botId: run.botId,
          runId: run.id,
          callId: id,
        });
      });
      // This is data, including prompt messages. The caller must never promote it to system authority.
      return {
        plugin: plugin.name,
        kind: input.kind,
        name: input.name,
        result,
        untrusted: true as const,
      };
    } catch (error) {
      throw error instanceof PluginError ? error : new PluginError("unavailable");
    } finally {
      await client?.close().catch(() => {});
      this.#active.delete(id);
    }
  }

  async install(value: unknown, signal: AbortSignal): Promise<InstalledPlugin> {
    const input = installPluginSchema.parse(value);
    const manifest = await this.preview(
      {
        name: input.name,
        endpoint: input.endpoint,
        ...(input.token ? { token: input.token } : {}),
      },
      signal,
    );
    if (manifest.digest !== input.reviewedDigest) throw new PluginError("conflict");
    return this.options.store.transaction((state) => {
      signal.throwIfAborted();
      if (
        state.plugins.length >= 16 ||
        state.plugins.some((plugin) => plugin.endpoint === manifest.endpoint)
      )
        throw new PluginError("conflict", "插件已安装或已达到16个插件上限。");
      const plugin: PluginRecord = {
        ...manifest,
        id: randomUUID(),
        revision: randomUUID(),
        enabled: false,
        grants: [],
        createdAt: new Date().toISOString(),
        ...(input.token ? { token: input.token } : {}),
      };
      state.plugins.push(plugin);
      recordPluginAudit(state, { phase: "installed", pluginId: plugin.id });
      return publicPlugin(plugin);
    });
  }

  async setEnabled(id: string, value: unknown): Promise<InstalledPlugin> {
    const input = updatePluginSchema.parse(value);
    const result = await this.options.store.transaction((state) => {
      const plugin = this.#find(state, id, input.revision);
      plugin.enabled = input.enabled;
      plugin.revision = randomUUID();
      recordPluginAudit(state, { phase: input.enabled ? "enabled" : "disabled", pluginId: id });
      return publicPlugin(plugin);
    });
    this.#revoke(id);
    return result;
  }

  async grant(id: string, botId: string, value: unknown): Promise<InstalledPlugin> {
    const input = grantPluginSchema.parse(value);
    if (!(await this.options.botExists(botId))) throw new PluginError("not_found");
    if (
      new Set(input.tools.map((item) => item.name)).size !== input.tools.length ||
      new Set(input.resources).size !== input.resources.length ||
      new Set(input.prompts).size !== input.prompts.length
    )
      throw new PluginError("invalid");
    const result = await this.options.store.transaction((state) => {
      const plugin = this.#find(state, id, input.revision);
      if (
        input.tools.some((grant) => !plugin.tools.some((tool) => tool.name === grant.name)) ||
        input.resources.some((uri) => !plugin.resources?.some((item) => item.uri === uri)) ||
        input.prompts.some((name) => !plugin.prompts?.some((item) => item.name === name))
      )
        throw new PluginError("invalid");
      plugin.grants = plugin.grants.filter((grant) => grant.botId !== botId);
      if (input.tools.length || input.resources.length || input.prompts.length)
        plugin.grants.push({
          botId,
          tools: input.tools,
          resources: input.resources,
          prompts: input.prompts,
        });
      if (plugin.grants.length > 128) throw new PluginError("invalid");
      plugin.revision = randomUUID();
      recordPluginAudit(state, { phase: "grants_changed", pluginId: id, botId });
      return publicPlugin(plugin);
    });
    this.#revoke(id);
    return result;
  }

  async remove(id: string, revision: string): Promise<void> {
    await this.options.store.transaction((state) => {
      this.#find(state, id, revision);
      state.plugins = state.plugins.filter((plugin) => plugin.id !== id);
      recordPluginAudit(state, { phase: "removed", pluginId: id });
    });
    this.#revoke(id);
  }

  async catalog(run: Run): Promise<{ tools: PluginCatalogItem[]; truncated: boolean }> {
    await this.options.assertScope(run);
    const { plugins } = await this.options.store.read();
    const tools: PluginCatalogItem[] = [];
    let truncated = false;
    for (const plugin of plugins.filter((plugin) => plugin.enabled)) {
      for (const grant of plugin.grants.find((grant) => grant.botId === run.botId)?.tools ?? []) {
        const descriptor = plugin.tools.find((tool) => tool.name === grant.name);
        if (!descriptor) continue;
        const item: PluginCatalogItem = {
          pluginId: plugin.id,
          revision: plugin.revision,
          pluginName: plugin.name,
          toolName: grant.name,
          mode: grant.mode,
          description: descriptor.description.slice(0, 500),
          inputSchema: descriptor.inputSchema,
        };
        if (tools.length >= 16 || Buffer.byteLength(JSON.stringify([...tools, item])) > 12 * 1024) {
          truncated = true;
          continue;
        }
        tools.push(item);
      }
    }
    return { tools, truncated };
  }

  async call(
    run: Run,
    value: z.infer<typeof callPluginSchema>,
    signal: AbortSignal,
  ): Promise<unknown> {
    await this.recover();
    // Detach nested values so the reviewed arguments and the eventual wire call are identical.
    const input = callPluginSchema.parse(JSON.parse(boundedJson(value, 16 * 1024)));
    boundedJson(input.arguments, 8 * 1024);
    await this.options.assertScope(run);
    const snapshot = await this.options.store.read();
    const plugin = this.#authorized(snapshot, run, input.pluginId, input.revision, input.toolName);
    const descriptor = plugin.tools.find((tool) => tool.name === input.toolName);
    if (!descriptor) throw new PluginError("forbidden");
    // Persisted catalogs may predate the current policy; reject them before compile or connection.
    checkPluginSchema(descriptor.inputSchema);
    const validate = new AjvJsonSchemaValidator().getValidator(descriptor.inputSchema);
    if (!validate(input.arguments).valid) throw new PluginError("invalid");
    if (this.#active.size >= 16) throw new PluginError("unavailable", "插件并发已达上限。");
    const id = randomUUID();
    const abort = new AbortController();
    const deadline = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(120_000)]);
    this.#active.set(id, { pluginId: plugin.id, abort });
    let client: Awaited<ReturnType<PluginConnector>> | undefined;
    try {
      const mode = plugin.grants
        .find((grant) => grant.botId === run.botId)
        ?.tools.find((grant) => grant.name === input.toolName)?.mode;
      if (mode !== "read" && mode !== "confirm") throw new PluginError("forbidden");
      await this.options.store.transaction((state) => {
        deadline.throwIfAborted();
        this.#authorized(state, run, plugin.id, plugin.revision, input.toolName);
        const now = new Date().toISOString();
        insertCallReceipt(state, {
          id,
          runId: run.id,
          channelId: run.channelId,
          botId: run.botId,
          pluginId: plugin.id,
          pluginName: plugin.name,
          pluginRevision: plugin.revision,
          toolName: input.toolName,
          mode,
          state: "preparing",
          approvalDecision: null,
          createdAt: now,
          updatedAt: now,
        });
      });
      client = await this.#connector(plugin.endpoint, plugin.token, deadline);
      const current = await this.#manifest(plugin.name, plugin.endpoint, client, deadline);
      if (current.digest !== plugin.digest) throw new PluginError("conflict");
      await this.#check(run, plugin.id, plugin.revision, input.toolName, deadline);
      if (mode === "confirm") {
        await this.#waitApproval(run, plugin, id, input.toolName, input.arguments, deadline);
        const refreshed = await this.#manifest(plugin.name, plugin.endpoint, client, deadline);
        if (refreshed.digest !== plugin.digest) throw new PluginError("conflict");
      }
      await this.options.assertScope(run);
      // Commit content-free dispatch intent before the external effect can leave the Server.
      await this.options.store.transaction((state) => {
        deadline.throwIfAborted();
        this.#authorized(state, run, plugin.id, plugin.revision, input.toolName);
        const receipt = callReceipt(state, id);
        receipt.state = "dispatching";
        receipt.dispatchedAt = receipt.updatedAt = new Date().toISOString();
        recordPluginAudit(state, {
          phase: "dispatching",
          pluginId: plugin.id,
          botId: run.botId,
          runId: run.id,
          callId: id,
          toolName: input.toolName,
        });
      });
      deadline.throwIfAborted();
      const result = await abortPluginOperation(
        client.call(input.toolName, input.arguments, deadline),
        deadline,
      );
      boundedJson(result, 12 * 1024);
      await this.#check(run, plugin.id, plugin.revision, input.toolName, deadline);
      await this.options.store.transaction((state) => {
        deadline.throwIfAborted();
        this.#authorized(state, run, plugin.id, plugin.revision, input.toolName);
        const receipt = callReceipt(state, id);
        receipt.state = "response_received";
        receipt.responseReceivedAt = receipt.updatedAt = new Date().toISOString();
        recordPluginAudit(state, {
          phase: "completed",
          pluginId: plugin.id,
          botId: run.botId,
          runId: run.id,
          callId: id,
          toolName: input.toolName,
        });
      });
      return { plugin: plugin.name, tool: input.toolName, result, untrusted: true };
    } catch (error) {
      await this.options.store
        .transaction((state) => {
          const receipt = state.callReceipts?.find((call) => call.id === id);
          if (receipt && receipt.state !== "response_received") {
            receipt.state = receipt.dispatchedAt ? "outcome_unknown" : "not_dispatched";
            receipt.updatedAt = new Date().toISOString();
            if (receipt.approvalRequestedAt && receipt.approvalDecision === null) {
              receipt.approvalDecision =
                error instanceof PluginError && error.code === "expired"
                  ? "expired"
                  : "interrupted";
              receipt.approvalDecidedAt = receipt.updatedAt;
            }
          }
          recordPluginAudit(state, {
            phase: "failed",
            pluginId: plugin.id,
            botId: run.botId,
            runId: run.id,
            callId: id,
            toolName: input.toolName,
          });
        })
        .catch(() => {});
      throw error instanceof PluginError ? error : new PluginError("unavailable");
    } finally {
      this.#pending.delete(id);
      await client?.close().catch(() => {});
      this.#active.delete(id);
    }
  }

  async decide(id: string, decision: "approve" | "reject"): Promise<void> {
    const call = this.#pending.get(id);
    if (!call) throw new PluginError("not_found");
    await this.options.assertScope(call.run);
    await this.options.store.transaction((state) => {
      if (this.#pending.get(id) !== call || call.signal.aborted) throw new PluginError("conflict");
      if (Date.parse(call.view.expiresAt) <= Date.now()) throw new PluginError("expired");
      this.#authorized(state, call.run, call.view.pluginId, call.revision, call.view.toolName);
      const receipt = callReceipt(state, id);
      // Concurrent decisions can await the same file queue while the first request is settling.
      if (receipt.approvalDecision !== null) throw new PluginError("conflict");
      receipt.approvalDecision = decision === "approve" ? "approved" : "rejected";
      receipt.approvalDecidedAt = receipt.updatedAt = new Date().toISOString();
      recordPluginAudit(state, {
        phase: decision === "approve" ? "approved" : "rejected",
        pluginId: call.view.pluginId,
        botId: call.run.botId,
        runId: call.run.id,
        callId: id,
        toolName: call.view.toolName,
      });
    });
    // A call is resolved once, only after its decision has persisted successfully.
    if (this.#pending.get(id) !== call || call.signal.aborted) throw new PluginError("conflict");
    this.#pending.delete(id);
    call.settle(decision);
  }

  close(): void {
    for (const active of this.#active.values()) active.abort.abort();
  }
  #revoke(pluginId: string): void {
    for (const active of this.#active.values())
      if (active.pluginId === pluginId) active.abort.abort();
  }
  #find(state: PluginState, id: string, revision: string): PluginRecord {
    const plugin = state.plugins.find((plugin) => plugin.id === id);
    if (!plugin) throw new PluginError("not_found");
    if (plugin.revision !== revision) throw new PluginError("conflict");
    return plugin;
  }
  #authorized(
    state: PluginState,
    run: Run,
    id: string,
    revision: string,
    toolName: string,
  ): PluginRecord {
    const plugin = this.#find(state, id, revision);
    if (
      !plugin.enabled ||
      !plugin.grants.some(
        (grant) => grant.botId === run.botId && grant.tools.some((tool) => tool.name === toolName),
      )
    )
      throw new PluginError("forbidden");
    return plugin;
  }
  async #check(
    run: Run,
    id: string,
    revision: string,
    toolName: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.options.assertScope(run);
    this.#authorized(await this.options.store.read(), run, id, revision, toolName);
    signal.throwIfAborted();
  }
  async #waitApproval(
    run: Run,
    plugin: PluginRecord,
    id: string,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.options.store.transaction((state) => {
      signal.throwIfAborted();
      this.#authorized(state, run, plugin.id, plugin.revision, toolName);
      const receipt = callReceipt(state, id);
      receipt.state = "awaiting_approval";
      receipt.approvalRequestedAt = receipt.updatedAt = new Date().toISOString();
      recordPluginAudit(state, {
        phase: "approval_requested",
        pluginId: plugin.id,
        botId: run.botId,
        runId: run.id,
        callId: id,
        toolName,
      });
    });
    let settle!: WaitingCall["settle"];
    const decided = new Promise<"approve" | "reject">((resolve) => {
      settle = resolve;
    });
    const expiresAt = new Date(Date.now() + this.#approvalTimeout).toISOString();
    this.#pending.set(id, {
      run,
      revision: plugin.revision,
      signal,
      settle,
      view: {
        id,
        pluginId: plugin.id,
        pluginName: plugin.name,
        toolName,
        botId: run.botId,
        channelId: run.channelId,
        runId: run.id,
        arguments: structuredClone(args),
        expiresAt,
      },
    });
    const timeout = AbortSignal.timeout(this.#approvalTimeout);
    try {
      const approvalSignal = AbortSignal.any([signal, timeout]);
      const decision = await abortPluginOperation(decided, approvalSignal);
      if (decision !== "approve") throw new PluginError("rejected");
    } catch (error) {
      if (!signal.aborted && (timeout.aborted || Date.parse(expiresAt) <= Date.now()))
        throw new PluginError("expired");
      throw error;
    } finally {
      this.#pending.delete(id);
    }
  }
}
