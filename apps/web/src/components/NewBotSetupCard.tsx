// 你最想让我先帮你做什么？ card (NewBotChat artboard) in a new Bot's empty 单聊; the answer sets its role.
import type { Bot } from "@openbot/domain";
import { type FormEvent, useState } from "react";
import { RobotAvatar } from "./RobotAvatar";
import "./NewBotSetupCard.css";

export interface RoleChoice {
  role: string;
  description: string;
  message: string;
}

const choices: Array<{ key: string; title: string; detail: string }> = [
  { key: "A", title: "写作与发布", detail: "负责成稿、改写、多平台适配" },
  { key: "B", title: "数据与复盘", detail: "汇总各渠道表现，找出哪些内容有效" },
  { key: "C", title: "个人助理", detail: "日程、待办、提醒、信息整理" },
];

/**
 * 「你最想让我先帮你做什么？」 (NewBotChat artboard), shown in a quick-created Bot's empty 单聊. It is
 * OpenBot's card, not the Bot speaking: the choice becomes the Bot's tag and role and is sent as the
 * Owner's first message. Nothing is saved until the Owner picks or writes an answer.
 */
export function NewBotSetupCard({
  bot,
  onChoose,
  onSkip,
}: {
  bot: Bot;
  onChoose(choice: RoleChoice): Promise<void>;
  onSkip(): void;
}) {
  const [own, setOwn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(choice: RoleChoice) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onChoose(choice);
    } catch {
      setError("没能保存分工，请重试。");
      setBusy(false);
    }
  }

  function submitOwn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const answer = own.trim();
    if (!answer) return;
    void submit({
      role: answer.slice(0, 40),
      description: answer.slice(0, 500),
      message: `我希望你负责：${answer}`,
    });
  }

  return (
    <div className="new-bot-setup">
      <RobotAvatar bot={bot} className="new-bot-setup-avatar" />
      <div className="new-bot-setup-body">
        <section className="new-bot-setup-card" aria-label="给新 Bot 定个分工" aria-busy={busy}>
          <header>
            <span>
              <strong>你最想让我先帮你做什么？</strong>
              <small>选一个最接近的，也可以直接写你的想法。</small>
            </span>
            <button type="button" aria-label="跳过" disabled={busy} onClick={onSkip}>
              <svg
                aria-hidden="true"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              >
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          </header>
          {choices.map((choice) => (
            <button
              type="button"
              className="new-bot-setup-choice"
              key={choice.key}
              disabled={busy}
              onClick={() =>
                void submit({
                  role: choice.title,
                  description: choice.detail,
                  message: `我希望你负责「${choice.title}」：${choice.detail}。`,
                })
              }
            >
              <span className="new-bot-setup-key" aria-hidden="true">
                {choice.key}
              </span>
              <span>
                <strong>{choice.title}</strong>
                <small>{choice.detail}</small>
              </span>
            </button>
          ))}
          <form onSubmit={submitOwn}>
            <input
              type="text"
              aria-label="自己的回答"
              placeholder="输入你自己的回答"
              maxLength={500}
              value={own}
              disabled={busy}
              onChange={(event) => setOwn(event.target.value)}
            />
          </form>
        </section>
        {error ? (
          <p className="new-bot-setup-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="new-bot-setup-note">
            选择后会把它设为这个 Bot 的标签和职责，并作为你的第一条消息发给它。
          </p>
        )}
      </div>
    </div>
  );
}
