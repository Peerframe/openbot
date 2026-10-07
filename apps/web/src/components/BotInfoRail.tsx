import type {
  ApprovalDecision,
  Bot,
  EmployeeProfile,
  ModelSelection,
  WorkspaceSnapshot,
} from "@openbot/domain";
import { type KeyboardEvent, useEffect, useId, useState } from "react";
import { getOwnerPreferences, updateEmployeeProfileDetails } from "../api";
import { type Automation, listAutomations, setAutomationEnabled } from "../destination-api";
import { needsRoleSetup } from "../quick-bot";
import { isActiveRun, runStatusLabel, runTitle } from "../run-state";
import { sidebarOrganization, useSidebarOrganization } from "../sidebar-organization";
import { useWorkspacePreferences } from "../workspace-preferences";
import { ApprovalStack } from "./ApprovalStack";
import { AvatarEditor } from "./AvatarEditor";
import { ChannelLibrary, NodeRow } from "./ContextRail";
import { DeleteIdentityDialog } from "./DeleteIdentityDialog";
import type { DesktopSettingsSection } from "./DesktopSettingsScreen";
import {
  evidenceKindLabel,
  evolutionMarkClass,
  evolutionTitle,
  evolutionWhen,
  selectEvolutionArchiveEvents,
  uniqueEvidenceReferences,
} from "./EmployeeEvolutionArchive";
import { EmployeeModelEditor } from "./EmployeeModelEditor";
import { NodeIcon } from "./Icons";
import "./ContextRail.css";
import "./BotInfoRail.css";

type Tab = "details" | "work" | "library" | "computer";
const tabLabels: Record<Tab, string> = {
  details: "详情",
  work: "工作",
  library: "资料库",
  computer: "电脑",
};
const tabs: Tab[] = ["details", "work", "library", "computer"];
/** Horizontal tabs: ArrowLeft/ArrowRight wrap, Home/End jump; other keys are left alone. */
function railTabForKey(current: Tab, key: string): Tab | undefined {
  const index = tabs.indexOf(current);
  if (key === "ArrowRight") return tabs[(index + 1) % tabs.length];
  if (key === "ArrowLeft") return tabs[(index + tabs.length - 1) % tabs.length];
  if (key === "Home") return tabs[0];
  if (key === "End") return tabs.at(-1);
  return undefined;
}
/** LongLists: a rail list shows at most four, then 「全部 N 个 ›」. */
const RAIL_PREVIEW = 4;

export const botComputerLabels: Record<Bot["computerProfile"], string> = {
  none: "不用电脑",
  model: "不用电脑",
  "docker-linux": "员工浏览器 · Docker",
  "macos-cua": "操作 macOS 电脑",
  "lume-vm": "Lume 虚拟机",
  coder: "代码工作区",
};

/**
 * Bot 信息 (BotInfo artboard): the rail beside a 单聊; it replaced the separate Bot page. Name,
 * tag and 介绍 are edited in place — the name through the rename route, the tag (the Server's role)
 * and description through the revision-checked profile route — and none grants any skill or
 * computer authority. 编辑头像 changes the look through the appearance route at the same revision
 * (C9).
 */
