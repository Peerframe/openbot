// A message's text plus its attachment cards; each card loads the file and shows a placeholder once
// the file has been permanently deleted.
import type { Bot } from "@openbot/domain";
import { type ReactNode, useEffect, useState } from "react";
import {
  AttachmentPurgedError,
  formatAttachmentSize,
  getChannelAttachment,
  splitMessageAttachments,
} from "../channel-attachment-client";
import type { UploadedComposerAttachment } from "../composer-context";
import { AttachmentActions } from "./AttachmentActions";
import { AttachmentPreview } from "./AttachmentPreview";
import { RichMessage } from "./RichMessage";
import "./MessageAttachments.css";

export function MessageAttachments({
  content,
  channelId,
  mentions,
  leading,
}: {
  content: string;
  channelId: string;
  mentions?: readonly Bot[] | undefined;
  leading?: ReactNode;
}) {
  const { text, ids } = splitMessageAttachments(content);
  return (
    <>
      {text || leading ? (
        <RichMessage content={text} mentions={mentions} leading={leading} />
      ) : null}
      {ids.length ? (
        <section className="message-attachments" aria-label="消息附件">
          {ids.map((id) => (
            <MessageAttachmentCard key={`${channelId}:${id}`} channelId={channelId} id={id} />
          ))}
        </section>
      ) : null}
    </>
  );
}

function MessageAttachmentCard({ channelId, id }: { channelId: string; id: string }) {
  const [attachment, setAttachment] = useState<UploadedComposerAttachment>();
  const [failed, setFailed] = useState<"unavailable" | "purged">();
  useEffect(() => {
    const controller = new AbortController();
    void getChannelAttachment(channelId, id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setAttachment(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setFailed(cause instanceof AttachmentPurgedError ? "purged" : "unavailable");
      });
    return () => controller.abort();
  }, [channelId, id]);
  if (failed === "purged")
    return (
      <article className="message-attachment-card is-purged" aria-label="附件已永久删除">
        <span className="message-attachment-gone" aria-hidden="true">
          —
        </span>
        <span className="attachment-card-caption">附件已永久删除</span>
      </article>
    );
  return (
    <article
      className="message-attachment-card"
      aria-label={attachment ? `附件 ${attachment.name}` : "附件"}
    >
      {attachment ? (
        <>
          <AttachmentPreview attachment={attachment} />
          <span className="attachment-card-caption">
            <strong title={attachment.name}>{attachment.name}</strong>
            <small>{formatAttachmentSize(attachment.sizeBytes)}</small>
          </span>
          <AttachmentActions attachment={attachment} onChange={setAttachment} lifecycle />
        </>
      ) : (
        <span className="attachment-card-caption">
          {failed ? "附件暂不可用或无权访问" : "正在加载附件…"}
        </span>
      )}
    </article>
  );
}
