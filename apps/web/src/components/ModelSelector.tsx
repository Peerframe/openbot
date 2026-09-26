import type { ModelSelection, ModelServicesSnapshot } from "@openbot/domain";
import { modelIdSchema } from "@openbot/protocol";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { discoverConnectionModels, getModelServices } from "../api";
import "./ModelServices.css";

export function useModelServices(refreshKey = 0) {
  const [snapshot, setSnapshot] = useState<ModelServicesSnapshot>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const cancelRefresh = useCallback(() => {
    generation.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = undefined;
    setLoading(false);
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    activeRequest.current?.abort();
    const currentGeneration = ++generation.current;
    const controller = new AbortController();
    activeRequest.current = controller;
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    setLoading(true);
    setError(undefined);
    try {
      const next = await getModelServices(controller.signal);
      if (!controller.signal.aborted && currentGeneration === generation.current) setSnapshot(next);
    } catch (cause) {
      if (!controller.signal.aborted && currentGeneration === generation.current) {
        setError(cause instanceof Error ? cause.message : "无法加载模型服务，请重试。");
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      if (!controller.signal.aborted && currentGeneration === generation.current) {
        activeRequest.current = undefined;
        setLoading(false);
      }
    }
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Connection changes invalidate the Server snapshot without changing the loader.
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => {
      controller.abort();
      cancelRefresh();
    };
  }, [refresh, refreshKey, cancelRefresh]);
  return { snapshot, setSnapshot, error, loading, refresh, cancelRefresh };
}

interface ModelSelectorProps {
  value: ModelSelection | null;
  onChange(value: ModelSelection | null): void;
  onManageModels?: (() => void) | undefined;
  onValidityChange?: ((valid: boolean) => void) | undefined;
  refreshKey?: number | undefined;
  allowDefault?: boolean | undefined;
  disabled?: boolean | undefined;
}

export function ModelSelector(props: ModelSelectorProps) {
  const { snapshot, error, loading, refresh } = useModelServices(props.refreshKey);
  useEffect(() => {
    if (loading || error || !snapshot) props.onValidityChange?.(false);
  }, [loading, error, snapshot, props.onValidityChange]);
  return (
    <section className="model-selector" aria-label="员工使用的模型">
      <div className="model-section-heading">
        <strong>模型服务与模型</strong>
        {props.onManageModels ? (
          <button className="model-text-button" type="button" onClick={props.onManageModels}>
            管理模型服务
          </button>
        ) : null}
      </div>
      {loading ? (
        <p className="model-help" role="status">
          正在加载模型服务…
        </p>
      ) : null}
      {error ? (
        <div className="model-inline-error" role="alert">
          <p>{error}</p>
          <button className="secondary-button" type="button" onClick={() => void refresh()}>
            重新加载
          </button>
        </div>
      ) : null}
      {snapshot ? (
        <ModelSelectionFields
          {...props}
          snapshot={snapshot}
          disabled={props.disabled || loading || Boolean(error)}
        />
      ) : null}
    </section>
  );
}

export function ModelSelectionFields({
  snapshot,
  value,
  onChange,
  disabled,
  onValidityChange,
  allowDefault = true,
}: ModelSelectorProps & { snapshot: ModelServicesSnapshot }) {
  const connection = snapshot.connections.find((item) => item.id === value?.connectionId);
  const available = snapshot.connections.filter((item) => item.enabled && item.hasApiKey);
  const legacy = allowDefault ? available.find((item) => item.source === "environment") : undefined;
  const valid =
    !disabled &&
    (value === null
      ? Boolean(legacy)
      : Boolean(
          connection?.enabled &&
            connection.hasApiKey &&
            modelIdSchema.safeParse(value.modelId).success,
        ));
  useEffect(() => onValidityChange?.(valid), [valid, onValidityChange]);
  const unavailable = value !== null && !available.some((item) => item.id === value.connectionId);
  return (
    <div className="model-field-grid">
      <label>
        <span>模型服务</span>
        <select
          value={value?.connectionId ?? ""}
          disabled={disabled}
          required={!legacy}
          onChange={(event) => {
            const selected = available.find((item) => item.id === event.target.value);
            if (!selected) return onChange(null);
            const preset = snapshot.presets.find((item) => item.id === selected.presetId);
            onChange({
              connectionId: selected.id,
              modelId: selected.defaultModel ?? preset?.suggestedModels[0] ?? "",
            });
          }}
        >
          <option value="" disabled={!legacy}>
            {legacy ? `Server 默认 · ${legacy.defaultModel ?? legacy.name}` : "请选择已配置的服务"}
          </option>
          {unavailable ? (
            <option value={value.connectionId} disabled>
              {connection?.name ?? "原模型服务"}（不可用）
            </option>
          ) : null}
          {available.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {value !== null ? (
        <ModelIdField
          key={`${value.connectionId}:${connection?.revision ?? 0}`}
          connectionId={value.connectionId}
          value={value.modelId}
          onChange={(modelId) => onChange({ connectionId: value.connectionId, modelId })}
          suggestions={
            snapshot.presets.find((item) => item.id === connection?.presetId)?.suggestedModels ?? []
          }
          discovery={
            snapshot.presets.find((item) => item.id === connection?.presetId)?.discovery ?? false
          }
          disabled={disabled || unavailable}
        />
      ) : legacy ? (
        <p className="model-help">使用 Server 环境配置的默认模型。</p>
      ) : null}
      {unavailable ? (
        <p className="model-inline-error" role="alert">
          原服务已停用或不可用，请选择其他服务。任务不会自动切换服务。
        </p>
      ) : null}
      {available.length === 0 ? (
        <p className="field-empty">
          还没有可用的模型服务。打开“管理模型服务”，选择厂商并保存 API Key。
        </p>
      ) : null}
    </div>
  );
}

export function ModelIdField({
  connectionId,
  value,
  onChange,
  suggestions,
  discovery,
  disabled,
}: {
  connectionId: string;
  value: string;
  onChange(value: string): void;
  suggestions: string[];
  discovery: boolean;
  disabled?: boolean | undefined;
}) {
  const listId = useId();
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const activeRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => activeRequest.current?.abort(), []);
  const invalid = value.length > 0 && !modelIdSchema.safeParse(value).success;
  const modelIds = [...new Set([...suggestions, ...discovered])];
  async function discover() {
    if (loading) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const models = await discoverConnectionModels(connectionId, controller.signal);
      if (controller.signal.aborted) return;
      setDiscovered(models);
      setStatus(
        models.length > 0
          ? `已读取 ${models.length} 个模型，可搜索或输入模型 ID。`
          : "服务未返回模型，仍可手动填写模型 ID。",
      );
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "无法获取模型列表，仍可手动填写。");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  return (
    <div className="model-id-field">
      <label>
        <span>模型 ID</span>
        <input
          list={listId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          maxLength={256}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${listId}-error` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="选择建议模型，或输入完整模型 ID"
          required
        />
        <datalist id={listId}>
          {modelIds.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
      </label>
      {invalid ? (
        <p id={`${listId}-error`} className="model-inline-error" role="alert">
          模型 ID 需以英文字母或数字开头，可包含 . _ : / @ + -，不能包含空格或中文。
        </p>
      ) : null}
      {discovery ? (
        <button
          className="secondary-button model-discover-button"
          type="button"
          disabled={disabled || loading}
          onClick={() => void discover()}
        >
          {loading ? "读取中…" : "获取模型列表"}
        </button>
      ) : null}
      <small className="model-help">
        {discovery
          ? "获取列表只查询模型；是否可调用取决于你的账户。"
          : "该服务使用手动模型 ID。可填控制台提供的模型或推理接入点 ID。"}
      </small>
      {status ? (
        <p className="model-help" role="status">
          {status}
        </p>
      ) : null}
      {error ? (
        <p className="model-inline-error" role="alert">
          {error} 可以继续手动填写。
        </p>
      ) : null}
    </div>
  );
}
