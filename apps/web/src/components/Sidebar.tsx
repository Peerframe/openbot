import type { Bot, Channel, Run } from "@openbot/domain";
import { useEffect, useRef, useState } from "react";
import { indexActiveRunsByBot, runStatusLabel } from "../run-state";
import { BotIcon, HashIcon, PlusIcon, SearchIcon, SettingsIcon, SkillIcon } from "./Icons";
import { RobotAvatar } from "./RobotAvatar";

interface SidebarProps {
  destination?: "chat" | "automations" | "skills" | "work";
  onWork?: (() => void) | undefined;
  onAutomations?: (() => void) | undefined;
  onSkills?: (() => void) | undefined;
  bots: Bot[];
  channels: Channel[];
  runs: Run[];
  ownerName: string;
  onHome?: (() => void) | undefined;
  onSettings?: ((section?: "general" | "about" | "automations") => void) | undefined;
  selectedChannelId?: string | undefined;
  selectedBotId?: string | undefined;
  onSelectChannel(channelId: string): void;
  onSelectBot(botId: string): void;
  onOpenBotProfile?: ((botId: string) => void) | undefined;
  onCreateBot(): void;
  onCreateChannel(): void;
  onManageNodes(): void;
  onLogout(): Promise<void>;
}

export function Sidebar({
  onWork,
  onSkills,
  bots,
  channels,
  runs,
  ownerName,
  onSettings,
  onHome,
  selectedChannelId,
  selectedBotId,
  onSelectChannel,
  onSelectBot,
  onOpenBotProfile,
  onCreateBot,
  onCreateChannel,
  onLogout,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const term = query.trim().toLocaleLowerCase();
  const activeRunByBot = indexActiveRunsByBot(runs);
  const [logoutError, setLogoutError] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      for (const menu of root.current?.querySelectorAll("details[open]") ?? []) {
        if (event.target instanceof Node && !menu.contains(event.target))
          menu.removeAttribute("open");
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  function dismiss() {
    for (const menu of root.current?.querySelectorAll("details[open]") ?? [])
      menu.removeAttribute("open");
  }
  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(false);
    try {
      await onLogout();
    } catch {
      setLogoutError(true);
      setLoggingOut(false);
    }
  }
  return (
    <aside
      className="sidebar"
      aria-label="主导航"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          const menu = (event.target as HTMLElement).closest("details");
          menu?.removeAttribute("open");
          menu?.querySelector("summary")?.focus();
        }
      }}
    >
      <div className="sidebar-brand-row">
        <a
          className="brand"
          href="/"
          aria-label="OpenBot 首页"
          onClick={
            onHome
              ? (event) => {
                  event.preventDefault();
                  onHome();
                }
              : undefined
          }
        >
          OpenBot
        </a>
        <details className="create-menu">
          <summary className="icon-button" aria-label="创建" title="创建">
            <PlusIcon />
          </summary>
          <div className="sidebar-popover create-popover">
            <button
              type="button"
              onClick={() => {
                dismiss();
                onCreateChannel();
              }}
            >
              <HashIcon />
              创建频道
            </button>
            <button
              type="button"
              onClick={() => {
                dismiss();
                onCreateBot();
              }}
            >
              <BotIcon />
              创建 Bot
            </button>
          </div>
        </details>
      </div>
      <search className="sidebar-search" aria-label="搜索工作空间">
        <SearchIcon />
        <input
          aria-label="搜索频道或 Bot"
          type="search"
          placeholder="搜索频道或 Bot"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </search>
      <div className="sidebar-body">
        <section className="sidebar-section">
          <div className="sidebar-heading">
            <h2>频道</h2>
          </div>
          <div className="sidebar-list">
            {channels
              .filter((channel) =>
                `${channel.name} ${channel.description}`.toLocaleLowerCase().includes(term),
              )
              .map((channel) => (
                <button
                  aria-current={selectedChannelId === channel.id ? "page" : undefined}
                  className={`sidebar-row channel-list-row ${selectedChannelId === channel.id ? "selected" : ""}`}
                  key={channel.id}
                  onClick={() => onSelectChannel(channel.id)}
                  type="button"
                >
                  <span className="channel-list-avatar">
                    <HashIcon />
                  </span>
                  <span className="channel-list-copy">
                    <strong>{channel.name}</strong>
                  </span>
                </button>
              ))}
            {!channels.some((channel) =>
              `${channel.name} ${channel.description}`.toLocaleLowerCase().includes(term),
            ) && <p className="sidebar-empty">{term ? "没有匹配的频道" : "点击顶部 + 创建频道"}</p>}
          </div>
        </section>
        <section className="sidebar-section">
          <div className="sidebar-heading">
            <h2>Bots</h2>
          </div>
          <div className="sidebar-list">
            {bots
              .filter((bot) => bot.name.toLocaleLowerCase().includes(term))
              .map((bot) => {
                const run = activeRunByBot.get(bot.id);
                return (
                  <button
                    className={`sidebar-row bot-row ${selectedBotId === bot.id ? "selected" : ""}`}
                    type="button"
                    key={bot.id}
                    aria-current={selectedBotId === bot.id ? "page" : undefined}
                    title={`${bot.name} · 点击对话，右键打开档案`}
                    onClick={() => onSelectBot(bot.id)}
                    onContextMenu={(event) => {
                      if (onOpenBotProfile) {
                        event.preventDefault();
                        onOpenBotProfile(bot.id);
                      }
                    }}
                    onKeyDown={(event) => {
                      if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
                        event.preventDefault();
                        onOpenBotProfile?.(bot.id);
                      }
                    }}
                  >
                    <RobotAvatar bot={bot} compact status={run?.status ?? bot.status} />
                    <span>{bot.name}</span>
                    <small className="bot-state">
                      <span
                        className={`status-dot ${run ? "active" : "idle"}`}
                        aria-hidden="true"
                      />
                      {run ? runStatusLabel(run.status) : "待命"}
                    </small>
                  </button>
                );
              })}
            {!bots.some((bot) => bot.name.toLocaleLowerCase().includes(term)) && (
              <p className="sidebar-empty">{term ? "没有匹配的 Bot" : "点击顶部 + 创建 Bot"}</p>
            )}
          </div>
        </section>
      </div>
      <footer className="sidebar-footer">
        {onWork && (
          <button className="sidebar-plugin" type="button" onClick={onWork}>
            <HashIcon />
            <span>任务监督</span>
          </button>
        )}
        {onSkills && (
          <button className="sidebar-plugin" type="button" onClick={onSkills}>
            <SkillIcon />
            <span>插件</span>
          </button>
        )}
        <details className="owner-menu">
          <summary>
            <span className="owner-avatar">{ownerName.slice(0, 1).toUpperCase()}</span>
            <span>{ownerName}</span>
            <span className="owner-chevron" aria-hidden="true">
              ⌄
            </span>
          </summary>
          <div className="sidebar-popover owner-popover">
            {onSettings && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    dismiss();
                    onSettings();
                  }}
                >
                  <SettingsIcon />
                  设置
                </button>
                <button
                  type="button"
                  onClick={() => {
                    dismiss();
                    onSettings("about");
                  }}
                >
                  <span aria-hidden="true">ⓘ</span>关于 OpenBot
                </button>
              </>
            )}
            <a href="https://github.com/yxflc11/openbot#readme" target="_blank" rel="noreferrer">
              帮助中心<span aria-hidden="true">↗</span>
            </a>
            <a
              href="https://github.com/yxflc11/openbot/issues/new"
              target="_blank"
              rel="noreferrer"
            >
              发送反馈<span aria-hidden="true">↗</span>
            </a>
            <hr />
            <button type="button" disabled={loggingOut} onClick={() => void handleLogout()}>
              {loggingOut ? "退出中…" : "退出登录"}
            </button>
            {logoutError && (
              <p className="warning" role="alert">
                退出失败，请重试
              </p>
            )}
          </div>
        </details>
      </footer>
    </aside>
  );
}
