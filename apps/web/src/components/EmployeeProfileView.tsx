import type {
  Channel,
  CreateEmployeeMemoryInput,
  EmployeeMemory,
  EmployeeProfile,
} from "@openbot/domain";
import { type FormEvent, type ReactNode, useId, useMemo, useRef, useState } from "react";
import { createEmployeeMemory, deleteEmployeeMemory, updateEmployeeMemory } from "../api";
import { isActiveRun, runStatusLabel } from "../run-state";
import { AppIcon } from "./AppIcon";
import { botComputerLabels } from "./BotInfoRail";
import { EmployeeDescriptionForm } from "./EmployeeDescriptionForm";
import { EmployeeEvolutionArchive } from "./EmployeeEvolutionArchive";
import { EmployeeModelEditor } from "./EmployeeModelEditor";
import { EmployeeSkillReview } from "./EmployeeSkillReview";
import { KnowledgeReviewPanel } from "./KnowledgeReviewPanel";
import { RobotAvatar } from "./RobotAvatar";
import "./EmployeeProfile.css";

export type ProfileTab =
  | "overview"
  | "evolution"
  | "skills"
  | "live"
  | "memory"
  | "records"
  | "configuration";

// 「运行中」 joined 工作记录 (owner decision, step 22); "live" stays a valid link and opens it.
const tabs: Array<{ id: ProfileTab; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "evolution", label: "进化档案" },
  { id: "skills", label: "技能" },
  { id: "memory", label: "记忆" },
  { id: "records", label: "工作记录" },
  { id: "configuration", label: "配置" },
];

export function profileTabForNavigationKey(
  current: ProfileTab,
  key: string,
): ProfileTab | undefined {
  const currentIndex = tabs.findIndex((item) => item.id === current);
  if (key === "Home") return tabs[0]?.id;
  if (key === "End") return tabs.at(-1)?.id;
  if (key === "ArrowRight") return tabs[(currentIndex + 1) % tabs.length]?.id;
  if (key === "ArrowLeft") return tabs[(currentIndex - 1 + tabs.length) % tabs.length]?.id;
  return undefined;
}

export function EmployeeProfileView({
  headerAction,
  initialTab = "overview",
  profile,
  loading,
  error,
  onRetry,
  onAssign,
  onExport,
  onProfileChanged,
  onOpenBrowser,
  onManageModels,
  modelServicesVersion,
  channels = [],
  onOpenRun,
}: {
  headerAction?: ReactNode;
  initialTab?: ProfileTab;
  profile: EmployeeProfile | undefined;
  loading: boolean;
  error: string | undefined;
  onRetry(): void;
  onAssign(): void;
  onExport(): void;
  onProfileChanged(): Promise<void>;
  onOpenBrowser?: (() => void) | undefined;
  onManageModels?: (() => void) | undefined;
  modelServicesVersion?: number | undefined;
  /** Used only to name the channel of each recent run. */
  channels?: readonly Channel[];
  /** Opens 任务详情 for a run, approval, output or decision in 工作记录. */
  onOpenRun?: ((runId: string) => void) | undefined;
}) {
  const [tab, setTab] = useState<ProfileTab>(initialTab === "live" ? "records" : initialTab);
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const tabSetId = useId();

  if (loading || profile === undefined || error !== undefined) {
    return (
      <main className="workspace-main employee-profile-loading">
        <div className="loading-header-action">{headerAction}</div>
        <AppIcon size={64} className="ep-loading-icon" />
        <h1>{error ? "没能读取 Bot 档案" : "正在读取 Bot 档案"}</h1>
        <p>{error ?? "正在汇总进化、技能、记忆和工作记录…"}</p>
        {error ? (
          <button className="ob-pill is-primary" type="button" onClick={onRetry}>
            重新加载
          </button>
        ) : null}
      </main>
    );
  }

  const { employee } = profile;
  return (
    <main className="workspace-main employee-profile">
      <div className="ep-scroll">
        <header className={`ep-hero${tab === "overview" ? "" : " is-compact"}`}>
          <span className="ep-avatar">
            <RobotAvatar bot={employee} status={employee.status} presence="dot" />
          </span>
          <div className="ep-identity">
            <div className="ep-name">
              <h1>{employee.name}</h1>
              {employee.role ? <span className="ob-tag">{employee.role}</span> : null}
            </div>
            <p className={profile.details.description ? undefined : "is-empty"}>
              {profile.details.description ||
                "还没有描述。可以在右侧设置里补充这个 Bot 适合做什么。"}
            </p>
          </div>
          <div className="ep-actions" hidden={tab !== "overview"}>
            {employee.computerProfile === "docker-linux" && onOpenBrowser ? (
              <button className="ob-pill" type="button" onClick={onOpenBrowser}>
                打开浏览器
              </button>
            ) : null}
            <button className="ob-pill is-primary" type="button" onClick={onAssign}>
              分配工作
            </button>
            {headerAction}
          </div>
        </header>

        <div className="ob-seg ep-tabs" role="tablist" aria-label="档案分区">
          {tabs.map((item, index) => (
            <button
              type="button"
              role="tab"
              id={`${tabSetId}-${item.id}-tab`}
              aria-controls={`${tabSetId}-${item.id}-panel`}
              aria-selected={tab === item.id}
              tabIndex={tab === item.id ? 0 : -1}
              ref={(node) => {
                tabButtons.current[index] = node;
              }}
              onClick={() => setTab(item.id)}
              onKeyDown={(event) => {
                const nextTab = profileTabForNavigationKey(item.id, event.key);
                if (nextTab === undefined) return;
                event.preventDefault();
                setTab(nextTab);
                tabButtons.current[
                  tabs.findIndex((candidate) => candidate.id === nextTab)
                ]?.focus();
              }}
              key={item.id}
            >
              {item.label}
            </button>
          ))}
        </div>

        <section
          className="employee-tab-content"
          role="tabpanel"
          id={`${tabSetId}-${tab}-panel`}
          aria-labelledby={`${tabSetId}-${tab}-tab`}
        >
          {tab === "overview" ? (
            <Overview profile={profile} channels={channels} onShowTab={setTab} />
          ) : null}
          {tab === "evolution" ? <Evolution profile={profile} /> : null}
          {tab === "skills" ? (
            <Skills profile={profile} onProfileChanged={onProfileChanged} />
          ) : null}
          {tab === "memory" ? (
            <EmployeeMemoryPanel profile={profile} onProfileChanged={onProfileChanged} />
          ) : null}
          {tab === "records" ? (
            <Records profile={profile} channels={channels} onOpenRun={onOpenRun} />
          ) : null}
          {tab === "configuration" ? (
            <Configuration
              profile={profile}
              onExport={onExport}
              onProfileChanged={onProfileChanged}
              onManageModels={onManageModels}
              modelServicesVersion={modelServicesVersion}
            />
          ) : null}
        </section>
      </div>
    </main>
  );
}

