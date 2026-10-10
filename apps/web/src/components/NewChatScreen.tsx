// 新建聊天 screen (New and NewGroup artboards): pick recipients and write the first message; one Bot
// opens a 单聊, several a 频道. Nothing is created before the message is sent.
import type { Bot } from "@openbot/domain";
import {
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { highlightMatch } from "../sidebar-organization";
import { GroupAvatar } from "./GroupAvatar";
import { PlusIcon, SendIcon } from "./Icons";
import { RobotAvatar } from "./RobotAvatar";
import { useListScroll } from "./useListScroll";
import "./NewChatScreen.css";

/** The Server accepts at most six recipients per message (createMessageInputSchema). */
const MAX_RECIPIENTS = 6;

export interface NewChatStart {
  botIds: string[];
  /** True when the Owner chose 创建频道 or picked several Bots; one Bot otherwise opens a 单聊. */
  asChannel: boolean;
  channelName?: string | undefined;
  text: string;
}

type Option = { kind: "create-bot" } | { kind: "create-channel" } | { kind: "bot"; bot: Bot };

/**
 * 新建聊天 (New and NewGroup artboards). 「+」 opens this recipients list: 创建新 Bot ⌘1 creates one
 * immediately; 创建频道 ⌘2 switches to 频道 mode. One Bot is a 单聊; several — or any number after
 * 创建频道 — become a 频道 when the first message is sent. Nothing is created before that.
 */
export function NewChatScreen({
  bots,
  primaryBotId,
  initialChannelMode = false,
  onCreateBot,
  onStart,
  onClose,
}: {
  bots: Bot[];
  /** 主 Bot leads the recipients, crowned (PrimaryBot artboard). */
  primaryBotId?: string | null | undefined;
  initialChannelMode?: boolean;
  onCreateBot(): void | Promise<void>;
  onStart(start: NewChatStart): Promise<void>;
  onClose?: (() => void) | undefined;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [channelMode, setChannelMode] = useState(initialChannelMode);
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(true);
  const [active, setActive] = useState(0);
  const [naming, setNaming] = useState(false);
  const [channelName, setChannelName] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const search = useRef<HTMLInputElement>(null);
  const message = useRef<HTMLTextAreaElement>(null);
  const recipients = useRef<HTMLDivElement>(null);
  const optionsList = useRef<HTMLDivElement | null>(null);
  const botById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const term = query.trim().toLocaleLowerCase();
  const candidates = bots
    .filter(
      (bot) =>
        !selected.includes(bot.id) &&
        (!term || `${bot.name} ${bot.role}`.toLocaleLowerCase().includes(term)),
    )
    .sort((a, b) => Number(b.id === primaryBotId) - Number(a.id === primaryBotId));
  // The two actions lead the list only before anything is chosen (New artboard); afterwards the
  // list holds the remaining Bots, numbered from ⌘1 (NewGroup artboard).
  const showActions = selected.length === 0 && !channelMode && !term;
  const options: Option[] = [
    ...(showActions ? ([{ kind: "create-bot" }, { kind: "create-channel" }] as Option[]) : []),
    ...candidates.map((bot): Option => ({ kind: "bot", bot })),
  ];
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const optionsRef = useListScroll(activeIndex);
  const chosen = selected.flatMap((id) => {
    const bot = botById.get(id);
    return bot ? [bot] : [];
  });
  const names = chosen.map((bot) => bot.name).join("、");
  const asChannel = channelMode || chosen.length > 1;

  useEffect(() => {
    search.current?.focus();
  }, []);

  // A press anywhere outside the field and the list closes it, as in the reference recording;
  // clicking or typing in the field opens it again.
  useEffect(() => {
    if (!pickerOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (recipients.current?.contains(target) || optionsList.current?.contains(target)) return;
      setPickerOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [pickerOpen]);

  function choose(bot: Bot) {
    if (selected.length >= MAX_RECIPIENTS) {
      setError(`一次最多选择 ${MAX_RECIPIENTS} 个 Bot。`);
      return;
    }
    setSelected((current) => [...current, bot.id]);
    setQuery("");
    setActive(0);
    setError(undefined);
    search.current?.focus();
  }

  async function createBot() {
    if (creating) return;
    setCreating(true);
    setError(undefined);
    try {
      await onCreateBot();
    } catch {
      setError("没能创建 Bot，请稍后重试。");
      setCreating(false);
    }
  }

  function pick(index: number) {
    const option = options[index];
    if (!option) return;
    if (option.kind === "create-bot") void createBot();
    else if (option.kind === "create-channel") {
      setChannelMode(true);
      setActive(0);
      search.current?.focus();
    } else choose(option.bot);
  }

  function onShortcut(event: KeyboardEvent<HTMLElement>) {
    if (!(event.metaKey || event.ctrlKey) || !/^[1-9]$/.test(event.key)) return false;
    event.preventDefault();
    pick(Number(event.key) - 1);
    return true;
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (onShortcut(event)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setPickerOpen(true);
      const count = Math.max(1, options.length);
      setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (pickerOpen) pick(activeIndex);
    } else if (event.key === "Backspace" && !query && selected.length > 0) {
      setSelected((current) => current.slice(0, -1));
    } else if (event.key === "Escape") {
      setPickerOpen(false);
    } else {
      setPickerOpen(true);
    }
  }

  async function send() {
    const content = text.trim();
    if (!content || selected.length === 0 || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await onStart({
        botIds: selected,
        asChannel,
        channelName: asChannel ? channelName.trim() || undefined : undefined,
        text: content,
      });
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      setError(
        code === "name_already_exists"
          ? "已有同名的频道，请换一个名字。"
          : "无法发送，请稍后重试。",
      );
      setSending(false);
    }
  }

  return (
    <main className="workspace-main new-chat" aria-label="新建聊天">
      <div className="new-chat-recipients" ref={recipients}>
        <span className="new-chat-label" aria-hidden="true">
          收件人：
        </span>
        {chosen.map((bot) => (
          <span className="new-chat-chip" key={bot.id}>
            <RobotAvatar bot={bot} compact />
            {bot.name}
            <button
              type="button"
              aria-label={`移除 ${bot.name}`}
              onClick={() => setSelected((current) => current.filter((id) => id !== bot.id))}
            >
              <svg
                aria-hidden="true"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </span>
        ))}
        <input
          ref={search}
          type="text"
          role="combobox"
          aria-label="收件人"
          aria-expanded={pickerOpen}
          aria-controls="new-chat-options"
          aria-activedescendant={pickerOpen ? `new-chat-option-${activeIndex}` : undefined}
          placeholder={chosen.length > 0 || channelMode ? "继续添加 Bot…" : "和谁聊？输入名字搜索"}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setPickerOpen(true);
          }}
          onFocus={() => setPickerOpen(true)}
          onClick={() => setPickerOpen(true)}
          onKeyDown={onSearchKeyDown}
        />
        {onClose ? (
          <button
            type="button"
            className="new-chat-close"
            aria-label="关闭新建聊天"
            onClick={onClose}
          >
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        ) : null}
      </div>

      {pickerOpen ? (
        <div
          className="new-chat-options"
          role="listbox"
          id="new-chat-options"
          ref={(element) => {
            optionsList.current = element;
            optionsRef(element);
          }}
          aria-label="选择收件人"
        >
          {options.map((option, index) => {
            // Reference recording: the shortcut shows on the highlighted row only; ⌘1–9 still work
            // for every row (aria-keyshortcuts).
            const shortcut = index < 9 && activeIndex === index ? <Keys index={index} /> : <span />;
            const common = {
              type: "button" as const,
              role: "option",
              id: `new-chat-option-${index}`,
              "aria-selected": activeIndex === index,
              "aria-keyshortcuts": index < 9 ? `Meta+${index + 1} Control+${index + 1}` : undefined,
              className: "new-chat-option",
              onMouseDown: (event: MouseEvent) => event.preventDefault(),
              onClick: () => pick(index),
            };
            if (option.kind === "create-bot")
              return (
                <button {...common} key="create-bot" disabled={creating}>
                  <span className="new-chat-create" aria-hidden="true">
                    <PlusIcon />
                  </span>
                  <span>{creating ? "正在创建…" : "创建新 Bot"}</span>
                  {shortcut}
                </button>
              );
            if (option.kind === "create-channel")
              return (
                <Fragment key="create-channel">
                  <button {...common}>
                    <span className="new-chat-create" aria-hidden="true">
                      <PeopleIcon />
                    </span>
                    <span>创建频道</span>
                    {shortcut}
                  </button>
                  <span className="new-chat-divider" aria-hidden="true" />
                </Fragment>
              );
            return (
              <button {...common} key={option.bot.id}>
                <RobotAvatar
                  bot={option.bot}
                  className="new-chat-option-avatar"
                  crown={option.bot.id === primaryBotId}
                />
                <span>
                  <span className="new-chat-bot-name">
                    <Match text={option.bot.name} query={query} />
                  </span>
                  {option.bot.role ? <small>{option.bot.role}</small> : null}
                </span>
                {shortcut}
              </button>
            );
          })}
          {candidates.length === 0 && !showActions ? (
            <p className="new-chat-empty">
              {bots.length === 0 ? "还没有 Bot，先创建一个。" : "没有匹配的 Bot"}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="new-chat-space">
        {asChannel && chosen.length > 0 ? (
          naming ? (
            <label className="new-chat-name">
              <span className="visually-hidden">频道名称</span>
              <input
                value={channelName}
                maxLength={80}
                placeholder={names.slice(0, 80)}
                onChange={(event) => setChannelName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    setNaming(false);
                    message.current?.focus();
                  }
                }}
              />
              <button type="button" className="ob-pill is-small" onClick={() => setNaming(false)}>
                完成
              </button>
            </label>
          ) : (
            <p className="new-chat-hint is-channel">
              <GroupAvatar name={channelName.trim() || names} members={chosen} size={26} />
              选了 {chosen.length} 个 Bot，发出第一条消息后建成频道
              {channelName.trim() ? `「${channelName.trim()}」` : ""} ·{" "}
              <button type="button" onClick={() => setNaming(true)}>
                命名频道
              </button>
            </p>
          )
        ) : chosen.length === 1 ? (
          <p className="new-chat-hint">发出第一条消息后会打开和 {chosen[0]?.name} 的单聊</p>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <form
        className="new-chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="new-chat-composer-row">
          <button
            type="button"
            className="ob-round"
            aria-label="添加附件"
            title="发出第一条消息后可以添加附件"
            disabled
          >
            <PlusIcon />
          </button>
          <textarea
            ref={message}
            aria-label="消息内容"
            rows={1}
            maxLength={8000}
            value={text}
            disabled={chosen.length === 0}
            placeholder={chosen.length ? `发消息给 ${names}` : "先选收件人"}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (onShortcut(event)) return;
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="submit"
            className="ob-round is-send"
            aria-label="发送消息"
            disabled={sending || !text.trim() || chosen.length === 0}
          >
            {sending ? <span aria-hidden="true">…</span> : <SendIcon />}
          </button>
        </div>
      </form>
    </main>
  );
}

function PeopleIcon() {
  return (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c.6-3.1 2.8-5 5.5-5s4.9 1.9 5.5 5" />
      <path d="M15.5 5.2a3 3 0 0 1 0 5.6" />
      <path d="M17.5 14.3c1.6.6 2.7 2.2 3 4.7" />
    </svg>
  );
}

function Keys({ index }: { index: number }) {
  return (
    <span className="new-chat-keys" aria-hidden="true">
      <kbd>⌘</kbd>
      <kbd>{index + 1}</kbd>
    </span>
  );
}

function Match({ text, query }: { text: string; query: string }) {
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
