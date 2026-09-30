import type { Bot, Channel, Run } from "@openbot/domain";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { indexActiveRunsByBot, runStatusLabel } from "../run-state";
import {
  arrangeSidebar,
  type SidebarEntry,
  type SidebarGroup,
  type SidebarItemKey,
  sidebarOrganization,
  useSidebarOrganization,
} from "../sidebar-organization";
import { BotIcon, HashIcon, PlusIcon, SearchIcon, SettingsIcon, SkillIcon } from "./Icons";
import { RobotAvatar } from "./RobotAvatar";
import { SidebarItemMenu, type SidebarMenuTarget } from "./SidebarItemMenu";

type SidebarItem = { kind: "channel"; channel: Channel } | { kind: "bot"; bot: Bot };

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
  onManageModels?: (() => void) | undefined;
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
  onManageModels,
  onLogout,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const term = query.trim().toLocaleLowerCase();
  const { values: organization } = useSidebarOrganization();
  const [menuTarget, setMenuTarget] = useState<SidebarMenuTarget>();
  const closeMenu = useCallback(() => {
    const opener = menuOpener.current;
    setMenuTarget(undefined);
    // Return focus to the row or heading that opened the menu, as native menus do.
    requestAnimationFrame(() => opener?.focus());
  }, []);
  const menuOpener = useRef<HTMLElement | null>(null);
  const botById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
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
  const entries: SidebarEntry<SidebarItem>[] = [
    ...channels.map((channel) => ({
      key: `channel:${channel.id}` as const,
      item: { kind: "channel" as const, channel },
      name: channel.name,
      searchText: `${channel.name} ${channel.description}`,
    })),
    ...bots.map((bot) => ({
      key: `bot:${bot.id}` as const,
      item: { kind: "bot" as const, bot },
      name: bot.name,
      searchText: `${bot.name} ${bot.role}`,
    })),
  ];
  const sections = arrangeSidebar(entries, organization, query);
  const shown = sections.flatMap((section) => section.entries);
  const visibleChannels = shown.filter((entry) => entry.item.kind === "channel").length;
  const visibleBots = shown.filter((entry) => entry.item.kind === "bot").length;
  const pinned = new Set(organization.pinned);
  const hidden = new Set(organization.hidden);
  const unread = new Set(organization.unread);

  function openItemMenu(
    key: SidebarItemKey,
    label: string,
    x: number,
    y: number,
    opener: HTMLElement,
  ) {
    menuOpener.current = opener;
    setMenuTarget({ kind: "item", key, label, x, y });
  }

  function menuHandlers(key: SidebarItemKey, label: string) {
    return {
      onContextMenu(event: MouseEvent<HTMLButtonElement>) {
        event.preventDefault();
        openItemMenu(key, label, event.clientX, event.clientY, event.currentTarget);
      },
      onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          openItemMenu(key, label, rect.left + 24, rect.bottom - 6, event.currentTarget);
        }
      },
    };
  }

  function rowTrailing(key: SidebarItemKey, state?: ReactNode) {
    const marks = [
      pinned.has(key) ? (
        <span className="sidebar-row-pin" role="img" aria-label="已置顶" key="pin">
          <PinIcon />
        </span>
      ) : null,
      term && hidden.has(key) ? (
        <span className="sidebar-row-hidden" key="hidden">
          已隐藏
        </span>
      ) : null,
      unread.has(key) ? (
        <span className="sidebar-unread-dot" role="img" aria-label="未读" key="unread" />
      ) : null,
    ].filter(Boolean);
    if (marks.length === 0 && state === undefined) return null;
    return (
      <span className="sidebar-row-trailing">
        {marks}
        {state}
      </span>
    );
  }

  function renderEntry(entry: SidebarEntry<SidebarItem>) {
    const { key, item } = entry;
    const isUnread = unread.has(key);
    if (item.kind === "channel") {
      const { channel } = item;
      const selected = selectedChannelId === channel.id;
      return (
        <button
          aria-current={selected ? "page" : undefined}
          className={`sidebar-row channel-list-row ${selected ? "selected" : ""} ${isUnread ? "unread" : ""}`}
          key={key}
          onClick={() => {
            sidebarOrganization.setUnread(key, false);
            onSelectChannel(channel.id);
          }}
          type="button"
          {...menuHandlers(key, channel.name)}
        >
          <ChannelAvatar
            members={channel.botIds.flatMap((id) => {
              const bot = botById.get(id);
              return bot ? [bot] : [];
            })}
          />
          <span className="channel-list-copy">
            <strong>{channel.name}</strong>
            <small>{channel.description || `${channel.botIds.length} 名 Bot`}</small>
          </span>
          {rowTrailing(key)}
        </button>
      );
    }
    const { bot } = item;
    const run = activeRunByBot.get(bot.id);
    const selected = selectedBotId === bot.id;
    return (
      <button
        className={`sidebar-row bot-row ${selected ? "selected" : ""} ${isUnread ? "unread" : ""}`}
        type="button"
        key={key}
        aria-current={selected ? "page" : undefined}
        title={`${bot.name} · 点击对话，右键查看更多操作`}
        onClick={() => {
          sidebarOrganization.setUnread(key, false);
          onSelectBot(bot.id);
        }}
        {...menuHandlers(key, bot.name)}
      >
        <RobotAvatar bot={bot} compact status={run?.status ?? bot.status} />
        <span className="sidebar-bot-copy">
          <strong>{bot.name}</strong>
          {bot.role ? <small>{bot.role}</small> : null}
        </span>
        {rowTrailing(
          key,
          <small className="bot-state">
            <span className={`status-dot ${run ? "active" : "idle"}`} aria-hidden="true" />
            {run ? runStatusLabel(run.status) : "待命"}
          </small>,
        )}
      </button>
    );
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
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("");
          }}
        />
      </search>
      <div className="sidebar-body">
        <section className="sidebar-section">
          {organization.groups.length === 0 ? (
            <div className="sidebar-heading">
              <h2>频道和 Bots</h2>
            </div>
          ) : null}
          <div className="sidebar-list">
            {sections.map((section) => (
              <div className="sidebar-group" key={section.group?.id ?? "ungrouped"}>
                {organization.groups.length > 0 ? (
                  <SectionHeading
                    group={section.group}
                    onMenu={(target, opener) => {
                      menuOpener.current = opener;
                      setMenuTarget(target);
                    }}
                  />
                ) : null}
                {section.entries.map((entry) => renderEntry(entry))}
              </div>
            ))}
            {visibleChannels === 0 && (
              <p className="sidebar-empty">{term ? "没有匹配的频道" : "点击顶部 + 创建频道"}</p>
            )}
            {visibleBots === 0 && (
              <p className="sidebar-empty">{term ? "没有匹配的 Bot" : "点击顶部 + 创建 Bot"}</p>
            )}
          </div>
        </section>
      </div>
      {menuTarget ? (
        <SidebarItemMenu
          target={menuTarget}
          organization={organization}
          onOpenProfile={
            menuTarget.kind === "item" && menuTarget.key.startsWith("bot:") && onOpenBotProfile
              ? () => onOpenBotProfile(menuTarget.key.slice(4))
              : undefined
          }
          onClose={closeMenu}
        />
      ) : null}
      <footer className="sidebar-footer">
        {onWork && (
          <button className="sidebar-plugin" type="button" onClick={onWork}>
            <HashIcon />
            <span>任务监督</span>
          </button>
        )}
        <div className="sidebar-footer-row">
          <details className="owner-menu">
            <summary aria-label={`${ownerName}：账户与设置`} title={ownerName}>
              <span className="owner-avatar" aria-hidden="true">
                {ownerName.slice(0, 1).toUpperCase()}
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
              {onManageModels ? (
                <button
                  type="button"
                  onClick={() => {
                    dismiss();
                    onManageModels();
                  }}
                >
                  <SettingsIcon />
                  模型服务
                </button>
              ) : null}
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
          {onSkills && (
            <button className="sidebar-plugin-pill" type="button" onClick={onSkills}>
              <SkillIcon />
              <span>插件</span>
            </button>
          )}
        </div>
      </footer>
    </aside>
  );
}

