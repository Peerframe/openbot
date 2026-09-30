import { useState } from "react";
import { ApiError } from "../api";
import { CloseIcon } from "./Icons";
import { useModalDialog } from "./useModalDialog";

export interface DeleteIdentityTarget {
  kind: "channel" | "bot";
  id: string;
  name: string;
}

const serverMessages: Record<string, string> = {
  active_work_blocks_delete: "还有进行中的任务。请先停止或等待任务结束，再删除。",
  channel_not_found: "这个频道已经不存在。",
  bot_not_found: "这个 Bot 已经不存在。",
  direct_channel_identity_follows_bot: "单独对话跟随 Bot，请删除对应的 Bot。",
};

/**
 * Permanent-delete confirmation. The Server decides what is removed and refuses while work is
 * active (ADR-0047); this dialog only makes the irreversible scope explicit and names the target.
 */
export function DeleteIdentityDialog({
  target,
  onClose,
  onDelete,
}: {
  target: DeleteIdentityTarget;
  onClose(): void;
  onDelete(target: DeleteIdentityTarget): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { dialogRef, closeDialog } = useModalDialog(onClose);
  const noun = target.kind === "channel" ? "频道" : "Bot";
  // Chinese copy puts a space around the Latin "Bot" but not around "频道".
  const action = target.kind === "channel" ? "永久删除频道" : "永久删除 Bot";

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onDelete(target);
    } catch (cause) {
      setError(
        (cause instanceof ApiError && serverMessages[cause.message]) ||
          `无法删除这个${noun}，请稍后重试。`,
      );
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop">
      <dialog
        ref={dialogRef}
        className="create-dialog delete-identity-dialog"
        aria-labelledby="delete-identity-title"
        aria-describedby="delete-identity-scope"
      >
        <header className="dialog-header">
          <div>
            <h2 id="delete-identity-title">
              {action}「{target.name}」？
            </h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={closeDialog}>
            <CloseIcon />
          </button>
        </header>
        <div className="delete-identity-body" id="delete-identity-scope">
          {target.kind === "channel" ? (
            <ul>
              <li>删除频道里的全部消息、回应和自动任务，成员会被移出。</li>
              <li>已完成任务的记录和审计会保留，显示为「已删除的频道」。</li>
            </ul>
          ) : (
            <ul>
              <li>删除与它的单独对话、记忆、技能、自动任务和插件授权，并从所有频道移出。</li>
              <li>已完成任务的记录和审计会保留，显示为「已删除的 Bot」。</li>
            </ul>
          )}
          <p>此操作无法撤销。有进行中的任务时无法删除。</p>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="dialog-actions">
          <button className="secondary-button" type="button" onClick={closeDialog}>
            取消
          </button>
          <button className="danger-button" type="button" disabled={busy} onClick={confirm}>
            {busy ? "正在删除…" : action}
          </button>
        </footer>
      </dialog>
    </div>
  );
}
