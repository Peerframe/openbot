// Settings → 技能 for one Bot (ProfileSkills artboard): skills by state and the Owner's review of the
// selected one. Skill state never grants computer authority.
import type {
  EmployeeProfile,
  EmployeeSkill,
  UpdateEmployeeSkillStateInput,
} from "@openbot/domain";
import { type FormEvent, useState } from "react";
import { updateEmployeeSkillState } from "../api";
import { EmployeeSkillImport } from "./EmployeeSkillImport";
import "./EmployeeSkillReview.css";

type SkillReviewState = UpdateEmployeeSkillStateInput["state"];

export function allowedSkillReviewStates(state: EmployeeSkill["state"]): SkillReviewState[] {
  if (state === "candidate") return ["verified", "suspended", "revoked"];
  if (state === "verified") return ["suspended", "revoked"];
  if (state === "suspended") return ["verified", "revoked"];
  return [];
}

const groups: Array<{ state: EmployeeSkill["state"]; label: string; preview: number }> = [
  { state: "candidate", label: "候选", preview: Number.POSITIVE_INFINITY },
  { state: "verified", label: "已验证", preview: 3 },
  { state: "suspended", label: "已暂停", preview: 3 },
  { state: "revoked", label: "已撤销", preview: 3 },
];

/**
 * 技能 (ProfileSkills artboard): the Bot's skills by state on the left, the selected one's full
 * review on the right. A skill's state says what it can do, never what it may touch: computer
 * authority is granted separately on each 工作电脑.
 */
