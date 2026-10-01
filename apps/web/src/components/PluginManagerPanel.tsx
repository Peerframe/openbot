import type { Bot } from "@openbot/domain";
import { type MutableRefObject, useEffect, useRef, useState } from "react";
import {
  listPlugins,
  type Plugin,
  type PluginContentScope,
  pluginError,
  pluginRequest,
} from "../plugin-api";
import "./PluginManagerPanel.css";
import { SearchIcon } from "./Icons";
import { PluginGrantEditor } from "./PluginGrantEditor";
import { PluginInstallForm } from "./PluginInstallForm";
import {
  PluginCatalogLinks,
  PluginContentDeclarations,
  PluginContentPanel,
  PluginUpdatePanel,
} from "./PluginPlatformPanels";
import { PluginToolList } from "./PluginToolList";
import { RobotAvatar } from "./RobotAvatar";
import { SettingsHeaderAction } from "./SettingsHeaderAction";

/** SPA-session sticky Bot selection per plugin (survives Skills remount / details keep-alive). */
const grantBotSelectionByPlugin = new Map<string, string>();

/** Test-only: clear sticky Bot selection between cases. */
export function resetGrantBotSelectionForTests(): void {
  grantBotSelectionByPlugin.clear();
}

export interface PluginManagerProps {
  bots: Bot[];
  /**
   * "settings" renders Settings → 插件 (SettingsPlugins artboard); "catalog" renders the Plugins
   * artboard's dialog body. Both share this component's state and Server mutations.
   */
  variant?: "panel" | "settings" | "catalog" | undefined;
  /** Catalog: opens Settings → 插件 from 「已安装 N 个」. */
  onManage?: (() => void) | undefined;
  scope?: PluginContentScope | undefined;
  onInsertMaterial?: ((text: string) => void) | undefined;
}

export function PluginManagerPanel(props: PluginManagerProps) {
  const [open, setOpen] = useState(false);
  // Keep PluginManager mounted after the first open so grant Bot selection survives
  // details toggle quirks / transient close during post-save reloads.
  const [mounted, setMounted] = useState(false);
  const grantBotSelectionRef = useRef(grantBotSelectionByPlugin);
  return (
    <details
      className="plugin-manager"
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        if (next) setMounted(true);
      }}
    >
      <summary>
        <strong>插件</strong>
        <span>连接 MCP 服务，为 Bot 分配工具、资源与界面</span>
      </summary>
      {mounted ? (
        <div hidden={!open}>
          <PluginManager {...props} grantBotSelectionRef={grantBotSelectionRef} />
        </div>
      ) : null}
    </details>
  );
}

