import { EmployeeSkillImport } from "./EmployeeSkillImport";
import type {
  EmployeeProfile,
  EmployeeSkill,
  UpdateEmployeeSkillStateInput,
} from "@openbot/domain";
import { type FormEvent, useState } from "react";
import { updateEmployeeSkillState } from "../api";

type SkillReviewState = UpdateEmployeeSkillStateInput["state"];

export function allowedSkillReviewStates(state: EmployeeSkill["state"]): SkillReviewState[] {
  if (state === "candidate") return ["verified", "suspended", "revoked"];
  if (state === "verified") return ["suspended", "revoked"];
  if (state === "suspended") return ["verified", "revoked"];
  return [];
}

export function EmployeeSkillReview({
  profile,
  onProfileChanged,
}: {
  profile: EmployeeProfile;
  onProfileChanged(): Promise<void>;
}) {
  const skillsById = new Map(profile.skills.map((skill) => [skill.id, skill]));
  return (
    <div className="employee-skill-review-list">
      <EmployeeSkillImport employeeId={profile.employee.id} onProfileChanged={onProfileChanged} />
      {profile.skills.length === 0 ? <p>还没有技能。导入后会先以候选状态出现。</p> : null}
      {profile.skills.map((skill) => (
        <details className={`employee-skill-review ${skill.state}`} key={skill.id}>
          <summary>
            <span className={`skill-state ${skill.state}`} aria-hidden="true" />
            <span className="employee-skill-summary-copy">
              <strong>{skill.name}</strong>
              <small>
                v{skill.version} · {skill.confidence}% · {skillStateLabel(skill.state)}
              </small>
            </span>
            <span className="employee-skill-disclosure">查看详情</span>
          </summary>

          <div className="employee-skill-review-body">
            <p>{skill.description}</p>
            <dl className="employee-skill-facts">
              <div>
                <dt>标准标识</dt>
                <dd>{skill.slug}</dd>
              </div>
              <div>
                <dt>来源</dt>
                <dd>{skillSourceLabel(skill.source)}</dd>
              </div>
              <div>
                <dt>取得时间</dt>
                <dd>{formatDateTime(skill.acquiredAt)}</dd>
              </div>
              <div>
                <dt>最后变化</dt>
                <dd>{formatDateTime(skill.updatedAt)}</dd>
              </div>
            </dl>

            <div className="employee-skill-metadata-grid">
              <SkillReferenceList
                title="需要的主机能力"
                empty="无额外能力声明"
                values={skill.requiredCapabilities}
              />
              <SkillReferenceList
                title="依赖技能"
                empty="没有技能依赖"
                values={skill.dependencyIds.map(
                  (dependencyId) => skillsById.get(dependencyId)?.name ?? dependencyId,
                )}
              />
              <SkillReferenceList
                title="证据引用"
                empty="尚无证据引用"
                values={skill.evidence.map(
                  (reference) =>
                    `${evidenceKindLabel(reference.kind)} · ${reference.label ?? reference.id}`,
                )}
              />
            </div>

            {skill.skillMarkdown ? (
              <section className="employee-skill-document">
                <h3>SKILL.md 全文</h3>
                <p>{skill.modelUseEnabled ? "已审核，Agent 可按需读取" : "未启用模型使用"}</p>
                <pre>{skill.skillMarkdown}</pre>
                <small>SHA-256: {skill.contentSha256}</small>
              </section>
            ) : (
              <p>此记录只有技能说明，尚无可供 Agent 使用的正文。</p>
            )}

            <SkillReviewForm
              key={`${skill.id}:${skill.state}:${skill.contentSha256 ?? "metadata"}`}
              employeeId={profile.employee.id}
              skill={skill}
              onProfileChanged={onProfileChanged}
            />
          </div>
        </details>
      ))}
    </div>
  );
}

