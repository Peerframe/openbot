import type { MessageReaction, ReactionEmoji } from "@openbot/domain";
import { useState } from "react";
import "./MessageReactions.css";
export const reactionLabels: Record<ReactionEmoji, string> = {
  "👍": "赞同",
  "❤️": "喜欢",
  "😂": "好笑",
  "🎉": "庆祝",
  "🤔": "思考",
  "👀": "关注",
};
/** Only persisted Owner choices appear below a bubble; the picker belongs to the action bar. */
export function MessageReactions({
  messageId,
  reactions,
  onChange,
}: {
  messageId: string;
  reactions: MessageReaction[];
  onChange(emoji: ReactionEmoji, active: boolean): Promise<void>;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string>();
  const selected = reactions.filter((item) => item.messageId === messageId);
  if (!selected.length && !error) return null;
  return (
    <div className="message-reactions">
      {selected.map((item) => (
        <button
          key={item.emoji}
          type="button"
          className="message-reaction-chip"
          aria-pressed="true"
          aria-label={`取消我的${reactionLabels[item.emoji]}回应`}
          title={`你：${reactionLabels[item.emoji]}`}
          disabled={pending}
          onClick={() => {
            if (pending) return;
            setPending(true);
            setError(undefined);
            void onChange(item.emoji, false)
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : "回应未保存，请重试。"),
              )
              .finally(() => setPending(false));
          }}
        >
          {item.emoji}
          <span className="visually-hidden">我的回应</span>
        </button>
      ))}
      {error ? (
        <span className="message-reaction-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
