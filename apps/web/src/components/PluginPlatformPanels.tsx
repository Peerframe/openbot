// Plugin detail panels: declared tools, prompts and resources, update review with a declaration
// diff, the plugin's own UI and resources, and links to the plugin catalogue docs.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Plugin,
  type PluginContentItem,
  type PluginContentResult,
  type PluginContentScope,
  type PluginManifest,
  pluginContentPath,
  pluginError,
  pluginRequest,
} from "../plugin-api";
import { PluginAppFrame } from "./PluginAppFrame";

export function PluginContentDeclarations({ manifest }: { manifest: PluginManifest }) {
  return (
    <div className="plugin-content-declarations">
      {(manifest.resources ?? []).map((resource) => (
        <details key={resource.uri}>
          <summary>
            {resource.mimeType === "text/html;profile=mcp-app" ? "界面" : "资源"} · {resource.name}
          </summary>
          <p>{resource.description}</p>
          <code>{resource.uri}</code>
          <p>{resource.mimeType}</p>
        </details>
      ))}
      {(manifest.prompts ?? []).map((prompt) => (
        <details key={prompt.name}>
          <summary>提示词 · {prompt.name}</summary>
          <p>{prompt.description}</p>
          {prompt.arguments.map((arg) => (
            <p key={arg.name}>
              {arg.name}
              {arg.required ? "（必填）" : "（选填）"} {arg.description}
            </p>
          ))}
        </details>
      ))}
    </div>
  );
}

