import type { EmployeeProfile } from "@openbot/domain";
import { type FormEvent, useId, useState } from "react";
import { updateEmployeeProfileDetails } from "../api";

/**
 * Name goes through the rename route; 标签 (the Server's role) and 描述 through the
 * revision-checked profile route, so an edit from another device is never overwritten.
 * Both are descriptive and grant no skill or computer authority.
 */
export function EmployeeSettingsForm({
  profile,
  onRename,
  onProfileChanged,
}: {
  profile: EmployeeProfile;
  onRename(name: string): Promise<void>;
  onProfileChanged(): Promise<void>;
}) {
  const initial = {
    name: profile.employee.name,
    role: profile.employee.role,
    description: profile.details.description,
    revision: profile.details.revision,
  };
  const [baseline, setBaseline] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [role, setRole] = useState(initial.role);
  const [description, setDescription] = useState(initial.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();
  const nameChanged = name.trim() !== baseline.name;
  const detailsChanged =
    role.trim() !== baseline.role || description.trim() !== baseline.description;
  const serverChanged = profile.details.revision !== baseline.revision;

  function reset(next = baseline) {
    setName(next.name);
    setRole(next.role);
    setDescription(next.description);
    setError(undefined);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !role.trim()) {
      setError("名称和标签不能为空。");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const next = { ...baseline };
      if (nameChanged) {
        await onRename(name.trim());
        next.name = name.trim();
      }
      if (detailsChanged) {
        const result = await updateEmployeeProfileDetails(profile.employee.id, {
          role,
          description,
          expectedRevision: baseline.revision,
        });
        next.role = result.employee.role;
        next.description = result.details.description;
        next.revision = result.details.revision;
      }
      setBaseline(next);
      reset(next);
      await onProfileChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法保存，请重新加载后再试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="ep-settings-form" onSubmit={(event) => void submit(event)}>
      <label className="ob-field" htmlFor={`${id}-name`}>
        名称
        <input
          id={`${id}-name`}
          value={name}
          maxLength={64}
          required
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="ob-field" htmlFor={`${id}-role`}>
        标签
        <input
          id={`${id}-role`}
          value={role}
          maxLength={160}
          required
          placeholder="研究、市场、行政"
          onChange={(event) => setRole(event.target.value)}
        />
      </label>
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
                name: profile.employee.name,
                role: profile.employee.role,
                description: profile.details.description,
                revision: profile.details.revision,
              };
              setBaseline(latest);
              reset(latest);
            }}
          >
            加载最新值
          </button>
        </div>
      ) : null}
      {nameChanged || detailsChanged ? (
        <footer>
          <button className="ob-pill is-small" type="button" onClick={() => reset()}>
            取消
          </button>
          <button
            className="ob-pill is-small is-primary"
            type="submit"
            disabled={saving || (detailsChanged && serverChanged)}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </footer>
      ) : null}
    </form>
  );
}
