import type { Bot } from "@openbot/domain";
import { type FormEvent, useEffect, useState } from "react";
import {
  listPlugins,
  type Plugin,
  type PluginContentScope,
  type PluginGrant,
  type PluginManifest,
  type PluginTool,
  pluginError,
  pluginRequest,
} from "../plugin-api";
import "./PluginManagerPanel.css";
import {
  PluginCatalogLinks,
  PluginContentDeclarations,
  PluginContentPanel,
  PluginUpdatePanel,
} from "./PluginPlatformPanels";

export interface PluginManagerProps {
  bots: Bot[];
  scope?: PluginContentScope | undefined;
  onInsertMaterial?: ((text: string) => void) | undefined;
}

export function PluginManagerPanel(props: PluginManagerProps) {
  const [open, setOpen] = useState(false);
  return (
    <details className="plugin-manager" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <strong>插件</strong>
        <span>连接 MCP 服务，为 Bot 分配工具、资源与界面</span>
      </summary>
      {open ? <PluginManager {...props} /> : null}
    </details>
  );
}

export function PluginManager({ bots, scope, onInsertMaterial }: PluginManagerProps) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is an explicit refresh and post-mutation reload.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void listPlugins(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]))
      .then((snapshot) => {
        if (!controller.signal.aborted) setPlugins(snapshot.plugins);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(pluginError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);
  async function mutate(path: string, method: string, input: unknown) {
    setBusy(true);
    setError(undefined);
    try {
      await pluginRequest(path, { method, body: JSON.stringify(input) });
      setRemoving(undefined);
      setAttempt((value) => value + 1);
    } catch (cause) {
      setError(pluginError(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="plugin-manager-body">
      <div className="plugin-manager-toolbar">
        <p>连接工具、资源、提示词和隔离界面。安装后为指定 Bot 分配权限。</p>
        <button type="button" className="secondary-button" onClick={() => setAdding(!adding)}>
          添加工具插件
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={busy || loading}
          onClick={() => setAttempt((value) => value + 1)}
        >
          刷新
        </button>
      </div>
      <PluginCatalogLinks />
      {adding ? (
        <PluginInstallForm
          onInstalled={() => {
            setAdding(false);
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {loading ? <p role="status">正在读取工具插件…</p> : null}
      {!loading && !error && !plugins.length ? (
        <p>还没有工具插件。添加一个 MCP 服务，审核工具后分配给 Bot。</p>
      ) : null}
      {plugins.map((plugin) => (
        <section
          className="installed-plugin"
          key={plugin.id}
          aria-label={`工具插件 ${plugin.name}`}
        >
          <header>
            <div>
              <h3>{plugin.name}</h3>
              <p className="plugin-endpoint">{plugin.endpoint}</p>
            </div>
            <span>{plugin.enabled ? "已启用" : "已停用"}</span>
          </header>
          <div className="plugin-manager-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy || loading}
              onClick={() =>
                void mutate(`plugins/${encodeURIComponent(plugin.id)}`, "PATCH", {
                  revision: plugin.revision,
                  enabled: !plugin.enabled,
                }).catch(() => undefined)
              }
            >
              {plugin.enabled ? "停用" : "启用"}
            </button>
            {removing === plugin.id ? (
              <>
                <span>移除后将撤销此插件的 Bot 授权。</span>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void mutate(`plugins/${encodeURIComponent(plugin.id)}`, "DELETE", {
                      revision: plugin.revision,
                    }).catch(() => undefined)
                  }
                >
                  确认移除
                </button>
                <button type="button" disabled={busy} onClick={() => setRemoving(undefined)}>
                  取消
                </button>
              </>
            ) : (
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => setRemoving(plugin.id)}
              >
                移除
              </button>
            )}
          </div>
          <PluginToolList tools={plugin.tools} />
          <PluginContentDeclarations manifest={plugin} />
          <PluginUpdatePanel
            key={`update:${plugin.id}:${plugin.revision}`}
            plugin={plugin}
            onApplied={() => setAttempt((value) => value + 1)}
          />
          <PluginContentPanel plugin={plugin} scope={scope} onInsertMaterial={onInsertMaterial} />
          <PluginGrantEditor
            key={plugin.id}
            plugin={plugin}
            bots={bots}
            disabled={busy || loading}
            onSave={(botId, tools, content) =>
              mutate(
                `plugins/${encodeURIComponent(plugin.id)}/grants/${encodeURIComponent(botId)}`,
                "PUT",
                { revision: plugin.revision, tools, ...content },
              )
            }
          />
        </section>
      ))}
    </div>
  );
}

export function PluginInstallForm({ onInstalled }: { onInstalled(): void }) {
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [manifest, setManifest] = useState<PluginManifest>();
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  function invalidate() {
    setManifest(undefined);
    setReviewed(false);
    setError(undefined);
  }
  async function preview(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setManifest(undefined);
    setReviewed(false);
    try {
      setManifest(
        await pluginRequest<PluginManifest>("plugins/preview", {
          method: "POST",
          signal: AbortSignal.timeout(35_000),
          body: JSON.stringify({
            name: name.trim(),
            endpoint: endpoint.trim(),
            ...(token ? { token } : {}),
          }),
        }),
      );
    } catch (cause) {
      setError(pluginError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function install() {
    if (!manifest || !reviewed || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await pluginRequest("plugins", {
        method: "POST",
        signal: AbortSignal.timeout(35_000),
        body: JSON.stringify({
          name: name.trim(),
          endpoint: endpoint.trim(),
          ...(token ? { token } : {}),
          reviewedDigest: manifest.digest,
        }),
      });
      setToken("");
      onInstalled();
    } catch (cause) {
      setError(pluginError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="plugin-install" aria-label="添加工具插件">
      <form className="plugin-fields" onSubmit={(event) => void preview(event)}>
        <label>
          插件名称
          <input
            required
            maxLength={80}
            disabled={busy}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              invalidate();
            }}
          />
        </label>
        <label>
          MCP 服务地址
          <input
            required
            type="url"
            maxLength={2048}
            disabled={busy}
            value={endpoint}
            placeholder="https://example.com/mcp"
            onChange={(event) => {
              setEndpoint(event.target.value);
              invalidate();
            }}
          />
        </label>
        <label>
          访问令牌（可选）
          <input
            type="password"
            autoComplete="off"
            maxLength={2048}
            disabled={busy}
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              invalidate();
            }}
          />
        </label>
        <p>预览会连接服务并读取工具声明，不调用工具。令牌由 Server 加密保存，不会提供给模型。</p>
        <button className="secondary-button" disabled={busy} type="submit">
          {busy ? "正在处理…" : "连接并预览工具"}
        </button>
      </form>
      {manifest ? (
        <div>
          <h4>
            {manifest.name} · {manifest.tools.length} 个工具
          </h4>
          <p className="plugin-endpoint">{manifest.endpoint}</p>
          <PluginToolList tools={manifest.tools} />
          <PluginContentDeclarations manifest={manifest} />
          <label className="plugin-review-check">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
              disabled={busy}
            />
            我已检查服务地址和工具声明，同意安装；稍后单独分配 Bot 权限。
          </label>
          <button
            type="button"
            className="primary-button"
            disabled={!reviewed || busy}
            onClick={() => void install()}
          >
            安装为停用状态
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function PluginToolList({ tools }: { tools: PluginTool[] }) {
  return (
    <div className="plugin-tool-list">
      {tools.map((tool) => (
        <details key={tool.name}>
          <summary>{tool.name}</summary>
          <p>{tool.description || "此工具未提供说明。"}</p>
          <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
          {tool.annotations ? (
            <>
              <p>以下是插件自报信息，不代表已获得授权。</p>
              <pre>{JSON.stringify(tool.annotations, null, 2)}</pre>
            </>
          ) : null}
        </details>
      ))}
    </div>
  );
}

function grantsForBot(plugin: Plugin, botId: string): {
  tools: PluginGrant[];
  resources: string[];
  prompts: string[];
} {
  const grant = plugin.grants.find((item) => item.botId === botId);
  const toolNames = new Set(plugin.tools.map((tool) => tool.name));
  const resourceUris = new Set((plugin.resources ?? []).map((resource) => resource.uri));
  const promptNames = new Set((plugin.prompts ?? []).map((prompt) => prompt.name));
  return {
    tools: (grant?.tools ?? []).filter((item) => toolNames.has(item.name)),
    resources: (grant?.resources ?? []).filter((uri) => resourceUris.has(uri)),
    prompts: (grant?.prompts ?? []).filter((name) => promptNames.has(name)),
  };
}

export function PluginGrantEditor({
  plugin,
  bots,
  disabled,
  onSave,
}: {
  plugin: Plugin;
  bots: Bot[];
  disabled: boolean;
  onSave(
    botId: string,
    tools: PluginGrant[],
    content: { resources: string[]; prompts: string[] },
  ): Promise<void>;
}) {
  // Sticky selection: only the Owner dropdown may change botId. Do not fall back to
  // bots[0] when the prior Bot disappears — that would show another Bot's empty grants.
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const selectedBotAvailable = bots.some((bot) => bot.id === botId);
  const initial = grantsForBot(plugin, botId);
  const [grants, setGrants] = useState<PluginGrant[]>(initial.tools);
  const [resources, setResources] = useState<string[]>(initial.resources);
  const [prompts, setPrompts] = useState<string[]>(initial.prompts);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!botId || !selectedBotAvailable) {
      setGrants([]);
      setResources([]);
      setPrompts([]);
      return;
    }
    const next = grantsForBot(plugin, botId);
    setGrants(next.tools);
    setResources(next.resources);
    setPrompts(next.prompts);
  }, [plugin, botId, selectedBotAvailable]);
  return (
    <form
      className="plugin-grant-editor"
      aria-label={`分配 ${plugin.name} 工具`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!botId || !selectedBotAvailable || disabled) return;
        void onSave(botId, grants, { resources, prompts })
          .then(() => setSaved(true))
          .catch(() => undefined);
      }}
    >
      <h4>分配给 Bot</h4>
      <label>
        接收 Bot
        <select
          aria-label={`${plugin.name} 接收 Bot`}
          value={botId}
          disabled={disabled}
          onChange={(event) => {
            const id = event.target.value;
            setBotId(id);
            const next = grantsForBot(plugin, id);
            setGrants(next.tools);
            setResources(next.resources);
            setPrompts(next.prompts);
            setSaved(false);
          }}
        >
          {botId && !selectedBotAvailable ? (
            <option value={botId} disabled>
              （Bot 已不存在）
            </option>
          ) : null}
          {bots.map((bot) => (
            <option value={bot.id} key={bot.id}>
              {bot.name}
            </option>
          ))}
        </select>
      </label>
      {plugin.tools.map((tool) => (
        <label className="plugin-tool-grant" key={tool.name}>
          <span>{tool.name}</span>
          <select
            aria-label={`${tool.name} 调用权限`}
            disabled={disabled || !botId || !selectedBotAvailable}
            value={grants.find((grant) => grant.name === tool.name)?.mode ?? "none"}
            onChange={(event) => {
              const mode = event.target.value;
              setGrants((current) => [
                ...current.filter((grant) => grant.name !== tool.name),
                ...(mode === "read" || mode === "confirm"
                  ? [{ name: tool.name, mode } satisfies PluginGrant]
                  : []),
              ]);
              setSaved(false);
            }}
          >
            <option value="none">不授权</option>
            <option value="confirm">每次调用前确认</option>
            <option value="read">允许持续只读调用</option>
          </select>
        </label>
      ))}
      {(plugin.resources ?? []).map((resource) => (
        <label className="plugin-review-check" key={resource.uri}>
          <input
            type="checkbox"
            disabled={disabled || !botId || !selectedBotAvailable}
            checked={resources.includes(resource.uri)}
            onChange={(event) => {
              setResources((current) =>
                event.target.checked
                  ? [...current, resource.uri]
                  : current.filter((uri) => uri !== resource.uri),
              );
              setSaved(false);
            }}
          />
          {resource.mimeType === "text/html;profile=mcp-app" ? "界面" : "资源"}：{resource.name}
        </label>
      ))}
      {(plugin.prompts ?? []).map((prompt) => (
        <label className="plugin-review-check" key={prompt.name}>
          <input
            type="checkbox"
            disabled={disabled || !botId || !selectedBotAvailable}
            checked={prompts.includes(prompt.name)}
            onChange={(event) => {
              setPrompts((current) =>
                event.target.checked
                  ? [...current, prompt.name]
                  : current.filter((name) => name !== prompt.name),
              );
              setSaved(false);
            }}
          />
          提示词：{prompt.name}
        </label>
      ))}
      <p>
        只读权限由你判断并授权，不采用插件自报标签。可能写入或产生外部影响的工具应选择每次确认。
      </p>
      <button className="secondary-button" type="submit" disabled={disabled || !botId || !selectedBotAvailable}>
        保存 Bot 工具权限
      </button>
      {saved ? <span role="status">已保存</span> : null}
    </form>
  );
}