export function PluginManager({
  bots,
  scope,
  onInsertMaterial,
  grantBotSelectionRef,
  variant = "panel",
  onManage,
}: PluginManagerProps & {
  grantBotSelectionRef?: MutableRefObject<Map<string, string>>;
}) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string>();
  const [managing, setManaging] = useState<string>();
  const [query, setQuery] = useState("");
  const localGrantBotSelectionRef = useRef(grantBotSelectionByPlugin);
  const botSelectionRef = grantBotSelectionRef ?? localGrantBotSelectionRef;
  async function reloadPlugins(signal?: AbortSignal) {
    setLoading(true);
    setError(undefined);
    try {
      const snapshot = await listPlugins(
        AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]),
      );
      if (signal?.aborted) return;
      setPlugins(snapshot.plugins);
      // Drop selection entries for plugins that disappeared (uninstall / empty snapshot).
      const alive = new Set(snapshot.plugins.map((plugin) => plugin.id));
      for (const pluginId of [...botSelectionRef.current.keys()]) {
        if (!alive.has(pluginId)) botSelectionRef.current.delete(pluginId);
      }
    } catch (cause: unknown) {
      if (signal?.aborted) return;
      setError(pluginError(cause));
      throw cause;
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is an explicit refresh trigger.
  useEffect(() => {
    const controller = new AbortController();
    void reloadPlugins(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [attempt]);
  async function mutate(path: string, method: string, input: unknown) {
    setBusy(true);
    setError(undefined);
    try {
      await pluginRequest(path, { method, body: JSON.stringify(input) });
      setRemoving(undefined);
      // Await the post-mutation GET so grant editors bind success to the authoritative snapshot.
      await reloadPlugins();
    } catch (cause) {
      setError(pluginError(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  }
  const botNames = new Map(bots.map((bot) => [bot.id, bot.name]));
  function toggle(plugin: Plugin) {
    void mutate(`plugins/${encodeURIComponent(plugin.id)}`, "PATCH", {
      revision: plugin.revision,
      enabled: !plugin.enabled,
    }).catch(() => undefined);
  }
  function details(plugin: Plugin) {
    return (
      <>
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
          selectedBotId={botSelectionRef.current.get(plugin.id)}
          onSelectedBotIdChange={(botId) => {
            if (botId) botSelectionRef.current.set(plugin.id, botId);
            else botSelectionRef.current.delete(plugin.id);
          }}
          onSave={(botId, tools, content) =>
            mutate(
              `plugins/${encodeURIComponent(plugin.id)}/grants/${encodeURIComponent(botId)}`,
              "PUT",
              { revision: plugin.revision, tools, ...content },
            )
          }
        />
      </>
    );
  }

  if (variant === "catalog") {
    const term = query.trim().toLocaleLowerCase();
    const shown = plugins.filter((plugin) =>
      `${plugin.name} ${plugin.tools.map((tool) => `${tool.name} ${tool.description}`).join(" ")}`
        .toLocaleLowerCase()
        .includes(term),
    );
    const botById = new Map(bots.map((bot) => [bot.id, bot]));
    return (
      <div className="plugins-catalog">
        <header className="plugins-catalog-header">
          <h1 id="plugins-dialog-title">插件</h1>
          {plugins.length > 0 ? (
            <button type="button" className="plugins-installed" onClick={onManage}>
              <span aria-hidden="true">
                {plugins.slice(0, 4).map((plugin) => (
                  <i key={plugin.id}>{Array.from(plugin.name.trim())[0]?.toLocaleUpperCase()}</i>
                ))}
              </span>
              已安装 {plugins.length} 个
            </button>
          ) : null}
        </header>
        <label className="plugins-search">
          <SearchIcon />
          <input
            type="search"
            aria-label="搜索插件"
            placeholder="搜索插件"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
        <section className="plugins-section" aria-labelledby="plugins-mine">
          <div className="plugins-section-heading">
            <h2 id="plugins-mine">我的插件</h2>
            <span>给哪个 Bot 用，在这里决定</span>
          </div>
          {loading && !plugins.length ? (
            <p className="plugins-empty" role="status">
              正在读取插件…
            </p>
          ) : shown.length === 0 ? (
            <p className="plugins-empty">
              {plugins.length
                ? "没有匹配的插件。"
                : "还没有插件。添加一个 MCP 服务，审核工具后分配给 Bot。"}
            </p>
          ) : (
            <div className="plugins-card">
              {shown.map((plugin) => {
                const granted = plugin.grants.flatMap((grant) => {
                  const bot = botById.get(grant.botId);
                  return bot ? [bot] : [];
                });
                return (
                  <div className="plugins-row" key={plugin.id}>
                    <div className="plugins-row-main">
                      <span className="plugins-tile" aria-hidden="true">
                        {Array.from(plugin.name.trim())[0]?.toLocaleUpperCase() ?? "?"}
                      </span>
                      <span className="plugins-row-text">
                        <strong>{plugin.name}</strong>
                        <small>
                          {plugin.enabled
                            ? plugin.tools
                                .map((tool) => tool.description || tool.name)
                                .join("、") || "没有声明工具"
                            : "已停用"}
                        </small>
                      </span>
                      <span
                        className="plugins-bots"
                        title={`已授权：${granted.map((bot) => bot.name).join("、") || "无"}`}
                      >
                        {granted.slice(0, 4).map((bot) => (
                          <RobotAvatar key={bot.id} bot={bot} compact />
                        ))}
                      </span>
                      <button
                        type="button"
                        className="ob-pill is-outline"
                        aria-expanded={managing === plugin.id}
                        onClick={() => setManaging(managing === plugin.id ? undefined : plugin.id)}
                      >
                        选择 Bot
                      </button>
                    </div>
                    {managing === plugin.id ? (
                      <div className="plugins-row-detail">
                        <PluginGrantEditor
                          key={plugin.id}
                          plugin={plugin}
                          bots={bots}
                          disabled={busy || loading}
                          selectedBotId={botSelectionRef.current.get(plugin.id)}
                          onSelectedBotIdChange={(botId) => {
                            if (botId) botSelectionRef.current.set(plugin.id, botId);
                            else botSelectionRef.current.delete(plugin.id);
                          }}
                          onSave={(botId, tools, content) =>
                            mutate(
                              `plugins/${encodeURIComponent(plugin.id)}/grants/${encodeURIComponent(botId)}`,
                              "PUT",
                              { revision: plugin.revision, tools, ...content },
                            )
                          }
                        />
                        <PluginContentPanel
                          plugin={plugin}
                          scope={scope}
                          onInsertMaterial={onInsertMaterial}
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>
        <section className="plugins-section" aria-labelledby="plugins-more">
          <div className="plugins-section-heading">
            <h2 id="plugins-more">添加插件</h2>
            <span>连接 MCP 服务，审核工具后再分配给 Bot</span>
          </div>
          {adding ? (
            <div className="plugins-card plugins-install">
              <PluginInstallForm
                onInstalled={() => {
                  setAdding(false);
                  setAttempt((value) => value + 1);
                }}
              />
            </div>
          ) : (
            <div className="plugins-add">
              <button type="button" className="ob-pill" onClick={() => setAdding(true)}>
                连接 MCP 服务
              </button>
              <PluginCatalogLinks />
            </div>
          )}
        </section>
      </div>
    );
  }

  if (variant === "settings")
    return (
      <>
        <SettingsHeaderAction>
          <button
            type="button"
            className="ob-pill is-primary"
            aria-expanded={adding}
            onClick={() => setAdding(!adding)}
          >
            添加插件
          </button>
        </SettingsHeaderAction>
        {adding ? (
          <section className="settings-group">
            <h3>添加工具插件</h3>
            <div className="settings-card">
              <PluginInstallForm
                onInstalled={() => {
                  setAdding(false);
                  setAttempt((value) => value + 1);
                }}
              />
            </div>
          </section>
        ) : null}
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
        {loading && !plugins.length ? (
          <p className="settings-empty" role="status">
            正在读取插件…
          </p>
        ) : null}
        {!loading && !error && !plugins.length ? (
          <p className="settings-empty">还没有插件。添加一个 MCP 服务，审核工具后分配给 Bot。</p>
        ) : null}
        {plugins.length ? (
          <div className="settings-group-rows settings-plugins">
            {plugins.map((plugin) => (
              <div className="settings-plugin" key={plugin.id}>
                <div className="settings-item">
                  <span className="settings-tile" aria-hidden="true">
                    {Array.from(plugin.name.trim())[0]?.toLocaleUpperCase() ?? "?"}
                  </span>
                  <span className="settings-item-text">
                    <strong>{plugin.name}</strong>
                    <small>
                      {plugin.enabled ? `${plugin.tools.length} 个工具` : "已停用"}
                      {plugin.grants.length > 0 ? " · " : ""}
                      {plugin.grants
                        .map((grant) => botNames.get(grant.botId))
                        .filter(Boolean)
                        .join("、")}
                    </small>
                  </span>
                  <span className="settings-plugin-actions">
                    <button
                      type="button"
                      className="ob-pill is-small"
                      aria-expanded={managing === plugin.id}
                      aria-label={`管理 ${plugin.name}`}
                      onClick={() => setManaging(managing === plugin.id ? undefined : plugin.id)}
                    >
                      管理
                    </button>
                    <button
                      type="button"
                      role="switch"
                      className="ob-switch"
                      aria-checked={plugin.enabled}
                      aria-label={`启用 ${plugin.name}`}
                      disabled={busy || loading}
                      onClick={() => toggle(plugin)}
                    />
                  </span>
                </div>
                {managing === plugin.id ? (
                  <section
                    className="installed-plugin settings-plugin-detail"
                    aria-label={`工具插件 ${plugin.name}`}
                  >
                    <p className="plugin-endpoint">{plugin.endpoint}</p>
                    {details(plugin)}
                  </section>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        <PluginCatalogLinks />
        <p className="settings-footnote">
          插件带来的是能力，不是权限：写入、发送这类操作仍按「审批与权限」里的规则先问你。
        </p>
      </>
    );

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
          {details(plugin)}
        </section>
      ))}
    </div>
  );
}
