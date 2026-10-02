import type {
  ApprovalDecision,
  Bot,
  EmployeeProfile,
  ModelSelection,
  WorkspaceSnapshot,
} from "@openbot/domain";
import { type KeyboardEvent, useEffect, useId, useState } from "react";
import { getOwnerPreferences, updateEmployeeProfileDetails } from "../api";
import { type Automation, listAutomations } from "../destination-api";
import { needsRoleSetup } from "../quick-bot";
import { isActiveRun } from "../run-state";
import { sidebarOrganization, useSidebarOrganization } from "../sidebar-organization";
import { useWorkspacePreferences } from "../workspace-preferences";
import { ApprovalCard } from "./ApprovalCard";
import { ChannelLibrary, NodeRow } from "./ContextRail";
import { DeleteIdentityDialog } from "./DeleteIdentityDialog";
import { EmployeeModelEditor } from "./EmployeeModelEditor";
import { NodeIcon } from "./Icons";
import { RobotAvatar } from "./RobotAvatar";
import "./ContextRail.css";
import "./BotInfoRail.css";

type Tab = "details" | "library" | "computer";
const tabLabels: Record<Tab, string> = { details: "详情", library: "资料库", computer: "电脑" };
const tabs: Tab[] = ["details", "library", "computer"];

const computerLabels: Record<Bot["computerProfile"], string> = {
  none: "不用电脑",
  model: "不用电脑",
  "docker-linux": "员工浏览器 · Docker",
  "macos-cua": "操作 macOS 电脑",
  "lume-vm": "Lume 虚拟机",
  coder: "代码工作区",
};

/**
 * Bot 信息 (BotInfo artboard): the rail beside a 单聊 and the Bot profile. Name and tag are edited
 * in place — the name through the rename route, the tag (the Server's role) through the
 * revision-checked profile route — and neither grants any skill or computer authority. 编辑头像
 * stays hidden until the Server accepts appearance changes after creation (C9).
 */
export function BotInfoRail({
  bot,
  profile,
  workspace,
  onCollapse,
  onShare,
  onRename,
  onProfileChanged,
  onDelete,
  onDecideApproval,
  onManageModels,
  modelServicesVersion,
}: {
  bot: Bot;
  profile: EmployeeProfile | undefined;
  workspace: WorkspaceSnapshot;
  onCollapse(): void;
  onShare(): void;
  onRename(name: string): Promise<void>;
  onProfileChanged(): Promise<void>;
  onDelete(): Promise<void>;
  onDecideApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  onManageModels(): void;
  modelServicesVersion?: number | undefined;
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
        <RobotAvatar bot={bot} className="bi-avatar" />
        <NameField key={`${bot.id}:${bot.name}`} name={bot.name} onRename={onRename} />
        <TagField
          key={`${bot.id}:${bot.role}`}
          bot={bot}
          profile={profile}
          onProfileChanged={onProfileChanged}
        />
      </div>

      <div
        className="ci-tabs"
        role="tablist"
        aria-label="Bot 信息分页"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const next =
            tabs[
              (tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length
            ] ?? tab;
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
            />
            <Routines bot={bot} />
            <BotNotificationToggle bot={bot} />
            <button type="button" className="bi-delete" onClick={() => setDeleting(true)}>
              删除这个 Bot…
            </button>
          </>
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
            />
          ) : (
            <p className="ci-empty">和它单聊后，你们的文件和它的产出会放在这里。</p>
          )
        ) : null}
        {tab === "computer" ? <Computer bot={bot} workspace={workspace} /> : null}
      </div>

      {deleting ? (
        <DeleteIdentityDialog
          target={{ kind: "bot", id: bot.id, name: bot.name }}
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
      <div className="ci-approvals">
        {pending.map((approval) => (
          <ApprovalCard
            approval={approval}
            bot={bot}
            channel={workspace.channels.find((channel) => channel.id === approval.channelId)}
            onDecide={onDecideApproval}
            key={approval.id}
          />
        ))}
      </div>
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
}: {
  bot: Bot;
  profile: EmployeeProfile | undefined;
  onComputer(): void;
  onProfileChanged(): Promise<void>;
  onManageModels(): void;
  modelServicesVersion?: number | undefined;
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
    : "未选择";
  // Only Bots that run a model can change it here; the others are fixed at creation.
  const editable = profile !== undefined && ["model", "docker-linux"].includes(bot.computerProfile);

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
            {computerLabels[bot.computerProfile]}
            <Chevron />
          </span>
        </button>
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
function Routines({ bot }: { bot: Bot }) {
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

  return (
    <section className="ci-section" aria-labelledby="bi-routines-heading">
      <h3 id="bi-routines-heading">例行任务</h3>
      {routines && routines.length > 0 ? (
        <div className="bi-card">
          {routines.map((routine) => (
            <div className="bi-row is-static" key={routine.id}>
              <span>{routine.name}</span>
              <span className="bi-row-value">
                {routine.enabled ? everyLabel(routine.intervalMinutes) : "已暂停"}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="bi-empty">
          {failed ? (
            "暂时读不到例行任务。"
          ) : (
            <>
              例行任务是这个 Bot 按计划重复做的事。
              <br />
              在聊天里让它设一个就行。
            </>
          )}
        </p>
      )}
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
function Computer({ bot, workspace }: { bot: Bot; workspace: WorkspaceSnapshot }) {
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
            <span className="bi-row-value">{computerLabels[bot.computerProfile]}</span>
          </div>
          {usesComputer ? (
            <div className="bi-row is-static">
              <span>现在</span>
              <span className="bi-row-value">{node?.name ?? "做任务时分配"}</span>
            </div>
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
            {workspace.nodes.map((item) => (
              <NodeRow node={item} key={item.id} />
            ))}
          </div>
        )}
      </section>
      <p className="bi-note">技能表示会做什么，不代表有权操作电脑。每台工作电脑单独授权。</p>
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
