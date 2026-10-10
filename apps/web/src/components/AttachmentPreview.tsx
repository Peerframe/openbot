// Attachment thumbnail: PNG/JPEG files load as an image that expands in a modal; other files show
// their extension badge.
import { useEffect, useState } from "react";
import { extensionOf, getAttachmentImage } from "../channel-attachment-client";
import type { UploadedComposerAttachment } from "../composer-context";
import { useModalDialog } from "./useModalDialog";

export function AttachmentPreview({ attachment }: { attachment: UploadedComposerAttachment }) {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<{ id: string; channelId: string; url: string }>();
  useEffect(() => {
    if (attachment.mediaType !== "image/png" && attachment.mediaType !== "image/jpeg") return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void getAttachmentImage(attachment, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview({ id: attachment.id, channelId: attachment.channelId, url: objectUrl });
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment]);
  const url =
    preview?.id === attachment.id && preview.channelId === attachment.channelId
      ? preview.url
      : undefined;
  return url ? (
    <>
      <button
        className="attachment-image-button"
        type="button"
        aria-label={`预览 ${attachment.name}`}
        onClick={() => setExpanded(true)}
      >
        <img className="attachment-thumbnail" src={url} alt={attachment.name} />
      </button>
      {expanded ? (
        <AttachmentImageDialog
          name={attachment.name}
          url={url}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </>
  ) : (
    <span className="attachment-file-icon" aria-hidden="true">
      {extensionOf(attachment.name)}
    </span>
  );
}

function AttachmentImageDialog({
  name,
  url,
  onClose,
}: {
  name: string;
  url: string;
  onClose(): void;
}) {
  const { dialogRef, closeDialog } = useModalDialog(onClose);
  return (
    <dialog ref={dialogRef} className="attachment-image-dialog" aria-label={`图片预览 ${name}`}>
      <header>
        <strong>{name}</strong>
        <button type="button" className="ob-round" aria-label="关闭图片预览" onClick={closeDialog}>
          ×
        </button>
      </header>
      <img src={url} alt={name} />
    </dialog>
  );
}
