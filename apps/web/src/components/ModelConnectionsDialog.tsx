import type {
  ModelConnection,
  ModelConnectionPreset,
  ModelServicesSnapshot,
} from "@openbot/domain";
import { modelIdSchema } from "@openbot/protocol";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  createModelConnection,
  testModelConnection,
  updateModelConnection,
} from "../api";
import { CloseIcon, PlusIcon } from "./Icons";
import { ModelIdField, useModelServices } from "./ModelSelector";
import { useModalDialog } from "./useModalDialog";

function providerLabel(preset: ModelConnectionPreset): string {
  const labels: Record<string, string> = {
    siliconflow: "硅基流动 / SiliconFlow",
    dashscope: "阿里云百炼",
    zai: "智谱 / Z.AI",
    ark: "火山方舟",
    custom: "自定义兼容 API",
  };
  return labels[preset.id] ?? preset.name;
}

function providerDescription(preset: ModelConnectionPreset): string {
  const descriptions: Record<string, string> = {
    openai: "连接 OpenAI 的 GPT 系列模型。",
    anthropic: "连接 Anthropic 的 Claude 系列模型。",
    gemini: "连接 Google 的 Gemini 系列模型。",
    deepseek: "连接 DeepSeek，选择账户可用的模型。",
    kimi: "连接 Kimi，请选择与你的 API Key 对应的站点。",
    openrouter: "使用一个账户连接多家厂商，模型 ID 需包含厂商前缀。",
    siliconflow: "选择账户对应的站点，获取可用的文本对话模型。",
    dashscope: "选择 API Key 所在区域，填写已开通的模型 ID。",
    zai: "连接 GLM 系列模型，请选择与你的 API Key 对应的站点。",
    minimax: "连接 MiniMax，选择账户可用的文本模型。",
    ark: "填写方舟控制台中已开通的模型或推理接入点 ID。",
    custom: "选择管理员已配置的自定义 API 地址。",
  };
  return descriptions[preset.id] ?? preset.description;
}

function endpointLabel(presetId: string, name: string): string {
  if (presetId === "dashscope") {
    const regions: Record<string, string> = {
      China: "北京",
      International: "新加坡",
      US: "美国 · 弗吉尼亚",
    };
    return regions[name] ?? name;
  }
  const labels: Record<string, string> = {
    Global: "国际站",
    China: "中国站",
    "Standard API": "标准 API",
    Beijing: "北京",
    International: "国际站",
    US: "美国",
  };
  return labels[name] ?? name;
}

export function ModelConnectionsDialog({
  onClose,
  onChanged,
}: {
  onClose(): void;
  onChanged(): void;
}) {
  const { snapshot, setSnapshot, error, loading, refresh, cancelRefresh } = useModelServices();
  const [selectedId, setSelectedId] = useState<string>("new");
  const [notice, setNotice] = useState<string>();
  const { dialogRef, closeDialog } = useModalDialog(onClose);
  const selected = snapshot?.connections.find((item) => item.id === selectedId);
  function saved(connection: ModelConnection, selectEditor: boolean) {
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
    if (selectEditor) setSelectedId(connection.id);
    setNotice(`已保存 ${connection.name}。`);
    onChanged();
  }
  return (
    <div className="dialog-backdrop model-services-backdrop">
      <dialog
        ref={dialogRef}
        className="create-dialog model-services-dialog"
        aria-labelledby="model-services-title"
      >
        <header className="dialog-header">
          <div>
            <h2 id="model-services-title">模型服务</h2>
            <p>连接常用厂商和 API 平台，再为员工选择模型。</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭模型服务"
            onClick={closeDialog}
          >
            <CloseIcon />
          </button>
        </header>
        <div className="model-services-body">
          <section className="model-connection-list" aria-label="已配置的模型服务">
            <div className="model-section-heading">
              <strong>已配置的服务</strong>
              <button
                className="model-text-button"
                type="button"
                onClick={() => void refresh()}
                disabled={loading}
              >
                刷新
              </button>
            </div>
            <button
              className={`model-connection-row model-add-connection ${selectedId === "new" ? "selected" : ""}`}
              type="button"
              onClick={() => setSelectedId("new")}
            >
              <PlusIcon />
              添加模型服务
            </button>
            {loading ? (
              <p className="model-help" role="status">
                正在加载…
              </p>
            ) : null}
            {snapshot?.connections.length === 0 ? (
              <p className="model-help">先添加一个服务。同一个连接可以供多个员工使用。</p>
            ) : null}
            {snapshot?.connections.map((connection) => (
              <button
                type="button"
                key={connection.id}
                className={`model-connection-row ${selectedId === connection.id ? "selected" : ""}`}
                onClick={() => setSelectedId(connection.id)}
                aria-pressed={selectedId === connection.id}
              >
                <strong>{connection.name}</strong>
                <small>
                  {connection.source === "environment"
                    ? "环境配置 · 只读"
                    : connection.enabled
                      ? "已启用"
                      : "已停用"}
                </small>
              </button>
            ))}
          </section>
          <div className="model-connection-detail">
            {notice ? (
              <p className="model-success" role="status">
                {notice}
              </p>
            ) : null}
            {error ? (
              <p className="model-inline-error" role="alert">
                {error}
              </p>
            ) : null}
            {snapshot ? (
              <ModelConnectionEditor
                key={`${selectedId}:${selected?.revision ?? 0}`}
                snapshot={snapshot}
                connection={selected}
                onSaved={saved}
                onReload={() => void refresh()}
              />
            ) : null}
          </div>
        </div>
        <footer className="model-services-footer">
          <span>API Key 由 Server 加密保存，浏览器不会保存密钥。</span>
          <button className="secondary-button" type="button" onClick={closeDialog}>
            完成
          </button>
        </footer>
      </dialog>
    </div>
  );
}

