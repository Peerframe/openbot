import { type FormEvent, useState } from "react";
import { type PluginManifest, pluginError, pluginRequest } from "../plugin-api";
import { PluginContentDeclarations } from "./PluginPlatformPanels";
import { PluginToolList } from "./PluginToolList";

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
