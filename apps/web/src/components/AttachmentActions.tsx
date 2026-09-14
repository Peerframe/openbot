import type { AttachmentOperation } from "@openbot/protocol";
import { useEffect, useRef, useState } from "react";
import {
  downloadAttachment,
  presentAttachmentProcessError,
  updateAttachment,
} from "../channel-attachment-client";
import type { UploadedComposerAttachment } from "../composer-context";

export function AttachmentActions({
  attachment,
  onChange,
  lifecycle = false,
}: {
  attachment: UploadedComposerAttachment;
  onChange(value: UploadedComposerAttachment): void;
  lifecycle?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const pending = useRef<AbortController | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Switching attachment identity must cancel pending work and clear its password.
  useEffect(() => {
    setBusy(false);
    setError("");
    setPassword("");
    return () => {
      pending.current?.abort();
      pending.current = undefined;
    };
  }, [attachment.id]);
  const image = attachment.mediaType.startsWith("image/");
  const media =
    attachment.mediaType.startsWith("audio/") || attachment.mediaType.startsWith("video/");
  const operation = media ? "transcribe" : image ? "ocr" : "extract";
  async function run(action: AttachmentOperation | "delete" | "restore" | "download") {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    const suppliedPassword = password;
    setPassword("");
    try {
      if (action === "download") await downloadAttachment(attachment);
      else {
        const next = await updateAttachment(
          attachment,
          action,
          suppliedPassword || undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) onChange(next);
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? presentAttachmentProcessError(cause.message) : "附件操作失败。",
        );
    } finally {
      if (pending.current === controller) {
        pending.current = undefined;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }
  return (
    <details className="attachment-actions">
      <summary>附件操作</summary>
      <div className="attachment-actions-body">
        {attachment.processing ? (
          <small>
            已{attachment.processing.operation === "transcribe" ? "转写" : "提取"}{" "}
            {attachment.processing.characters} 字符
            {attachment.processing.truncated ? "（内容已截断）" : ""}
          </small>
        ) : null}
        {attachment.mediaType !== "text/plain" && !attachment.deletedAt ? (
          <>
            {attachment.mediaType === "application/pdf" ? (
              <label>
                PDF 密码（需要时填写）
                <input
                  type="password"
                  autoComplete="off"
                  value={password}
                  disabled={busy}
                  maxLength={256}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            ) : null}
            {media ? (
              <small>点击转写会将此媒体发送给已配置的 OpenAI；原文件仍保留在当前 Server。</small>
            ) : null}
            <button type="button" disabled={busy} onClick={() => void run(operation)}>
              {busy
                ? "正在处理…"
                : media
                  ? "发送至 OpenAI 转写"
                  : image
                    ? "识别图片文字"
                    : "提取文档文字"}
            </button>
          </>
        ) : null}
        <button type="button" disabled={busy} onClick={() => void run("download")}>
          下载原文件
        </button>
        {lifecycle ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(attachment.deletedAt ? "restore" : "delete")}
          >
            {attachment.deletedAt ? "恢复附件" : "移到回收站"}
          </button>
        ) : null}
        {busy ? (
          <button
            type="button"
            onClick={() => {
              pending.current?.abort();
              pending.current = undefined;
              setBusy(false);
            }}
          >
            取消处理
          </button>
        ) : null}
        {error ? <span role="alert">{error}</span> : null}
      </div>
    </details>
  );
}
