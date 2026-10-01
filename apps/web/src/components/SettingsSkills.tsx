import type { Bot, EmployeeProfile, EmployeeSkill } from "@openbot/domain";
import { useCallback, useEffect, useState } from "react";
import { getEmployeeProfile } from "../api";
import { useEmployeeProfiles } from "../use-employee-profiles";
import { EmployeeSkillImport } from "./EmployeeSkillImport";
import { EmployeeSkillReview } from "./EmployeeSkillReview";
import { SettingsHeaderAction } from "./SettingsHeaderAction";

type Filter = "all" | "verified" | "candidate" | "off";

const sourceLabels: Record<EmployeeSkill["source"], string> = {
  "built-in": "内置",
  installed: "已安装",
  learned: "在工作中学会",
  imported: "从模板导入",
  manual: "手动添加",
};
const stateLabels: Record<EmployeeSkill["state"], string> = {
  verified: "已验证",
  candidate: "待审核",
  suspended: "已暂停",
  revoked: "已撤销",
};

/**
 * Settings → 技能 (SettingsSkills artboard): every Bot's skills in one list. Review and install
 * reuse the profile flows; a skill stays descriptive and never grants computer authority.
 */
export function SettingsSkills({ bots }: { bots: Bot[] }) {
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [sub, setSub] = useState<{ kind: "review"; botId: string } | { kind: "install" }>();
  const { profiles, failedIds, loading } = useEmployeeProfiles(
    bots.map((bot) => bot.id),
    revision,
  );
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  const entries = [...profiles]
    .flatMap(([botId, profile]) => profile.skills.map((skill) => ({ botId, skill })))
    .sort((left, right) => left.skill.name.localeCompare(right.skill.name));
  const off = (skill: EmployeeSkill) => skill.state === "suspended" || skill.state === "revoked";
  const counts: Record<Filter, number> = {
    all: entries.length,
    verified: entries.filter(({ skill }) => skill.state === "verified").length,
    candidate: entries.filter(({ skill }) => skill.state === "candidate").length,
    off: entries.filter(({ skill }) => off(skill)).length,
  };
  const pending = entries.filter(({ skill }) => skill.state === "candidate");
  const installed = entries.filter(
    ({ skill }) =>
      skill.state !== "candidate" &&
      (filter === "all" ||
        (filter === "verified" && skill.state === "verified") ||
        (filter === "off" && off(skill))),
  );
  const changed = () => setRevision((value) => value + 1);

  if (sub?.kind === "review")
    return (
      <SkillReviewPage
        botId={sub.botId}
        botName={names.get(sub.botId) ?? "Bot"}
        onBack={() => setSub(undefined)}
        onChanged={changed}
      />
    );
  if (sub?.kind === "install")
    return <SkillInstallPage bots={bots} onBack={() => setSub(undefined)} onChanged={changed} />;

  return (
    <>
      <SettingsHeaderAction>
        <button
          type="button"
          className="ob-pill is-primary"
          disabled={bots.length === 0}
          onClick={() => setSub({ kind: "install" })}
        >
          安装技能
        </button>
      </SettingsHeaderAction>
      <div className="settings-filters">
        {(
          [
            ["all", "全部"],
            ["verified", "已验证"],
            ["candidate", "待审核"],
            ["off", "已停用"],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            key={id}
            className="ob-filter"
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {label} {loading ? "" : counts[id]}
          </button>
        ))}
      </div>
      {loading ? (
        <p className="settings-empty" role="status">
          正在读取技能…
        </p>
      ) : null}
      {failedIds.length > 0 ? (
        <p className="form-error" role="alert">
          {failedIds.length} 个 Bot 的技能暂时无法读取。
        </p>
      ) : null}
      {!loading && (filter === "all" || filter === "candidate") && pending.length > 0 ? (
        <section className="settings-group">
          <h3>待你审核</h3>
          <div className="settings-group-rows">
            {pending.map(({ botId, skill }) => (
              <div className="settings-item settings-skill" key={`${botId}:${skill.id}`}>
                <span className="settings-item-text">
                  <strong>{skill.name}</strong>
                  <small>
                    {names.get(botId)} · {sourceLabels[skill.source]}
                    {skill.requiredCapabilities.length > 0
                      ? ` · 需要：${skill.requiredCapabilities.join("、")}`
                      : ""}
                  </small>
                </span>
                <span className="ob-tag is-pending">待审核</span>
                <button
                  type="button"
                  className="ob-pill is-small is-primary"
                  aria-label={`审核 ${skill.name}`}
                  onClick={() => setSub({ kind: "review", botId })}
                >
                  审核
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {!loading && filter !== "candidate" ? (
        <section className="settings-group">
          <h3>已安装</h3>
          {installed.length === 0 ? (
            <p className="settings-empty">
              {entries.length === 0
                ? "还没有技能。Bot 在工作中学会的技能会先出现在「待你审核」。"
                : "没有符合条件的技能。"}
            </p>
          ) : (
            <div className="settings-group-rows">
              {installed.map(({ botId, skill }) => (
                <div className="settings-item settings-skill" key={`${botId}:${skill.id}`}>
                  <span className="settings-item-text">
                    <strong>{skill.name}</strong>
                    <small>
                      {names.get(botId)} · {sourceLabels[skill.source]} · {skill.version}
                    </small>
                  </span>
                  <span className={`ob-tag is-${skill.state}`}>{stateLabels[skill.state]}</span>
                  <span />
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}
      <p className="settings-footnote">
        技能表示 Bot 会做什么，不代表它有权操作电脑；真正动手前仍要走审批。
      </p>
    </>
  );
}

function SubPage({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack(): void;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-subpage">
      <button type="button" className="settings-subpage-back" onClick={onBack}>
        <span aria-hidden="true">‹</span> 技能
      </button>
      <h2 className="settings-subpage-title">{title}</h2>
      {children}
    </div>
  );
}

function SkillReviewPage({
  botId,
  botName,
  onBack,
  onChanged,
}: {
  botId: string;
  botName: string;
  onBack(): void;
  onChanged(): void;
}) {
  const [profile, setProfile] = useState<EmployeeProfile>();
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    try {
      setProfile(await getEmployeeProfile(botId));
      setError(false);
    } catch {
      setError(true);
    }
  }, [botId]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <SubPage title={`审核 ${botName} 的技能`} onBack={onBack}>
      {error ? (
        <p className="form-error" role="alert">
          无法读取这个 Bot 的技能，请重试。
        </p>
      ) : profile ? (
        <EmployeeSkillReview
          profile={profile}
          onProfileChanged={async () => {
            await load();
            onChanged();
          }}
        />
      ) : (
        <p className="settings-empty" role="status">
          正在读取…
        </p>
      )}
    </SubPage>
  );
}

function SkillInstallPage({
  bots,
  onBack,
  onChanged,
}: {
  bots: Bot[];
  onBack(): void;
  onChanged(): void;
}) {
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  return (
    <SubPage title="安装技能" onBack={onBack}>
      <label className="ob-field settings-bot-field">
        安装给
        <select value={botId} onChange={(event) => setBotId(event.target.value)}>
          {bots.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}
            </option>
          ))}
        </select>
      </label>
      {botId ? (
        <EmployeeSkillImport
          key={botId}
          employeeId={botId}
          onProfileChanged={async () => onChanged()}
        />
      ) : null}
    </SubPage>
  );
}
