import type { Bot } from "@openbot/domain";
import type { RealtimeConnectionState } from "../api";
import { shortcutLabel } from "../desktop-shortcuts";
import { GroupAvatar } from "./GroupAvatar";
import { PanelLeftIcon, ShareIcon } from "./Icons";
import { RobotAvatar } from "./RobotAvatar";
import "./WorkspaceShell.css";

/**
 * The main column's 56px header (Main and Profile artboards). There is no window-wide toolbar:
 * the title pill opens the right rail, the rail's 收起 closes it, and back/forward and the panel
 * toggles are keyboard and menu commands. When the sidebar is hidden this header leaves room for
 * the macOS traffic lights and offers one button to reopen it.
 */
export function WorkspaceHeader({
  title,
  avatars = [],
  group = false,
  railOpen,
  onToggleRail,
  realtimeState,
  sidebarOpen,
  onOpenSidebar,
  onShare,
}: {
  title: string;
  /** The 单聊 Bot, or the 频道's members in order. */
  avatars?: Bot[];
  /** A 频道 shows its group avatar (GroupAvatars artboard); a 单聊 or profile shows one head. */
  group?: boolean;
  railOpen: boolean;
  /** Present when this view has a rail (a conversation or a Bot profile). */
  onToggleRail?: (() => void) | undefined;
  realtimeState: RealtimeConnectionState;
  sidebarOpen: boolean;
  onOpenSidebar(): void;
  onShare?: (() => void) | undefined;
}) {
  const pill = (
    <>
      {group ? (
        <span className="shell-pill-avatars" aria-hidden="true">
          <GroupAvatar name={title} members={avatars} size={26} />
        </span>
      ) : avatars[0] ? (
        <span className="shell-pill-avatars" aria-hidden="true">
          <RobotAvatar bot={avatars[0]} compact />
        </span>
      ) : null}
      <span className="shell-pill-name">{title}</span>
    </>
  );
  return (
    <header className={`shell-header${sidebarOpen ? "" : " without-sidebar"}`}>
      <div className="shell-leading">
        {sidebarOpen ? null : (
          <button
            type="button"
            className="shell-icon"
            aria-label="打开侧栏"
            title={`打开侧栏 · ${shortcutLabel("B")}`}
            aria-controls="workspace-sidebar"
            onClick={onOpenSidebar}
          >
            <PanelLeftIcon />
          </button>
        )}
      </div>
      {onToggleRail ? (
        <button
          type="button"
          className="shell-pill"
          aria-expanded={railOpen}
          aria-controls="workspace-details"
          title={railOpen ? "收起信息" : "查看信息与成员"}
          onClick={onToggleRail}
        >
          {pill}
        </button>
      ) : (
        <h1 className="shell-pill is-static">{pill}</h1>
      )}
      <div className="shell-actions">
        <span className={`shell-live ${realtimeState}`}>
          <i aria-hidden="true" />
          {realtimeState === "live"
            ? "实时"
            : realtimeState === "retrying"
              ? "重新连接中"
              : "连接中"}
        </span>
        {onShare ? (
          <button
            type="button"
            className="shell-icon"
            aria-label="分享"
            title="分享"
            onClick={onShare}
          >
            <ShareIcon />
          </button>
        ) : null}
      </div>
    </header>
  );
}
