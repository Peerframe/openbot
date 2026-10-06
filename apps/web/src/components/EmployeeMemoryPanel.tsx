import type { CreateEmployeeMemoryInput, EmployeeMemory, EmployeeProfile } from "@openbot/domain";
import { type FormEvent, type ReactNode, useId, useMemo, useState } from "react";
import { createEmployeeMemory, deleteEmployeeMemory, updateEmployeeMemory } from "../api";
import { KnowledgeReviewPanel } from "./KnowledgeReviewPanel";
import "./EmployeeMemoryPanel.css";

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