function ChannelAvatar({ members }: { members: Bot[] }) {
  const [first, second] = members;
  return (
    <span
      className={`channel-list-avatar${first ? " has-members" : ""}${second ? " is-pair" : ""}`}
      aria-hidden="true"
    >
      {first ? <RobotAvatar bot={first} compact /> : <HashIcon />}
      {second ? <RobotAvatar bot={second} compact /> : null}
    </span>
  );
}

function SectionHeading({
  group,
  onMenu,
}: {
  group: SidebarGroup | undefined;
  onMenu(target: SidebarMenuTarget, opener: HTMLElement): void;
}) {
  if (!group) {
    return (
      <div className="sidebar-heading sidebar-group-heading">
        <h2>未分组</h2>
      </div>
    );
  }
  return (
    <div className="sidebar-heading sidebar-group-heading">
      <h2>
        <button
          type="button"
          className="sidebar-group-name"
          title="右键或按 Shift+F10 管理分组"
          onContextMenu={(event) => {
            event.preventDefault();
            onMenu(
              { kind: "group", group, x: event.clientX, y: event.clientY },
              event.currentTarget,
            );
          }}
          onKeyDown={(event) => {
            if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              onMenu(
                { kind: "group", group, x: rect.left, y: rect.bottom + 4 },
                event.currentTarget,
              );
            }
          }}
        >
          {group.name}
        </button>
      </h2>
    </div>
  );
}

function PinIcon() {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 17v5M9 3h6l-1 6 4 4H6l4-4Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