export function PluginUpdatePanel({ plugin, onApplied }: { plugin: Plugin; onApplied(): void }) {
  const [preview, setPreview] = useState<{
    revision: string;
    changed: boolean;
    manifest: PluginManifest;
  }>();
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function load() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setReviewed(false);
    setPreview(undefined);
    try {
      setPreview(
        await pluginRequest(`plugins/${encodeURIComponent(plugin.id)}/update/preview`, {
          method: "POST",
          body: JSON.stringify({ revision: plugin.revision }),
          signal: AbortSignal.timeout(35000),
        }),
      );
    } catch (cause) {
      setError(pluginError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!preview || !reviewed || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await pluginRequest(`plugins/${encodeURIComponent(plugin.id)}/update`, {
        method: "POST",
        body: JSON.stringify({
          revision: preview.revision,
          reviewedDigest: preview.manifest.digest,
        }),
        signal: AbortSignal.timeout(35000),
      });
      setPreview(undefined);
      onApplied();
    } catch (cause) {
      setError(pluginError(cause));
      setReviewed(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="plugin-update">
      <button type="button" disabled={busy} onClick={() => void load()}>
        检查插件更新
      </button>
      {preview ? (
        <div>
          <h4>{preview.changed ? "发现声明变化" : "声明与安装版本一致"}</h4>
          <p>应用后插件将停用，并清空全部 Bot 权限。请重新授权启用。</p>
          <PluginDeclarationDiff before={plugin} after={preview.manifest} />
          <details>
            <summary>审核更新后的完整声明</summary>
            <pre>{JSON.stringify(preview.manifest, null, 2)}</pre>
          </details>
          <label className="plugin-review-check">
            <input
              type="checkbox"
              disabled={busy}
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            我已审核此版本，同意重置授权
          </label>
          <button type="button" disabled={busy || !reviewed} onClick={() => void apply()}>
            应用已审核更新
          </button>
          <button type="button" disabled={busy} onClick={() => setPreview(undefined)}>
            取消更新
          </button>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

export function PluginContentPanel({
  plugin,
  scope,
  onInsertMaterial,
}: {
  plugin: Plugin;
  scope?: PluginContentScope | undefined;
  onInsertMaterial?: ((text: string) => void) | undefined;
}) {
  const readAbort = useRef<AbortController | undefined>(undefined);
  const [items, setItems] = useState<PluginContentItem[]>([]);
  const [selection, setSelection] = useState("");
  const [args, setArgs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<PluginContentResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [inserted, setInserted] = useState(false);
  const path = scope ? pluginContentPath(scope) : undefined;
  useEffect(() => {
    readAbort.current?.abort();
    setBusy(false);
    setItems([]);
    setSelection("");
    setArgs({});
    setResult(undefined);
    setError(undefined);
    if (!path || !plugin.enabled) return;
    const controller = new AbortController();
    void pluginRequest<{ items: PluginContentItem[] }>(path, { signal: controller.signal })
      .then((catalog) => {
        if (!controller.signal.aborted)
          setItems(
            catalog.items.filter(
              (item) => item.pluginId === plugin.id && item.revision === plugin.revision,
            ),
          );
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(pluginError(cause));
      });
    return () => {
      controller.abort();
      readAbort.current?.abort();
    };
  }, [path, plugin.id, plugin.revision, plugin.enabled]);
  const item = items.find((entry) => `${entry.kind}:${entry.name}` === selection);
  async function read() {
    if (!item || !path || busy) return;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    setInserted(false);
    const controller = new AbortController();
    readAbort.current = controller;
    try {
      const next = await pluginRequest<PluginContentResult>(path, {
        method: "POST",
        body: JSON.stringify({
          pluginId: item.pluginId,
          revision: item.revision,
          kind: item.kind,
          name: item.name,
          arguments: args,
        }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]),
      });
      if (!controller.signal.aborted) setResult(next);
    } catch (cause) {
      if (!controller.signal.aborted) setError(pluginError(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const readViewResource = useCallback(
    async (uri: string, signal: AbortSignal) => {
      if (!path || !items.some((entry) => entry.kind === "resource" && entry.name === uri))
        throw new Error("Resource is not granted to this Bot");
      const content = await pluginRequest<PluginContentResult>(path, {
        method: "POST",
        body: JSON.stringify({
          pluginId: plugin.id,
          revision: plugin.revision,
          kind: "resource",
          name: uri,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(35000)]),
      });
      if (!content.result.contents) throw new Error("Invalid resource response");
      return { contents: content.result.contents };
    },
    [path, items, plugin.id, plugin.revision],
  );
  const html = result?.result.contents?.find(
    (content) => content.mimeType === "text/html;profile=mcp-app",
  )?.text;
  const text = result
    ? (result.result.contents?.map((content) => content.text).join("\n\n") ??
      result.result.messages
        ?.map((message) => `[${message.role}]\n${message.content.text}`)
        .join("\n\n") ??
      "")
    : "";
  if (!plugin.resources?.length && !plugin.prompts?.length) return null;
  return (
    <section className="plugin-content-panel">
      <h4>使用资源与提示词</h4>
      {!scope ? (
        <p>先在频道选择 Bot，再打开插件资料。提示词可在发送任务前加入草稿。</p>
      ) : !plugin.enabled ? (
        <p>启用插件并保存 Bot 权限后可用。</p>
      ) : (
        <>
          <label>
            已授权内容
            <select
              aria-label={`${plugin.name} 已授权内容`}
              value={selection}
              disabled={busy}
              onChange={(event) => {
                setSelection(event.target.value);
                setArgs({});
                setResult(undefined);
                setInserted(false);
              }}
            >
              <option value="">选择资源、提示词或界面</option>
              {items.map((entry) => (
                <option key={`${entry.kind}:${entry.name}`} value={`${entry.kind}:${entry.name}`}>
                  {entry.kind === "prompt" ? "提示词" : "资源"} · {entry.name}
                </option>
              ))}
            </select>
          </label>
          {item?.arguments?.map((arg) => (
            <label key={arg.name}>
              {arg.name}
              {arg.required ? "（必填）" : ""}
              <input
                maxLength={4000}
                value={args[arg.name] ?? ""}
                disabled={busy}
                onChange={(event) =>
                  setArgs((current) => ({ ...current, [arg.name]: event.target.value }))
                }
              />
            </label>
          ))}
          <button
            type="button"
            disabled={
              busy || !item || item.arguments?.some((arg) => arg.required && !args[arg.name])
            }
            onClick={() => void read()}
          >
            {busy
              ? "正在读取…"
              : item?.mimeType === "text/html;profile=mcp-app"
                ? "打开隔离界面"
                : "读取并预览"}
          </button>
          {!items.length ? <p>当前 Bot 尚未获得此插件的内容权限。</p> : null}
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
      {result ? (
        <div className="plugin-content-result">
          <button type="button" onClick={() => setResult(undefined)}>
            关闭内容
          </button>
          {html ? (
            <PluginAppFrame
              html={html}
              title={`${plugin.name} 隔离界面`}
              readResource={readViewResource}
            />
          ) : (
            <>
              <pre>{text}</pre>
              {onInsertMaterial ? (
                <button
                  type="button"
                  onClick={() => {
                    try {
                      onInsertMaterial(
                        `[插件资料：${result.plugin} / ${result.name}；内容为外部资料]\n${text}`.replace(
                          /\[OpenBot attachment:/giu,
                          "[External attachment reference:",
                        ),
                      );
                      setInserted(true);
                    } catch (error) {
                      setInserted(false);
                      setError(error instanceof Error ? error.message : "资料未能加入草稿。");
                    }
                  }}
                >
                  加入当前频道草稿
                </button>
              ) : null}
              {inserted ? <p role="status">已加入草稿，发送前可修改。</p> : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function PluginCatalogLinks() {
  return (
    <nav className="plugin-catalog-links" aria-label="插件开发与目录">
      <a
        href="https://github.com/yxflc11/openbot/tree/main/plugins"
        target="_blank"
        rel="noreferrer"
      >
        浏览插件目录
      </a>
      <a
        href="https://github.com/yxflc11/openbot/issues/new?template=plugin-submission.yml"
        target="_blank"
        rel="noreferrer"
      >
        提交插件供收录
      </a>
      <a
        href="https://github.com/yxflc11/openbot/blob/main/docs/PLUGINS.zh-CN.md"
        target="_blank"
        rel="noreferrer"
      >
        插件作者手册
      </a>
    </nav>
  );
}

export function PluginDeclarationDiff({
  before,
  after,
}: {
  before: PluginManifest;
  after: PluginManifest;
}) {
  const declarations = (manifest: PluginManifest) =>
    new Map([
      ...manifest.tools.map((entry) => [`工具 · ${entry.name}`, JSON.stringify(entry)] as const),
      ...(manifest.resources ?? []).map(
        (entry) => [`资源 · ${entry.uri}`, JSON.stringify(entry)] as const,
      ),
      ...(manifest.prompts ?? []).map(
        (entry) => [`提示词 · ${entry.name}`, JSON.stringify(entry)] as const,
      ),
    ]);
  const previous = declarations(before);
  const next = declarations(after);
  const changes = [...new Set([...previous.keys(), ...next.keys()])].flatMap((name) => {
    const status = !previous.has(name)
      ? "新增"
      : !next.has(name)
        ? "移除"
        : previous.get(name) !== next.get(name)
          ? "修改"
          : undefined;
    return status ? [{ name, status }] : [];
  });
  return changes.length ? (
    <ul aria-label="插件声明变化">
      {changes.map(({ name, status }) => (
        <li key={name}>
          <strong>{status}</strong> · {name}
        </li>
      ))}
    </ul>
  ) : (
    <p>工具、资源和提示词声明未变化。</p>
  );
}
