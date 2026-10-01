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
  highlightMatch,
  type SidebarEntry,
  type SidebarGroup,
  type SidebarItemKey,
  searchSidebar,
  sidebarOrganization,
  useSidebarOrganization,
} from "../sidebar-organization";
import { DeleteIdentityDialog, type DeleteIdentityTarget } from "./DeleteIdentityDialog";
import { BotIcon, HashIcon, PlusIcon, SearchIcon, SettingsIcon, SkillIcon } from "./Icons";
import { RobotAvatar } from "./RobotAvatar";
import { SidebarItemMenu, type SidebarMenuTarget } from "./SidebarItemMenu";
import "./Sidebar.css";

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
  /** Server unread counts keyed by sidebar row (ADR-0047); the manual mark stays per device. */
  unreadCounts?: Partial<Record<SidebarItemKey, number>> | undefined;
  onMarkRead?: ((key: SidebarItemKey) => void) | undefined;
  onRenameItem?: ((key: SidebarItemKey, name: string) => Promise<void>) | undefined;
  onDeleteItem?: ((target: DeleteIdentityTarget) => Promise<void>) | undefined;
  onAddBotToChannel?: ((channelId: string, botId: string) => Promise<void>) | undefined;
  onCreateBot(): void;
  onCreateChannel(): void;
  onManageNodes(): void;
  onManageModels?: (() => void) | undefined;
  onLogout(): Promise<void>;
}