function SkillReferenceList({
  title,
  empty,
  values,
}: {
  title: string;
  empty: string;
  values: string[];
}) {
  return (
    <section>
      <h3>{title}</h3>
      {values.length === 0 ? (
        <p>{empty}</p>
      ) : (
        <ul>
          {values.map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

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
  const [selectedState, setSelectedState] = useState<SkillReviewState>();
  const [confidence, setConfidence] = useState(skill.confidence > 0 ? skill.confidence : 80);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  if (actions.length === 0) {
    return <p className="employee-skill-terminal">此技能已永久撤销，不能重新启用。</p>;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      selectedState === undefined ||
      (selectedState === "verified" && skill.skillMarkdown && !contentReviewed)
    )
      return;
    setSaving(true);
    setError(undefined);
    try {
      const input: UpdateEmployeeSkillStateInput =
        selectedState === "verified"
          ? {
              state: "verified",
              ...(skill.contentSha256 ? { reviewedContentSha256: skill.contentSha256 } : {}),
              confidence,
              reason,
              evidence: [],
              ownerReviewed: true,
            }
          : {
              state: selectedState,
              reason,
              evidence: [],
              ownerReviewed: true,
            };
      await updateEmployeeSkillState(employeeId, skill.id, input);
      setSelectedState(undefined);
      setReason("");
      await onProfileChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法保存技能审核决定。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="employee-skill-lifecycle" aria-label={`${skill.name} 生命周期审核`}>
      <header>
        <h3>Owner 审核</h3>
        <p>技能状态只表示已掌握程度，不会授予电脑权限。</p>
      </header>
      <div className="employee-skill-action-row">
        {actions.map((state) => (
          <button
            className={`${state === "revoked" ? "skill-danger-button" : ""} ${
              selectedState === state ? "selected" : ""
            }`}
            type="button"
            aria-pressed={selectedState === state}
            onClick={() => {
              setError(undefined);
              setSelectedState(state);
              setContentReviewed(false);
            }}
            key={state}
          >
            {skillActionLabel(state, skill.state)}
          </button>
        ))}
      </div>

      {selectedState ? (
        <form className="employee-skill-review-form" onSubmit={(event) => void submit(event)}>
          {selectedState === "revoked" ? (
            <p className="employee-skill-revoke-warning">
              永久撤销后不能恢复。请先核对证据和依赖关系，再提交决定。
            </p>
          ) : null}
          {selectedState === "verified" ? (
            <label>
              <span>证据可信度（1–100）</span>
              <input
                type="number"
                min={1}
                max={100}
                value={confidence}
                required
                onChange={(event) => setConfidence(Number(event.target.value))}
              />
            </label>
          ) : null}
          {selectedState === "verified" && skill.skillMarkdown ? (
            <label>
              <input
                type="checkbox"
                checked={contentReviewed}
                required
                onChange={(event) => setContentReviewed(event.target.checked)}
              />
              <span>我已核对上方完整正文，允许 Agent 将此版本发送给已配置模型并使用。</span>
            </label>
          ) : null}
          <label>
            <span>审核理由</span>
            <textarea
              value={reason}
              minLength={1}
              maxLength={500}
              required
              placeholder="说明你核对了什么，以及为什么做出这个决定"
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div>
            <button
              className={selectedState === "revoked" ? "skill-danger-button" : "primary-button"}
              type="submit"
              disabled={
                saving ||
                (selectedState === "verified" && Boolean(skill.skillMarkdown) && !contentReviewed)
              }
            >
              {saving ? "提交中…" : skillSubmitLabel(selectedState)}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={saving}
              onClick={() => setSelectedState(undefined)}
            >
              取消
            </button>
          </div>
        </form>
      ) : null}
    </section>
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
  if (source === "learned") return "员工学习";
  if (source === "imported") return "员工包导入";
  return "Owner 手动登记";
}

function evidenceKindLabel(kind: EmployeeSkill["evidence"][number]["kind"]): string {
  if (kind === "run") return "任务";
  if (kind === "artifact") return "产出";
  if (kind === "approval") return "审批";
  if (kind === "import") return "导入";
  return "人工记录";
}

function skillActionLabel(state: SkillReviewState, current: EmployeeSkill["state"]): string {
  if (state === "verified") return current === "suspended" ? "恢复并验证" : "验证技能";
  if (state === "suspended") return "暂停技能";
  return "永久撤销";
}

function skillSubmitLabel(state: SkillReviewState): string {
  if (state === "verified") return "确认验证";
  if (state === "suspended") return "确认暂停";
  return "确认永久撤销";
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
