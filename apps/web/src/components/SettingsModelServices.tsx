import type { ModelConnection } from "@openbot/domain";
import { useEffect, useState } from "react";
import { ApiError, getWorkspace, updateModelConnection } from "../api";
import { SearchIcon } from "./Icons";
import {
  ModelConnectionEditor,
  providerDescription,
  providerLabel,
} from "./ModelConnectionsDialog";
import { useModelServices } from "./ModelSelector";
import { ModelSettingsScreen } from "./ModelSettingsScreen";

/**
 * Settings → 模型服务 (Settings artboard): connected services with an enable switch, then the
 * provider catalogue. API keys stay on the Server; this view only sends them once, when saving.
 */
export function SettingsModelServices({ onChanged }: { onChanged?: (() => void) | undefined }) {
  const { snapshot, setSnapshot, error, loading, refresh, cancelRefresh } = useModelServices();
  const [editing, setEditing] = useState<{ connectionId?: string; presetId?: string }>();
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string>();
  const [toggleError, setToggleError] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [usage, setUsage] = useState<Map<string, number>>();

  useEffect(() => {
    // Only for the 「N 个 Bot 在用」 hint; without it the rows simply omit the count.
    const controller = new AbortController();
    getWorkspace(controller.signal)
      .then((workspace) => {
        const counts = new Map<string, number>();
        for (const bot of workspace.bots) {
          const id = bot.model?.connectionId;
          if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        setUsage(counts);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  function saved(connection: ModelConnection) {
    cancelRefresh();
    setSnapshot((current) =>
      current
        ? {
            ...current,
            connections: current.connections.some((item) => item.id === connection.id)
              ? current.connections.map((item) =>
                  item.id === connection.id && item.revision <= connection.revision
                    ? connection
                    : item,
                )
              : [...current.connections, connection],
          }
        : current,
    );
    // Stay in the editor so the connection can be tested right away.
    setEditing({ connectionId: connection.id });
    setNotice(`已保存 ${connection.name}。`);
    onChanged?.();
  }

  async function toggle(connection: ModelConnection) {
    if (busyId) return;
    setBusyId(connection.id);
    setToggleError(undefined);
    try {
      saved(
        await updateModelConnection(connection.id, {
          expectedRevision: connection.revision,
          name: connection.name,
          enabled: !connection.enabled,
        }),
      );
      setEditing(undefined);
      setNotice(undefined);
    } catch (cause) {
      setToggleError(
        cause instanceof ApiError && cause.status === 409
          ? "连接已在其他位置更新，已重新加载。"
          : "无法更改连接状态，请重试。",
      );
      void refresh();
    } finally {
      setBusyId(undefined);
    }
  }

  if (editing && snapshot) {
    const connection = snapshot.connections.find((item) => item.id === editing.connectionId);
    return (
      <div className="settings-subpage">
        <button
          type="button"
          className="settings-subpage-back"
          onClick={() => {
            setEditing(undefined);
            setNotice(undefined);
          }}
        >
          <span aria-hidden="true">‹</span> 模型服务
        </button>
        {notice ? (
          <p className="model-success" role="status">
            {notice}
          </p>
        ) : null}
        <ModelConnectionEditor
          key={`${editing.connectionId ?? editing.presetId}:${connection?.revision ?? 0}`}
          snapshot={snapshot}
          connection={connection}
          initialPresetId={editing.presetId}
          onSaved={saved}
          onReload={() => void refresh()}
        />
      </div>
    );
  }

  const term = query.trim().toLocaleLowerCase();
  const catalogue = (snapshot?.presets ?? []).filter(
    (preset) =>
      preset.id !== "custom" &&
      `${providerLabel(preset)} ${preset.name} ${providerDescription(preset)}`
        .toLocaleLowerCase()
        .includes(term),
  );
  const hasCustom = snapshot?.presets.some((preset) => preset.id === "custom") ?? false;

  return (
    <>
      {error ? (
        <div className="settings-load-notice" role="alert">
          <p>{error}</p>
          <button type="button" className="secondary-button" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      ) : null}
      {toggleError ? (
        <p className="form-error" role="alert">
          {toggleError}
        </p>
      ) : null}
      {loading && !snapshot ? (
        <p className="settings-load-notice" role="status">
          正在读取模型服务…
        </p>
      ) : null}
      {snapshot ? (
        <>
          <section className="settings-group">
            <h3>已连接</h3>
            {snapshot.connections.length === 0 ? (
              <p className="settings-empty">还没有连接。从下面选一个服务商，填入 API Key 即可。</p>
            ) : (
              <div className="settings-group-rows">
                {snapshot.connections.map((connection) => {
                  const preset = snapshot.presets.find((item) => item.id === connection.presetId);
                  const bots = usage?.get(connection.id) ?? 0;
                  const detail =
                    connection.source === "environment"
                      ? "环境配置 · 只读"
                      : connection.enabled
                        ? [
                            connection.defaultModel,
                            usage ? (bots ? `${bots} 个 Bot 在用` : "暂无 Bot 使用") : undefined,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "已启用"
                        : "已停用";
                  return (
                    <div className="settings-item" key={connection.id}>
                      <ProviderTile label={preset ? providerLabel(preset) : connection.name} />
                      <button
                        type="button"
                        className="settings-item-open"
                        onClick={() => setEditing({ connectionId: connection.id })}
                      >
                        <strong>{connection.name}</strong>
                        <small>{detail}</small>
                      </button>
                      <button
                        type="button"
                        role="switch"
                        className="ob-switch"
                        aria-checked={connection.enabled}
                        aria-label={`启用 ${connection.name}`}
                        disabled={connection.source === "environment" || busyId !== undefined}
                        onClick={() => void toggle(connection)}
                      />
                    </div>
                  );
                })}
              </div>
            )}
            <p className="settings-footnote">
              API Key 加密保存在你的 OpenBot 里，浏览器不会保存密钥。
            </p>
          </section>

          <section className="settings-group">
            <div className="settings-group-heading">
              <h3>添加服务</h3>
              {hasCustom ? (
                <button type="button" onClick={() => setEditing({ presetId: "custom" })}>
                  自定义兼容 API
                </button>
              ) : null}
            </div>
            <label className="settings-search-field">
              <SearchIcon />
              <input
                type="search"
                aria-label="搜索服务商"
                placeholder="搜索服务商"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="settings-catalogue">
              {catalogue.map((preset) => (
                <div className="settings-item" key={preset.id}>
                  <ProviderTile label={providerLabel(preset)} />
                  <span className="settings-item-text">
                    <strong>{providerLabel(preset)}</strong>
                    <small>{providerDescription(preset)}</small>
                  </span>
                  <button
                    type="button"
                    className="ob-pill is-small"
                    aria-label={`添加 ${providerLabel(preset)}`}
                    onClick={() => setEditing({ presetId: preset.id })}
                  >
                    添加
                  </button>
                </div>
              ))}
              {catalogue.length === 0 ? <p className="settings-empty">没有匹配的服务商</p> : null}
            </div>
          </section>
        </>
      ) : null}

      <details className="settings-disclosure">
        <summary>默认模型与原生 Agent</summary>
        <ModelSettingsScreen embedded onDone={() => {}} />
      </details>
    </>
  );
}

/** Letter tile; OpenBot ships no third-party logos. */
function ProviderTile({ label }: { label: string }) {
  return (
    <span className="settings-tile" aria-hidden="true">
      {Array.from(label.trim())[0]?.toLocaleUpperCase() ?? "?"}
    </span>
  );
}
