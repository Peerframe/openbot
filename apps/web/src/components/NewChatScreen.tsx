import type { Bot } from "@openbot/domain";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { highlightMatch } from "../sidebar-organization";
import { PlusIcon, SendIcon } from "./Icons";
import { RobotAvatar } from "./RobotAvatar";
import "./NewChatScreen.css";

/** The Server accepts at most six recipients per message (createMessageInputSchema). */
const MAX_RECIPIENTS = 6;

export interface NewChatStart {
  botIds: string[];
  /** Only for two or more Bots; a channel is created on the first message. */
  channelName?: string | undefined;
  text: string;
}

/**
 * New artboard: pick recipients, then the first message opens the direct conversation (one Bot)
 * or creates a channel with the chosen Bots. Nothing is created until the message is sent.
 */
export function NewChatScreen({
  bots,
  onCreateBot,
  onStart,
}: {
  bots: Bot[];
  onCreateBot(): void;
  onStart(start: NewChatStart): Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(true);
  const [active, setActive] = useState(0);
  const [naming, setNaming] = useState(false);
  const [channelName, setChannelName] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const search = useRef<HTMLInputElement>(null);
  const message = useRef<HTMLTextAreaElement>(null);
  const botById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const term = query.trim().toLocaleLowerCase();
  const candidates = bots.filter(
    (bot) =>
      !selected.includes(bot.id) &&
      (!term || `${bot.name} ${bot.role}`.toLocaleLowerCase().includes(term)),
  );
  // Option 0 is 「创建新 Bot」; Bots follow, the first eight reachable with ⌘2–⌘9.
  const optionCount = candidates.length + 1;
  const activeIndex = Math.min(active, optionCount - 1);
  const chosen = selected.flatMap((id) => {
    const bot = botById.get(id);
    return bot ? [bot] : [];
  });
  const names = chosen.map((bot) => bot.name).join("、");

  useEffect(() => {
    search.current?.focus();
  }, []);

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

  function pick(index: number) {
    if (index === 0) {
      onCreateBot();
      return;
    }
    const bot = candidates[index - 1];
    if (bot) choose(bot);
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
      setActive(
        (index) => (index + (event.key === "ArrowDown" ? 1 : -1) + optionCount) % optionCount,
      );
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
        channelName: selected.length > 1 ? channelName.trim() || undefined : undefined,
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
      <div className="new-chat-recipients">
        <span className="new-chat-label" aria-hidden="true">
          收件人：
        </span>
        {chosen.map((bot) => (
          <span className="new-chat-chip" key={bot.id}>
            <RobotAvatar bot={bot} compact />
            {bot.name}
            <button
              type="button"
              aria-label={`移除${bot.name}`}
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
          aria-label="搜索或创建 Bot"
          aria-expanded={pickerOpen}
          aria-controls="new-chat-options"
          aria-activedescendant={pickerOpen ? `new-chat-option-${activeIndex}` : undefined}
          placeholder="搜索或创建 Bot"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            // While searching, Enter picks the first matching Bot rather than 「创建新 Bot」.
            setActive(event.target.value.trim() ? 1 : 0);
            setPickerOpen(true);
          }}
          onFocus={() => setPickerOpen(true)}
          onKeyDown={onSearchKeyDown}
        />
      </div>

      {pickerOpen ? (
        <div
          className="new-chat-options"
          role="listbox"
          id="new-chat-options"
          aria-label="选择 Bot"
        >
          <button
            type="button"
            role="option"
            id="new-chat-option-0"
            aria-selected={activeIndex === 0}
            aria-keyshortcuts="Meta+1 Control+1"
            className="new-chat-option"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => pick(0)}
          >
            <span className="new-chat-create" aria-hidden="true">
              <PlusIcon />
            </span>
            <span>创建新 Bot</span>
            <Keys index={0} />
          </button>
          {candidates.map((bot, index) => (
            <button
              type="button"
              role="option"
              id={`new-chat-option-${index + 1}`}
              key={bot.id}
              aria-selected={activeIndex === index + 1}
              aria-keyshortcuts={index < 8 ? `Meta+${index + 2} Control+${index + 2}` : undefined}
              className="new-chat-option"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(bot)}
            >
              <span className="new-chat-avatar" aria-hidden="true">
                <RobotAvatar bot={bot} compact />
              </span>
              <span>
                <span className="new-chat-bot-name">
                  <Match text={bot.name} query={query} />
                </span>
                {bot.role ? <small>{bot.role}</small> : null}
              </span>
              {index < 8 ? <Keys index={index + 1} /> : <span />}
            </button>
          ))}
          {candidates.length === 0 ? (
            <p className="new-chat-empty">
              {bots.length === 0 ? "还没有 Bot，先创建一个。" : "没有匹配的 Bot"}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="new-chat-space">
        {chosen.length > 1 ? (
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
            <p className="new-chat-hint">
              选了 {chosen.length} 个 Bot，发出第一条消息后会建成一个频道
              {channelName.trim() ? `「${channelName.trim()}」` : ""} ·{" "}
              <button type="button" onClick={() => setNaming(true)}>
                命名频道
              </button>
            </p>
          )
        ) : chosen.length === 1 ? (
          <p className="new-chat-hint">发出第一条消息后会打开和 {chosen[0]?.name} 的单独对话</p>
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
            placeholder={chosen.length ? `发消息给 ${names}` : "先选择收件人"}
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