export function ModelConnectionEditor({
  snapshot,
  connection,
  onSaved,
  onReload,
}: {
  snapshot: ModelServicesSnapshot;
  connection: ModelConnection | undefined;
  onSaved(connection: ModelConnection, selectEditor: boolean): void;
  onReload(): void;
}) {
  const initialPreset =
    snapshot.presets.find((item) => item.id === (connection?.presetId ?? "deepseek")) ??
    snapshot.presets[0];
  const [presetId, setPresetId] = useState(initialPreset?.id ?? "");
  const [baseUrl, setBaseUrl] = useState(
    connection?.baseUrl ?? initialPreset?.endpoints[0]?.baseUrl ?? "",
  );
  const [name, setName] = useState(
    connection?.name ?? (initialPreset ? providerLabel(initialPreset) : ""),
  );
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const formId = useId();
  const preset = snapshot.presets.find((item) => item.id === presetId);
  const endpoints =
    presetId === "custom"
      ? snapshot.customBaseUrls.map((url) => ({ name: url, baseUrl: url }))
      : (preset?.endpoints ?? []);
  const environment = connection?.source === "environment";
  const unchanged =
    connection !== undefined &&
    name.trim() === connection.name &&
    enabled === connection.enabled &&
    !apiKey.trim();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || environment) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = connection
        ? await updateModelConnection(connection.id, {
            expectedRevision: connection.revision,
            name: name.trim(),
            enabled,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          })
        : await createModelConnection({
            name: name.trim(),
            presetId,
            baseUrl,
            apiKey: apiKey.trim(),
          });
      if (mounted.current) setApiKey("");
      onSaved(result, mounted.current);
    } catch (cause) {
      if (!mounted.current) return;
      setError(
        cause instanceof ApiError && cause.status === 409
          ? "连接已在其他位置更新。请重新加载连接，再确认你的修改。"
          : cause instanceof Error
            ? cause.message
            : "保存失败，请重试。",
      );
    } finally {
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <>
      <form className="model-connection-form" onSubmit={(event) => void submit(event)}>
        <div className="model-section-heading">
          <h3>{connection ? "连接配置" : "添加模型服务"}</h3>
        </div>
        <label htmlFor={`${formId}-provider`}>
          <span>服务提供商</span>
          <select
            id={`${formId}-provider`}
            value={presetId}
            disabled={Boolean(connection) || saving}
            required
            onChange={(event) => {
              const next = snapshot.presets.find((item) => item.id === event.target.value);
              if (!next) return;
              setPresetId(next.id);
              setName(providerLabel(next));
              setBaseUrl(
                next.id === "custom"
                  ? (snapshot.customBaseUrls[0] ?? "")
                  : (next.endpoints[0]?.baseUrl ?? ""),
              );
              setApiKey("");
              setError(undefined);
            }}
          >
            {snapshot.presets.map((item) => (
              <option key={item.id} value={item.id}>
                {providerLabel(item)}
              </option>
            ))}
          </select>
        </label>
        {preset ? (
          <p className="model-help">
            {providerDescription(preset)}{" "}
            <a href={preset.docsUrl} target="_blank" rel="noreferrer">
              官方文档 ↗
            </a>
          </p>
        ) : null}
        <label htmlFor={`${formId}-endpoint`}>
          <span>API 地址与区域</span>
          <select
            id={`${formId}-endpoint`}
            value={baseUrl}
            disabled={Boolean(connection) || saving || endpoints.length === 0}
            required
            onChange={(event) => setBaseUrl(event.target.value)}
          >
            {endpoints.length === 0 ? <option value="">没有可用地址</option> : null}
            {connection && !endpoints.some((item) => item.baseUrl === connection.baseUrl) ? (
              <option value={connection.baseUrl}>{connection.baseUrl}</option>
            ) : null}
            {endpoints.map((item) => (
              <option key={item.baseUrl} value={item.baseUrl}>
                {endpointLabel(presetId, item.name)}
              </option>
            ))}
          </select>
          {baseUrl ? <small className="model-endpoint">{baseUrl}</small> : null}
        </label>
        {presetId === "custom" && endpoints.length === 0 ? (
          <p className="field-empty">
            Server 尚未配置允许使用的自定义 API 地址，请管理员先添加授权地址。
          </p>
        ) : null}
        <label htmlFor={`${formId}-name`}>
          <span>连接名称</span>
          <input
            id={`${formId}-name`}
            value={name}
            maxLength={80}
            required
            disabled={environment || saving}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 DeepSeek · 工作账户"
          />
        </label>
        {environment ? (
          <p className="field-empty">
            这是 Server 环境中的 Kimi 连接。可选择模型或测试调用；修改地址与密钥需要更新 Server
            环境配置。
          </p>
        ) : (
          <label htmlFor={`${formId}-key`}>
            <span>{connection ? "更新 API Key" : "API Key"}</span>
            <input
              id={`${formId}-key`}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={apiKey}
              disabled={saving}
              required={!connection}
              maxLength={2048}
              placeholder={
                connection?.hasApiKey ? "已保存密钥；留空保留原密钥" : "粘贴该服务的 API Key"
              }
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
        )}
        {connection && !environment ? (
          <label className="model-enabled-toggle">
            <input
              type="checkbox"
              checked={enabled}
              disabled={saving}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>启用这个连接</span>
          </label>
        ) : null}
        {connection && !environment ? (
          <p className="model-help">
            停用后，使用这个连接的员工将无法发起模型调用。切换提供商或地址请添加新连接。
          </p>
        ) : null}
        {error ? (
          <div className="model-inline-error" role="alert">
            <p>{error}</p>
            <button className="model-text-button" type="button" onClick={onReload}>
              重新加载连接
            </button>
          </div>
        ) : null}
        {!environment ? (
          <button
            className="primary-button"
            type="submit"
            disabled={saving || unchanged || !baseUrl || !name.trim()}
          >
            {saving ? "保存中…" : connection ? "保存修改" : "保存连接"}
          </button>
        ) : null}
        {!connection ? (
          <p className="model-help">保存后即可为员工选择模型。保存连接不会发起模型调用。</p>
        ) : null}
      </form>
      {connection ? <ConnectionModelTest connection={connection} snapshot={snapshot} /> : null}
    </>
  );
}