export function EmployeeSkillReview({
  profile,
  onProfileChanged,
}: {
  profile: EmployeeProfile;
  onProfileChanged(): Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<EmployeeSkill["state"][]>([]);
  const [importing, setImporting] = useState(false);
  const firstCandidate = profile.skills.find((skill) => skill.state === "candidate");
  const [selectedId, setSelectedId] = useState(firstCandidate?.id ?? profile.skills[0]?.id);
  const skillsById = new Map(profile.skills.map((skill) => [skill.id, skill]));
  const selected =
    (selectedId && skillsById.get(selectedId)) || firstCandidate || profile.skills[0];
  const term = query.trim().toLocaleLowerCase();
  const matching = profile.skills.filter(
    (skill) => !term || `${skill.name} ${skill.slug}`.toLocaleLowerCase().includes(term),
  );

  return (
    <div className="ep-skills-layout">
      <div className="ep-skill-index">
        <div className="ep-search-row">
          <input
            type="search"
            className="ep-search"
            placeholder={`搜索 ${profile.skills.length} 个技能`}
            aria-label="搜索技能"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className="ob-pill is-small"
            aria-label="导入 SKILL.md"
            aria-expanded={importing}
            onClick={() => setImporting((open) => !open)}
          >
            导入
          </button>
        </div>
        {profile.skills.length === 0 ? (
          <p className="ep-empty">还没有技能。导入或学到后会先以候选状态出现，审核后才会使用。</p>
        ) : null}
        {groups.map((group) => {
          const items = matching.filter((skill) => skill.state === group.state);
          if (items.length === 0) return null;
          const open = term !== "" || expanded.includes(group.state);
          const shown = open ? items : items.slice(0, group.preview);
          return (
            <section key={group.state} aria-label={group.label}>
              <h3 className="ep-day">
                {group.label} · {items.length}
                {group.state === "candidate" ? " 待你审核" : ""}
              </h3>
              <ul className="ep-card ep-skill-list">
                {shown.map((skill) => (
                  <li key={skill.id}>
                    <button
                      type="button"
                      aria-pressed={selected?.id === skill.id && !importing}
                      onClick={() => {
                        setSelectedId(skill.id);
                        setImporting(false);
                      }}
                    >
                      <span>
                        <strong>{skill.name}</strong>
                        <small>
                          v{skill.version} · {skillSourceLabel(skill.source)} ·{" "}
                          {formatDate(skill.updatedAt)}
                        </small>
                      </span>
                      <span className={`ep-skill-state is-${skill.state}`}>
                        {skillStateLabel(skill.state)}
                      </span>
                    </button>
                  </li>
                ))}
                {shown.length < items.length ? (
                  <li>
                    <button
                      type="button"
                      className="ep-more"
                      onClick={() => setExpanded([...expanded, group.state])}
                    >
                      显示全部 {items.length} 个 ›
                    </button>
                  </li>
                ) : null}
              </ul>
            </section>
          );
        })}
      </div>
      {importing ? (
        <EmployeeSkillImport
          employeeId={profile.employee.id}
          onClose={() => setImporting(false)}
          onProfileChanged={onProfileChanged}
        />
      ) : selected ? (
        <SkillDetail
          key={`${selected.id}:${selected.state}:${selected.contentSha256 ?? "metadata"}`}
          employeeId={profile.employee.id}
          skill={selected}
          skillsById={skillsById}
          onProfileChanged={onProfileChanged}
        />
      ) : null}
    </div>
  );
}

function SkillDetail({
  employeeId,
  skill,
  skillsById,
  onProfileChanged,
}: {
  employeeId: string;
  skill: EmployeeSkill;
  skillsById: Map<string, EmployeeSkill>;
  onProfileChanged(): Promise<void>;
}) {
  return (
    <section className="ep-skill-detail" aria-label={skill.name}>
      <header>
        <span>
          <strong>{skill.name}</strong>
          <small>
            {skillStateLabel(skill.state)} · v{skill.version} · {skillSourceLabel(skill.source)} ·{" "}
            {formatDate(skill.acquiredAt)} · {skill.evidence.length} 条证据
          </small>
        </span>
        {skill.state === "candidate" ? <span className="ep-attention-pill">待你审核</span> : null}
      </header>
      <p>{skill.description}</p>
      <div className="ep-skill-facts">
        <TagList
          title="需要的电脑能力"
          empty="不需要额外能力"
          values={skill.requiredCapabilities}
        />
        <TagList
          title="依赖技能"
          empty="没有技能依赖"
          values={skill.dependencyIds.map((id) => skillsById.get(id)?.name ?? id)}
        />
      </div>
      {skill.evidence.length > 0 ? (
        <details className="ep-skill-evidence">
          <summary>证据 · {skill.evidence.length}</summary>
          <ul>
            {skill.evidence.map((reference) => (
              <li key={`${reference.kind}:${reference.id}`}>
                {evidenceKindLabel(reference.kind)} · {reference.label ?? reference.id}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {skill.skillMarkdown ? (
        <div className="ep-skill-document">
          <h3>
            SKILL.md 全文
            <small>{skill.modelUseEnabled ? "已审核，Bot 可以按需读取" : "未启用模型使用"}</small>
          </h3>
          <pre>{skill.skillMarkdown}</pre>
          <small>
            SHA-256 {skill.contentSha256} · 标识 {skill.slug}
          </small>
        </div>
      ) : (
        <p className="ep-note">这条记录只有技能说明，还没有可供 Bot 使用的正文。</p>
      )}
      <SkillReviewForm employeeId={employeeId} skill={skill} onProfileChanged={onProfileChanged} />
    </section>
  );
}

function TagList({ title, empty, values }: { title: string; empty: string; values: string[] }) {
  return (
    <div>
      <h3>{title}</h3>
      {values.length === 0 ? (
        <small>{empty}</small>
      ) : (
        <span className="ep-tags">
          {values.map((value) => (
            <span className="ob-tag" key={value}>
              {value}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * Owner review. Every decision needs a reason; verifying a skill with a body also needs the
 * explicit confirmation that the exact text was read, and permanent revoke asks twice.
 */
function SkillReviewForm({
  employeeId,
  skill,
  onProfileChanged,
}: {
  employeeId: string;
  skill: EmployeeSkill;
  onProfileChanged(): Promise<void>;
}) {
  const actions = allowedSkillReviewStates(skill.state);
  const [contentReviewed, setContentReviewed] = useState(false);
  const [confidence, setConfidence] = useState(skill.confidence > 0 ? skill.confidence : 80);
  const [reason, setReason] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  if (actions.length === 0) {
    return <p className="ep-note">这个技能已永久撤销，不能重新启用。</p>;
  }
  const needsContentReview = Boolean(skill.skillMarkdown);

  async function decide(state: SkillReviewState, event?: FormEvent) {
    event?.preventDefault();
    if (saving || !reason.trim()) return;
    if (state === "verified" && needsContentReview && !contentReviewed) return;
    if (state === "revoked" && !confirmRevoke) {
      setConfirmRevoke(true);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const input: UpdateEmployeeSkillStateInput =
        state === "verified"
          ? {
              state: "verified",
              ...(skill.contentSha256 ? { reviewedContentSha256: skill.contentSha256 } : {}),
              confidence,
              reason,
              evidence: [],
              ownerReviewed: true,
            }
          : { state, reason, evidence: [], ownerReviewed: true };
      await updateEmployeeSkillState(employeeId, skill.id, input);
      setReason("");
      setConfirmRevoke(false);
      await onProfileChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "没能保存技能审核决定。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="ep-skill-review"
      aria-label={`${skill.name} 审核`}
      onSubmit={(event) =>
        void decide(actions.includes("verified") ? "verified" : (actions[0] ?? "suspended"), event)
      }
    >
      <label className="ob-field">
        审核理由
        <textarea
          value={reason}
          minLength={1}
          maxLength={500}
          rows={2}
          required
          placeholder="说明你核对了什么，以及为什么做出这个决定"
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      {actions.includes("verified") ? (
        <div className="ep-review-checks">
          <label className="ep-confidence">
            证据可信度
            <input
              type="number"
              min={1}
              max={100}
              value={confidence}
              onChange={(event) => setConfidence(Number(event.target.value))}
            />
          </label>
          {needsContentReview ? (
            <label className="ep-checkbox">
              <input
                type="checkbox"
                checked={contentReviewed}
                onChange={(event) => setContentReviewed(event.target.checked)}
              />
              <span>我已核对上方完整正文，允许这个 Bot 把这个版本发给已配置的模型使用。</span>
            </label>
          ) : null}
        </div>
      ) : null}
      {confirmRevoke ? (
        <p className="ep-danger-note">永久撤销后不能恢复。请核对证据和依赖，再点一次确认。</p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <footer>
        <small>技能状态只表示会做什么，不会授予电脑权限。</small>
        <span>
          {actions.includes("suspended") ? (
            <button
              type="button"
              className="ob-pill is-small"
              disabled={saving || !reason.trim()}
              onClick={() => void decide("suspended")}
            >
              暂停技能
            </button>
          ) : null}
          <button
            type="button"
            className="ob-pill is-small ep-danger-pill"
            disabled={saving || !reason.trim()}
            onClick={() => void decide("revoked")}
          >
            {confirmRevoke ? "确认永久撤销" : "永久撤销"}
          </button>
          {actions.includes("verified") ? (
            <button
              type="submit"
              className="ob-pill is-small is-primary"
              disabled={saving || !reason.trim() || (needsContentReview && !contentReviewed)}
            >
              {saving ? "正在提交…" : skill.state === "suspended" ? "恢复并验证" : "验证技能"}
            </button>
          ) : null}
        </span>
      </footer>
    </form>
  );
}

function skillStateLabel(state: EmployeeSkill["state"]): string {
  if (state === "candidate") return "候选";
  if (state === "verified") return "已验证";
  if (state === "suspended") return "已暂停";
  return "已撤销";
}

function skillSourceLabel(source: EmployeeSkill["source"]): string {
  if (source === "built-in") return "内置";
  if (source === "installed") return "已安装";
  if (source === "learned") return "Bot 学到";
  if (source === "imported") return "导入";
  return "你手动登记";
}

function evidenceKindLabel(kind: EmployeeSkill["evidence"][number]["kind"]): string {
  if (kind === "run") return "任务";
  if (kind === "artifact") return "产出";
  if (kind === "approval") return "确认";
  if (kind === "import") return "导入";
  return "人工记录";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (date.toDateString() === new Date().toDateString()) return "今天";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
