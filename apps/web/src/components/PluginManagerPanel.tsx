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
import { PluginGrantEditor } from "./PluginGrantEditor";
import { PluginInstallForm } from "./PluginInstallForm";
import {
  PluginCatalogLinks,
  PluginContentDeclarations,
  PluginContentPanel,
  PluginUpdatePanel,
} from "./PluginPlatformPanels";
import { PluginToolList } from "./PluginToolList";

/** SPA-session sticky Bot selection per plugin (survives Skills remount / details keep-alive). */
const grantBotSelectionByPlugin = new Map<string, string>();

/** Test-only: clear sticky Bot selection between cases. */
export function resetGrantBotSelectionForTests(): void {
  grantBotSelectionByPlugin.clear();
}

export interface PluginManagerProps {
  bots: Bot[];
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
        </section>
      ))}
    </div>
  );
}
