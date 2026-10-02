import type { EmployeeProfile } from "@openbot/domain";
import { type FormEvent, useId, useState } from "react";
import { updateEmployeeProfileDetails } from "../api";

/**
 * 介绍 in 配置 (ProfileConfig artboard). Name and tag are edited in the Bot 信息 rail; the
 * description goes through the revision-checked profile route with the current role unchanged,
 * so an edit from another device is never overwritten. It is descriptive and grants no skill or
 * computer authority.
 */
export function EmployeeDescriptionForm({
  profile,
  onProfileChanged,
}: {
  profile: EmployeeProfile;
  onProfileChanged(): Promise<void>;
}) {
  const initial = { description: profile.details.description, revision: profile.details.revision };
  const [baseline, setBaseline] = useState(initial);
  const [description, setDescription] = useState(initial.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();
  const changed = description.trim() !== baseline.description;
  const serverChanged = profile.details.revision !== baseline.revision;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await updateEmployeeProfileDetails(profile.employee.id, {
        role: profile.employee.role,
        description,
        expectedRevision: baseline.revision,
      });
      const next = {
        description: result.details.description,
        revision: result.details.revision,
      };
      setBaseline(next);
      setDescription(next.description);
      await onProfileChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法保存，请重新加载后再试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="ep-description-form" onSubmit={(event) => void submit(event)}>
      <label className="ob-field" htmlFor={`${id}-description`}>
        描述
        <textarea
          id={`${id}-description`}
          rows={3}
          value={description}
          maxLength={2000}
          placeholder="这个 Bot 适合做什么，以及应当遵守的协作边界。"
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <small>名字和标签在右栏直接改。介绍只用于说明，不授予任何权限。</small>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {serverChanged ? (
        <div className="ep-stale" role="status">
          <p>这个 Bot 已在另一台设备更新。</p>
          <button
            className="ob-pill is-small"
            type="button"
            onClick={() => {
              const latest = {
                description: profile.details.description,
                revision: profile.details.revision,
              };
              setBaseline(latest);
              setDescription(latest.description);
              setError(undefined);
            }}
          >
            加载最新值
          </button>
        </div>
      ) : null}
      <footer>
        {changed ? (
          <button
            className="ob-pill is-small"
            type="button"
            disabled={saving}
            onClick={() => {
              setDescription(baseline.description);
              setError(undefined);
            }}
          >
            取消
          </button>
        ) : null}
        <button
          className="ob-pill is-small is-primary"
          type="submit"
          disabled={!changed || saving || serverChanged}
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </footer>
    </form>
  );
}
