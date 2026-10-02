import type { Bot, Channel } from "@openbot/domain";
import { useState } from "react";
import { ApiError } from "../api";
import { Dialog } from "./Dialog";
import { GroupAvatar } from "./GroupAvatar";
import { RobotAvatar } from "./RobotAvatar";

export interface DeleteIdentityTarget {
  kind: "channel" | "bot";
  id: string;
  name: string;
}

const serverMessages: Record<string, string> = {
  active_work_blocks_delete: "还有进行中的任务。请先停止或等待任务结束，再删除。",
  channel_not_found: "这个频道已经不存在。",
  bot_not_found: "这个 Bot 已经不存在。",
  direct_channel_identity_follows_bot: "单聊跟随 Bot，请删除对应的 Bot。",
};

/**
 * Permanent-delete confirmation (DialogDelete artboard). The Server decides what is removed and
 * refuses while work is active (ADR-0047); this dialog only names the target and makes the
 * irreversible scope explicit. Closing never deletes.
 */
export function DeleteIdentityDialog({
  target,
  bots = [],
  channels = [],
  onClose,
  onDelete,
}: {
  target: DeleteIdentityTarget;
  /** Workspace lists for the identity row; the dialog works without them. */
  bots?: readonly Bot[];
  channels?: readonly Channel[];
  onClose(): void;
  onDelete(target: DeleteIdentityTarget): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const isBot = target.kind === "bot";
  const noun = isBot ? "Bot" : "频道";
  const bot = isBot ? bots.find((item) => item.id === target.id) : undefined;
  const channel = isBot ? undefined : channels.find((item) => item.id === target.id);
  const members = channel
    ? channel.botIds.flatMap((id) => bots.filter((item) => item.id === id))
    : [];
  const channelCount = channels.filter(
    (item) => !item.directBotId && item.botIds.includes(target.id),
  ).length;
  const detail = bot
    ? [bot.role, channelCount > 0 ? `在 ${channelCount} 个频道里` : undefined]
        .filter(Boolean)
        .join(" · ")
    : channel
      ? `${members.length} 名 Bot`
      : undefined;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onDelete(target);
    } catch (cause) {
      setError(
        (cause instanceof ApiError && serverMessages[cause.message]) ||
          `没能删除这个${noun}，请稍后重试。`,
      );
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={isBot ? "永久删除这个 Bot？" : "永久删除这个频道？"}
      intro="删除后不能恢复。"
      width={480}
      className="delete-identity-dialog"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ob-pill is-large" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="ob-pill is-large is-danger"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? "正在删除…" : "永久删除"}
          </button>
        </>
      }
    >
      <div className="ob-dialog-identity">
        {bot ? (
          <RobotAvatar bot={bot} className="ob-dialog-identity-avatar" />
        ) : channel ? (
          <GroupAvatar name={channel.name} members={members} size={56} />
        ) : null}
        <span>
          <strong>{target.name}</strong>
          {detail ? <small>{detail}</small> : null}
        </span>
      </div>
      <ul className="ob-dialog-list">
        {isBot ? (
          <li>删除单聊、记忆、技能、例行任务和插件授权，并从所有频道移出。</li>
        ) : (
          <li>删除频道里的全部消息、回应和例行任务，成员会被移出。</li>
        )}
        <li>已完成任务的记录和审计会保留，显示为「已删除的{isBot ? " Bot" : "频道"}」。</li>
        <li className="is-danger">有进行中的任务时不能删除。此操作无法撤销。</li>
      </ul>
      {error ? (
        <p className="ob-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