export function BotInfoRail({
  bot,
  profile,
  profileError,
  onRetryProfile,
  workspace,
  onCollapse,
  onShare,
  onRename,
  onProfileChanged,
  onAppearanceChanged,
  onDelete,
  onDecideApproval,
  onManageModels,
  modelServicesVersion,
  onOpenSettings,
  onOpenRun,
  onOpenBrowser,
}: {
  bot: Bot;
  profile: EmployeeProfile | undefined;
  /** The latest profile read failed; retained data is not shown as current. */
  profileError?: string | undefined;
  onRetryProfile?: (() => void) | undefined;
  workspace: WorkspaceSnapshot;
  onCollapse(): void;
  onShare(): void;
  onRename(name: string): Promise<void>;
  onProfileChanged(): Promise<void>;
  /** The Server's Bot after an appearance change, so every avatar of it updates at once. */
  onAppearanceChanged(bot: Bot): void;
  onDelete(): Promise<void>;
  onDecideApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  onManageModels(): void;
  modelServicesVersion?: number | undefined;
  /** 「全部 N 个 ›」 under a capped list opens its settings section. */
  onOpenSettings?: ((section: DesktopSettingsSection) => void) | undefined;
  /** A task row opens 任务详情. */
  onOpenRun?: ((runId: string) => void) | undefined;
  /** 员工浏览器 for a Bot that works in the Docker browser. */
  onOpenBrowser?: (() => void) | undefined;
}) {
  const [tab, setTab] = useState<Tab>("details");
  const [deleting, setDeleting] = useState(false);
  const tabId = useId();
  const direct = workspace.channels.find((channel) => channel.directBotId === bot.id);

  return (
    <aside className="context-rail channel-info bot-info" aria-label="Bot 信息">
      <header className="ci-header">
        <h2 className="visually-hidden">Bot 信息</h2>
        <button
          type="button"
          className="ci-icon"
          aria-label="分享 Bot 模板"
          title="分享 Bot 模板"
          onClick={onShare}
        >
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
            <polyline points="16 6 12 2 8 6" />
            <line x1="12" y1="2" x2="12" y2="15" />
          </svg>
        </button>
        <button
          type="button"
          className="ci-icon"
          aria-label="收起"
          title="收起"
          onClick={onCollapse}
        >
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

      <div className="bi-identity">
        <AvatarEditor
          bot={bot}
          bots={workspace.bots}
          profile={profile}
          onChanged={onAppearanceChanged}
          onConflict={onProfileChanged}
        />
        <NameField key={`${bot.id}:${bot.name}`} name={bot.name} onRename={onRename} />
        <TagField
          key={`${bot.id}:${bot.role}`}
          bot={bot}
          profile={profile}
          onProfileChanged={onProfileChanged}
        />
        {profile ? (
          <DescriptionField
            key={`${bot.id}:${profile.details.revision}`}
            profile={profile}
            onProfileChanged={onProfileChanged}
          />
        ) : null}
      </div>
      {profileError ? (
        <div className="bi-profile-error" role="alert">
          <span>没能读取 Bot 资料：{profileError}</span>
          {onRetryProfile ? (
            <button type="button" className="ob-pill is-small" onClick={onRetryProfile}>
              重试
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        className="ci-tabs"
        role="tablist"
        aria-label="Bot 信息分页"
        onKeyDown={(event) => {
          const next = railTabForKey(tab, event.key);
          if (next === undefined) return;
          event.preventDefault();
          setTab(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
        }}
      >
        {tabs.map((id) => (
          <button
            type="button"
            role="tab"
            id={`${tabId}-${id}`}
            aria-controls={`${tabId}-panel`}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            data-tab={id}
            key={id}
            onClick={() => setTab(id)}
          >
            {tabLabels[id]}
          </button>
        ))}
      </div>

      <div
        className="ci-body bi-body"
        id={`${tabId}-panel`}
        role="tabpanel"
        aria-labelledby={`${tabId}-${tab}`}
      >
        {tab === "details" ? (
          <>
            <Approvals bot={bot} workspace={workspace} onDecideApproval={onDecideApproval} />
            <HowItWorks
              bot={bot}
              profile={profile}
              onComputer={() => setTab("computer")}
              onProfileChanged={onProfileChanged}
              onManageModels={onManageModels}
              modelServicesVersion={modelServicesVersion}
              onOpenSettings={onOpenSettings}
            />
            <Routines bot={bot} onOpenSettings={onOpenSettings} />
            <BotNotificationToggle bot={bot} />
            <button type="button" className="bi-delete" onClick={() => setDeleting(true)}>
              删除这个 Bot…
            </button>
          </>
        ) : null}
        {tab === "work" ? (
          <Work
            profile={profile}
            profileError={profileError}
            workspace={workspace}
            onOpenRun={onOpenRun}
          />
        ) : null}
        {tab === "library" ? (
          direct ? (
            <ChannelLibrary
              channelId={direct.id}
              artifacts={workspace.artifacts
                .filter(
                  (artifact) =>
                    workspace.runs.find((run) => run.id === artifact.runId)?.channelId ===
                    direct.id,
                )
                .sort((left, right) => right.createdAt.localeCompare(left.createdAt))}
              botNameForRun={() => bot.name}
              botName={(botId) => (botId === bot.id ? bot.name : undefined)}
              channelName={bot.name}
            />
          ) : (
            <p className="ci-empty">和它单聊后，你们的文件和它的产出会放在这里。</p>
          )
        ) : null}
        {tab === "computer" ? (
          <Computer
            bot={bot}
            workspace={workspace}
            onOpenSettings={onOpenSettings}
            onOpenBrowser={onOpenBrowser}
          />
        ) : null}
      </div>

      {deleting ? (
        <DeleteIdentityDialog
          target={{ kind: "bot", id: bot.id, name: bot.name }}
          bots={workspace.bots}
          channels={workspace.channels}
          onClose={() => setDeleting(false)}
          onDelete={onDelete}
        />
      ) : null}
    </aside>
  );
}

/** The name, edited in place: Enter or leaving the field saves, Escape restores. */
function NameField({ name, onRename }: { name: string; onRename(name: string): Promise<void> }) {
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function commit() {
    const next = value.trim();
    if (saving) return;
    if (!next || next === name) {
      setValue(name);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await onRename(next);
    } catch {
      setError("没能改名，可能已有同名的 Bot。");
      setValue(name);
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") event.currentTarget.blur();
    else if (event.key === "Escape") {
      setValue(name);
      setError(undefined);
      requestAnimationFrame(() => (event.target as HTMLInputElement).blur());
    }
  }

  return (
    <>
      <input
        className="bi-name"
        type="text"
        aria-label="Bot 名称"
        maxLength={64}
        value={value}
        disabled={saving}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={onKeyDown}
      />
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

/**
 * The tag is the Server's role. A quick-created Bot's placeholder role reads as 添加标签. Saving
 * sends the profile revision, so an edit made elsewhere is refused instead of overwritten.
 */
function TagField({
  bot,
  profile,
  onProfileChanged,
}: {
  bot: Bot;
  profile: EmployeeProfile | undefined;
  onProfileChanged(): Promise<void>;
}) {
  const empty = needsRoleSetup(bot) || !bot.role.trim();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(empty ? "" : bot.role);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function commit() {
    const next = value.trim();
    if (saving) return;
    if (!next || next === bot.role || !profile) {
      setEditing(false);
      setValue(empty ? "" : bot.role);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await updateEmployeeProfileDetails(bot.id, {
        role: next,
        description: profile.details.description,
        expectedRevision: profile.details.revision,
      });
      setEditing(false);
      await onProfileChanged();
    } catch {
      setError("没能保存标签，请重试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {editing ? (
        <input
          className="bi-tag-input"
          type="text"
          aria-label="标签"
          placeholder="研究、市场、行政"
          maxLength={160}
          // biome-ignore lint/a11y/noAutofocus: the Owner just chose to edit the tag.
          autoFocus
          value={value}
          disabled={saving}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            else if (event.key === "Escape") {
              setValue(empty ? "" : bot.role);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className={`bi-tag${empty ? " is-empty" : ""}`}
          disabled={!profile}
          onClick={() => setEditing(true)}
        >
          {empty ? "添加标签" : bot.role}
        </button>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

/**
 * 介绍 under the tag: what the Bot is for, edited in place like the tag. Saving keeps the role and
 * sends the profile revision, so an edit from another device is refused instead of overwritten.
 * It is descriptive only and grants nothing.
 */
function DescriptionField({
  profile,
  onProfileChanged,
}: {
  profile: EmployeeProfile;
  onProfileChanged(): Promise<void>;
}) {
  const saved = profile.details.description;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function commit() {
    const next = value.trim();
    if (saving) return;
    if (next === saved.trim()) {
      setEditing(false);
      setValue(saved);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await updateEmployeeProfileDetails(profile.employee.id, {
        role: profile.employee.role,
        description: next,
        expectedRevision: profile.details.revision,
      });
      setEditing(false);
      await onProfileChanged();
    } catch {
      setError("没能保存介绍，可能已在另一台设备修改。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {editing ? (
        <textarea
          className="bi-description-input"
          aria-label="介绍"
          placeholder="这个 Bot 适合做什么"
          rows={3}
          maxLength={2000}
          // biome-ignore lint/a11y/noAutofocus: the Owner just chose to edit the description.
          autoFocus
          value={value}
          disabled={saving}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              setValue(saved);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className={`bi-description${saved.trim() ? "" : " is-empty"}`}
          title={saved.trim() ? "编辑介绍" : undefined}
          onClick={() => setEditing(true)}
        >
          {saved.trim() || "添加介绍"}
        </button>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function Approvals({
  bot,
  workspace,
  onDecideApproval,
}: {
  bot: Bot;
  workspace: WorkspaceSnapshot;
  onDecideApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
}) {
  const pending = workspace.approvals.filter(
    (approval) => approval.status === "pending" && approval.botId === bot.id,
  );
  if (pending.length === 0) return null;
  return (
    <section className="ci-section" aria-label="需要确认的操作">
      <h3>需要处理 · {pending.length}</h3>
      <ApprovalStack
        approvals={pending}
        botFor={() => bot}
        channelFor={(approval) =>
          workspace.channels.find((channel) => channel.id === approval.channelId)
        }
        onDecide={onDecideApproval}
      />
    </section>
  );
}

function sameModel(left: ModelSelection | undefined | null, right: ModelSelection | undefined) {
  return (
    left !== undefined &&
    left !== null &&
    right !== undefined &&
    left.connectionId === right.connectionId &&
    left.modelId === right.modelId
  );
}

/** 怎么工作: the model and whether the Bot uses a computer. */
function HowItWorks({
  bot,
  profile,
  onComputer,
  onProfileChanged,
  onManageModels,
  modelServicesVersion,
  onOpenSettings,
}: {
  bot: Bot;
  profile: EmployeeProfile | undefined;
  onComputer(): void;
  onProfileChanged(): Promise<void>;
  onManageModels(): void;
  modelServicesVersion?: number | undefined;
  onOpenSettings?: ((section: DesktopSettingsSection) => void) | undefined;
}) {
  const [defaultModel, setDefaultModel] = useState<ModelSelection>();
  const [editingModel, setEditingModel] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getOwnerPreferences(controller.signal)
      .then((preferences) => setDefaultModel(preferences.defaultModel ?? undefined))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  const model = profile?.configuration.model ?? bot.model;
  const modelLabel = model
    ? `${sameModel(model, defaultModel) ? "默认 · " : ""}${model.modelId}`
    : defaultModel
      ? `默认 · ${defaultModel.modelId}`
      : "未选择";
  // Only Bots that run a model can change it here; the others are fixed at creation.
  const editable = profile !== undefined && ["model", "docker-linux"].includes(bot.computerProfile);
  const candidates = profile?.skills.filter((skill) => skill.state === "candidate").length ?? 0;

  return (
    <section className="ci-section" aria-labelledby="bi-how-heading">
      <h3 id="bi-how-heading">怎么工作</h3>
      <div className="bi-card">
        <button
          type="button"
          className="bi-row"
          aria-expanded={editable ? editingModel : undefined}
          disabled={!editable}
          onClick={() => setEditingModel((open) => !open)}
        >
          <span>模型</span>
          <span className="bi-row-value">
            {modelLabel}
            {editable ? <Chevron /> : null}
          </span>
        </button>
        {editingModel && profile ? (
          <div className="bi-row-editor">
            <EmployeeModelEditor
              key={profile.employee.id}
              profile={profile}
              onProfileChanged={onProfileChanged}
              onManageModels={onManageModels}
              modelServicesVersion={modelServicesVersion}
            />
          </div>
        ) : null}
        <button type="button" className="bi-row" onClick={onComputer}>
          <span>电脑</span>
          <span className="bi-row-value">
            {botComputerLabels[bot.computerProfile]}
            <Chevron />
          </span>
        </button>
        {profile && onOpenSettings ? (
          <>
            <button type="button" className="bi-row" onClick={() => onOpenSettings("skills")}>
              <span>技能</span>
              <span className="bi-row-value">
                {profile.skills.length} 个{candidates > 0 ? ` · ${candidates} 个待审核` : ""}
                <Chevron />
              </span>
            </button>
            <button type="button" className="bi-row" onClick={() => onOpenSettings("memory")}>
              <span>记忆</span>
              <span className="bi-row-value">
                {profile.memories.length} 条
                <Chevron />
              </span>
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}

function everyLabel(minutes: number) {
  if (minutes % 1440 === 0) return minutes === 1440 ? "每天" : `每 ${minutes / 1440} 天`;
  if (minutes % 60 === 0) return minutes === 60 ? "每小时" : `每 ${minutes / 60} 小时`;
  return `每 ${minutes} 分钟`;
}

/** 例行任务 this Bot repeats on a schedule; they are set up by asking in the conversation. */
function Routines({
  bot,
  onOpenSettings,
}: {
  bot: Bot;
  onOpenSettings?: ((section: DesktopSettingsSection) => void) | undefined;
}) {
  const [routines, setRoutines] = useState<Automation[]>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setRoutines(undefined);
    setFailed(false);
    listAutomations(controller.signal)
      .then((all) => setRoutines(all.filter((automation) => automation.botId === bot.id)))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [bot.id]);

  const [toggleError, setToggleError] = useState(false);
  // A switch pauses or resumes through the Server's routine route; the row reverts if it refuses.
  async function toggle(routine: Automation) {
    const enabled = !routine.enabled;
    const swap = (next: Automation) =>
      setRoutines((current) => current?.map((item) => (item.id === next.id ? next : item)));
    setToggleError(false);
    swap({ ...routine, enabled });
    try {
      swap(await setAutomationEnabled(routine.id, enabled));
    } catch {
      swap(routine);
      setToggleError(true);
    }
  }

  return (
    <section className="ci-section" aria-labelledby="bi-routines-heading">
      <h3 id="bi-routines-heading">例行任务</h3>
      {routines && routines.length > 0 ? (
        <div className="bi-card">
          {routines.slice(0, RAIL_PREVIEW).map((routine) => (
            <div className="bi-row is-static bi-routine" key={routine.id}>
              <span className="bi-work-text">
                <strong>{routine.name}</strong>
                <small>{routine.enabled ? everyLabel(routine.intervalMinutes) : "已暂停"}</small>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={routine.enabled}
                aria-label={`${routine.name}：${routine.enabled ? "暂停" : "恢复"}`}
                className="ob-switch"
                onClick={() => void toggle(routine)}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="bi-note">
          {failed ? "暂时读不到例行任务。" : "在聊天里让它定期做某件事，就会出现在这里。"}
        </p>
      )}
      {toggleError ? (
        <p className="form-error" role="alert">
          没能切换，请重试。
        </p>
      ) : null}
      {routines && routines.length > RAIL_PREVIEW && onOpenSettings ? (
        <button type="button" className="ci-more" onClick={() => onOpenSettings("routines")}>
          全部 {routines.length} 个 ›
        </button>
      ) : null}
    </section>
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
    <div className="ci-notify">
      <span className="ci-notify-text">
        <strong className="ci-notify-title">通知</strong>
        <small className="ci-notify-hint">
          {systemOn || !enabled
            ? "完成任务或需要回应时提醒你"
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

/** 电脑: how this Bot uses a computer, where it works now, and what is connected. */
function Computer({
  bot,
  workspace,
  onOpenSettings,
  onOpenBrowser,
}: {
  bot: Bot;
  workspace: WorkspaceSnapshot;
  onOpenSettings?: ((section: DesktopSettingsSection) => void) | undefined;
  onOpenBrowser?: (() => void) | undefined;
}) {
  const active = workspace.runs.find((run) => run.botId === bot.id && isActiveRun(run));
  const node = workspace.nodes.find((item) => item.id === active?.nodeId);
  const usesComputer = bot.computerProfile !== "none" && bot.computerProfile !== "model";
  return (
    <>
      <section className="ci-section" aria-labelledby="bi-computer-heading">
        <h3 id="bi-computer-heading">怎么用电脑</h3>
        <div className="bi-card">
          <div className="bi-row is-static">
            <span>方式</span>
            <span className="bi-row-value">{botComputerLabels[bot.computerProfile]}</span>
          </div>
          {usesComputer ? (
            <div className="bi-row is-static">
              <span>现在</span>
              <span className="bi-row-value">{node?.name ?? "做任务时分配"}</span>
            </div>
          ) : null}
          {bot.computerProfile === "docker-linux" && onOpenBrowser ? (
            <button type="button" className="bi-row" onClick={onOpenBrowser}>
              <span>员工浏览器</span>
              <span className="bi-row-value">
                打开
                <Chevron />
              </span>
            </button>
          ) : null}
        </div>
      </section>
      <section className="ci-section" aria-label="工作电脑">
        <h3>
          工作电脑<span className="ci-section-meta">{workspace.nodes.length} 台已连接</span>
        </h3>
        {workspace.nodes.length === 0 ? (
          <div className="ci-card ci-no-computer">
            <NodeIcon />
            <p>尚未连接工作电脑</p>
          </div>
        ) : (
          <div className="ci-card">
            {workspace.nodes.slice(0, RAIL_PREVIEW).map((item) => (
              <NodeRow node={item} key={item.id} />
            ))}
          </div>
        )}
        {workspace.nodes.length > RAIL_PREVIEW && onOpenSettings ? (
          <button type="button" className="ci-more" onClick={() => onOpenSettings("hosts")}>
            全部 {workspace.nodes.length} 个 ›
          </button>
        ) : null}
      </section>
      <p className="bi-note">技能表示会做什么，不代表有权操作电脑。每台工作电脑单独授权。</p>
    </>
  );
}

/** 工作 stays short (owner feedback 2026-10-06): three rows each until the Owner asks for more. */
const WORK_PREVIEW = 3;
const WORK_PAGE = 20;

/**
 * 工作: the Bot's tasks and 成长, from the same Server profile the Bot page used to show. Live
 * work comes first; finished tasks are newest first. 成长 lists dated, sourced events only —
 * never a score or level, and never the model's raw reasoning.
 */
function Work({
  profile,
  profileError,
  workspace,
  onOpenRun,
}: {
  profile: EmployeeProfile | undefined;
  profileError?: string | undefined;
  workspace: WorkspaceSnapshot;
  onOpenRun?: ((runId: string) => void) | undefined;
}) {
  const [runLimit, setRunLimit] = useState(WORK_PREVIEW);
  const [eventLimit, setEventLimit] = useState(WORK_PREVIEW);
  if (!profile)
    return (
      <p className="bi-empty" role="status">
        {profileError ? "暂时读不到工作记录。" : "正在读取工作记录…"}
      </p>
    );
  const where = (channelId: string) => {
    const channel = workspace.channels.find((item) => item.id === channelId);
    return channel ? (channel.directBotId ? "单聊" : `# ${channel.name}`) : "频道";
  };
  const runs = [...profile.records.runs].sort(
    (left, right) =>
      Number(isActiveRun(right)) - Number(isActiveRun(left)) ||
      Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
  const events = selectEvolutionArchiveEvents(profile.evolution, "all");
  if (runs.length === 0 && events.length === 0)
    return <p className="bi-empty">在聊天里交给它第一项工作，任务和成长会出现在这里。</p>;

  return (
    <>
      <section className="ci-section" aria-labelledby="bi-runs-heading">
        <h3 id="bi-runs-heading">
          任务
          {profile.statistics.totalRuns > 0 ? (
            <span className="ci-section-meta">
              完成 {profile.statistics.completedRuns} / {profile.statistics.totalRuns}
            </span>
          ) : null}
        </h3>
        {runs.length === 0 ? (
          <p className="bi-note">还没有任务。</p>
        ) : (
          <div className="bi-card">
            {runs.slice(0, runLimit).map((run) => {
              const failed = run.status === "failed" || run.status === "blocked";
              const tone = isActiveRun(run)
                ? " is-live"
                : run.status === "completed"
                  ? " is-ok"
                  : failed
                    ? " is-bad"
                    : "";
              return (
                <button
                  type="button"
                  className="bi-row bi-work-row"
                  key={run.id}
                  disabled={!onOpenRun}
                  onClick={() => onOpenRun?.(run.id)}
                >
                  <span className="bi-work-text">
                    <strong>{runTitle(run)}</strong>
                    <small>
                      {where(run.channelId)} · {evolutionWhen(run.createdAt)}
                    </small>
                  </span>
                  <span className={`bi-work-state${tone}`}>
                    {failed ? "没能完成" : runStatusLabel(run.status)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {runs.length > runLimit ? (
          <button
            type="button"
            className="ci-more"
            onClick={() =>
              setRunLimit(runLimit === WORK_PREVIEW ? WORK_PAGE : runLimit + WORK_PAGE)
            }
          >
            {runLimit === WORK_PREVIEW ? `全部 ${runs.length} 个 ›` : "更早的任务 ›"}
          </button>
        ) : null}
      </section>
      {events.length > 0 ? (
        <section className="ci-section" aria-labelledby="bi-growth-heading">
          <h3 id="bi-growth-heading">成长</h3>
          {
            <ol className="bi-card bi-events">
              {events.slice(0, eventLimit).map((event) => {
                const evidence = uniqueEvidenceReferences(event.evidence);
                return (
                  <li
                    className="bi-event"
                    key={event.id}
                    title={evidence
                      .map((item) => `${evidenceKindLabel(item.kind)}：${item.label ?? item.id}`)
                      .join("\n")}
                  >
                    <i className={evolutionMarkClass(event.type)} aria-hidden="true" />
                    <span className="bi-work-text">
                      <strong>{evolutionTitle(event)}</strong>
                      <small>
                        {evidenceKindLabel(event.source)}
                        {evidence.length > 0 ? ` · ${evidence.length} 条证据` : ""} ·{" "}
                        {evolutionWhen(event.createdAt)}
                      </small>
                    </span>
                  </li>
                );
              })}
            </ol>
          }
          {events.length > eventLimit ? (
            <button
              type="button"
              className="ci-more"
              onClick={() =>
                setEventLimit(eventLimit === WORK_PREVIEW ? WORK_PAGE : eventLimit + WORK_PAGE)
              }
            >
              {eventLimit === WORK_PREVIEW ? `全部 ${events.length} 条 ›` : "更早的记录 ›"}
            </button>
          ) : null}
          <p className="bi-note">只记有来源的变化，不代表权限。成长方向受 Hermes Agent 启发。</p>
        </section>
      ) : null}
    </>
  );
}

function Chevron() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}
