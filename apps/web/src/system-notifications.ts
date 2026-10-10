// Opt-in system notifications for new Bot replies and approvals, through Desktop or the browser
// Notifications API. Notices name only the Bot and channel, never message text.
import type { Approval, Bot, Channel } from "@openbot/domain";
import { getOpenBotDesktopBridge } from "./desktop-runtime";

export type NotificationSupport = "desktop" | "granted" | "default" | "denied" | "unsupported";

export interface SystemNotice {
  title: string;
  body: string;
  channelId: string;
}

const TITLE_LIMIT = 40;
const BODY_LIMIT = 80;
const MESSAGE_THROTTLE_MS = 60_000;

function bounded(text: string, limit: number) {
  const single = text.replace(/\s+/gu, " ").trim();
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`;
}

/** Desktop uses its main-process bridge; the browser uses the standard Notifications API. */
export function notificationSupport(): NotificationSupport {
  if (getOpenBotDesktopBridge()?.showNotification) return "desktop";
  if (typeof window === "undefined" || typeof window.Notification !== "function")
    return "unsupported";
  return window.Notification.permission;
}

/** Must run from a user gesture; the browser shows its own permission prompt. */
export async function requestNotificationPermission(): Promise<NotificationSupport> {
  const support = notificationSupport();
  if (support !== "default") return support;
  try {
    return await window.Notification.requestPermission();
  } catch {
    return notificationSupport();
  }
}

/** Resolves true when shown; onClick runs only after the Owner clicks the notification. */
export async function showSystemNotification(
  notice: Pick<SystemNotice, "title" | "body">,
  onClick: () => void,
): Promise<boolean> {
  const title = bounded(notice.title, TITLE_LIMIT);
  const body = bounded(notice.body, BODY_LIMIT);
  const bridge = getOpenBotDesktopBridge();
  if (bridge?.showNotification) {
    try {
      const pending = bridge.showNotification({ title, body });
      // The Desktop promise settles on click/close, so do not wait for it to report "shown".
      // The IPC call can reject (window closing, handler gone); a lost notice is not an error.
      pending.then(
        (result) => {
          if (result.status === "clicked") onClick();
        },
        () => undefined,
      );
      return true;
    } catch {
      return false;
    }
  }
  if (notificationSupport() !== "granted") return false;
  try {
    const notification = new window.Notification(title, { body });
    notification.onclick = () => {
      window.focus();
      onClick();
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}

export function windowIsAttended() {
  return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * Derives notices from Server snapshots. Notices contain only Bot and channel names, never message
 * text or approval details, because they can appear on a locked screen. The first observation is a
 * baseline, so opening the app never replays an existing backlog.
 */
export class NotificationTracker {
  #approvals: Set<string> | undefined;
  #unread: Record<string, number> | undefined;
  #lastMessageNotice = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  approvals(approvals: Approval[], bots: Bot[], channels: Channel[]): SystemNotice[] {
    const pending = approvals.filter((approval) => approval.status === "pending");
    const previous = this.#approvals;
    this.#approvals = new Set(pending.map((approval) => approval.id));
    if (previous === undefined) return [];
    return pending
      .filter((approval) => !previous.has(approval.id))
      .slice(0, 3)
      .map((approval) => {
        const bot = bots.find((item) => item.id === approval.botId);
        const channel = channels.find((item) => item.id === approval.channelId);
        return {
          title: "需要你批准",
          body:
            [bot?.name, channel && !channel.directBotId ? channel.name : undefined]
              .filter(Boolean)
              .join(" · ") || "有一个操作在等待你处理",
          channelId: approval.channelId,
        };
      });
  }

  messages(unread: Record<string, number>, bots: Bot[], channels: Channel[]): SystemNotice[] {
    const previous = this.#unread;
    this.#unread = { ...unread };
    if (previous === undefined) return [];
    const now = this.now();
    const notices: SystemNotice[] = [];
    for (const [channelId, count] of Object.entries(unread)) {
      if (count <= (previous[channelId] ?? 0)) continue;
      if (now - (this.#lastMessageNotice.get(channelId) ?? -Infinity) < MESSAGE_THROTTLE_MS)
        continue;
      const channel = channels.find((item) => item.id === channelId);
      if (!channel) continue;
      const bot = channel.directBotId
        ? bots.find((item) => item.id === channel.directBotId)
        : undefined;
      this.#lastMessageNotice.set(channelId, now);
      notices.push({
        title: bot ? `${bot.name} 回复了你` : `「${channel.name}」有新消息`,
        body: `${count} 条未读`,
        channelId,
      });
      if (notices.length >= 3) break;
    }
    return notices;
  }
}