function Overview({
  profile,
  channels,
  onShowTab,
}: {
  profile: EmployeeProfile;
  channels: readonly Channel[];
  onShowTab(tab: ProfileTab): void;
}) {
  const channelNames = new Map(
    channels.map((channel) => [channel.id, channel.directBotId ? "单独对话" : `# ${channel.name}`]),
  );
  const evolution = profile.evolution.slice(0, 3);
  const runs = profile.records.runs.slice(0, 3);
  return (
    <div className="ep-overview">
      <dl className="ep-stats">
        <EmployeeStat label="任务" value={profile.statistics.totalRuns} />
        <EmployeeStat label="已完成" value={profile.statistics.completedRuns} />
        <EmployeeStat label="失败" value={profile.statistics.failedRuns} />
        <EmployeeStat label="已验证技能" value={profile.statistics.verifiedSkills} />
      </dl>

      <div className="ep-split">
        <section className="ep-card-section" aria-labelledby="ep-evolution-heading">
          <header>
            <h2 id="ep-evolution-heading">最近进化</h2>
            <button type="button" onClick={() => onShowTab("evolution")}>
              查看全部
            </button>
          </header>
          <ul className="ep-list">
            {evolution.map((event) => (
              <li key={event.id}>
                <strong>{event.title}</strong>
                <small>
                  {event.summary ? `${event.summary} · ` : ""}
                  {formatShortDate(event.createdAt)}
                </small>
              </li>
            ))}
            {evolution.length === 0 ? (
              <li className="is-empty">真实能力变化会在这里留下可追溯的记录。</li>
            ) : null}
          </ul>
        </section>
        <section className="ep-card-section" aria-labelledby="ep-work-heading">
          <header>
            <h2 id="ep-work-heading">最近工作</h2>
            <button type="button" onClick={() => onShowTab("records")}>
              查看全部
            </button>
          </header>
          <ul className="ep-list">
            {runs.map((run) => (
              <li key={run.id} className="has-status">
                <span>
                  <strong>{run.title}</strong>
                  <small>
                    {channelNames.get(run.channelId) ?? "频道"} · {formatShortDate(run.createdAt)}
                  </small>
                </span>
                <span className={`ep-run-status ${run.status}`}>{runStatusLabel(run.status)}</span>
              </li>
            ))}
            {runs.length === 0 ? (
              <li className="is-empty">分配第一项工作后，任务会出现在这里。</li>
            ) : null}
          </ul>
        </section>
      </div>

      <section className="ep-skills" aria-labelledby="ep-skills-heading">
        <h2 id="ep-skills-heading">技能</h2>
        {profile.skills.length === 0 ? (
          <p className="ep-muted">还没有技能。学习到的技能会先以候选状态出现，审核后才会使用。</p>
        ) : (
          <ul>
            {profile.skills.map((skill) => (
              <li key={skill.id} className={`ep-skill ${skill.state}`}>
                {skill.state === "candidate" ? (
                  `候选：${skill.name} · 待审核`
                ) : (
                  <>
                    <i aria-hidden="true" />
                    {skill.name}
                    {skill.state === "verified" ? null : ` · ${skillStateLabel(skill.state)}`}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Evolution({ profile }: { profile: EmployeeProfile }) {
  return (
    <ProfileSection>
      <EmployeeEvolutionArchive events={profile.evolution} />
    </ProfileSection>
  );
}

function Skills({
  profile,
  onProfileChanged,
}: {
  profile: EmployeeProfile;
  onProfileChanged(): Promise<void>;
}) {
  return (
    <ProfileSection description="候选技能要通过确定性测试或你的审核，才会成为已验证技能。">
      <EmployeeSkillReview profile={profile} onProfileChanged={onProfileChanged} />
    </ProfileSection>
  );
}

const PAGE = 20;
/** LongLists: settings-style lists get a search box once they pass 20 entries. */
const SEARCH_AFTER = 20;

type MemoryFilter = "all" | "semantic" | "episodic" | "procedural" | "other";
const memoryFilters: Array<{ id: MemoryFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "semantic", label: "事实" },
  { id: "episodic", label: "经历" },
  { id: "procedural", label: "流程" },
  { id: "other", label: "其他" },
];

function memoryMatches(memory: EmployeeMemory, filter: MemoryFilter) {
  if (filter === "all") return true;
  if (filter === "other") return !["semantic", "episodic", "procedural"].includes(memory.kind);
  return memory.kind === filter;
}

/** Model use is refused by the Server for these; the switch mirrors that and stays off. */
function modelUseAllowed(memory: EmployeeMemory) {
  return memory.kind !== "secret-reference" && ["public", "internal"].includes(memory.sensitivity);
}

/** 记忆 (ProfileMemory artboard): 候选经验 cards, then the Bot's long-term memories. */
export function EmployeeMemoryPanel({
  profile,
  onProfileChanged,
}: {
  profile: EmployeeProfile;
  onProfileChanged(): Promise<void>;
}) {
  const [editingMemoryId, setEditingMemoryId] = useState<string | "new">();
  const [confirmingMemoryId, setConfirmingMemoryId] = useState<string>();
  const [busyMemoryId, setBusyMemoryId] = useState<string>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<MemoryFilter>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const editingMemory = profile.memories.find((memory) => memory.id === editingMemoryId);
  const counts = useMemo(
    () =>
      Object.fromEntries(
        memoryFilters.map((item) => [
          item.id,
          profile.memories.filter((memory) => memoryMatches(memory, item.id)).length,
        ]),
      ) as Record<MemoryFilter, number>,
    [profile.memories],
  );
  const needle = query.trim().toLocaleLowerCase();
  const matching = profile.memories
    .filter((memory) => memoryMatches(memory, filter))
    .filter(
      (memory) =>
        !needle ||
        memory.title.toLocaleLowerCase().includes(needle) ||
        memory.content.toLocaleLowerCase().includes(needle),
    )
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const visible = matching.slice(0, limit);

  async function remove(memory: EmployeeMemory) {
    setBusyMemoryId(memory.id);
    setError(undefined);
    try {
      await deleteEmployeeMemory(profile.employee.id, memory.id, {
        expectedRevision: memory.revision,
        ownerReviewed: true,
      });
      setConfirmingMemoryId(undefined);
      await onProfileChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法删除这条记忆。");
    } finally {
      setBusyMemoryId(undefined);
    }
  }

  async function setModelUse(memory: EmployeeMemory, enabled: boolean) {
    setBusyMemoryId(memory.id);
    setError(undefined);
    try {
      // Revision-checked, so a switch flipped on a stale copy fails instead of overwriting.
      await updateEmployeeMemory(profile.employee.id, memory.id, {
        expectedRevision: memory.revision,
        modelUseEnabled: enabled,
      });
      await onProfileChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法更改这条记忆。");
    } finally {
      setBusyMemoryId(undefined);
    }
  }

  return (
    <ProfileSection description="只有打开「模型可用」的记忆才会发给模型；机密内容只存名称，不存密钥。记忆不会进入 Bot 模板。">
      <KnowledgeReviewPanel
        key={profile.employee.id}
        botId={profile.employee.id}
        onChanged={onProfileChanged}
      />
      <section className="ep-block" aria-labelledby="ep-memory-heading">
        <div className="ep-block-head">
          <div className="ep-block-title">
            <h2 id="ep-memory-heading">记忆 · {profile.memories.length}</h2>
            <fieldset className="ep-text-filters" aria-label="记忆类型">
              {memoryFilters
                .filter((item) => item.id !== "other" || counts.other > 0)
                .map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    aria-pressed={filter === item.id}
                    onClick={() => {
                      setFilter(item.id);
                      setLimit(PAGE);
                    }}
                  >
                    {item.label} {counts[item.id]}
                  </button>
                ))}
            </fieldset>
          </div>
          <div className="ep-block-tools">
            {profile.memories.length > SEARCH_AFTER ? (
              <input
                type="search"
                className="ep-search"
                placeholder="搜索记忆"
                aria-label="搜索记忆"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLimit(PAGE);
                }}
              />
            ) : null}
            <button
              className="ob-pill is-small"
              type="button"
              onClick={() => {
                setError(undefined);
                setEditingMemoryId("new");
              }}
            >
              添加记忆
            </button>
          </div>
        </div>

        {editingMemoryId ? (
          <EmployeeMemoryEditor
            key={editingMemory?.id ?? "new"}
            employeeId={profile.employee.id}
            memory={editingMemory}
            onCancel={() => setEditingMemoryId(undefined)}
            onSaved={async () => {
              setEditingMemoryId(undefined);
              await onProfileChanged();
            }}
          />
        ) : null}

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        {profile.memories.length === 0 ? (
          <p className="ep-empty">还没有长期记忆。任务中的临时状态不会自动变成记忆。</p>
        ) : visible.length === 0 ? (
          <p className="ep-empty">没有符合条件的记忆。</p>
        ) : (
          <ul className="ep-card ep-memory-list">
            {visible.map((memory) => {
              const confirming = confirmingMemoryId === memory.id;
              const busy = busyMemoryId === memory.id;
              const allowed = modelUseAllowed(memory);
              return (
                <li key={memory.id}>
                  <div className="ep-memory-text">
                    <strong>{memory.title}</strong>
                    <span>{memory.content}</span>
                    <span className="ep-tags">
                      <span className="ob-tag">{memoryKindLabel(memory.kind)}</span>
                      <span className="ob-tag">{memorySensitivityLabel(memory.sensitivity)}</span>
                    </span>
                    <MemorySource memory={memory} />
                  </div>
                  <div className="ep-memory-side">
                    <span className="ep-model-use">
                      <span>模型可用</span>
                      <button
                        type="button"
                        role="switch"
                        className="ob-switch"
                        aria-checked={allowed && memory.modelUseEnabled === true}
                        aria-label={`允许模型使用 ${memory.title}`}
                        title={allowed ? undefined : "机密、受限和密钥引用不能发给模型"}
                        disabled={!allowed || busy}
                        onClick={() => void setModelUse(memory, memory.modelUseEnabled !== true)}
                      />
                    </span>
                    <div className="ep-row-actions">
                      {confirming ? (
                        <>
                          <span>内容将永久删除</span>
                          <button
                            className="is-danger"
                            type="button"
                            disabled={busy}
                            onClick={() => void remove(memory)}
                          >
                            {busy ? "删除中…" : "确认删除"}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setConfirmingMemoryId(undefined)}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            aria-label={`编辑 ${memory.title}`}
                            onClick={() => {
                              setError(undefined);
                              setEditingMemoryId(memory.id);
                            }}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            aria-label={`删除 ${memory.title}`}
                            onClick={() => setConfirmingMemoryId(memory.id)}
                          >
                            删除
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {matching.length > visible.length ? (
          <button type="button" className="ep-more" onClick={() => setLimit(limit + PAGE)}>
            显示更多（还有 {matching.length - visible.length} 条）
          </button>
        ) : null}

        {profile.memoryEvents.length > 0 ? (
          <details className="ep-memory-audit">
            <summary>修改记录 · {profile.memoryEvents.length}</summary>
            <ol>
              {profile.memoryEvents.slice(0, 100).map((event) => (
                <li key={event.id}>
                  <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
                  <span>
                    {memoryActionLabel(event.action)} · 修订 {event.revision}
                    {event.changedFields.length > 0
                      ? ` · ${event.changedFields.map(memoryFieldLabel).join("、")}`
                      : ""}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </section>
    </ProfileSection>
  );
}

/** Where a reviewed memory came from, with the stored identifiers for audit. */
function MemorySource({ memory }: { memory: EmployeeMemory }) {
  const { provenance } = memory;
  if (provenance.source === "reviewed-work-proposal") {
    return (
      <small className="knowledge-source">
        {typeof provenance.sourceTaskId === "string" &&
        typeof provenance.sourceWorkRunId === "string" ? (
          <>
            来源 Task：
            <a href={`#/tasks?task=${encodeURIComponent(provenance.sourceTaskId)}`}>
              {provenance.sourceTaskId}
            </a>
            {" · "}Work Run：<code>{provenance.sourceWorkRunId}</code>
          </>
        ) : (
          "原生任务来源信息不完整。"
        )}
      </small>
    );
  }
  return typeof provenance.sourceRunId === "string" ? (
    <small className="knowledge-source">来源频道 Run：{provenance.sourceRunId}</small>
  ) : null;
}

const emptyMemoryDraft: CreateEmployeeMemoryInput = {
  kind: "semantic",
  title: "",
  content: "",
  sensitivity: "internal",
  portability: "owner-selectable",
  modelUseEnabled: false,
};

function EmployeeMemoryEditor({
  employeeId,
  memory,
  onCancel,
  onSaved,
}: {
  employeeId: string;
  memory?: EmployeeMemory | undefined;
  onCancel(): void;
  onSaved(): Promise<void>;
}) {
  const [draft, setDraft] = useState<CreateEmployeeMemoryInput>(
    memory === undefined
      ? { ...emptyMemoryDraft }
      : {
          kind: memory.kind,
          title: memory.title,
          content: memory.content,
          sensitivity: memory.sensitivity,
          portability: memory.portability === "included" ? "owner-selectable" : memory.portability,
          modelUseEnabled: memory.modelUseEnabled ?? false,
        },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const formId = useId();
  const secretReference = draft.kind === "secret-reference";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      if (memory === undefined) {
        await createEmployeeMemory(employeeId, draft);
      } else {
        await updateEmployeeMemory(employeeId, memory.id, {
          ...draft,
          expectedRevision: memory.revision,
        });
      }
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法保存这条记忆。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="ep-memory-editor" onSubmit={(event) => void submit(event)}>
      <header>
        <span>
          <strong>{memory ? "编辑记忆" : "添加记忆"}</strong>
          <small>只保存需要跨任务保留的信息。不要在这里粘贴密码或私钥。</small>
        </span>
        <small>{draft.content.length}/8000</small>
      </header>
      <div className="ep-memory-fields">
        <label className="ob-field" htmlFor={`${formId}-kind`}>
          <span>类型</span>
          <select
            id={`${formId}-kind`}
            value={draft.kind}
            onChange={(event) => {
              const kind = event.target.value as CreateEmployeeMemoryInput["kind"];
              setDraft((current) => ({
                ...current,
                kind,
                ...(kind === "secret-reference"
                  ? { sensitivity: "restricted", portability: "never", modelUseEnabled: false }
                  : {}),
              }));
            }}
          >
            <option value="working">工作</option>
            <option value="episodic">经历</option>
            <option value="semantic">事实</option>
            <option value="procedural">流程</option>
            <option value="secret-reference">密钥引用</option>
          </select>
        </label>
        <label className="ob-field" htmlFor={`${formId}-sensitivity`}>
          <span>敏感级别</span>
          <select
            id={`${formId}-sensitivity`}
            value={draft.sensitivity}
            disabled={secretReference}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                sensitivity: event.target.value as CreateEmployeeMemoryInput["sensitivity"],
                modelUseEnabled:
                  ["public", "internal"].includes(event.target.value) &&
                  current.modelUseEnabled === true,
              }))
            }
          >
            <option value="public">公开</option>
            <option value="internal">内部</option>
            <option value="confidential">机密</option>
            <option value="restricted">受限</option>
          </select>
        </label>
        <label className="ob-field" htmlFor={`${formId}-portability`}>
          <span>未来迁移策略</span>
          <select
            id={`${formId}-portability`}
            value={draft.portability}
            disabled={secretReference}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                portability: event.target.value as CreateEmployeeMemoryInput["portability"],
              }))
            }
          >
            <option value="owner-selectable">以后可由你选择</option>
            <option value="never">永不迁移</option>
          </select>
        </label>
      </div>
      <label className="ob-field" htmlFor={`${formId}-title`}>
        <span>标题</span>
        <input
          id={`${formId}-title`}
          value={draft.title}
          maxLength={160}
          required
          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
        />
      </label>
      <label className="ob-field" htmlFor={`${formId}-content`}>
        <span>{secretReference ? "引用位置" : "内容"}</span>
        <textarea
          id={`${formId}-content`}
          value={draft.content}
          maxLength={8000}
          required
          placeholder={
            secretReference
              ? "例如：密码管理器中的条目名称；不要填写真实密钥"
              : "写下需要跨任务保留的事实、经验或流程"
          }
          onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
        />
      </label>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <label className="ep-checkbox">
        <input
          type="checkbox"
          checked={draft.modelUseEnabled ?? false}
          disabled={
            saving || secretReference || !["public", "internal"].includes(draft.sensitivity)
          }
          onChange={(event) =>
            setDraft((current) => ({ ...current, modelUseEnabled: event.target.checked }))
          }
        />
        <span>允许这个 Bot 之后的任务把这条记忆发给模型</span>
      </label>
      <small className="ep-note">
        机密、受限和密钥引用不能启用。关闭后停止后续读取，已发送的内容无法撤回。
      </small>
      <footer>
        <button className="ob-pill is-small" type="button" disabled={saving} onClick={onCancel}>
          取消
        </button>
        <button className="ob-pill is-small is-primary" type="submit" disabled={saving}>
          {saving ? "保存中…" : "保存记忆"}
        </button>
      </footer>
    </form>
  );
}

type RecordKind = "run" | "approval" | "artifact" | "decision";
type RecordFilter = "all" | RecordKind;
const recordFilters: Array<{ id: RecordFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "run", label: "任务" },
  { id: "approval", label: "确认" },
  { id: "artifact", label: "产出" },
  { id: "decision", label: "决策" },
];
const recordKindLabel: Record<RecordKind, string> = {
  run: "任务",
  approval: "确认",
  artifact: "产出",
  decision: "决策",
};
/** ProfileWork: past five in-progress items the rest fold into 「还有 N 个」. */
const LIVE_LIMIT = 5;

interface WorkRecord {
  id: string;
  kind: RecordKind;
  runId: string;
  title: string;
  meta: string;
  state: string;
  tone?: "ok" | "bad" | undefined;
  createdAt: string;
}

function approvalStateLabel(status: EmployeeProfile["records"]["approvals"][number]["status"]) {
  return { pending: "等你确认", approved: "已批准", rejected: "已拒绝", expired: "已过期" }[status];
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function minutesLeft(value: string) {
  const minutes = Math.ceil((Date.parse(value) - Date.now()) / 60_000);
  return minutes > 0 ? `${minutes} 分钟内有效` : "即将过期";
}

/** 工作记录 (ProfileWork artboard): 进行中 first, then every record newest first. */
function Records({
  profile,
  channels,
  onOpenRun,
}: {
  profile: EmployeeProfile;
  channels: readonly Channel[];
  onOpenRun?: ((runId: string) => void) | undefined;
}) {
  const [filter, setFilter] = useState<RecordFilter>("all");
  const [limit, setLimit] = useState(PAGE);
  const [showAllLive, setShowAllLive] = useState(false);
  const { runs, approvals, artifacts, decisions } = profile.records;
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const channelName = (channelId: string) => {
    const channel = channels.find((item) => item.id === channelId);
    return channel ? (channel.directBotId ? "单聊" : `# ${channel.name}`) : "频道";
  };
  const latestStep = (runId: string) =>
    decisions
      .filter((item) => item.runId === runId)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];

  // Waiting for the Owner comes first, soonest expiry on top (LongLists).
  const pending = approvals
    .filter((approval) => approval.status === "pending")
    .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt));
  const pendingRuns = new Set(pending.map((approval) => approval.runId));
  const working = runs.filter((run) => isActiveRun(run) && !pendingRuns.has(run.id));
  const live = [
    ...pending.map((approval) => ({
      id: approval.id,
      runId: approval.runId,
      waiting: true,
      title: `等你确认 · ${approval.summary}`,
      meta: `${channelName(approval.channelId)} · ${minutesLeft(approval.expiresAt)}`,
    })),
    ...working.map((run) => {
      const step = latestStep(run.id);
      return {
        id: run.id,
        runId: run.id,
        waiting: false,
        title: `正在工作 · ${run.title}`,
        meta: `${channelName(run.channelId)}${step ? ` · 现在：${step.message}` : ""}`,
      };
    }),
  ];
  const shownLive = showAllLive ? live : live.slice(0, LIVE_LIMIT);

  const all: WorkRecord[] = [
    ...runs.map((run): WorkRecord => {
      const done = run.status === "completed";
      const failed = run.status === "failed" || run.status === "blocked";
      return {
        id: `run:${run.id}`,
        kind: "run",
        runId: run.id,
        title: run.title,
        meta: `${channelName(run.channelId)} · ${formatShortDate(run.createdAt)}`,
        state: failed ? "没能完成" : runStatusLabel(run.status),
        tone: done ? "ok" : failed ? "bad" : undefined,
        createdAt: run.createdAt,
      };
    }),
    ...approvals.map(
      (approval): WorkRecord => ({
        id: `approval:${approval.id}`,
        kind: "approval",
        runId: approval.runId,
        title: approval.summary,
        meta: `${approval.decidedAt ? "你处理 · " : ""}${formatDateTime(approval.decidedAt ?? approval.createdAt)}`,
        state: approvalStateLabel(approval.status),
        createdAt: approval.createdAt,
      }),
    ),
    ...artifacts.map(
      (artifact): WorkRecord => ({
        id: `artifact:${artifact.id}`,
        kind: "artifact",
        runId: artifact.runId,
        title: artifact.name,
        meta: `${runsById.get(artifact.runId)?.title ?? "任务"} · ${formatBytes(artifact.sizeBytes)}`,
        state: "已保存",
        createdAt: artifact.createdAt,
      }),
    ),
    ...decisions.map(
      (decision): WorkRecord => ({
        id: `decision:${decision.id}`,
        kind: "decision",
        runId: decision.runId,
        title: decision.summary,
        meta: `阶段说明 · ${formatDateTime(decision.createdAt)}`,
        state: "可审计",
        createdAt: decision.createdAt,
      }),
    ),
  ].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const counts = Object.fromEntries(
    recordFilters.map((item) => [
      item.id,
      item.id === "all" ? all.length : all.filter((record) => record.kind === item.id).length,
    ]),
  ) as Record<RecordFilter, number>;
  const matching = filter === "all" ? all : all.filter((record) => record.kind === filter);
  const visible = matching.slice(0, limit);

  return (
    <ProfileSection description="决策只记录可审计的阶段说明，不记录模型的原始思维链。每条记录都能回到原来的对话和任务。">
      {live.length > 0 ? (
        <section className="ep-block" aria-labelledby="ep-live-heading">
          <h2 id="ep-live-heading">进行中 · {live.length}</h2>
          <ul className="ep-card ep-live-list">
            {shownLive.map((item) => (
              <li key={item.id}>
                <RecordButton runId={item.runId} onOpenRun={onOpenRun}>
                  <i className={item.waiting ? "is-waiting" : "is-working"} aria-hidden="true" />
                  <span className="ep-record-text">
                    <strong>{item.title}</strong>
                    <small>{item.meta}</small>
                  </span>
                  {onOpenRun ? <span className="ep-record-link">任务详情 ›</span> : null}
                </RecordButton>
              </li>
            ))}
          </ul>
          {live.length > shownLive.length ? (
            <button type="button" className="ep-more" onClick={() => setShowAllLive(true)}>
              还有 {live.length - shownLive.length} 个 ›
            </button>
          ) : null}
        </section>
      ) : null}
      <section className="ep-block" aria-labelledby="ep-records-heading">
        <div className="ep-block-title">
          <h2 id="ep-records-heading">工作记录</h2>
          <fieldset className="ep-text-filters" aria-label="记录类型">
            {recordFilters.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-pressed={filter === item.id}
                onClick={() => {
                  setFilter(item.id);
                  setLimit(PAGE);
                }}
              >
                {item.label} {counts[item.id]}
              </button>
            ))}
          </fieldset>
        </div>
        {all.length === 0 ? (
          <p className="ep-empty">还没有工作记录。分配第一项工作后会出现在这里。</p>
        ) : visible.length === 0 ? (
          <p className="ep-empty">没有这类记录。</p>
        ) : (
          <ul className="ep-card ep-record-list" aria-label="工作记录">
            {visible.map((record) => (
              <li key={record.id}>
                <RecordButton runId={record.runId} onOpenRun={onOpenRun}>
                  <span className="ob-tag">{recordKindLabel[record.kind]}</span>
                  <span className="ep-record-text">
                    <strong>{record.title}</strong>
                    <small>{record.meta}</small>
                  </span>
                  <span className={`ep-record-state${record.tone ? ` is-${record.tone}` : ""}`}>
                    {record.state}
                  </span>
                </RecordButton>
              </li>
            ))}
          </ul>
        )}
        {matching.length > visible.length ? (
          <button type="button" className="ep-more" onClick={() => setLimit(limit + PAGE)}>
            加载更早的记录 ›
          </button>
        ) : null}
      </section>
    </ProfileSection>
  );
}

/** A record row opens 任务详情 when the host can show it; otherwise it is plain text. */
function RecordButton({
  runId,
  onOpenRun,
  children,
}: {
  runId: string;
  onOpenRun?: ((runId: string) => void) | undefined;
  children: ReactNode;
}) {
  return onOpenRun ? (
    <button type="button" className="ep-record" onClick={() => onOpenRun(runId)}>
      {children}
    </button>
  ) : (
    <div className="ep-record">{children}</div>
  );
}

/** 配置 (ProfileConfig artboard): 介绍, then how the Bot works. */
function Configuration({
  profile,
  onExport,
  onProfileChanged,
  onManageModels,
  modelServicesVersion,
}: {
  profile: EmployeeProfile;
  onExport(): void;
  onProfileChanged(): Promise<void>;
  onManageModels?: (() => void) | undefined;
  modelServicesVersion?: number | undefined;
}) {
  const [editingModel, setEditingModel] = useState(false);
  // Only these profiles may pick a model; the Server enforces the same rule.
  const usesModel = ["model", "docker-linux"].includes(profile.employee.computerProfile);
  const model = profile.configuration.model;
  return (
    <ProfileSection description="导出的 Bot 模板不含记忆和电脑权限；对方要在自己的服务电脑上重新授权。">
      <div className="ep-config">
        <section className="ep-block" aria-labelledby="ep-intro-heading">
          <h2 id="ep-intro-heading">介绍</h2>
          <EmployeeDescriptionForm
            key={profile.employee.id}
            profile={profile}
            onProfileChanged={onProfileChanged}
          />
        </section>
        <section className="ep-block" aria-labelledby="ep-how-heading">
          <h2 id="ep-how-heading">怎么工作</h2>
          <div className="ep-card ep-config-rows">
            {usesModel ? (
              <div className="ep-config-row">
                <span className="ep-record-text">
                  <strong>模型</strong>
                  <small>新任务使用这里的选择；已排队的任务保留原模型</small>
                </span>
                <span className="ep-config-value">
                  <span>{model ? model.modelId : "默认模型"}</span>
                  <button
                    type="button"
                    className="ep-text-button"
                    aria-expanded={editingModel}
                    onClick={() => setEditingModel(!editingModel)}
                  >
                    {editingModel ? "收起" : "更改"}
                  </button>
                </span>
              </div>
            ) : null}
            {usesModel && editingModel ? (
              <div className="ep-config-editor">
                <EmployeeModelEditor
                  key={profile.employee.id}
                  profile={profile}
                  onProfileChanged={onProfileChanged}
                  onManageModels={onManageModels}
                  modelServicesVersion={modelServicesVersion}
                />
              </div>
            ) : null}
            <div className="ep-config-row">
              <span className="ep-record-text">
                <strong>电脑</strong>
                <small>创建时决定；需要不同的方式请新建一个 Bot</small>
              </span>
              <span className="ep-config-value">
                {botComputerLabels[profile.configuration.executionProfile]}
              </span>
            </div>
            <div className="ep-config-row">
              <span className="ep-record-text">
                <strong>模板格式</strong>
                <small>分享 Bot 模板时使用</small>
              </span>
              <span className="ep-config-value">
                <code>{profile.configuration.portabilityFormat}</code>
                <button type="button" className="ep-text-button" onClick={onExport}>
                  导出模板
                </button>
              </span>
            </div>
          </div>
        </section>
      </div>
    </ProfileSection>
  );
}

function EmployeeStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** One tab's content, unframed (ProfileOptionC); the boundary note sits at the end. */
function ProfileSection({
  description,
  children,
}: {
  description?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section className="ep-panel">
      {children}
      {description ? <p className="ep-note">{description}</p> : null}
    </section>
  );
}

function skillStateLabel(state: EmployeeProfile["skills"][number]["state"]) {
  return state === "candidate"
    ? "候选"
    : state === "verified"
      ? "已验证"
      : state === "suspended"
        ? "已暂停"
        : "已撤销";
}

function memoryKindLabel(kind: EmployeeProfile["memories"][number]["kind"]) {
  const labels: Record<EmployeeProfile["memories"][number]["kind"], string> = {
    working: "工作",
    episodic: "经历",
    semantic: "事实",
    procedural: "流程",
    "secret-reference": "密钥引用",
  };
  return labels[kind];
}

function memorySensitivityLabel(sensitivity: EmployeeProfile["memories"][number]["sensitivity"]) {
  return {
    public: "公开",
    internal: "内部",
    confidential: "机密",
    restricted: "受限",
  }[sensitivity];
}

function memoryActionLabel(action: EmployeeProfile["memoryEvents"][number]["action"]) {
  return action === "created" ? "已创建" : action === "updated" ? "已更新" : "已删除";
}

function memoryFieldLabel(field: EmployeeProfile["memoryEvents"][number]["changedFields"][number]) {
  return {
    kind: "类型",
    title: "标题",
    content: "内容",
    sensitivity: "敏感级别",
    portability: "迁移策略",
    modelUseEnabled: "模型使用",
  }[field];
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

/** 「今天 10:24」 for today, otherwise 「9/27」, as in the artboard. */
function formatShortDate(value: string) {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString())
    return `今天 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date)}`;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
