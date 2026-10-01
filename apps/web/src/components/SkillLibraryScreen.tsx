import type { Bot, Channel, EmployeeSkill, EmployeeSkillState } from "@openbot/domain";
import { type ReactNode, useState } from "react";
import { useEmployeeProfiles } from "../use-employee-profiles";
import { EmployeeSkillImport } from "./EmployeeSkillImport";
import { BotIcon, CloseIcon, PlusIcon, SearchIcon } from "./Icons";
import "./destinations.css";
import { PluginManagerPanel } from "./PluginManagerPanel";

interface SkillEntry {
  botId: string;
  skill: EmployeeSkill;
}

const states: { value: EmployeeSkillState | "all"; label: string }[] = [
  { value: "all", label: "全部技能" },
  { value: "verified", label: "已验证" },
  { value: "candidate", label: "待审核" },
  { value: "suspended", label: "已暂停" },
  { value: "revoked", label: "已撤销" },
];
const botStatusLabels: Record<Bot["status"], string> = {
  idle: "待命",
  running: "运行中",
  waiting_approval: "等待批准",
  blocked: "受阻",
  human_takeover: "人工接管",
  offline: "离线",
  completed: "已完成",
  failed: "失败",
};
const sourceLabels: Record<EmployeeSkill["source"], string> = {
  "built-in": "内置",
  installed: "已安装",
  learned: "学习获得",
  imported: "导入",
  manual: "手动添加",
};

