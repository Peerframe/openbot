import type { Artifact } from "@openbot/domain";
import { useEffect, useState } from "react";
import {
  downloadAttachment,
  extensionOf,
  formatAttachmentSize,
  updateAttachment,
} from "../channel-attachment-client";
import type { UploadedComposerAttachment } from "../composer-context";
import { ArtifactDownloadLink } from "./ArtifactCard";
import { Dialog } from "./Dialog";
import { sidebarTime } from "./Sidebar";
import "./AttachmentsManager.css";

const PAGE = 20;
type Source = "all" | "upload" | "output";

interface FileRow {
  key: string;
  name: string;
  meta: string;
  createdAt: string;
  upload?: UploadedComposerAttachment;
  output?: Artifact;
}

/** C19: how many messages and tasks still point at a file; absent on an older 服务电脑. */
export function referenceLabel(file: UploadedComposerAttachment): string | undefined {
  const count = file.referenceCount;
  if (!count) return undefined;
  const parts = [
    count.messages > 0 ? `${count.messages} 条消息引用` : "",
    count.tasks > 0 ? `${count.tasks} 个任务引用` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("、") : "没有消息或任务引用";
}

function processedLabel(file: UploadedComposerAttachment) {
  if (!file.processing) return undefined;
  return file.processing.operation === "transcribe" ? "已转写" : "已提取文字";
}

/**
 * 频道文件 (ChannelFiles artboard): the Owner's uploads and the Bots' outputs in one list, with a
 * 回收站 for uploads. In the 回收站 a file can no longer be read or newly referenced by Bots, and it
 * can be restored; the 服务电脑 offers no permanent cleanup, so neither does this dialog.
 */
export function AttachmentsManagerDialog({
  channelId,
  channelName,
  outputs = [],
  botNameForRun = () => undefined,
  onClose,
}: {
  channelId: string;
  channelName?: string | undefined;
  /** This channel's task outputs; they can be downloaded but not moved to the 回收站. */
  outputs?: Artifact[];
  botNameForRun?(runId: string): string | undefined;
  onClose(): void;
}) {
  const { files, setFiles, status } = useChannelAttachments(channelId);
  // Results of the Owner's own actions; kept apart from loading so a reload does not erase them.
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<"files" | "trash">("files");
  const [source, setSource] = useState<Source>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [busyId, setBusyId] = useState<string>();

  const uploads = files.filter((file) => !file.deletedAt);
  const trash = files.filter((file) => file.deletedAt);
  const rows: FileRow[] = [
    ...uploads.map((file) => ({
      key: `upload:${file.id}`,
      name: file.name,
      createdAt: file.createdAt,
      meta: [
        "你上传",
        sidebarTime(file.createdAt),
        formatAttachmentSize(file.sizeBytes),
        processedLabel(file),
        referenceLabel(file),
      ]
        .filter(Boolean)
        .join(" · "),
      upload: file,
    })),
    ...outputs.map((artifact) => ({
      key: `output:${artifact.id}`,
      name: artifact.name,
      createdAt: artifact.createdAt,
      meta: [
        `${botNameForRun(artifact.runId) ?? "Bot"} 产出`,
        sidebarTime(artifact.createdAt),
        formatAttachmentSize(artifact.sizeBytes),
      ].join(" · "),
      output: artifact,
    })),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const counts = {
    all: rows.length,
    upload: rows.filter((row) => row.upload).length,
    output: rows.filter((row) => row.output).length,
  };
  const needle = query.trim().toLocaleLowerCase();
  const matching = rows
    .filter((row) => source === "all" || (source === "upload" ? row.upload : row.output))
    .filter((row) => !needle || row.name.toLocaleLowerCase().includes(needle));
  const visible = matching.slice(0, limit);

  async function change(file: UploadedComposerAttachment, action: "delete" | "restore") {
    setBusyId(file.id);
    setNotice("");
    try {
      const next = await updateAttachment(file, action);
      setFiles((values) => values.map((item) => (item.id === next.id ? next : item)));
    } catch {
      setNotice(action === "delete" ? "没能移到回收站，请重试。" : "没能恢复，请重试。");
    } finally {
      setBusyId(undefined);
    }
  }

  async function download(file: UploadedComposerAttachment) {
    setNotice("");
    try {
      await downloadAttachment(file);
    } catch {
      setNotice("下载失败，请重试。");
    }
  }

  return (
    <Dialog
      title={channelName ? `${channelName} 的文件` : "频道文件"}
      intro="你上传的文件和 Bot 的产出。"
      width={640}
      className="channel-files-dialog"
      onClose={onClose}
      footerStart={
        <small className="channel-files-note">
          {/* C20 (#159): the 服务电脑 has no permanent cleanup, so none is offered. */}
          移到回收站后，Bot
          不能再读取或新引用这个文件，已发送的内容无法撤回。可以随时恢复；永久清理暂未提供。
        </small>
      }
    >
      <div className="ob-seg" role="tablist" aria-label="文件分区">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "files"}
          onClick={() => setTab("files")}
        >
          文件 · {rows.length}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "trash"}
          onClick={() => setTab("trash")}
        >
          回收站 · {trash.length}
        </button>
      </div>
      {tab === "files" ? (
        <div className="channel-files-tools">
          <fieldset className="channel-files-filters" aria-label="来源">
            {(
              [
                ["all", "全部"],
                ["upload", "你上传"],
                ["output", "Bot 产出"],
              ] as const
            ).map(([id, label]) => (
              <button
                type="button"
                key={id}
                aria-pressed={source === id}
                onClick={() => {
                  setSource(id);
                  setLimit(PAGE);
                }}
              >
                {label} {counts[id]}
              </button>
            ))}
          </fieldset>
          <input
            type="search"
            className="channel-files-search"
            placeholder="搜索文件名"
            aria-label="搜索文件名"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(PAGE);
            }}
          />
        </div>
      ) : null}
      {notice || status ? (
        <p className="channel-files-status" role="status">
          {notice || status}
        </p>
      ) : null}
      {tab === "files" ? (
        visible.length > 0 ? (
          <ul className="channel-files-list">
            {visible.map((row) => (
              <li key={row.key}>
                <span className="channel-files-badge" aria-hidden="true">
                  {extensionOf(row.name)}
                </span>
                <span className="channel-files-text">
                  <strong title={row.name}>{row.name}</strong>
                  <small>{row.meta}</small>
                </span>
                <span className="channel-files-actions">
                  {row.upload ? (
                    <>
                      <button
                        type="button"
                        className="ob-pill is-small"
                        onClick={() => row.upload && void download(row.upload)}
                      >
                        下载
                      </button>
                      <button
                        type="button"
                        className="ob-pill is-small"
                        disabled={busyId === row.upload.id}
                        onClick={() => row.upload && void change(row.upload, "delete")}
                      >
                        移到回收站
                      </button>
                    </>
                  ) : row.output ? (
                    <ArtifactDownloadLink
                      artifact={row.output}
                      className="ob-pill is-small"
                      downloadImage
                    >
                      下载
                    </ArtifactDownloadLink>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="channel-files-empty">
            {rows.length === 0
              ? "还没有文件。在消息里添加的附件和 Bot 的产出会出现在这里。"
              : "没有符合条件的文件。"}
          </p>
        )
      ) : trash.length > 0 ? (
        <ul className="channel-files-list is-trash">
          {trash.map((file) => (
            <li key={file.id}>
              <span className="channel-files-badge" aria-hidden="true">
                {extensionOf(file.name)}
              </span>
              <span className="channel-files-text">
                <strong title={file.name}>{file.name}</strong>
                <small>
                  {[
                    file.deletedAt ? `${sidebarTime(file.deletedAt)} 移到回收站` : "",
                    referenceLabel(file),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </span>
              <span className="channel-files-actions">
                <button
                  type="button"
                  className="ob-pill is-small"
                  disabled={busyId === file.id}
                  onClick={() => void change(file, "restore")}
                >
                  恢复
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="channel-files-empty">回收站是空的。</p>
      )}
      {tab === "files" && matching.length > visible.length ? (
        <button type="button" className="channel-files-more" onClick={() => setLimit(limit + PAGE)}>
          显示更多（还有 {matching.length - visible.length} 个）
        </button>
      ) : null}
    </Dialog>
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
