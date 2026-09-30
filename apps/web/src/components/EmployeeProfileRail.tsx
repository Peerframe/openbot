import type { Bot, EmployeeProfile, ExecutionNode } from "@openbot/domain";
import { type FormEvent, useId, useState } from "react";
import { updateEmployeeProfileDetails } from "../api";
import { isActiveRun } from "../run-state";
import { sidebarOrganization, useSidebarOrganization } from "../sidebar-organization";
import { useWorkspacePreferences } from "../workspace-preferences";
import { RobotAvatar } from "./RobotAvatar";

/** Bot settings rail from the Profile artboard: identity fields, notifications and runtime. */
export function EmployeeProfileRail({
  profile,
  nodes,
  onBack,
  onCollapse,
  onRename,
  onProfileChanged,
}: {
  profile: EmployeeProfile | undefined;
  nodes: ExecutionNode[];
  onBack(): void;
  onCollapse(): void;
  onRename(name: string): Promise<void>;
  onProfileChanged(): Promise<void>;
}) {
  return (
    <aside className="context-rail employee-profile-rail" aria-label="Bot 设置">
      <header className="ep-rail-header">
        <button className="ep-icon-button" type="button" aria-label="返回" onClick={onBack}>
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <h2>设置</h2>
        <button className="ep-icon-button" type="button" aria-label="收起" onClick={onCollapse}>
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 17 11 12 6 7" />
            <polyline points="13 17 18 12 13 7" />
          </svg>
        </button>
      </header>
      {profile ? (
        <div className="ep-rail-body">
          <span className="ep-rail-avatar">
            <RobotAvatar bot={profile.employee} />
          </span>
          <EmployeeSettingsForm
            key={profile.employee.id}
            profile={profile}
            onRename={onRename}
            onProfileChanged={onProfileChanged}
          />
          <BotNotificationToggle bot={profile.employee} />
          <Runtime profile={profile} nodes={nodes} />
        </div>
      ) : null}
    </aside>
  );
}

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

/**
 * Per-Bot mute on this device, shared with the sidebar's 关闭通知. System notifications also
 * need the Settings → 通知 opt-in (ADR-0048); the hint says so instead of prompting here.
 */
function BotNotificationToggle({ bot }: { bot: Bot }) {
  const { values } = useSidebarOrganization();
  const preferences = useWorkspacePreferences().values;
  const key = `bot:${bot.id}` as const;
  const enabled = !values.muted.includes(key);
  const systemOn = preferences.notifyApprovals || preferences.notifyMessages;
  return (
    <div className="rail-notify">
      <span>
        <strong>通知</strong>
        <small>
          {systemOn || !enabled
            ? "完成任务或需要回应时通知你"
            : "还需要在 设置 → 通知 中开启系统通知"}
        </small>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="通知"
        className="ob-switch"
        onClick={() => sidebarOrganization.setMuted(key, enabled)}
      />
    </div>
  );
}

const executionLabels: Record<Bot["computerProfile"], string> = {
  none: "仅对话",
  model: "模型工具",
  "docker-linux": "员工浏览器 · Docker",
  "macos-cua": "macOS 电脑操作",
  "lume-vm": "Lume 虚拟机",
  coder: "代码工作区",
};

function Runtime({ profile, nodes }: { profile: EmployeeProfile; nodes: ExecutionNode[] }) {
  const activeRun = profile.records.runs.find(isActiveRun);
  const activeNode = nodes.find((node) => node.id === activeRun?.nodeId);
  return (
    <section className="ep-runtime" aria-labelledby="ep-runtime-heading">
      <h3 id="ep-runtime-heading">运行环境</h3>
      <dl>
        <div>
          <dt>模型</dt>
          <dd>{profile.configuration.model?.modelId ?? "未指定"}</dd>
        </div>
        <div>
          <dt>工作主机</dt>
          <dd>{activeNode?.name ?? "执行任务时分配"}</dd>
        </div>
        <div>
          <dt>执行方式</dt>
          <dd>{executionLabels[profile.configuration.executionProfile]}</dd>
        </div>
      </dl>
      <p>技能表示会做什么，不代表有权操作电脑。每台主机单独授权。</p>
    </section>
  );
}
