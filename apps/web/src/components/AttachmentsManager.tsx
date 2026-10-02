import { useEffect, useId, useRef, useState } from "react";
import { formatAttachmentSize } from "../channel-attachment-client";
import type { UploadedComposerAttachment } from "../composer-context";
import { AttachmentActions } from "./AttachmentActions";
import { useModalDialog } from "./useModalDialog";
import "./AttachmentsManager.css";

export function AttachmentsManagerDialog({
  channelId,
  onClose,
}: {
  channelId: string;
  onClose(): void;
}) {
  const { dialogRef, closeDialog } = useModalDialog(onClose);
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, []);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the shared native-dialog cancel handler supplies the Escape equivalent for backdrop dismissal.
    <dialog
      ref={dialogRef}
      className="channel-files-dialog"
      aria-labelledby={titleId}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          closeDialog();
      }}
    >
      <header>
        <h2 id={titleId} ref={title} tabIndex={-1}>
          频道文件
        </h2>
        <button type="button" onClick={closeDialog} aria-label="关闭频道文件">
          关闭
        </button>
      </header>
      <AttachmentsManager channelId={channelId} />
    </dialog>
  );
}

/**
 * The channel's uploaded files from the Server's bounded listing. Entries that claim another channel
 * reject the whole response rather than being filtered, because the Server scopes the listing.
 */
export function useChannelAttachments(channelId: string, revision = 0) {
  const [files, setFiles] = useState<UploadedComposerAttachment[]>([]);
  const [status, setStatus] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setStatus("正在加载…");
    void fetch(`/api/v1/channels/${encodeURIComponent(channelId)}/attachments`, {
      credentials: "include",
      cache: revision > 0 ? "reload" : "default",
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("附件列表加载失败。");
        const data = (await response.json()) as { attachments: UploadedComposerAttachment[] };
        if (
          !Array.isArray(data.attachments) ||
          data.attachments.length > 1024 ||
          data.attachments.some((file) => file.channelId !== channelId)
        )
          throw new Error("附件列表与频道不匹配。");
        if (!controller.signal.aborted) {
          setFiles(data.attachments);
          setStatus("");
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setStatus(error instanceof Error ? error.message : "附件加载失败。");
      });
    return () => controller.abort();
  }, [channelId, revision]);
  return { files, setFiles, status, setStatus };
}

export function AttachmentsManager({ channelId }: { channelId: string }) {
  const [trash, setTrash] = useState(false);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const { files, setFiles, status, setStatus } = useChannelAttachments(channelId, revision);
  async function cleanup() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/channels/${encodeURIComponent(channelId)}/attachments/cleanup`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ olderThanDays: 7 }),
        },
      );
      if (!response.ok) throw new Error("清理未完成：服务暂不可用或无法确认附件引用。");
      const result = (await response.json()) as { removed: number; retained: number };
      setStatus(`已清理 ${result.removed} 个附件，${result.retained} 个仍被任务或消息引用。`);
      setRevision((value) => value + 1);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "清理失败。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="频道文件" className="channel-files-manager">
      <div>
        <button type="button" aria-pressed={!trash} onClick={() => setTrash(false)}>
          可用附件
        </button>
        <button type="button" aria-pressed={trash} onClick={() => setTrash(true)}>
          回收站
        </button>
      </div>
      {trash ? (
        <>
          <p>
            回收站中的附件仍为已有任务保留原文件。永久清理只删除移入回收站超过 7
            天、且不再被任务或消息引用的附件。
          </p>
          <button type="button" disabled={busy} onClick={() => void cleanup()}>
            清理符合条件的附件
          </button>
        </>
      ) : null}
      <p role="status">{status}</p>
      {files
        .filter((file) => Boolean(file.deletedAt) === trash)
        .map((file) => (
          <article key={file.id}>
            <strong>{file.name}</strong>
            <small>{formatAttachmentSize(file.sizeBytes)}</small>
            <AttachmentActions
              attachment={file}
              lifecycle
              onChange={(next) =>
                setFiles((values) => values.map((item) => (item.id === next.id ? next : item)))
              }
            />
          </article>
        ))}
      {!status && !files.some((file) => Boolean(file.deletedAt) === trash) ? (
        <p>这里还没有附件。</p>
      ) : null}
    </section>
  );
}
