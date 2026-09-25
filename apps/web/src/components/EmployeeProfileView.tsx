import type { CreateEmployeeMemoryInput, EmployeeMemory, EmployeeProfile } from "@openbot/domain";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import {
  createEmployeeMemory,
  deleteEmployeeMemory,
  updateEmployeeMemory,
  updateEmployeeProfileDetails,
} from "../api";
import { runStatusLabel } from "../run-state";
import { EmployeeEvolutionArchive } from "./EmployeeEvolutionArchive";
import { EmployeeModelEditor } from "./EmployeeModelEditor";
import { EmployeeSkillReview } from "./EmployeeSkillReview";
import { KnowledgeReviewPanel } from "./KnowledgeReviewPanel";
import { runStatusSummary } from "./NativeRunControls";
import { OpenBotMark } from "./OpenBotMark";
import { RobotAvatar } from "./RobotAvatar";

export type ProfileTab =
  | "overview"
  | "evolution"
  | "skills"
  | "live"
  | "memory"
  | "records"
  | "configuration";

const tabs: Array<{ id: ProfileTab; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "evolution", label: "进化档案" },
  { id: "skills", label: "技能图谱" },
  { id: "live", label: "运行中" },
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
}) {
  const [tab, setTab] = useState<ProfileTab>(initialTab);
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const tabSetId = useId();

  if (loading || profile === undefined) {
    return (
      <main className="workspace-main employee-profile-loading">
        <div className="loading-header-action">{headerAction}</div>
        <OpenBotMark className="onboarding-mark" />
        <h1>{error ? "无法读取员工档案" : "正在读取员工档案"}</h1>
        <p>{error ?? "正在汇总进化、技能、记忆和工作记录…"}</p>
        {error ? (
          <button className="primary-button" type="button" onClick={onRetry}>
            重新加载
          </button>
        ) : null}
      </main>
    );
  }

  const { employee } = profile;
  return (
    <main className="workspace-main employee-profile">
      <header className="employee-profile-header">
        <RobotAvatar bot={employee} status={employee.status} className="employee-profile-avatar" />
        <div className="employee-profile-identity">
          <h1>{employee.name}</h1>
          <p>{employee.role}</p>
          <span className={`employee-status ${employee.status}`}>
            <i />
            {employeeStatusLabel(employee.status)}
          </span>
        </div>
        <div className="employee-profile-actions">
          {employee.computerProfile === "docker-linux" && onOpenBrowser ? (
            <button className="secondary-button" type="button" onClick={onOpenBrowser}>
              打开浏览器
            </button>
          ) : null}
          <button className="primary-button" type="button" onClick={onAssign}>
            分配任务
          </button>
          <button className="secondary-button" type="button" onClick={onExport}>
            导出模板
          </button>
          {headerAction}
        </div>
      </header>

      <div className="employee-tabs" role="tablist" aria-label="员工档案页面">
        {tabs.map((item, index) => (
          <button
            className={tab === item.id ? "selected" : ""}
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
              tabButtons.current[tabs.findIndex((candidate) => candidate.id === nextTab)]?.focus();
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
        {tab === "overview" ? <Overview profile={profile} /> : null}
        {tab === "evolution" ? <Evolution profile={profile} /> : null}
        {tab === "skills" ? <Skills profile={profile} onProfileChanged={onProfileChanged} /> : null}
        {tab === "live" ? <LiveWork profile={profile} /> : null}
        {tab === "memory" ? (
          <EmployeeMemoryPanel profile={profile} onProfileChanged={onProfileChanged} />
        ) : null}
        {tab === "records" ? <Records profile={profile} /> : null}
        {tab === "configuration" ? (
          <>
            <EmployeeProfileDetailsEditor profile={profile} onProfileChanged={onProfileChanged} />
            {["model", "docker-linux"].includes(profile.employee.computerProfile) ? (
              <EmployeeModelEditor
                key={profile.employee.id}
                profile={profile}
                onProfileChanged={onProfileChanged}
                onManageModels={onManageModels}
                modelServicesVersion={modelServicesVersion}
              />
            ) : null}
          </>
        ) : null}
      </section>
    </main>
  );
}

function Overview({ profile }: { profile: EmployeeProfile }) {
  return (
    <div className="employee-profile-body">
      <section className="employee-about">
        <h2>关于</h2>
        <p>
          {profile.details.description ||
            `${profile.employee.name} 的职责是${profile.employee.role}。员工身份、技能和工作记录保存在 OpenBot Server；执行电脑可以更换，不会改变员工本身。`}
        </p>
      </section>

      <dl className="employee-stat-row">
        <EmployeeStat label="任务" value={profile.statistics.totalRuns} />
        <EmployeeStat label="已完成" value={profile.statistics.completedRuns} />
        <EmployeeStat label="失败" value={profile.statistics.failedRuns} />
        <EmployeeStat label="已验证技能" value={profile.statistics.verifiedSkills} />
      </dl>

      <div className="employee-overview-split">
        <section>
          <SectionHeading title="最近进化" description="每一次变化都有来源和证据。" />
          <EvolutionTimeline events={profile.evolution.slice(0, 4)} />
        </section>
        <section>
          <SectionHeading title="技能图谱" description="技能不会自动获得电脑权限。" />
          <SkillGraph profile={profile} />
        </section>
      </div>

      <section className="employee-recent-work">
        <SectionHeading title="最近工作" description="来自 Server 的可审计任务记录。" />
        <RunTable runs={profile.records.runs.slice(0, 5)} />
      </section>
    </div>
  );
}

function Evolution({ profile }: { profile: EmployeeProfile }) {
  return (
    <ProfileSection
      title="进化档案"
      description="按真实时间查看职责、配置和能力变化；原始思维链、等级和外观都不属于权限。"
    >
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
    <ProfileSection
      title="技能图谱"
      description="候选技能必须通过确定性测试或人工审核，才能成为已验证技能。"
    >
      <EmployeeSkillReview profile={profile} onProfileChanged={onProfileChanged} />
    </ProfileSection>
  );
}

function LiveWork({ profile }: { profile: EmployeeProfile }) {
  const activeRuns = profile.records.runs.filter((run) =>
    ["queued", "assigned", "running", "waiting_approval", "blocked"].includes(run.status),
  );
  return (
    <ProfileSection title="运行中" description="展示结构化阶段和决策摘要，不展示模型的原始思维链。">
      {activeRuns.length === 0 && profile.records.decisions.length === 0 ? (
        <EmployeeEmpty
          title="当前没有运行中的任务"
          copy="给这名员工分配工作后，进度会出现在这里。"
        />
      ) : (
        <div className="employee-live-grid">
          <RunTable runs={activeRuns} />
          <DecisionTimeline decisions={profile.records.decisions} />
        </div>
      )}
    </ProfileSection>
  );
}

export function EmployeeMemoryPanel({
  profile,
  onProfileChanged,
}: {
  profile: EmployeeProfile;
  onProfileChanged(): Promise<void>;
}) {
  const [editingMemoryId, setEditingMemoryId] = useState<string | "new">();
  const [confirmingMemoryId, setConfirmingMemoryId] = useState<string>();
  const [deletingMemoryId, setDeletingMemoryId] = useState<string>();
  const [error, setError] = useState<string>();
  const editingMemory = profile.memories.find((memory) => memory.id === editingMemoryId);

  async function remove(memory: EmployeeMemory) {
    setDeletingMemoryId(memory.id);
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
      setDeletingMemoryId(undefined);
    }
  }

  return (
    <ProfileSection
      title="记忆"
      description="只有明确允许的记忆才会用于模型任务；候选经验须经你审阅。记忆不会进入当前员工模板。"
    >
      <KnowledgeReviewPanel
        key={profile.employee.id}
        botId={profile.employee.id}
        onChanged={onProfileChanged}
      />
      <div className="employee-memory-toolbar">
        <p>
          共 {profile.memories.length} 条 · 生命周期记录 {profile.memoryEvents.length} 条
        </p>
        <button
          className="secondary-button"
          type="button"
          onClick={() => {
            setError(undefined);
            setEditingMemoryId("new");
          }}
        >
          添加记忆
        </button>
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
        <EmployeeEmpty title="还没有长期记忆" copy="运行中的临时状态不会自动进入员工模板。" />
      ) : (
        <div className="employee-record-list employee-memory-list">
          {profile.memories.map((memory) => {
            const confirming = confirmingMemoryId === memory.id;
            const deleting = deletingMemoryId === memory.id;
            return (
              <article key={memory.id}>
                <div>
                  <strong>{memory.title}</strong>
                  <p>{memory.content}</p>
                  <small>
                    {memoryKindLabel(memory.kind)} · {memorySensitivityLabel(memory.sensitivity)} ·{" "}
                    {memoryPortabilityLabel(memory.portability)} · 修订 {memory.revision} ·{" "}
                    {memory.modelUseEnabled ? "允许模型使用" : "仅供你查看"}
                  </small>
                  {memory.provenance.source === "reviewed-work-proposal" ? (
                    <small className="knowledge-source">
                      {typeof memory.provenance.sourceTaskId === "string" &&
                      typeof memory.provenance.sourceWorkRunId === "string" ? (
                        <>
                          来源 Task：
                          <a
                            href={`#/tasks?task=${encodeURIComponent(memory.provenance.sourceTaskId)}`}
                          >
                            {memory.provenance.sourceTaskId}
                          </a>
                          {" · "}Work Run：<code>{memory.provenance.sourceWorkRunId}</code>
                        </>
                      ) : (
                        "原生任务来源信息不完整。"
                      )}
                    </small>
                  ) : typeof memory.provenance.sourceRunId === "string" ? (
                    <small className="knowledge-source">
                      来源频道 Run：{memory.provenance.sourceRunId}
                    </small>
                  ) : null}
                </div>
                <div className="employee-memory-actions">
                  {confirming ? (
                    <>
                      <span>内容将永久删除</span>
                      <button
                        className="memory-danger-button"
                        type="button"
                        disabled={deleting}
                        onClick={() => void remove(memory)}
                      >
                        {deleting ? "删除中…" : "确认删除"}
                      </button>
                      <button
                        type="button"
                        disabled={deleting}
                        onClick={() => setConfirmingMemoryId(undefined)}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setError(undefined);
                          setEditingMemoryId(memory.id);
                        }}
                      >
                        编辑
                      </button>
                      <button type="button" onClick={() => setConfirmingMemoryId(memory.id)}>
                        删除
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {profile.memoryEvents.length > 0 ? (
        <details className="employee-memory-audit">
          <summary>查看生命周期记录</summary>
          <ol>
            {profile.memoryEvents.map((event) => (
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
    </ProfileSection>
  );
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
    <form className="form-grid employee-memory-editor" onSubmit={(event) => void submit(event)}>
      <header>
        <div>
          <h3>{memory ? "编辑记忆" : "添加记忆"}</h3>
          <p>只保存需要跨任务保留的信息。不要在这里粘贴密码或私钥。</p>
        </div>
        <span>{draft.content.length}/8000</span>
      </header>
      <div className="employee-memory-fields">
        <label htmlFor={`${formId}-kind`}>
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
            <option value="semantic">知识</option>
            <option value="procedural">流程</option>
            <option value="secret-reference">密钥引用</option>
          </select>
        </label>
        <label htmlFor={`${formId}-sensitivity`}>
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
        <label htmlFor={`${formId}-portability`}>
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
      <label htmlFor={`${formId}-title`}>
        <span>标题</span>
        <input
          id={`${formId}-title`}
          value={draft.title}
          maxLength={160}
          required
          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
        />
      </label>
      <label htmlFor={`${formId}-content`}>
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
      <label className="memory-model-use">
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
        <span>允许此员工后续任务将这条记忆发送给配置的模型</span>
      </label>
      <small>机密、受限和密钥引用不能启用。关闭后停止后续读取，已发送的内容无法撤回。</small>
      <footer className="employee-memory-editor-actions">
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? "保存中…" : "保存记忆"}
        </button>
        <button className="secondary-button" type="button" disabled={saving} onClick={onCancel}>
          取消
        </button>
      </footer>
    </form>
  );
}

function Records({ profile }: { profile: EmployeeProfile }) {
  return (
    <ProfileSection
      title="工作记录"
      description="任务、审批、产物与结构化进度都保留对原始记录的引用。"
    >
      <RunTable runs={profile.records.runs} />
      <div className="employee-record-counts">
        <span>审批 {profile.records.approvals.length}</span>
        <span>产物 {profile.records.artifacts.length}</span>
        <span>决策摘要 {profile.records.decisions.length}</span>
      </div>
    </ProfileSection>
  );
}

export function EmployeeProfileDetailsEditor({
  profile,
  onProfileChanged,
}: {
  profile: EmployeeProfile;
  onProfileChanged(): Promise<void>;
}) {
  const initialDetails = {
    role: profile.employee.role,
    description: profile.details.description,
    revision: profile.details.revision,
  };
  const [baseline, setBaseline] = useState(initialDetails);
  const [role, setRole] = useState(initialDetails.role);
  const [description, setDescription] = useState(initialDetails.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const formId = useId();
  const changed = role.trim() !== baseline.role || description.trim() !== baseline.description;
  const serverChanged = profile.details.revision !== baseline.revision;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const result = await updateEmployeeProfileDetails(profile.employee.id, {
        role,
        description,
        expectedRevision: baseline.revision,
      });
      const nextBaseline = {
        role: result.employee.role,
        description: result.details.description,
        revision: result.details.revision,
      };
      setBaseline(nextBaseline);
      setRole(nextBaseline.role);
      setDescription(nextBaseline.description);
      await onProfileChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法保存员工主页。请重新加载后再试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ProfileSection
      title="配置"
      description="编辑员工的说明性主页；电脑权限与执行配置仍由 Server 单独管理。"
    >
      <form className="employee-profile-details-form" onSubmit={(event) => void submit(event)}>
        <header>
          <div>
            <h3>个人主页</h3>
            <p>职责和简介可帮助人类与总管正确分派工作，但不会授予技能或电脑权限。</p>
          </div>
          <span>修订 {baseline.revision}</span>
        </header>
        <label htmlFor={`${formId}-role`}>
          <span>职责</span>
          <input
            id={`${formId}-role`}
            value={role}
            maxLength={160}
            required
            onChange={(event) => setRole(event.target.value)}
          />
          <small>{role.length}/160</small>
        </label>
        <label htmlFor={`${formId}-description`}>
          <span>简介</span>
          <textarea
            id={`${formId}-description`}
            value={description}
            maxLength={2000}
            placeholder="描述适合交给这名员工的工作，以及应当遵守的协作边界。"
            onChange={(event) => setDescription(event.target.value)}
          />
          <small>{description.length}/2000</small>
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {serverChanged ? (
          <div className="employee-profile-stale" role="status">
            <p>这名员工已在另一台设备更新。请加载 Server 最新值后再继续。</p>
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                const latest = {
                  role: profile.employee.role,
                  description: profile.details.description,
                  revision: profile.details.revision,
                };
                setBaseline(latest);
                setRole(latest.role);
                setDescription(latest.description);
                setError(undefined);
              }}
            >
              加载最新值
            </button>
          </div>
        ) : null}
        <footer className="employee-profile-details-actions">
          <button
            className="primary-button"
            type="submit"
            disabled={saving || !changed || serverChanged}
          >
            {saving ? "保存中…" : "保存主页"}
          </button>
        </footer>
      </form>

      <dl className="employee-config-list">
        <div>
          <dt>固定执行配置</dt>
          <dd>{profile.configuration.executionProfile}</dd>
        </div>
        <div>
          <dt>可移植格式</dt>
          <dd>{profile.configuration.portabilityFormat}</dd>
        </div>
        <div>
          <dt>电脑权限</dt>
          <dd>不随员工模板导出，接收者必须在自己的 Server 重新授权</dd>
        </div>
      </dl>
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

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <header className="employee-section-heading">
      <h2>{title}</h2>
      <p>{description}</p>
    </header>
  );
}

function ProfileSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="employee-profile-body employee-tab-panel">
      <SectionHeading title={title} description={description} />
      {children}
    </section>
  );
}

function EvolutionTimeline({ events }: { events: EmployeeProfile["evolution"] }) {
  if (events.length === 0) {
    return <EmployeeEmpty title="暂无进化记录" copy="真实能力变化会形成可追溯事件。" />;
  }
  return (
    <ol className="employee-evolution-timeline">
      {events.map((event) => (
        <li key={event.id}>
          <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
          <span aria-hidden="true" />
          <div>
            <strong>{event.title}</strong>
            <p>{event.summary}</p>
            <small>
              来源：{event.source}
              {event.evidence.length > 0 ? ` · ${event.evidence.length} 条证据` : ""}
            </small>
          </div>
        </li>
      ))}
    </ol>
  );
}

function SkillGraph({ profile }: { profile: EmployeeProfile }) {
  if (profile.skills.length === 0) {
    return <EmployeeEmpty title="还没有技能" copy="学习到的技能会先以候选状态出现。" />;
  }
  const skills = profile.skills.slice(0, 6);
  return (
    <div className="employee-skill-graph">
      <RobotAvatar bot={profile.employee} compact className="employee-skill-avatar" />
      <div>
        {skills.map((skill) => (
          <article key={skill.id}>
            <span className={`skill-state ${skill.state}`} aria-hidden="true" />
            <strong>{skill.name}</strong>
            <small>
              v{skill.version} · {skill.confidence}% · {skillStateLabel(skill.state)}
            </small>
          </article>
        ))}
      </div>
    </div>
  );
}

function DecisionTimeline({ decisions }: { decisions: EmployeeProfile["records"]["decisions"] }) {
  if (decisions.length === 0) return null;
  return (
    <section>
      <SectionHeading title="决策摘要" description="可审计的阶段说明，而非原始思维链。" />
      <ol className="employee-decision-list">
        {decisions.map((decision) => (
          <li key={decision.id}>
            <span>{decision.stage}</span>
            <p>{decision.summary}</p>
            <time dateTime={decision.createdAt}>{formatDateTime(decision.createdAt)}</time>
          </li>
        ))}
      </ol>
    </section>
  );
}

function RunTable({ runs }: { runs: EmployeeProfile["records"]["runs"] }) {
  if (runs.length === 0) {
    return <EmployeeEmpty title="还没有工作记录" copy="完成第一项任务后会出现在这里。" />;
  }
  return (
    <div className="employee-run-table">
      <table aria-label="员工工作记录">
        <thead>
          <tr className="employee-run-table-header">
            <th scope="col">时间</th>
            <th scope="col">任务</th>
            <th scope="col">状态</th>
            <th scope="col">结果</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>
                <time dateTime={run.createdAt}>{formatDateTime(run.createdAt)}</time>
              </td>
              <td>
                <strong>{run.title}</strong>
              </td>
              <td>
                <span className={`employee-run-state ${run.status}`}>
                  <i />
                  {runStatusLabel(run.status)}
                </span>
              </td>
              <td>
                <small>{runStatusSummary(run) ?? "—"}</small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmployeeEmpty({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="employee-empty">
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  );
}

function employeeStatusLabel(status: EmployeeProfile["employee"]["status"]) {
  const labels: Record<EmployeeProfile["employee"]["status"], string> = {
    idle: "待命",
    running: "工作中",
    waiting_approval: "等待审批",
    blocked: "已阻塞",
    human_takeover: "人工接管",
    offline: "离线",
    completed: "已完成",
    failed: "失败",
  };
  return labels[status];
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
    working: "工作记忆",
    episodic: "情景记忆",
    semantic: "语义记忆",
    procedural: "流程记忆",
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

function memoryPortabilityLabel(portability: EmployeeProfile["memories"][number]["portability"]) {
  return portability === "never"
    ? "永不迁移"
    : portability === "owner-selectable"
      ? "以后可由你选择"
      : "已选择迁移";
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

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