/** The shared sidebar of the design contract (docs/design/desktop-ui-2026-10/Sidebar.dc.html). */
export function Sidebar({
  onWork,
  onSkills,
  bots,
  channels,
  runs,
  ownerName,
  onSettings,
  selectedChannelId,
  selectedBotId,
  onSelectChannel,
  onSelectBot,
  onOpenBotProfile,
  unreadCounts,
  onMarkRead,
  onRenameItem,
  onDeleteItem,
  onAddBotToChannel,
  onCreateBot,
  onCreateChannel,
  onManageModels,
  onLogout,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const term = query.trim();
  const [focusGroupId, setFocusGroupId] = useState<string>();
  const { values: organization } = useSidebarOrganization();
  const [menuTarget, setMenuTarget] = useState<SidebarMenuTarget>();
  const [deleteTarget, setDeleteTarget] = useState<DeleteIdentityTarget>();
  const menuOpener = useRef<HTMLElement | null>(null);
  const closeMenu = useCallback(() => {
    const opener = menuOpener.current;
    setMenuTarget(undefined);
    // Return focus to the row or heading that opened the menu, as native menus do.
    requestAnimationFrame(() => opener?.focus());
  }, []);
  const botById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const channelById = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel])),
    [channels],
  );
  const activeRunByBot = indexActiveRunsByBot(runs);
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
  const pinned = new Set(organization.pinned);
  const hidden = new Set(organization.hidden);
  const manualUnread = new Set(organization.unread);
  const isUnread = (key: SidebarItemKey) => manualUnread.has(key) || Boolean(unreadCounts?.[key]);
  // Hidden conversations come back when they have something new, as the design specifies.
  const revealed = new Set(entries.map((entry) => entry.key).filter(isUnread));
  const sections = arrangeSidebar(entries, organization, "", revealed);
  const search = searchSidebar(entries, organization, term);
  const focusGroup = focusGroupId
    ? organization.groups.find((group) => group.id === focusGroupId)
    : undefined;

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

  function identityActions(key: SidebarItemKey, label: string) {
    if (!onRenameItem || !onDeleteItem) return undefined;
    const kind = key.startsWith("bot:") ? ("bot" as const) : ("channel" as const);
    const id = key.slice(kind === "bot" ? 4 : 8);
    return {
      kind,
      maxLength: kind === "bot" ? 64 : 80,
      onRename: (name: string) => onRenameItem(key, name),
      onDelete: () => setDeleteTarget({ kind, id, name: label }),
    };
  }

  function open(entry: SidebarEntry<SidebarItem>) {
    sidebarOrganization.setUnread(entry.key, false);
    if (entry.item.kind === "channel") onSelectChannel(entry.item.channel.id);
    else onSelectBot(entry.item.bot.id);
  }

  function clearSearch() {
    setQuery("");
    setFocusGroupId(undefined);
  }

  function renderRow(entry: SidebarEntry<SidebarItem>, highlight: string) {
    const { key, item } = entry;
    const unread = isUnread(key);
    const selected =
      item.kind === "channel"
        ? selectedChannelId === item.channel.id
        : selectedBotId === item.bot.id;
    const run = item.kind === "bot" ? activeRunByBot.get(item.bot.id) : undefined;
    const sub =
      item.kind === "channel"
        ? item.channel.description || `${item.channel.botIds.length} 名 Bot`
        : run
          ? `${runStatusLabel(run.status)} · ${run.title}`
          : "待命";
    const count = unreadCounts?.[key];
    return (
      <button
        type="button"
        key={key}
        className={`sb-row${selected ? " is-selected" : ""}${unread ? " is-unread" : ""}`}
        data-kind={item.kind}
        aria-current={selected ? "page" : undefined}
        title={
          item.kind === "bot"
            ? `${item.bot.name} · 点击对话，右键查看更多操作`
            : `${item.channel.name} · 右键查看更多操作`
        }
        onClick={() => open(entry)}
        {...menuHandlers(key, entry.name)}
      >
        {item.kind === "channel" ? (
          <ChannelAvatar
            members={item.channel.botIds.flatMap((id) => {
              const bot = botById.get(id);
              return bot ? [bot] : [];
            })}
          />
        ) : (
          <span className="sb-avatar" aria-hidden="true">
            <RobotAvatar bot={item.bot} compact status={run?.status ?? item.bot.status} />
          </span>
        )}
        <span className="sb-text">
          <span className="sb-title-line">
            <strong className="sb-name">
              <Highlighted text={entry.name} query={highlight} />
            </strong>
            {item.kind === "bot" && item.bot.role ? (
              <span className="ob-tag">
                <Highlighted text={item.bot.role} query={highlight} />
              </span>
            ) : null}
          </span>
          <small className={`sb-sub${run ? " is-active" : ""}`}>{sub}</small>
        </span>
        <span className="sb-meta">
          {pinned.has(key) ? (
            <span className="sb-pin" role="img" aria-label="已置顶">
              <PinGlyph />
            </span>
          ) : null}
          {term && hidden.has(key) ? <span className="sb-hidden">已隐藏</span> : null}
          {unread ? (
            <span
              className="sb-unread"
              role="img"
              aria-label={count ? `${count} 条未读` : "未读"}
            />
          ) : null}
        </span>
      </button>
    );
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      clearSearch();
      return;
    }
    if (event.key !== "Enter" || !term) return;
    event.preventDefault();
    const first = search.conversations[0] ?? search.groups[0]?.entries[0];
    if (first) {
      open(first);
      clearSearch();
    } else if (search.groups[0]) {
      setFocusGroupId(search.groups[0].group.id);
    }
  }

  const nothing = entries.length === 0;
  let body: ReactNode;
  if (focusGroup) {
    const members = entries.filter((entry) => organization.membership[entry.key] === focusGroup.id);
    body = (
      <div className="sb-section">
        <div className="sb-section-title">
          <span>{focusGroup.name}</span>
          <button type="button" className="sb-link" onClick={() => setFocusGroupId(undefined)}>
            返回
          </button>
        </div>
        {members.map((entry) => renderRow(entry, ""))}
      </div>
    );
  } else if (term) {
    body = (
      <>
        {search.groups.length > 0 ? (
          <div className="sb-section">
            <div className="sb-section-title">
              <span>分组</span>
              <span className="sb-count">{search.groups.length}</span>
            </div>
            {search.groups.map(({ group, entries: members }) => (
              <div key={group.id}>
                <button
                  type="button"
                  className="sb-row is-group-hit"
                  onClick={() => setFocusGroupId(group.id)}
                >
                  <span className="sb-avatar is-folder" aria-hidden="true">
                    <FolderGlyph />
                  </span>
                  <span className="sb-text">
                    <strong className="sb-name">
                      <Highlighted text={group.name} query={term} />
                    </strong>
                    <small className="sb-sub">{members.length} 个对话</small>
                  </span>
                  <span className="sb-meta" aria-hidden="true">
                    <ChevronGlyph />
                  </span>
                </button>
                {members.map((entry) => (
                  <button
                    type="button"
                    className="sb-child"
                    key={entry.key}
                    onClick={() => {
                      open(entry);
                      clearSearch();
                    }}
                  >
                    {entry.item.kind === "bot" ? (
                      <RobotAvatar bot={entry.item.bot} compact />
                    ) : (
                      <span className="sb-child-hash" aria-hidden="true">
                        <HashIcon />
                      </span>
                    )}
                    <span>{entry.name}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        ) : null}
        <div className="sb-section">
          <div className="sb-section-title">
            <span>对话</span>
            <span className="sb-count">{search.conversations.length}</span>
          </div>
          {search.conversations.map((entry) => renderRow(entry, term))}
          {search.conversations.length === 0 && search.groups.length === 0 ? (
            <p className="sb-empty">没有匹配的对话、Bot 或分组</p>
          ) : null}
        </div>
        <p className="sb-hint">按回车打开第一个结果 · Esc 清除</p>
      </>
    );
  } else {
    body = (
      <>
        {sections.map((section) => (
          <div className="sb-section" key={section.group?.id ?? "ungrouped"}>
            {organization.groups.length > 0 ? (
              <SectionHeading
                group={section.group}
                collapsed={section.collapsed}
                onMenu={(target, opener) => {
                  menuOpener.current = opener;
                  setMenuTarget(target);
                }}
              />
            ) : null}
            {section.collapsed ? null : section.entries.map((entry) => renderRow(entry, ""))}
          </div>
        ))}
        {nothing ? <p className="sb-empty">点击上方 + 创建频道或 Bot</p> : null}
      </>
    );
  }

  const menuKey = menuTarget?.kind === "item" ? menuTarget.key : undefined;
  const menuChannel = menuKey?.startsWith("channel:")
    ? channelById.get(menuKey.slice(8))
    : undefined;

  return (
    <aside
      className="sidebar sb"
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
      <div className="sb-top">
        <details className="sb-create">
          <summary aria-label="新建" title="新建">
            <PlusIcon />
          </summary>
          <div className="ob-menu sb-popover" role="menu">
            <button
              type="button"
              role="menuitem"
              className="ob-menu-item"
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
              role="menuitem"
              className="ob-menu-item"
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
      <search className={`ob-search sb-search${term ? " is-active" : ""}`}>
        <SearchIcon />
        <input
          type="search"
          aria-label="搜索对话、Bot 和分组"
          placeholder="搜索对话、Bot 和分组"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setFocusGroupId(undefined);
          }}
          onKeyDown={onSearchKeyDown}
        />
        {term || focusGroup ? (
          <button type="button" className="sb-clear" aria-label="清除搜索" onClick={clearSearch}>
            <ClearGlyph />
          </button>
        ) : null}
      </search>
      <nav className="sb-list" aria-label="对话列表">
        {body}
      </nav>
      {menuTarget ? (
        <SidebarItemMenu
          target={menuTarget}
          organization={organization}
          onOpenProfile={
            menuKey?.startsWith("bot:") && onOpenBotProfile
              ? () => onOpenBotProfile(menuKey.slice(4))
              : undefined
          }
          identity={
            menuTarget.kind === "item"
              ? identityActions(menuTarget.key, menuTarget.label)
              : undefined
          }
          serverUnread={Boolean(menuKey && unreadCounts?.[menuKey])}
          onMarkRead={menuKey && onMarkRead ? () => onMarkRead(menuKey) : undefined}
          addableBots={
            menuChannel && !menuChannel.directBotId
              ? bots.filter((bot) => !menuChannel.botIds.includes(bot.id))
              : []
          }
          onAddBot={
            menuChannel && !menuChannel.directBotId && onAddBotToChannel
              ? (botId) => onAddBotToChannel(menuChannel.id, botId)
              : undefined
          }
          onClose={closeMenu}
        />
      ) : null}
      {deleteTarget && onDeleteItem ? (
        <DeleteIdentityDialog
          target={deleteTarget}
          onClose={() => setDeleteTarget(undefined)}
          onDelete={async (target) => {
            await onDeleteItem(target);
            setDeleteTarget(undefined);
          }}
        />
      ) : null}
      <footer className="sb-footer">
        <AccountMenu
          ownerName={ownerName}
          onWork={onWork}
          onSettings={onSettings}
          onManageModels={onManageModels}
          onLogout={onLogout}
        />
        {onSkills ? (
          <button className="sb-plugins" type="button" onClick={onSkills}>
            <SkillIcon />
            <span>插件</span>
          </button>
        ) : null}
      </footer>
    </aside>
  );
}

/** Menu artboard: the large account menu opened from 「我」. */
function AccountMenu({
  ownerName,
  onWork,
  onSettings,
  onManageModels,
  onLogout,
}: {
  ownerName: string;
  onWork?: (() => void) | undefined;
  onSettings?: ((section?: "general" | "about" | "automations") => void) | undefined;
  onManageModels?: (() => void) | undefined;
  onLogout(): Promise<void>;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const [help, setHelp] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  function close() {
    details.current?.removeAttribute("open");
    setHelp(false);
  }
  async function logout() {
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
    <details
      className="sb-account"
      ref={details}
      onToggle={(event) => {
        if (!event.currentTarget.open) setHelp(false);
      }}
    >
      <summary aria-label={`${ownerName}：账户与设置`} title={ownerName}>
        我
      </summary>
      <div className="ob-menu is-large sb-account-menu" role="menu" aria-label="我的账户与设置">
        {help ? (
          <>
            <button
              type="button"
              role="menuitem"
              className="ob-menu-item"
              onClick={() => setHelp(false)}
            >
              <span aria-hidden="true">‹</span>
              返回
            </button>
            <a
              role="menuitem"
              className="ob-menu-item"
              href="https://github.com/yxflc11/openbot#readme"
              target="_blank"
              rel="noreferrer"
            >
              <span className="sb-grow">帮助中心</span>
              <span aria-hidden="true">↗</span>
            </a>
            <a
              role="menuitem"
              className="ob-menu-item"
              href="https://github.com/yxflc11/openbot/issues/new"
              target="_blank"
              rel="noreferrer"
            >
              <span className="sb-grow">发送反馈</span>
              <span aria-hidden="true">↗</span>
            </a>
          </>
        ) : (
          <>
            {onWork ? (
              <button
                type="button"
                role="menuitem"
                className="ob-menu-item"
                onClick={() => {
                  close();
                  onWork();
                }}
              >
                <HashIcon />
                <span className="sb-grow">任务监督</span>
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className="ob-menu-item"
              aria-haspopup="true"
              onClick={() => setHelp(true)}
            >
              <BookGlyph />
              <span className="sb-grow">帮助与反馈</span>
              <ChevronGlyph />
            </button>
            {onSettings ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="ob-menu-item"
                  onClick={() => {
                    close();
                    onSettings("about");
                  }}
                >
                  <InfoGlyph />
                  <span className="sb-grow">关于 OpenBot</span>
                  <ChevronGlyph />
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="ob-menu-item"
                  onClick={() => {
                    close();
                    onSettings();
                  }}
                >
                  <SettingsIcon />
                  <span className="sb-grow">设置</span>
                </button>
              </>
            ) : null}
            {onManageModels ? (
              // Temporary: model connections move into the Settings 模型服务 section in plan step 7.
              <button
                type="button"
                role="menuitem"
                className="ob-menu-item"
                onClick={() => {
                  close();
                  onManageModels();
                }}
              >
                <ModelGlyph />
                <span className="sb-grow">模型服务</span>
              </button>
            ) : null}
            <span className="ob-menu-separator" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              className="ob-menu-item"
              disabled={loggingOut}
              onClick={() => void logout()}
            >
              <LogoutGlyph />
              <span className="sb-grow">{loggingOut ? "退出中…" : "退出登录"}</span>
            </button>
            {logoutError ? (
              <p className="form-error" role="alert">
                退出失败，请重试
              </p>
            ) : null}
          </>
        )}
      </div>
    </details>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const { before, hit, after } = highlightMatch(text, query);
  if (!hit) return <>{text}</>;
  return (
    <>
      {before}
      <mark>{hit}</mark>
      {after}
    </>
  );
}

function ChannelAvatar({ members }: { members: Bot[] }) {
  const [first, second] = members;
  if (!first)
    return (
      <span className="sb-avatar is-empty" aria-hidden="true">
        <HashIcon />
      </span>
    );
  return (
    <span className={`sb-avatar-pair${second ? " is-pair" : ""}`} aria-hidden="true">
      <RobotAvatar bot={first} compact />
      {second ? <RobotAvatar bot={second} compact /> : null}
    </span>
  );
}

function SectionHeading({
  group,
  collapsed,
  onMenu,
}: {
  group: SidebarGroup | undefined;
  collapsed: boolean;
  onMenu(target: SidebarMenuTarget, opener: HTMLElement): void;
}) {
  if (!group) {
    return (
      <div className="sb-section-title">
        <span>未分组</span>
      </div>
    );
  }
  return (
    <div className="sb-section-title">
      <button
        type="button"
        className="sb-group-name"
        aria-expanded={!collapsed}
        title="点击折叠或展开；右键或 Shift+F10 管理分组"
        onClick={() => sidebarOrganization.setCollapsed(group.id, !collapsed)}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu({ kind: "group", group, x: event.clientX, y: event.clientY }, event.currentTarget);
        }}
        onKeyDown={(event) => {
          if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu({ kind: "group", group, x: rect.left, y: rect.bottom + 4 }, event.currentTarget);
          }
        }}
      >
        {group.name}
        <span className={`sb-fold${collapsed ? " is-collapsed" : ""}`} aria-hidden="true">
          <ChevronGlyph />
        </span>
      </button>
    </div>
  );
}

function Glyph({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}
const PinGlyph = () => (
  <Glyph size={12}>
    <path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4Z" />
  </Glyph>
);
const ChevronGlyph = () => (
  <Glyph size={14}>
    <path d="M9 18l6-6-6-6" />
  </Glyph>
);
const FolderGlyph = () => (
  <Glyph size={20}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Glyph>
);
const ClearGlyph = () => (
  <Glyph size={10}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Glyph>
);
const BookGlyph = () => (
  <Glyph>
    <path d="M4 19V5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2zM18 19v2H6" />
  </Glyph>
);
const InfoGlyph = () => (
  <Glyph>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Glyph>
);
const ModelGlyph = () => (
  <Glyph>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5" />
  </Glyph>
);
const LogoutGlyph = () => (
  <Glyph>
    <path d="M15 21h4a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-4M8 17l-5-5 5-5M3 12h12" />
  </Glyph>
);
