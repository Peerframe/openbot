// Composer attachment strip: pick, drag-drop or paste files, upload them and show the draft's
// attachments, within the per-message limit of 8 files and 20 MB.
import { type RefObject, useEffect, useRef, useState } from "react";
import { extensionOf, formatAttachmentSize, middleEllipsis } from "../channel-attachment-client";
import {
  COMPOSER_ATTACHMENT_ACCEPT,
  type ComposerAttachment,
  MAX_COMPOSER_ATTACHMENT_BYTES,
  MAX_COMPOSER_ATTACHMENTS,
  uploadComposerAttachment,
  validateComposerAttachmentBatch,
} from "../composer-context";
import { AttachmentActions } from "./AttachmentActions";
import { AttachmentPreview } from "./AttachmentPreview";
import "./MessageAttachments.css";

export interface ComposerAttachmentPickerProps {
  channelId: string;
  attachments: ComposerAttachment[];
  getAttachments(): ComposerAttachment[];
  onChange(next: ComposerAttachment[]): void;
  inputRef: RefObject<HTMLInputElement | null>;
  disabled?: boolean;
  dropTargetRef?: RefObject<HTMLElement | null>;
  onUploadingChange?(busy: boolean): void;
}

function attachmentBytes(attachment: ComposerAttachment) {
  return attachment.sizeBytes ?? new TextEncoder().encode(attachment.text).byteLength;
}

/** Whether the draft has reached the per-message limits (8 attachments, 20 MB in total). */
export function composerAttachmentsFull(attachments: ComposerAttachment[]) {
  return (
    attachments.length >= MAX_COMPOSER_ATTACHMENTS ||
    attachments.reduce((sum, item) => sum + attachmentBytes(item), 0) >=
      MAX_COMPOSER_ATTACHMENT_BYTES
  );
}

