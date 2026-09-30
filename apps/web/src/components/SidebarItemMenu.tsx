import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  maxGroupNameLength,
  type SidebarGroup,
  type SidebarItemKey,
  type SidebarOrganization,
  sidebarOrganization,
} from "../sidebar-organization";

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

/**
 * Native-sized context menu for sidebar rows and group headers. Pin, group, hide and the manual
 * unread mark only change the per-device arrangement. Rename and delete are Server identity writes
 * (ADR-0047) supplied by the caller; delete always goes through a separate confirmation dialog.
 */
export function SidebarItemMenu({
  target,
  organization,
  onOpenProfile,
  identity,
  serverUnread = false,
  onMarkRead,
  onClose,
}: {
  target: SidebarMenuTarget;
  organization: Readonly<SidebarOrganization>;
  onOpenProfile?: (() => void) | undefined;
  identity?: SidebarIdentityActions | undefined;
  serverUnread?: boolean;
  onMarkRead?: (() => void) | undefined;
  onClose(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"menu" | "move" | "new-group" | "rename" | "identity">("menu");
  const [name, setName] = useState(target.kind === "group" ? target.group.name : "");
  const [identityName, setIdentityName] = useState(target.kind === "item" ? target.label : "");
  const [identityBusy, setIdentityBusy] = useState(false);
  const [identityError, setIdentityError] = useState<string>();
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
      if (mode !== "menu" && target.kind === "item") setMode("menu");
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
    return (
      <div
        className="sidebar-context-menu"
        role="menu"
        aria-label={`分组「${group.name}」`}
        ref={menu}
        style={style}
        onKeyDown={onKeyDown}
      >
        {mode === "rename" ? (
          <GroupNameForm
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
            <button type="button" role="menuitem" onClick={() => setMode("rename")}>
              重命名分组…
            </button>
            <span className="sidebar-context-separator" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              onClick={() => run(() => sidebarOrganization.dissolveGroup(group.id))}
            >
              解散分组
            </button>
            <p className="sidebar-context-note">解散后对话回到「未分组」，不会被删除。</p>
          </>
        )}
      </div>
    );
  }

  const { key } = target;
  const pinned = organization.pinned.includes(key);
  const hidden = organization.hidden.includes(key);
  const unread = organization.unread.includes(key) || serverUnread;
  const currentGroup = organization.membership[key];

  return (
    <div
      className="sidebar-context-menu"
      role="menu"
      aria-label={`${target.label} 的操作`}
      ref={menu}
      style={style}
      onKeyDown={onKeyDown}
    >
      {mode === "menu" ? (
        <>
          {onOpenProfile ? (
            <>
              <button type="button" role="menuitem" onClick={() => run(onOpenProfile)}>
                打开档案
              </button>
              <span className="sidebar-context-separator" aria-hidden="true" />
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => run(() => sidebarOrganization.setPinned(key, !pinned))}
          >
            {pinned ? "取消置顶" : "置顶"}
          </button>
          <button
            type="button"
            role="menuitem"
            aria-haspopup="true"
            onClick={() => setMode(organization.groups.length > 0 ? "move" : "new-group")}
          >
            移至分组…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              run(() => {
                sidebarOrganization.setUnread(key, !unread);
                if (unread) onMarkRead?.();
              })
            }
          >
            {unread ? "标为已读" : "标为未读"}
          </button>
          <span className="sidebar-context-separator" aria-hidden="true" />
          {identity ? (
            <button type="button" role="menuitem" onClick={() => setMode("identity")}>
              重命名…
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => run(() => sidebarOrganization.setHidden(key, !hidden))}
          >
            {hidden ? "在侧栏显示" : "从侧栏隐藏"}
          </button>
          {identity ? (
            <>
              <span className="sidebar-context-separator" aria-hidden="true" />
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => run(identity.onDelete)}
              >
                {identity.kind === "channel" ? "删除频道…" : "删除 Bot…"}
              </button>
            </>
          ) : null}
        </>
      ) : mode === "identity" && identity ? (
        <GroupNameForm
          label={identity.kind === "channel" ? "频道名称" : "Bot 名称"}
          value={identityName}
          maxLength={identity.maxLength}
          placeholder={target.label}
          submitLabel={identityBusy ? "正在保存…" : "保存"}
          busy={identityBusy}
          error={identityError}
          onChange={(value) => {
            setIdentityName(value);
            setIdentityError(undefined);
          }}
          onSubmit={async () => {
            const next = identityName.trim();
            if (next === target.label) return onClose();
            setIdentityBusy(true);
            try {
              await identity.onRename(next);
              onClose();
            } catch (cause) {
              setIdentityError(
                (cause instanceof Error && renameErrors[cause.message]) ||
                  "无法重命名，请稍后重试。",
              );
              setIdentityBusy(false);
            }
          }}
        />
      ) : mode === "move" ? (
        <>
          {organization.groups.map((group) => (
            <button
              type="button"
              role="menuitem"
              key={group.id}
              aria-current={currentGroup === group.id ? "true" : undefined}
              onClick={() => run(() => sidebarOrganization.moveToGroup(key, group.id))}
            >
              {group.name}
              {currentGroup === group.id ? <span aria-hidden="true">✓</span> : null}
            </button>
          ))}
          <span className="sidebar-context-separator" aria-hidden="true" />
          <button type="button" role="menuitem" onClick={() => setMode("new-group")}>
            新建分组…
          </button>
          {currentGroup ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => run(() => sidebarOrganization.moveToGroup(key, undefined))}
            >
              移出分组
            </button>
          ) : null}
        </>
      ) : (
        <GroupNameForm
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

function GroupNameForm({
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
      <label>
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
      <button type="submit" disabled={busy || value.trim().length === 0}>
        {submitLabel}
      </button>
    </form>
  );
}