export function SkillLibraryScreen({
  bots,
  onOpenBot,
  headerAction,
  onBack,
  onCreateBot,
  onImportBot,
  channels = [],
  onInsertMaterial,
}: {
  bots: Bot[];
  channels?: Channel[];
  onInsertMaterial?(channelId: string, botId: string, text: string): void;
  onOpenBot(botId: string): void;
  headerAction?: ReactNode;
  onBack?(): void;
  onCreateBot?(): void;
  onImportBot?(): void;
}) {
  const [contentChannelId, setContentChannelId] = useState(channels[0]?.id ?? "");
  const [contentBotId, setContentBotId] = useState("");
  const contentChannel = channels.find((channel) => channel.id === contentChannelId);
  const scopeBotId = contentChannel?.botIds.includes(contentBotId)
    ? contentBotId
    : contentChannel?.botIds[0];
  const [tab, setTab] = useState<"skills" | "bots">("skills");
  const [adding, setAdding] = useState(false);
  const [importBotId, setImportBotId] = useState(bots[0]?.id ?? "");
  const [importedBotId, setImportedBotId] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<EmployeeSkillState | "all">("all");
  const { profiles, failedIds, loading } = useEmployeeProfiles(
    bots.map((bot) => bot.id),
    revision,
  );
  const entries: SkillEntry[] = [...profiles]
    .flatMap(([botId, profile]) => profile.skills.map((skill) => ({ botId, skill })))
    .sort((left, right) => left.skill.name.localeCompare(right.skill.name));

  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  const term = query.trim().toLocaleLowerCase();
  const filtered = entries.filter(
    ({ skill, botId }) =>
      (state === "all" || skill.state === state) &&
      `${skill.name} ${skill.slug} ${skill.description} ${names.get(botId) ?? ""}`
        .toLocaleLowerCase()
        .includes(term),
  );

  const filteredBots = bots.filter((bot) =>
    `${bot.name} ${bot.role}`.toLocaleLowerCase().includes(term),
  );
  const importTarget = bots.find((bot) => bot.id === importBotId) ?? bots[0];

  return (
    <main className="workspace-destination plugin-refresh" aria-labelledby="skill-library-title">
      <header className="destination-header">
        <div className="plugin-header-leading">
          {onBack && (
            <button type="button" className="settings-back" onClick={onBack}>
              <span aria-hidden="true">←</span> 返回应用
            </button>
          )}
          <h1 id="skill-library-title">插件</h1>
        </div>
        <div className="destination-header-actions">{headerAction}</div>
      </header>
      <div className="destination-scroll">
        <section className="destination-intro plugin-intro">
          <div>
            <h2>为你的 Bot 添加能力</h2>
            <p>管理技能与 Bot，按你的工作方式扩展 OpenBot。</p>
          </div>
          <div className="plugin-add-actions">
            {tab === "skills" ? (
              <button
                type="button"
                className="destination-primary"
                onClick={() => {
                  setAdding(true);
                  setImportedBotId(undefined);
                }}
              >
                <PlusIcon /> 添加技能
              </button>
            ) : (
              <>
                {onImportBot && (
                  <button type="button" className="destination-secondary" onClick={onImportBot}>
                    导入 Bot
                  </button>
                )}
                {onCreateBot && (
                  <button type="button" className="destination-primary" onClick={onCreateBot}>
                    <PlusIcon /> 创建 Bot
                  </button>
                )}
              </>
            )}
          </div>
        </section>
        {channels.length > 0 && (
          <div className="plugin-content-scope">
            <label>
              使用插件的频道{" "}
              <select
                value={contentChannelId}
                onChange={(event) => setContentChannelId(event.target.value)}
              >
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Bot{" "}
              <select
                value={scopeBotId ?? ""}
                onChange={(event) => setContentBotId(event.target.value)}
              >
                {bots
                  .filter((bot) => contentChannel?.botIds.includes(bot.id))
                  .map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        )}
        <PluginManagerPanel
          bots={bots}
          scope={
            scopeBotId && contentChannel
              ? { channelId: contentChannel.id, botId: scopeBotId }
              : undefined
          }
          onInsertMaterial={
            scopeBotId && contentChannel && onInsertMaterial
              ? (text) => onInsertMaterial(contentChannel.id, scopeBotId, text)
              : undefined
          }
        />
        <div
          className="plugin-tabs"
          role="tablist"
          aria-label="插件类型"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? "skills"
                : event.key === "End"
                  ? "bots"
                  : tab === "skills"
                    ? "bots"
                    : "skills";
            setTab(next);
            event.currentTarget.querySelector<HTMLButtonElement>(`#plugin-tab-${next}`)?.focus();
          }}
        >
          {(["skills", "bots"] as const).map((item) => (
            <button
              type="button"
              role="tab"
              key={item}
              id={`plugin-tab-${item}`}
              aria-selected={tab === item}
              aria-controls="plugin-panel"
              tabIndex={tab === item ? 0 : -1}
              onClick={() => setTab(item)}
            >
              {item === "skills" ? "技能" : "Bots"}
            </button>
          ))}
        </div>
        <section id="plugin-panel" role="tabpanel" aria-labelledby={`plugin-tab-${tab}`}>
          {adding && tab === "skills" && (
            <section className="plugin-import-panel" aria-labelledby="plugin-import-heading">
              <div className="plugin-import-heading">
                <div>
                  <h3 id="plugin-import-heading">添加技能</h3>
                  <p>选择 Bot，导入技能全文，再到 Bot 档案审核来源与权限。</p>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="关闭添加技能"
                  onClick={() => setAdding(false)}
                >
                  <CloseIcon />
                </button>
              </div>
              {importTarget ? (
                <>
                  <label className="plugin-target">
                    添加到 Bot
                    <select
                      aria-label="技能所属 Bot"
                      value={importTarget.id}
                      onChange={(event) => {
                        setImportBotId(event.target.value);
                        setImportedBotId(undefined);
                      }}
                    >
                      {bots.map((bot) => (
                        <option key={bot.id} value={bot.id}>
                          {bot.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <EmployeeSkillImport
                    key={importTarget.id}
                    employeeId={importTarget.id}
                    onProfileChanged={async () => {
                      setRevision((value) => value + 1);
                      setImportedBotId(importTarget.id);
                    }}
                  />
                  {importedBotId && (
                    <button
                      type="button"
                      className="destination-secondary"
                      onClick={() => onOpenBot(importedBotId)}
                    >
                      前往 Bot 档案审核
                    </button>
                  )}
                </>
              ) : (
                <div className="plugin-import-empty">
                  <p>先创建或导入一个 Bot，再为它添加技能。</p>
                  {onCreateBot && (
                    <button type="button" className="destination-primary" onClick={onCreateBot}>
                      创建 Bot
                    </button>
                  )}
                  {onImportBot && (
                    <button type="button" className="destination-secondary" onClick={onImportBot}>
                      导入 Bot
                    </button>
                  )}
                </div>
              )}
            </section>
          )}
          <div className="destination-toolbar">
            <search className="destination-search" aria-label="搜索插件内容">
              <SearchIcon />
              <input
                type="search"
                aria-label="搜索技能或 Bot"
                placeholder="搜索技能或 Bot"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </search>
            <button
              type="button"
              className="destination-secondary"
              disabled={loading}
              onClick={() => setRevision((value) => value + 1)}
            >
              刷新
            </button>
          </div>
          {tab === "skills" && (
            <fieldset className="destination-filters" aria-label="技能状态">
              {states.map((item) => (
                <button
                  type="button"
                  key={item.value}
                  aria-pressed={state === item.value}
                  onClick={() => setState(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </fieldset>
          )}
          {tab === "skills" && failedIds.length > 0 ? (
            <div className="destination-notice" role="alert">
              未能读取 {failedIds.map((id) => names.get(id) ?? "Bot").join("、")}{" "}
              的技能，请刷新重试。
            </div>
          ) : null}
          {tab === "bots" ? (
            filteredBots.length === 0 ? (
              <div className="destination-empty">
                <h3>{term ? "没有匹配的 Bot" : "从你的第一个 Bot 开始"}</h3>
                <p>
                  {term
                    ? "试试其他名称或角色。"
                    : "创建一个 Bot 或导入已有 Bot 包，然后在档案中配置模型与技能。"}
                </p>
              </div>
            ) : (
              <div className="destination-skill-list plugin-bot-list">
                {filteredBots.map((bot) => (
                  <article className="destination-skill" key={bot.id}>
                    <div className="destination-skill-top">
                      <span className="destination-skill-monogram">
                        <BotIcon />
                      </span>
                      <div className="destination-skill-heading">
                        <h3>{bot.name}</h3>
                        <span>{bot.role}</span>
                      </div>
                    </div>
                    <p>
                      {bot.computerProfile === "none"
                        ? "使用模型与已审核技能完成任务。"
                        : "可连接工作电脑执行任务。"}
                    </p>
                    <div className="destination-skill-footer">
                      <span>{botStatusLabels[bot.status]}</span>
                      <button
                        className="destination-text-button"
                        type="button"
                        onClick={() => onOpenBot(bot.id)}
                      >
                        打开 Bot 档案 <span aria-hidden="true">↗</span>
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )
          ) : loading ? (
            <p className="destination-empty" role="status">
              正在读取技能…
            </p>
          ) : filtered.length === 0 ? (
            <div className="destination-empty">
              <h3>
                {query || state !== "all"
                  ? "没有匹配的技能"
                  : failedIds.length > 0
                    ? "技能暂时无法读取"
                    : "技能会在这里汇集"}
              </h3>
              <p>
                {query || state !== "all"
                  ? "试试其他关键词或状态。"
                  : "Bot 档案中的技能和审核状态会同步显示在这里。"}
              </p>
            </div>
          ) : (
            <>
              <p className="destination-result-count" role="status">
                {filtered.length} 项技能记录
              </p>
              <div className="destination-skill-list">
                {filtered.map(({ skill, botId }) => (
                  <article className="destination-skill" key={`${botId}:${skill.id}`}>
                    <div className="destination-skill-top">
                      <span className="destination-skill-monogram" aria-hidden="true">
                        {skill.name.slice(0, 1)}
                      </span>
                      <div className="destination-skill-heading">
                        <h3>{skill.name}</h3>
                        <span>
                          {skill.slug} · v{skill.version}
                        </span>
                      </div>
                      <span className={`destination-state ${skill.state}`}>
                        {states.find((item) => item.value === skill.state)?.label}
                      </span>
                    </div>
                    <p>{skill.description}</p>
                    <div className="destination-skill-meta">
                      <span>{sourceLabels[skill.source]}</span>
                      <span>
                        {skill.requiredCapabilities.length > 0
                          ? `需要 ${skill.requiredCapabilities.join("、")}`
                          : "无额外能力要求"}
                      </span>
                    </div>
                    <div className="destination-skill-footer">
                      <span>{names.get(botId) ?? "Bot"}</span>
                      <button
                        className="destination-text-button"
                        type="button"
                        onClick={() => onOpenBot(botId)}
                      >
                        查看与审核 <span aria-hidden="true">↗</span>
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
          <p className="destination-footnote">
            这里展示当前工作空间的技能与 Bot。外部技能商店尚未接入；导入内容需要审核后才能使用。
          </p>
        </section>
      </div>
    </main>
  );
}
