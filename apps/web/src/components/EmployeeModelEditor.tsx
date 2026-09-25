// Adapted from OpenBot MIT feature-source EmployeeProfileView at 9cc73c9.
import type { EmployeeProfile, ModelSelection } from "@openbot/domain";
import { type FormEvent, useState } from "react";
import { ApiError, getEmployeeProfile, updateEmployeeModel } from "../api";
import { ModelSelector } from "./ModelSelector";

export function EmployeeModelEditor({
  profile,
  onProfileChanged,
  onManageModels,
  modelServicesVersion,
}: {
  profile: EmployeeProfile;
  onProfileChanged(): Promise<void>;
  onManageModels?: (() => void) | undefined;
  modelServicesVersion?: number | undefined;
}) {
  const [baseline, setBaseline] = useState({
    revision: profile.details.revision,
    model: profile.configuration.model ?? null,
  });
  const [model, setModel] = useState<ModelSelection | null>(baseline.model);
  const [valid, setValid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const stale = profile.details.revision !== baseline.revision;
  const changed =
    model?.connectionId !== baseline.model?.connectionId ||
    model?.modelId.trim() !== baseline.model?.modelId;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !valid || !changed || stale) return;
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await updateEmployeeModel(profile.employee.id, {
        expectedRevision: baseline.revision,
        model: model ? { ...model, modelId: model.modelId.trim() } : null,
      });
      const nextModel = result.employee.model ?? null;
      setBaseline({ revision: result.details.revision, model: nextModel });
      setModel(nextModel);
      setNotice("已更新模型。新任务将使用这个选择，已排队的任务保留原模型。");
      await onProfileChanged();
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 409
          ? "员工配置已在其他位置更新。请加载最新值，再确认模型选择。"
          : cause instanceof Error
            ? cause.message
            : "无法保存模型，请重新加载后重试。",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="employee-model-form" onSubmit={(event) => void save(event)}>
      <h3>对话模型</h3>
      <ModelSelector
        value={model}
        allowDefault={profile.employee.computerProfile !== "docker-linux"}
        onChange={(value) => {
          setModel(value);
          setNotice(undefined);
        }}
        onValidityChange={setValid}
        onManageModels={onManageModels}
        refreshKey={modelServicesVersion}
        disabled={saving || stale}
      />
      {stale ? (
        <p className="model-help" role="status">
          员工配置已更新，加载最新值后继续。
        </p>
      ) : null}
      {error ? (
        <p className="model-inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="model-success" role="status">
          {notice}
        </p>
      ) : null}
      <div className="model-actions">
        <button
          className="primary-button"
          type="submit"
          disabled={saving || !valid || !changed || stale}
        >
          {saving ? "保存中…" : "保存模型"}
        </button>
        {stale || error ? (
          <button
            className="secondary-button"
            type="button"
            disabled={saving}
            onClick={async () => {
              try {
                const latest = await getEmployeeProfile(profile.employee.id);
                const nextModel = latest.configuration.model ?? null;
                setBaseline({ revision: latest.details.revision, model: nextModel });
                setModel(nextModel);
                setError(undefined);
                await onProfileChanged();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "重新加载失败。");
              }
            }}
          >
            加载最新值
          </button>
        ) : null}
      </div>
    </form>
  );
}