function ConnectionModelTest({
  connection,
  snapshot,
}: {
  connection: ModelConnection;
  snapshot: ModelServicesSnapshot;
}) {
  const preset = snapshot.presets.find((item) => item.id === connection.presetId);
  const [modelId, setModelId] = useState(
    connection.defaultModel ?? preset?.suggestedModels[0] ?? "",
  );
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string>();
  const [error, setError] = useState<string>();
  const activeRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => activeRequest.current?.abort(), []);
  const disabled = !connection.enabled || !connection.hasApiKey;
  const validModel = modelIdSchema.safeParse(modelId).success;
  async function test() {
    if (testing || disabled || !validModel) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setTesting(true);
    setResult(undefined);
    setError(undefined);
    try {
      await testModelConnection(connection.id, modelId.trim(), controller.signal);
      if (controller.signal.aborted) return;
      setResult(`模型 ${modelId.trim()} 已成功返回文本。`);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "调用失败，请检查模型 ID 与账户配置。");
    } finally {
      if (!controller.signal.aborted) setTesting(false);
    }
  }
  return (
    <section className="model-connection-test" aria-label="查看模型与测试连接">
      <h3>模型与连接测试</h3>
      <ModelIdField
        connectionId={connection.id}
        value={modelId}
        onChange={(value) => {
          setModelId(value);
          setResult(undefined);
          setError(undefined);
        }}
        suggestions={preset?.suggestedModels ?? []}
        discovery={preset?.discovery ?? false}
        disabled={disabled || testing}
      />
      <button
        className="secondary-button"
        type="button"
        disabled={disabled || testing || !validModel}
        onClick={() => void test()}
      >
        {testing ? "调用中…" : "测试模型（会调用 API）"}
      </button>
      <p className="model-help">发送一条简短测试消息，按提供商的 API 用量计费。</p>
      {disabled ? <p className="model-help">启用连接并保存密钥后可测试。</p> : null}
      {result ? (
        <p className="model-success" role="status">
          {result}
        </p>
      ) : null}
      {error ? (
        <p className="model-inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
