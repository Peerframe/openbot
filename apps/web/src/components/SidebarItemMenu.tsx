import type { Bot } from "@openbot/domain";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  maxGroupNameLength,
  type SidebarGroup,
  type SidebarItemKey,
  type SidebarOrganization,
  sidebarOrganization,
} from "../sidebar-organization";
import { RobotAvatar } from "./RobotAvatar";

export type SidebarMenuTarget =
  | { kind: "item"; key: SidebarItemKey; label: string; x: number; y: number }
  | { kind: "group"; group: SidebarGroup; x: number; y: number };

export interface SidebarIdentityActions {
  kind: "channel" | "bot";
  maxLength: number;
  onRename(name: string): Promise<void>;
  onDelete(): void;
}

const renameErrors: Record<string, string> = {
  name_already_exists: "已有同名的对象，请换一个名字。",
  invalid_rename_input: "名字不能为空，且不能超过长度限制。",
};

type Mode = "menu" | "move" | "new-group" | "rename-group" | "identity" | "add-bot";

/**
 * Context menus from the ContextMenu artboard. Pin, group, mute, hide and the manual unread mark
 * are per-device arrangement; rename, delete and adding a Bot are Server writes supplied by the
 * caller, and delete always goes through a separate confirmation dialog.
 */
export function SidebarItemMenu({
  target,
  organization,
  onOpenProfile,
  identity,
  serverUnread = false,
  onMarkRead,
  addableBots = [],
  onAddBot,
  onSetPrimary,
  onClose,
}: {
  target: SidebarMenuTarget;
  organization: Readonly<SidebarOrganization>;
  onOpenProfile?: (() => void) | undefined;
  identity?: SidebarIdentityActions | undefined;
  serverUnread?: boolean;
  onMarkRead?: (() => void) | undefined;
  addableBots?: Bot[];
  onAddBot?: ((botId: string) => Promise<void>) | undefined;
  /** Offered for a Bot that is not 主 Bot yet; the Server write is the caller's. */
  onSetPrimary?: (() => Promise<void>) | undefined;
  onClose(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("menu");
  const [name, setName] = useState(target.kind === "group" ? target.group.name : "");
  const [identityName, setIdentityName] = useState(target.kind === "item" ? target.label : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [position, setPosition] = useState({ left: target.x, top: target.y });

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the menu switches content.
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(target.x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(target.y, window.innerHeight - rect.height - 8)),
    });
  }, [target.x, target.y, mode]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: move focus into each new menu content.
  useEffect(() => {
    const first = menu.current?.querySelector<HTMLElement>("input, [role='menuitem']");
    first?.focus();
  }, [mode]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (mode !== "menu") setMode("menu");
      else onClose();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(
      menu.current?.querySelectorAll<HTMLElement>("[role='menuitem']:not(:disabled)") ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  }

  function run(action: () => void) {
    action();
    onClose();
  }

  const style = { left: position.left, top: position.top };

  if (target.kind === "group") {
    const { group } = target;
    const folded = (organization.collapsed ?? []).includes(group.id);
    return (
      <div
        className="ob-menu sidebar-context-menu"
        role="menu"
        aria-label={`分组「${group.name}」`}
        ref={menu}
        style={style}
        onKeyDown={onKeyDown}
      >
        {mode === "rename-group" ? (
          <NameForm
            label="分组名称"
            value={name}
            submitLabel="保存"
            onChange={setName}
            onSubmit={() => {
              if (sidebarOrganization.renameGroup(group.id, name)) onClose();
            }}
          />
        ) : (
          <>
            <Item icon={<RenameIcon />} onClick={() => setMode("rename-group")}>
              重命名分组
            </Item>
            <Item
              icon={<FoldIcon />}
              onClick={() => run(() => sidebarOrganization.setCollapsed(group.id, !folded))}
            >
              {folded ? "展开分组" : "折叠分组"}
            </Item>
            <span className="ob-menu-separator" aria-hidden="true" />
            <Item
              icon={<UngroupIcon />}
              onClick={() => run(() => sidebarOrganization.dissolveGroup(group.id))}
            >
              解散分组
            </Item>
            <p className="sidebar-context-note">解散后对话回到「未分组」，不会被删除。</p>
          </>
        )}
      </div>
    );
  }

  const { key } = target;
  const isBot = key.startsWith("bot:");
  const pinned = organization.pinned.includes(key);
  const hidden = organization.hidden.includes(key);
  const unread = organization.unread.includes(key) || serverUnread;
  const muted = (organization.muted ?? []).includes(key);
  const currentGroup = organization.membership[key];

  return (
    <div
      className="ob-menu sidebar-context-menu"
      role="menu"
      aria-label={`${target.label} 的操作`}
      ref={menu}
      style={style}
      onKeyDown={onKeyDown}
    >
      {mode === "menu" ? (
        <>
          {isBot && onSetPrimary ? (
            <>
              <Item
                icon={<CrownGlyph />}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(undefined);
                  try {
                    await onSetPrimary();
                    onClose();
                  } catch {
                    setError("无法设为主 Bot，请稍后重试。");
                    setBusy(false);
                  }
                }}
              >
                设为主 Bot
              </Item>
              {error ? (
                <p className="form-error" role="alert">
                  {error}
                </p>
              ) : null}
              <span className="ob-menu-separator" aria-hidden="true" />
            </>
          ) : null}
          <Item
            icon={<PinIcon />}
            onClick={() => run(() => sidebarOrganization.setPinned(key, !pinned))}
          >
            {pinned ? "取消置顶" : "置顶"}
          </Item>
          <Item
            icon={<FolderPlusIcon />}
            haspopup
            onClick={() => setMode(organization.groups.length > 0 ? "move" : "new-group")}
          >
            {organization.groups.length > 0 ? "移至分组…" : "移至新分组"}
          </Item>
          {isBot ? (
            <Item
              icon={<BellDotIcon />}
              onClick={() =>
                run(() => {
                  sidebarOrganization.setUnread(key, !unread);
                  if (unread) onMarkRead?.();
                })
              }
            >
              {unread ? "标为已读" : "标为未读"}
            </Item>
          ) : (
            <Item
              icon={<BellOffIcon />}
              onClick={() => run(() => sidebarOrganization.setMuted(key, !muted))}
            >
              {muted ? "开启通知" : "关闭通知"}
            </Item>
          )}
          {identity || onOpenProfile || onAddBot ? (
            <span className="ob-menu-separator" aria-hidden="true" />
          ) : null}
          {identity ? (
            <Item icon={<RenameIcon />} onClick={() => setMode("identity")}>
              {isBot ? "重命名 Bot" : "重命名频道"}
            </Item>
          ) : null}
          {isBot && onOpenProfile ? (
            <Item icon={<ProfileIcon />} onClick={() => run(onOpenProfile)}>
              编辑资料
            </Item>
          ) : null}
          {!isBot && onAddBot ? (
            <Item icon={<AddPersonIcon />} haspopup onClick={() => setMode("add-bot")}>
              添加 Bot
            </Item>
          ) : null}
          <span className="ob-menu-separator" aria-hidden="true" />
          <Item
            icon={<HideIcon />}
            onClick={() => run(() => sidebarOrganization.setHidden(key, !hidden))}
          >
            {hidden ? "在侧栏显示" : "从侧栏隐藏"}
          </Item>
          {identity ? (
            <Item icon={<TrashIcon />} danger onClick={() => run(identity.onDelete)}>
              {isBot ? "删除 Bot…" : "删除频道…"}
            </Item>
          ) : null}
        </>
      ) : mode === "move" ? (
        <>
          {organization.groups.map((group) => (
            <Item
              key={group.id}
              current={currentGroup === group.id}
              onClick={() => run(() => sidebarOrganization.moveToGroup(key, group.id))}
            >
              <span className="sidebar-context-grow">{group.name}</span>
              {currentGroup === group.id ? <span aria-hidden="true">✓</span> : null}
            </Item>
          ))}
          <span className="ob-menu-separator" aria-hidden="true" />
          <Item icon={<FolderPlusIcon />} onClick={() => setMode("new-group")}>
            新建分组…
          </Item>
          {currentGroup ? (
            <Item onClick={() => run(() => sidebarOrganization.moveToGroup(key, undefined))}>
              移出分组
            </Item>
          ) : null}
        </>
      ) : mode === "add-bot" ? (
        <>
          {addableBots.length === 0 ? (
            <p className="sidebar-context-note">所有 Bot 都已在这个频道里。</p>
          ) : (
            addableBots.map((bot) => (
              <Item
                key={bot.id}
                icon={<RobotAvatar bot={bot} compact />}
                disabled={busy}
                onClick={async () => {
                  if (!onAddBot) return;
                  setBusy(true);
                  setError(undefined);
                  try {
                    await onAddBot(bot.id);
                    onClose();
                  } catch {
                    setError("无法添加，请稍后重试。");
                    setBusy(false);
                  }
                }}
              >
                {bot.name}
              </Item>
            ))
          )}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : mode === "identity" && identity ? (
        <NameForm
          label={identity.kind === "channel" ? "频道名称" : "Bot 名称"}
          value={identityName}
          maxLength={identity.maxLength}
          placeholder={target.label}
          submitLabel={busy ? "正在保存…" : "保存"}
          busy={busy}
          error={error}
          onChange={(value) => {
            setIdentityName(value);
            setError(undefined);
          }}
          onSubmit={async () => {
            const next = identityName.trim();
            if (next === target.label) return onClose();
            setBusy(true);
            try {
              await identity.onRename(next);
              onClose();
            } catch (cause) {
              setError(
                (cause instanceof Error && renameErrors[cause.message]) ||
                  "无法重命名，请稍后重试。",
              );
              setBusy(false);
            }
          }}
        />
      ) : (
        <NameForm
          label="新分组名称"
          value={name}
          submitLabel="创建并移入"
          onChange={setName}
          onSubmit={() => {
            if (sidebarOrganization.moveToNewGroup(key, name)) onClose();
          }}
        />
      )}
    </div>
  );
}

