import {
  type Message,
  type MessageReaction,
  type ReactionEmoji,
  type Run,
  reactionEmojis,
} from "@openbot/domain";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { reactionLabels } from "./MessageReactions";
import "./MessageActionBar.css";

const statusLabels: Record<Run["status"], string> = {
  queued: "排队中",
  assigned: "已分派",
  running: "工作中",
  waiting_approval: "等待批准",
  blocked: "受阻",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
};
export function MessageActionBar({
  message,
  onReply,
  onInspectRun,
  run,
  reactions,
  onReactionChange,
}: {
  message: Message;
  onReply(): void;
  onInspectRun?(runId: string): void;
  run?: Run | undefined;
  reactions: MessageReaction[];
  onReactionChange(emoji: ReactionEmoji, active: boolean): Promise<void>;
}) {
  const [open, setOpen] = useState<"emoji" | "more">(),
    [error, setError] = useState<string>(),
    [pending, setPending] = useState(false),
    [copied, setCopied] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const emojiButton = useRef<HTMLButtonElement>(null),
    moreButton = useRef<HTMLButtonElement>(null),
    popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const trigger = () => (open === "emoji" ? emojiButton.current : moreButton.current);
  const close = (restore = false) => {
    const target = trigger();
    setOpen(undefined);
    if (restore) target?.focus();
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = (
          open === "emoji" ? emojiButton.current : moreButton.current
        )?.getBoundingClientRect(),
        panel = popup.current?.getBoundingClientRect();
      if (!rect || !panel) return;
      const left = Math.max(
        8,
        Math.min(rect.right - panel.width, window.innerWidth - panel.width - 8),
      );
      const below = rect.bottom + 6;
      const top =
        below + panel.height <= window.innerHeight - 8
          ? below
          : Math.max(8, rect.top - panel.height - 6);
      setPosition({ left, top });
    };
    place();
    popup.current?.querySelector<HTMLButtonElement>("button")?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !popup.current?.contains(event.target) &&
        !emojiButton.current?.contains(event.target) &&
        !moreButton.current?.contains(event.target)
      )
        setOpen(undefined);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open]);
  const toggle = (kind: "emoji" | "more") => {
    setError(undefined);
    setCopied(false);
    setOpen(open === kind ? undefined : kind);
  };
  return (
    <>
      <div
        className={`message-action-bar ${message.authorType === "human" ? "for-human" : "for-bot"}`}
        data-open={open ? "true" : undefined}
      >
        <button
          ref={emojiButton}
          type="button"
          aria-label="添加回应"
          title="添加回应"
          aria-haspopup="menu"
          aria-expanded={open === "emoji"}
          aria-controls={open === "emoji" ? id : undefined}
          onClick={() => toggle("emoji")}
        >
          <ActionIcon kind="emoji" />
        </button>
        <button type="button" aria-label="回复" title="回复" onClick={onReply}>
          <ActionIcon kind="reply" />
        </button>
        <button
          ref={moreButton}
          type="button"
          aria-label="更多操作"
          title="更多操作"
          aria-haspopup="menu"
          aria-expanded={open === "more"}
          aria-controls={open === "more" ? id : undefined}
          onClick={() => toggle("more")}
        >
          <ActionIcon kind="more" />
        </button>
      </div>
      {open
        ? createPortal(
            <div
              id={id}
              ref={popup}
              className={`message-action-popover ${open === "emoji" ? "emoji-picker" : "more-menu"}`}
              role="menu"
              aria-label={open === "emoji" ? "选择回应" : "更多消息操作"}
              style={{ left: position.left, top: position.top }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  close(true);
                  return;
                }
                const buttons = Array.from(
                    popup.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ??
                      [],
                  ),
                  current = buttons.indexOf(document.activeElement as HTMLButtonElement);
                if (
                  ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(
                    event.key,
                  )
                ) {
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? buttons.length - 1
                        : (current +
                            (["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1) +
                            buttons.length) %
                          buttons.length;
                  buttons[next]?.focus();
                }
              }}
            >
              {open === "emoji" ? (
                reactionEmojis.map((emoji) => {
                  const active = reactions.some(
                    (item) => item.messageId === message.id && item.emoji === emoji,
                  );
                  return (
                    <button
                      key={emoji}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      aria-label={reactionLabels[emoji]}
                      title={reactionLabels[emoji]}
                      disabled={pending}
                      onClick={() => {
                        if (pending) return;
                        setPending(true);
                        setError(undefined);
                        void onReactionChange(emoji, !active)
                          .then(() => close(true))
                          .catch((cause: unknown) =>
                            setError(
                              cause instanceof Error ? cause.message : "回应未保存，请重试。",
                            ),
                          )
                          .finally(() => setPending(false));
                      }}
                    >
                      {emoji}
                    </button>
                  );
                })
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setError(undefined);
                      void Promise.resolve()
                        .then(() => {
                          if (!navigator.clipboard) throw new Error("Clipboard unavailable");
                          return navigator.clipboard;
                        })
                        .then((clipboard) => clipboard.writeText(message.content))
                        .then(() => setCopied(true))
                        .catch(() => setError("复制失败，请重试。"));
                    }}
                  >
                    {copied ? "已复制" : "复制"}
                  </button>
                  {run && onInspectRun ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onInspectRun(run.id);
                        close();
                      }}
                    >
                      任务详情 · {statusLabels[run.status]}
                    </button>
                  ) : null}
                  <time dateTime={message.createdAt}>
                    {new Date(message.createdAt).toLocaleString()}
                  </time>
                </>
              )}
              {error ? <p role="alert">{error}</p> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
function ActionIcon({ kind }: { kind: "emoji" | "reply" | "more" }) {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "emoji" ? (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M8.5 14.2c1.5 2 5.5 2 7 0M8.5 9h.01M15.5 9h.01" />
        </>
      ) : kind === "reply" ? (
        <path d="m9 5-6 5 6 5M3 10h10c5 0 8 3 8 8" />
      ) : (
        <>
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
        </>
      )}
    </svg>
  );
}