export function ComposerAttachmentPicker(props: ComposerAttachmentPickerProps) {
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploadName, setUploadName] = useState<string>();
  const [error, setError] = useState<string>();
  const [retryFiles, setRetryFiles] = useState<File[]>([]);
  const latest = useRef(props);
  latest.current = props;
  const pending = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    setError(undefined);
    setRetryFiles([]);
    setUploading(false);
    setDragging(false);
    setUploadName(undefined);
    return () => {
      pending.current?.abort(new Error(`Attachment channel ${props.channelId} changed or closed.`));
      pending.current = undefined;
      latest.current.onUploadingChange?.(false);
    };
  }, [props.channelId]);

  async function upload(files: File[]) {
    if (!files.length || pending.current || latest.current.disabled) return;
    setError(undefined);
    setRetryFiles([]);
    const controller = new AbortController();
    pending.current = controller;
    const channelId = latest.current.channelId;
    setUploading(true);
    latest.current.onUploadingChange?.(true);
    try {
      validateComposerAttachmentBatch(latest.current.getAttachments(), files);
      const failures: string[] = [];
      const failedFiles: File[] = [];
      for (const file of files) {
        if (controller.signal.aborted || latest.current.channelId !== channelId) return;
        setUploadName(file.name);
        try {
          const uploaded = await uploadComposerAttachment(channelId, file, controller.signal);
          if (controller.signal.aborted || latest.current.channelId !== channelId) return;
          // Append to the current list: an upload must never resurrect an older draft.
          const current = latest.current.getAttachments();
          validateComposerAttachmentBatch(current, [file]);
          latest.current.onChange([...current, uploaded]);
        } catch (cause) {
          if (controller.signal.aborted) return;
          failedFiles.push(file);
          failures.push(
            `${file.name}：${cause instanceof Error ? cause.message : "附件上传失败。"}`,
          );
        }
      }
      if (failures.length) {
        setRetryFiles(failedFiles);
        setError(failures.join("；"));
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "附件上传失败。");
    } finally {
      if (pending.current === controller) {
        pending.current = undefined;
        setUploading(false);
        setUploadName(undefined);
        latest.current.onUploadingChange?.(false);
      }
    }
  }
  const uploadLatest = useRef(upload);
  uploadLatest.current = upload;
  useEffect(() => {
    const target = props.dropTargetRef?.current;
    const channelId = props.channelId;
    if (!target) return;
    let depth = 0;
    const hasFiles = (transfer: DataTransfer | null) =>
      Boolean(
        transfer &&
          (Array.from(transfer.types ?? []).includes("Files") ||
            Array.from(transfer.items ?? []).some((item) => item.kind === "file") ||
            transfer.files.length),
      );
    const clearDrag = () => {
      depth = 0;
      target.classList.remove("attachment-drop-active");
      setDragging(false);
    };
    const enter = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth += 1;
      if (!latest.current.disabled && !pending.current) {
        target.classList.add("attachment-drop-active");
        setDragging(true);
      }
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer)
        event.dataTransfer.dropEffect =
          latest.current.disabled || pending.current ? "none" : "copy";
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      depth -= 1;
      if (depth <= 0) clearDrag();
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      // Even when disabled or busy, prevent the browser from navigating to a dropped file.
      event.preventDefault();
      clearDrag();
      if (latest.current.channelId === channelId)
        void uploadLatest.current(Array.from(event.dataTransfer?.files ?? []));
    };
    const paste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (!files.length) return; // Preserve ordinary text paste and editing semantics.
      event.preventDefault();
      const names = new Set(latest.current.getAttachments().map((item) => item.name));
      const normalized = files.map((file) => {
        if (!/^image\.(png|jpe?g)$/iu.test(file.name) && file.name) return file;
        if (!/^image\/(png|jpeg)$/u.test(file.type)) return file;
        let index = 1;
        const extension = file.type === "image/png" ? "png" : "jpg";
        let name = `粘贴图片-${index}.${extension}`;
        while (names.has(name)) name = `粘贴图片-${++index}.${extension}`;
        names.add(name);
        return new File([file], name, { type: file.type, lastModified: file.lastModified });
      });
      void uploadLatest.current(normalized);
    };
    target.addEventListener("dragenter", enter);
    target.addEventListener("dragover", over);
    target.addEventListener("dragleave", leave);
    target.addEventListener("drop", drop);
    target.addEventListener("paste", paste);
    return () => {
      target.removeEventListener("dragenter", enter);
      target.removeEventListener("dragover", over);
      target.removeEventListener("dragleave", leave);
      target.removeEventListener("drop", drop);
      target.removeEventListener("paste", paste);
      target.classList.remove("attachment-drop-active");
    };
  }, [props.dropTargetRef, props.channelId]);

  return (
    <>
      <input
        hidden
        ref={props.inputRef}
        type="file"
        multiple
        accept={COMPOSER_ATTACHMENT_ACCEPT}
        aria-label="选择附件"
        disabled={props.disabled || uploading}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void upload(files);
        }}
      />
      {dragging ? (
        <div className="attachment-drop-hint" role="status">
          松开以添加附件
        </div>
      ) : null}
      {props.attachments.length > 0 || uploading ? (
        <div className="composer-attachment-list">
          {props.attachments.map((attachment, index) => (
            <span
              className="composer-attachment-card"
              key={attachment.id ?? `${attachment.name}-${index}`}
            >
              {attachment.id ? (
                <AttachmentPreview attachment={attachment} />
              ) : (
                <span className="attachment-file-icon" aria-hidden="true">
                  {extensionOf(attachment.name)}
                </span>
              )}
              <span className="attachment-card-name" title={attachment.name}>
                {middleEllipsis(attachment.name)}
              </span>
              <small>{formatAttachmentSize(attachmentBytes(attachment))}</small>
              {attachment.id ? (
                <AttachmentActions
                  attachment={attachment}
                  onChange={(next) =>
                    latest.current.onChange(
                      latest.current
                        .getAttachments()
                        .map((item) => (item.id === next.id ? next : item)),
                    )
                  }
                />
              ) : null}
              <button
                type="button"
                className="attachment-remove-button"
                aria-label={`移除附件 ${attachment.name}`}
                disabled={props.disabled}
                onClick={() =>
                  latest.current.onChange(
                    latest.current.getAttachments().filter((item) => item !== attachment),
                  )
                }
              >
                ×
              </button>
            </span>
          ))}
          {uploading ? (
            <span className="composer-attachment-card is-uploading">
              <span className="attachment-file-icon" aria-hidden="true">
                {uploadName ? extensionOf(uploadName) : "…"}
              </span>
              {uploadName ? (
                <span className="attachment-card-name" title={uploadName}>
                  {middleEllipsis(uploadName)}
                </span>
              ) : null}
              <small role="status">
                <span className="visually-hidden">
                  正在上传{uploadName ? ` ${uploadName}` : "附件"}
                </span>
                上传中…
              </small>
              <button
                type="button"
                className="attachment-remove-button"
                aria-label="取消上传"
                onClick={() => {
                  pending.current?.abort();
                  pending.current = undefined;
                  setUploading(false);
                  setUploadName(undefined);
                  latest.current.onUploadingChange?.(false);
                  setError(
                    "已取消剩余上传。已加入草稿的附件会保留；服务电脑已收到的原件可在附件管理中查看。",
                  );
                }}
              >
                ×
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
      {props.attachments.length > 0 ? (
        <small className="composer-attachment-count">
          {props.attachments.length} / {MAX_COMPOSER_ATTACHMENTS} 个附件 · 合计{" "}
          {formatAttachmentSize(
            props.attachments.reduce((sum, item) => sum + attachmentBytes(item), 0),
          )}{" "}
          / 20 MB
          {composerAttachmentsFull(props.attachments) ? " · 已到上限" : ""}
        </small>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
          {retryFiles.length > 0 ? (
            <button
              type="button"
              disabled={uploading || props.disabled}
              onClick={() => void upload(retryFiles)}
            >
              重试失败的附件
            </button>
          ) : null}
        </p>
      ) : null}
    </>
  );
}
