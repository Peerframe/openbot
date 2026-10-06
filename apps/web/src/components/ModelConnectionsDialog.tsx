import type {
  ModelConnection,
  ModelConnectionDependencies,
  ModelConnectionPreset,
  ModelServicesSnapshot,
} from "@openbot/domain";
import { modelIdSchema } from "@openbot/protocol";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  createModelConnection,
  deleteModelConnection,
  discoverConnectionModels,
  updateModelConnection,
  verifyModelConnection,
} from "../api";
import { Dialog } from "./Dialog";
import { useModelServices } from "./ModelSelector";
import "./ModelServices.css";
import { BrandMark, providerMark } from "./BrandMark";

export function providerLabel(preset: ModelConnectionPreset): string {
  const labels: Record<string, string> = {
    siliconflow: "硅基流动 / SiliconFlow",
    dashscope: "阿里云百炼",
    zai: "智谱 / Z.AI",
    ark: "火山方舟",
    custom: "自定义兼容 API",
  };
  return labels[preset.id] ?? preset.name;
}

export function providerDescription(preset: ModelConnectionPreset): string {
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

function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** The provider's logo (owner request 2026-10-05), or its first letter for a custom service. */
export function ProviderTile({
  label,
  presetId,
}: {
  label: string;
  presetId?: string | undefined;
}) {
  return <BrandMark className="settings-tile" mark={providerMark(presetId)} label={label} />;
}

const verifyErrors: Record<string, string> = {
  model_credentials_invalid: "API Key 没有通过验证。检查密钥和区域是否对应。",
  model_provider_unavailable: "服务商暂时没有正常返回模型列表，稍后再试。",
  model_discovery_not_supported: "这个服务商不提供模型列表，保存后手动填写模型 ID。",
  model_endpoint_not_authorized: "服务电脑不允许使用这个地址。",
  model_connection_disabled: "这个连接已停用。先在列表里启用它再测试。",
};

type Verification =
  | { state: "idle" }
  | { state: "checking"; key: string }
  | { state: "ok"; key: string; models: string[] }
  | { state: "failed"; key: string; message: string };

type Removal =
  | { state: "idle" }
  | { state: "confirm" }
  | { state: "removing" }
  | { state: "blocked"; dependencies: ModelConnectionDependencies }
  | { state: "failed"; message: string };

/**
 * DialogModel artboard: add or edit one model connection. 测试 reads only the provider's model list
 * (C17 verify, or the saved key's model list) — it never sends a conversation and costs nothing.
 * A new key must pass that check before it is saved; the 服务电脑 still decides on every call.
 */
export function ModelConnectionDialog({
  snapshot,
  connection,
  initialPresetId,
  onClose,
  onSaved,
  onDeleted,
  onReload,
}: {
  snapshot: ModelServicesSnapshot;
  /** The connection to edit; absent to add a new one. */
  connection?: ModelConnection | undefined;
  /** Provider to start a new connection with (settings 添加 rows). */
  initialPresetId?: string | undefined;
  onClose(): void;
  onSaved(connection: ModelConnection): void;
  onDeleted?: ((connectionId: string) => void) | undefined;
  /** Re-reads the services after a conflict; the caller remounts with the new revision. */
  onReload(): void;
}) {
  const initialPreset =
    snapshot.presets.find(
      (item) => item.id === (connection?.presetId ?? initialPresetId ?? "deepseek"),
    ) ?? snapshot.presets[0];
  const [presetId, setPresetId] = useState(initialPreset?.id ?? "");
  const [picking, setPicking] = useState(false);
  const [baseUrl, setBaseUrl] = useState(
    connection?.baseUrl ?? firstEndpoint(snapshot, initialPreset?.id ?? ""),
  );
  const [name, setName] = useState(
    connection?.name ?? (initialPreset ? providerLabel(initialPreset) : ""),
  );
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState(connection?.defaultModel ?? "");
  const [verification, setVerification] = useState<Verification>({ state: "idle" });
  const [removal, setRemoval] = useState<Removal>({ state: "idle" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; conflict: boolean }>();
  const formId = useId();
  const activeRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => activeRequest.current?.abort(), []);

  const preset = snapshot.presets.find((item) => item.id === presetId);
  const endpoints =
    presetId === "custom"
      ? snapshot.customBaseUrls.map((url) => ({ name: url, baseUrl: url }))
      : (preset?.endpoints ?? []);
  const environment = connection?.source === "environment";
  const busy = saving || removal.state === "removing";
  const discovery = preset?.discovery ?? false;
  const key = apiKey.trim();
  // What a check covers: a typed key with its provider and address, or the saved key.
  const checkKey = key
    ? `${presetId}|${baseUrl}|${key}`
    : connection
      ? `saved:${connection.id}`
      : "";
  const current = "key" in verification && verification.key === checkKey ? verification : undefined;
  const verified = current?.state === "ok" ? current.models : undefined;
  const canCheck =
    discovery && !environment && !busy && Boolean(baseUrl) && Boolean(key || connection?.hasApiKey);
  const modelOptions = [
    ...new Set([
      ...(verified ?? preset?.suggestedModels ?? []),
      ...(defaultModel ? [defaultModel] : []),
    ]),
  ];
  const modelValid = !defaultModel || modelIdSchema.safeParse(defaultModel).success;
  const changed = connection
    ? name.trim() !== connection.name ||
      Boolean(key) ||
      defaultModel !== (connection.defaultModel ?? "")
    : true;
  // A new key is saved only after the model-list check passed for exactly these inputs.
  const keyReady = discovery && key ? Boolean(verified) : connection ? true : Boolean(key);
  const canSave =
    !environment &&
    !busy &&
    changed &&
    keyReady &&
    modelValid &&
    Boolean(baseUrl) &&
    Boolean(name.trim());

  async function check() {
    if (!canCheck) return;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const forKey = checkKey;
    setVerification({ state: "checking", key: forKey });
    try {
      const models = key
        ? await verifyModelConnection({ presetId, baseUrl, apiKey: key }, controller.signal)
        : await discoverConnectionModels(connection?.id ?? "", controller.signal);
      if (controller.signal.aborted) return;
      setVerification({ state: "ok", key: forKey, models });
      if (!defaultModel && models.length > 0)
        setDefaultModel(
          preset?.suggestedModels.find((id) => models.includes(id)) ?? models[0] ?? "",
        );
    } catch (cause) {
      if (controller.signal.aborted) return;
      setVerification({
        state: "failed",
        key: forKey,
        message:
          (cause instanceof Error && verifyErrors[cause.message]) ||
          "没能读取模型列表。检查 API Key 和区域后再试。",
      });
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(undefined);
    try {
      const model = defaultModel.trim();
      const result = connection
        ? await updateModelConnection(connection.id, {
            expectedRevision: connection.revision,
            name: name.trim(),
            ...(key ? { apiKey: key } : {}),
            ...(model !== (connection.defaultModel ?? "") ? { defaultModel: model || null } : {}),
          })
        : await createModelConnection({
            name: name.trim(),
            presetId,
            baseUrl,
            apiKey: key,
            ...(model ? { defaultModel: model } : {}),
          });
      setApiKey("");
      onSaved(result);
    } catch (cause) {
      const conflict = cause instanceof ApiError && cause.status === 409;
      setError({
        conflict,
        message: conflict
          ? "这个连接刚在别处改过。重新加载后再确认你的修改。"
          : cause instanceof Error
            ? cause.message
            : "保存失败，请重试。",
      });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!connection || busy) return;
    setRemoval({ state: "removing" });
    try {
      await deleteModelConnection(connection.id, { expectedRevision: connection.revision });
      onDeleted?.(connection.id);
    } catch (cause) {
      if (cause instanceof ApiError && cause.body.error === "model_connection_in_use") {
        const body = cause.body as Partial<ModelConnectionDependencies>;
        setRemoval({
          state: "blocked",
          dependencies: {
            bots: Array.isArray(body.bots) ? body.bots : [],
            runIds: Array.isArray(body.runIds) ? body.runIds : [],
            ownerDefault: body.ownerDefault === true,
            transcription: body.transcription === true,
          },
        });
        return;
      }
      setRemoval({
        state: "failed",
        message:
          cause instanceof ApiError && cause.status === 409
            ? "这个连接刚在别处改过。重新加载后再断开。"
            : cause instanceof ApiError && cause.status === 404
              ? "这个连接已经不存在了。"
              : "没能断开这个服务，请重试。",
      });
    }
  }

  function choosePreset(next: ModelConnectionPreset) {
    setPresetId(next.id);
    setName(providerLabel(next));
    setBaseUrl(firstEndpoint(snapshot, next.id));
    setApiKey("");
    setDefaultModel("");
    setPicking(false);
    setError(undefined);
  }

  const confirming = removal.state !== "idle";
  const footer = confirming ? (
    <>
      <button
        type="button"
        className="ob-pill is-large"
        disabled={removal.state === "removing"}
        onClick={() => setRemoval({ state: "idle" })}
      >
        返回
      </button>
      {removal.state === "confirm" || removal.state === "removing" ? (
        <button
          type="button"
          className="ob-pill is-large is-danger"
          disabled={removal.state === "removing"}
          onClick={() => void remove()}
        >
          {removal.state === "removing" ? "正在断开…" : "断开"}
        </button>
      ) : null}
    </>
  ) : environment ? (
    <button type="button" className="ob-pill is-large" onClick={onClose}>
      完成
    </button>
  ) : (
    <>
      <button type="button" className="ob-pill is-large" onClick={onClose}>
        取消
      </button>
      <button
        type="submit"
        form={formId}
        className="ob-pill is-large is-primary"
        disabled={!canSave}
      >
        {saving ? "正在保存…" : "保存"}
      </button>
    </>
  );

  return (
    <Dialog
      title="连接模型服务"
      intro="测试只读取模型列表，保存后 Bot 才能使用。"
      width={600}
      className="model-connection-dialog"
      onClose={onClose}
      footerStart={
        connection && !environment && !confirming ? (
          <button
            type="button"
            className="model-disconnect"
            disabled={busy}
            onClick={() => setRemoval({ state: "confirm" })}
          >
            断开这个服务
          </button>
        ) : undefined
      }
      footer={footer}
    >
      {confirming ? (
        <RemovalNotice connection={connection} removal={removal} onReload={onReload} />
      ) : (
        <form
          id={formId}
          className="model-connection-form"
          onSubmit={(event) => void submit(event)}
        >
          <div className="model-provider">
            <ProviderTile label={preset ? providerLabel(preset) : name} presetId={preset?.id} />
            <span>
              <strong>{preset ? providerLabel(preset) : name}</strong>
              <small>
                {presetId === "custom" ? "兼容 API" : "官方 API"} ·{" "}
                {discovery ? "支持读取模型列表" : "需要手动填写模型 ID"}
              </small>
            </span>
            {connection ? null : (
              <button
                type="button"
                className="ob-pill is-small"
                aria-expanded={picking}
                disabled={busy}
                onClick={() => setPicking((open) => !open)}
              >
                换服务商
              </button>
            )}
          </div>
          {picking ? (
            <ul className="model-provider-list" aria-label="服务商">
              {snapshot.presets.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-current={item.id === presetId}
                    onClick={() => choosePreset(item)}
                  >
                    <ProviderTile label={providerLabel(item)} presetId={item.id} />
                    <span>
                      <strong>{providerLabel(item)}</strong>
                      <small>{providerDescription(item)}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="model-connection-fields">
            <label className="ob-field">
              显示名称
              <input
                value={name}
                maxLength={80}
                required
                disabled={environment || busy}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="ob-field">
              区域与地址
              <select
                value={baseUrl}
                disabled={Boolean(connection) || busy || endpoints.length === 0}
                required
                onChange={(event) => setBaseUrl(event.target.value)}
              >
                {endpoints.length === 0 ? <option value="">没有可用地址</option> : null}
                {connection && !endpoints.some((item) => item.baseUrl === connection.baseUrl) ? (
                  <option value={connection.baseUrl}>{endpointHost(connection.baseUrl)}</option>
                ) : null}
                {endpoints.map((item) => (
                  <option key={item.baseUrl} value={item.baseUrl}>
                    {presetId === "custom"
                      ? item.baseUrl
                      : `${endpointLabel(presetId, item.name)} · ${endpointHost(item.baseUrl)}`}
                  </option>
                ))}
              </select>
            </label>
            {environment ? null : (
              <label className="ob-field is-wide">
                API Key
                <input
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={apiKey}
                  disabled={busy}
                  required={!connection}
                  maxLength={2048}
                  placeholder={
                    connection?.hasApiKey
                      ? "已保存；留空继续用原来的密钥"
                      : "粘贴这个服务的 API Key"
                  }
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
            )}
          </div>
          {presetId === "custom" && endpoints.length === 0 ? (
            <p className="model-help">服务电脑还没有允许任何自定义地址，请管理员先添加。</p>
          ) : null}
          {environment ? (
            <p className="model-help">
              这是服务电脑环境配置里的连接，只能查看；修改地址和密钥要更新服务电脑的环境配置。
            </p>
          ) : discovery ? (
            <div className={`model-verify is-${current?.state ?? "idle"}`}>
              <span className="ob-dialog-check" aria-hidden="true">
                {current?.state === "ok" ? "✓" : current?.state === "failed" ? "!" : ""}
              </span>
              <span role="status">
                <strong>
                  {current?.state === "ok"
                    ? `已验证 · 读到 ${current.models.length} 个模型`
                    : current?.state === "checking"
                      ? "正在读取模型列表…"
                      : current?.state === "failed"
                        ? current.message
                        : key || !connection
                          ? "保存前先测试这个 API Key"
                          : "可以测试已保存的密钥"}
                </strong>
                <small>只读取模型列表，不发送对话、不产生费用</small>
              </span>
              <button
                type="button"
                className="ob-pill is-small"
                disabled={!canCheck || current?.state === "checking"}
                onClick={() => void check()}
              >
                {current ? "重新测试" : "测试"}
              </button>
            </div>
          ) : (
            <p className="model-help">
              这个服务商不提供模型列表，无法提前验证密钥；保存后在第一次使用时由服务电脑检查。
            </p>
          )}
          <label className="ob-field" htmlFor={`${formId}-model`}>
            默认模型
            {verified && verified.length > 0 ? (
              <select
                id={`${formId}-model`}
                value={defaultModel}
                disabled={environment || busy}
                onChange={(event) => setDefaultModel(event.target.value)}
              >
                <option value="">不设默认</option>
                {modelOptions.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <input
                  id={`${formId}-model`}
                  list={`${formId}-models`}
                  value={defaultModel}
                  disabled={environment || busy}
                  maxLength={256}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={!modelValid}
                  placeholder="选择或输入模型 ID；可以留空"
                  onChange={(event) => setDefaultModel(event.target.value)}
                />
                <datalist id={`${formId}-models`}>
                  {modelOptions.map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
              </>
            )}
          </label>
          {!modelValid ? (
            <p className="ob-dialog-error" role="alert">
              模型 ID 需以英文字母或数字开头，只能包含字母、数字和 . _ : / @ + -。
            </p>
          ) : null}
          {error ? (
            <div className="ob-dialog-error" role="alert">
              {error.message}
              {error.conflict ? (
                <button type="button" className="model-text-button" onClick={onReload}>
                  重新加载
                </button>
              ) : null}
            </div>
          ) : null}
          <small className="ob-dialog-foot-note">
            API Key 加密保存在服务电脑上；保存后页面不再显示原文。
          </small>
        </form>
      )}
    </Dialog>
  );
}

/**
 * 管理模型服务 from a Bot's model picker: loads the services and opens the dialog to add one.
 * Existing connections are edited from 设置 › 模型服务.
 */
export function AddModelConnectionDialog({
  onClose,
  onChanged,
}: {
  onClose(): void;
  onChanged(connection: ModelConnection): void;
}) {
  const { snapshot, error, refresh } = useModelServices();
  if (snapshot)
    return (
      <ModelConnectionDialog
        snapshot={snapshot}
        onClose={onClose}
        onSaved={(connection) => {
          onChanged(connection);
          onClose();
        }}
        onReload={() => void refresh()}
      />
    );
  return (
    <Dialog
      title="连接模型服务"
      width={600}
      onClose={onClose}
      footer={
        error ? (
          <button type="button" className="ob-pill is-large" onClick={() => void refresh()}>
            重试
          </button>
        ) : undefined
      }
    >
      <p
        className={error ? "ob-dialog-error" : "ob-dialog-loading"}
        role={error ? "alert" : "status"}
      >
        {error ?? "正在读取模型服务…"}
      </p>
    </Dialog>
  );
}

function RemovalNotice({
  connection,
  removal,
  onReload,
}: {
  connection: ModelConnection | undefined;
  removal: Removal;
  onReload(): void;
}) {
  if (removal.state === "blocked") {
    const { bots, runIds, ownerDefault, transcription } = removal.dependencies;
    return (
      <div className="ob-dialog-notice is-warning" role="alert">
        <strong>还有地方在用 {connection?.name}，暂时不能断开</strong>
        <ul>
          {bots.map((bot) => (
            <li key={bot.id}>{bot.name} 用它作为模型</li>
          ))}
          {runIds.length > 0 ? <li>{runIds.length} 个没结束的任务正在用它</li> : null}
          {ownerDefault ? <li>它是你的默认模型（设置 › 通用 › 默认模型）</li> : null}
          {transcription ? <li>语音转写在用它（设置 › 模型服务 › 语音转写）</li> : null}
        </ul>
        <span>先给这些 Bot 换一个模型、等任务结束，或换掉默认模型和语音转写连接，再来断开。</span>
      </div>
    );
  }
  if (removal.state === "failed")
    return (
      <div className="ob-dialog-notice is-danger" role="alert">
        <strong>{removal.message}</strong>
        <span>
          <button type="button" className="model-text-button" onClick={onReload}>
            重新加载
          </button>
        </span>
      </div>
    );
  return (
    <div className="ob-dialog-notice is-danger">
      <strong>断开 {connection?.name}？</strong>
      <span>
        服务电脑会删除这个连接和保存的 API Key。过去的任务记录会保留；以后要用需要重新连接。
      </span>
    </div>
  );
}

function firstEndpoint(snapshot: ModelServicesSnapshot, presetId: string): string {
  if (presetId === "custom") return snapshot.customBaseUrls[0] ?? "";
  return snapshot.presets.find((item) => item.id === presetId)?.endpoints[0]?.baseUrl ?? "";
}