function Item({
  icon,
  danger = false,
  haspopup = false,
  current = false,
  disabled = false,
  onClick,
  children,
}: {
  icon?: ReactNode;
  danger?: boolean;
  haspopup?: boolean;
  current?: boolean;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`ob-menu-item${danger ? " is-danger" : ""}`}
      aria-haspopup={haspopup ? "true" : undefined}
      aria-current={current ? "true" : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {icon ? (
        <span className="sidebar-context-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </button>
  );
}

function NameForm({
  label,
  value,
  submitLabel,
  maxLength = maxGroupNameLength,
  placeholder = "例如 市场团队",
  busy = false,
  error,
  onChange,
  onSubmit,
}: {
  label: string;
  value: string;
  submitLabel: string;
  maxLength?: number;
  placeholder?: string;
  busy?: boolean;
  error?: string | undefined;
  onChange(value: string): void;
  onSubmit(): void | Promise<void>;
}) {
  return (
    <form
      className="sidebar-context-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void onSubmit();
      }}
    >
      <label className="ob-field">
        <span>{label}</span>
        <input
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        className="ob-pill is-primary"
        disabled={busy || value.trim().length === 0}
      >
        {submitLabel}
      </button>
    </form>
  );
}

/** The 主 Bot crown as a small glyph, in its own gold (PrimaryBot artboard). */
export function CrownGlyph({ label }: { label?: string }) {
  return (
    <svg
      className="ob-crown-glyph"
      width="15"
      height="11"
      viewBox="0 0 24 17"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path
        d="M1 15.5L3 3.5L8.5 9L12 1L15.5 9L21 3.5L23 15.5Z"
        fill="#F5B83D"
        stroke="#B9801A"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Stroke({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}
const PinIcon = () => (
  <Stroke>
    <path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4z" />
  </Stroke>
);
const FolderPlusIcon = () => (
  <Stroke>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M12 10v6M9 13h6" />
  </Stroke>
);
const BellDotIcon = () => (
  <Stroke>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    <circle cx="18" cy="5" r="2.5" fill="currentColor" stroke="none" />
  </Stroke>
);
const BellOffIcon = () => (
  <Stroke>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0M3 3l18 18" />
  </Stroke>
);
const RenameIcon = () => (
  <Stroke>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </Stroke>
);
const ProfileIcon = () => (
  <Stroke>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="11" r="2.5" />
    <path d="M5.5 17c.8-1.8 2-2.6 3.5-2.6s2.7.8 3.5 2.6M15 10h3M15 14h3" />
  </Stroke>
);
const AddPersonIcon = () => (
  <Stroke>
    <circle cx="9" cy="8" r="4" />
    <path d="M2 21c1.2-3.5 3.8-5 7-5s5.8 1.5 7 5M19 8v6M16 11h6" />
  </Stroke>
);
const HideIcon = () => (
  <Stroke>
    <path d="M17.9 17.9A10 10 0 0 1 12 20c-7 0-10-8-10-8a18 18 0 0 1 4.1-5.1M9.9 4.2A9 9 0 0 1 12 4c7 0 10 8 10 8a18 18 0 0 1-2.2 3.2" />
    <path d="M2 2l20 20" />
  </Stroke>
);
const TrashIcon = () => (
  <Stroke>
    <path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
  </Stroke>
);
const FoldIcon = () => (
  <Stroke>
    <path d="M6 9l6 6 6-6" />
  </Stroke>
);
const UngroupIcon = () => (
  <Stroke>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M9 13h6" />
  </Stroke>
);
