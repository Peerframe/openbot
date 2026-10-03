import type { PortableEmployeeProfileSummary, PortableEmployeeSkillSummary } from "@openbot/domain";
import "./PortableEmployeeReview.css";

export function PortableProfileSummaryCard({
  employee,
  requestedCapabilities,
  headingId,
  note,
}: {
  employee: PortableEmployeeProfileSummary;
  requestedCapabilities: string[];
  headingId: string;
  note: string;
}) {
  return (
    <section className="portable-profile-summary" aria-labelledby={headingId}>
      <h3 id={headingId}>员工资料</h3>
      <dl>
        <div>
          <dt>职责</dt>
          <dd>{employee.role}</dd>
        </div>
        <div>
          <dt>简介</dt>
          <dd>{employee.description || "模板未提供简介。"}</dd>
        </div>
        <div>
          <dt>请求能力</dt>
          <dd>{requestedCapabilities.length > 0 ? requestedCapabilities.join("、") : "无"}</dd>
        </div>
      </dl>
      <p>{note}</p>
    </section>
  );
}

export function PortableSkillList({
  skills,
  stateLabel,
  emptyLabel,
}: {
  skills: PortableEmployeeSkillSummary[];
  stateLabel: string;
  emptyLabel: string;
}) {
  if (skills.length === 0) return <p className="import-empty">{emptyLabel}</p>;

  return (
    <ul className="portable-skill-list">
      {skills.map((skill) => (
        <li key={skill.slug}>
          <div className="portable-skill-heading">
            <div>
              <strong>{skill.name}</strong>
              <span>
                {skill.slug} · {skill.version}
              </span>
            </div>
            <small>{stateLabel}</small>
          </div>
          <p>{skill.description}</p>
          {skill.content ? (
            <details>
              <summary>查看技能正文 · {skill.content.license}</summary>
              <pre>{skill.content.markdown}</pre>
              <small>SHA-256: {skill.content.sha256}</small>
            </details>
          ) : (
            <p>仅包含技能描述，未携带指令正文；不能据此恢复执行能力。</p>
          )}
          <dl>
            <div>
              <dt>请求能力</dt>
              <dd>
                {skill.requiredCapabilities.length > 0
                  ? skill.requiredCapabilities.join("、")
                  : "无"}
              </dd>
            </div>
            <div>
              <dt>依赖技能</dt>
              <dd>{skill.dependencySlugs.length > 0 ? skill.dependencySlugs.join("、") : "无"}</dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}
