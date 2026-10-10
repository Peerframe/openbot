// 频道文件 dialog (ChannelFiles artboard): uploads and Bot outputs, the 回收站, permanent delete and
// 查看引用. Also exports the hook that loads a channel's attachment list.
import type { Artifact } from "@openbot/domain";
import { useEffect, useState } from "react";
import {
  AttachmentCommandError,
  type AttachmentReferences,
  cleanupChannelTrash,
  downloadAttachment,
  extensionOf,
  formatAttachmentSize,
  getAttachmentReferences,
  purgeAttachment,
  updateAttachment,
} from "../channel-attachment-client";
import type { UploadedComposerAttachment } from "../composer-context";
import { runStatusLabel } from "../run-state";
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

/** Files the 服务电脑 reports as referenced; an older 服务电脑 without counts decides by itself. */
function isReferenced(file: UploadedComposerAttachment) {
  const count = file.referenceCount;
  return count !== undefined && count.messages + count.tasks > 0;
}

function trashReferenceLabel(file: UploadedComposerAttachment): string | undefined {
  if (!file.referenceCount) return undefined;
  return isReferenced(file) ? referenceLabel(file) : "没有引用";
}

function keptNote(file: UploadedComposerAttachment): string {
  return file.referenceCount && file.referenceCount.messages > 0
    ? "还有消息在引用它，不能永久删除。先删掉那些消息，或者留着它。"
    : "还有任务在引用它，不能永久删除。";
}

const totalSize = (files: UploadedComposerAttachment[]) =>
  formatAttachmentSize(files.reduce((sum, file) => sum + file.sizeBytes, 0));

/** A transport failure leaves the outcome unknown; a refusal from the 服务电脑 does not. */
const unclear = (cause: unknown) => !(cause instanceof AttachmentCommandError);

type Purge =
  | { kind: "one"; file: UploadedComposerAttachment }
  | { kind: "all"; requestKey: string; unclear?: boolean };

function processedLabel(file: UploadedComposerAttachment) {
  if (!file.processing) return undefined;
  return file.processing.operation === "transcribe" ? "已转写" : "已提取文字";
}

/**
 * 频道文件 (ChannelFiles artboard): the Owner's uploads and the Bots' outputs in one list, with a
 * 回收站 for uploads. In the 回收站 a file can no longer be read or newly referenced by Bots; it can
 * be restored or, after a confirmation, permanently deleted (C21). The 服务电脑 keeps referenced
 * files and audits every deletion; this dialog only asks.
 */
export function AttachmentsManagerDialog({
  channelId,
  channelName,
  outputs = [],
  botNameForRun = () => undefined,
  botName = () => undefined,
  initialTab = "files",
  onClose,
  onShowMessage,
  onShowTask,
}: {
  channelId: string;
  initialTab?: "files" | "trash";
  channelName?: string | undefined;
  /** This channel's task outputs; they can be downloaded but not moved to the 回收站. */
  outputs?: Artifact[];
  botNameForRun?(runId: string): string | undefined;
  botName?: ((botId: string) => string | undefined) | undefined;
  /** C24: open a referencing message in the conversation; without it the list is read-only. */
  onShowMessage?: ((messageId: string) => void) | undefined;
  onShowTask?: ((runId: string) => void) | undefined;
  onClose(): void;
}) {
  const [revision, setRevision] = useState(0);
  const { files, setFiles, status } = useChannelAttachments(channelId, revision);
  // Results of the Owner's own actions; kept apart from loading so a reload does not erase them.
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<"files" | "trash">(initialTab);
  const [purge, setPurge] = useState<Purge>();
  const [purging, setPurging] = useState(false);
  const [purgeError, setPurgeError] = useState("");
  const [referencesOpen, setReferencesOpen] = useState<string>();
  const [source, setSource] = useState<Source>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [busyId, setBusyId] = useState<string>();

  const uploads = files.filter((file) => !file.deletedAt);
  const trash = files.filter((file) => file.deletedAt);
  const removable = trash.filter((file) => !isReferenced(file));
  const kept = trash.filter(isReferenced);
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

  async function confirmPurge(target: Purge) {
    setPurging(true);
    setPurgeError("");
    try {
      if (target.kind === "one") {
        const result = await purgeAttachment(channelId, target.file.id);
        setFiles((values) => values.filter((item) => item.id !== result.id));
        setNotice(
          `已永久删除「${target.file.name}」，释放 ${formatAttachmentSize(result.freedBytes)}。`,
        );
      } else {
        const result = await cleanupChannelTrash(channelId, target.requestKey);
        setNotice(
          [
            `已永久删除 ${result.removed} 个文件，释放 ${formatAttachmentSize(result.freedBytes)}。`,
            result.retainedCount > 0 ? `${result.retainedCount} 个还被引用，已保留。` : "",
          ].join(""),
        );
        setRevision((value) => value + 1);
      }
      setPurge(undefined);
    } catch (cause) {
      if (target.kind === "all" && unclear(cause)) {
        // The same key replays the saved outcome, so 重试 cannot delete twice.
        setPurge({ ...target, unclear: true });
        setPurgeError("没能确认是否已经删除。点「重试」会接着同一次清理，不会重复删除。");
        return;
      }
      setPurge(undefined);
      if (cause instanceof AttachmentCommandError && cause.code === "attachment_referenced") {
        const count = cause.referenceCount;
        if (target.kind === "one" && count)
          setFiles((values) =>
            values.map((item) =>
              item.id === target.file.id ? { ...item, referenceCount: count } : item,
            ),
          );
        setNotice("这个文件刚被消息或任务引用，已保留。");
      } else if (
        cause instanceof AttachmentCommandError &&
        cause.code === "attachment_not_in_trash"
      ) {
        setNotice("这个文件已经不在回收站了。");
        setRevision((value) => value + 1);
      } else if (unclear(cause)) {
        setNotice("没能确认是否已经删除，已重新读取回收站。");
        setRevision((value) => value + 1);
      } else {
        setNotice("没能永久删除，请稍后重试。");
      }
    } finally {
      setPurging(false);
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
          {tab === "trash"
            ? "回收站里的文件 Bot 不能再读取。永久删除不能恢复；还被消息或任务引用的会保留。"
            : "移到回收站后，Bot 不能再读取或新引用这个文件，已发送的内容无法撤回。在回收站里可以恢复，也可以永久删除。"}
        </small>
      }
      footer={
        tab === "trash" && trash.length > 0 ? (
          <button
            type="button"
            className="ob-pill is-danger is-soft"
            disabled={removable.length === 0 || purging}
            onClick={() => {
              setPurgeError("");
              setPurge({ kind: "all", requestKey: crypto.randomUUID() });
            }}
          >
            清空回收站（{removable.length} 个 · {totalSize(removable)}）
          </button>
        ) : undefined
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
                  {file.deletedAt ? `${sidebarTime(file.deletedAt)} 移到回收站 · ` : ""}
                  {formatAttachmentSize(file.sizeBytes)}
                  {trashReferenceLabel(file) ? " · " : ""}
                  {isReferenced(file) ? (
                    <span className="is-warning">{trashReferenceLabel(file)}</span>
                  ) : (
                    trashReferenceLabel(file)
                  )}
                </small>
              </span>
              <span className="channel-files-actions">
                <button
                  type="button"
                  className="ob-pill is-small"
                  disabled={busyId === file.id || purging}
                  onClick={() => void change(file, "restore")}
                >
                  恢复
                </button>
                <button
                  type="button"
                  className="ob-pill is-small is-danger is-soft"
                  disabled={isReferenced(file) || busyId === file.id || purging}
                  aria-describedby={isReferenced(file) ? `kept-${file.id}` : undefined}
                  onClick={() => {
                    setPurgeError("");
                    setPurge({ kind: "one", file });
                  }}
                >
                  永久删除
                </button>
              </span>
              {isReferenced(file) ? (
                <p className="channel-files-kept" id={`kept-${file.id}`}>
                  {keptNote(file)}
                  <button
                    type="button"
                    className="channel-files-references-toggle"
                    aria-expanded={referencesOpen === file.id}
                    onClick={() =>
                      setReferencesOpen((current) => (current === file.id ? undefined : file.id))
                    }
                  >
                    {referencesOpen === file.id ? "收起引用" : "查看引用 ›"}
                  </button>
                </p>
              ) : null}
              {referencesOpen === file.id ? (
                <ReferenceList
                  channelId={channelId}
                  file={file}
                  botName={botName}
                  onShowMessage={onShowMessage}
                  onShowTask={onShowTask}
                />
              ) : null}
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
      {purge ? (
        <PurgeConfirm
          files={purge.kind === "one" ? [purge.file] : removable}
          kept={purge.kind === "one" ? [] : kept}
          busy={purging}
          retry={purge.kind === "all" && purge.unclear === true}
          error={purgeError}
          onCancel={() => {
            setPurge(undefined);
            if (purge.kind === "all" && purge.unclear) setRevision((value) => value + 1);
          }}
          onConfirm={() => void confirmPurge(purge)}
        />
      ) : null}
    </Dialog>
  );
}

function authorLabel(
  author: AttachmentReferences["messages"][number]["author"],
  botName: (botId: string) => string | undefined,
): string {
  if (author.kind === "owner") return "你";
  if (author.kind === "system") return "系统消息";
  return (author.botId && botName(author.botId)) || "Bot";
}

/**
 * C24 查看引用: the messages and tasks that keep a file, newest first. Choosing one leaves the
 * dialog for the conversation or 任务详情; the 服务电脑 sends previews only, never full content.
 */
function ReferenceList({
  channelId,
  file,
  botName,
  onShowMessage,
  onShowTask,
}: {
  channelId: string;
  file: UploadedComposerAttachment;
  botName: (botId: string) => string | undefined;
  onShowMessage?: ((messageId: string) => void) | undefined;
  onShowTask?: ((runId: string) => void) | undefined;
}) {
  const [references, setReferences] = useState<AttachmentReferences>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getAttachmentReferences(channelId, file.id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setReferences(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [channelId, file.id]);
  if (failed)
    return <p className="channel-files-references is-status">没能读取引用，请稍后再试。</p>;
  if (!references) return <p className="channel-files-references is-status">正在读取引用…</p>;
  const shown = references.messages.length + references.tasks.length;
  const total = references.messageCount + references.taskCount;
  return (
    <ul className="channel-files-references" aria-label={`引用 ${file.name} 的消息和任务`}>
      {references.messages.map((message) => (
        <li key={message.id}>
          <button
            type="button"
            disabled={!onShowMessage}
            onClick={() => onShowMessage?.(message.id)}
          >
            <strong>
              {authorLabel(message.author, botName)} · {sidebarTime(message.createdAt)}
            </strong>
            <small>{message.preview || "（只有附件）"}</small>
          </button>
        </li>
      ))}
      {references.tasks.map((task) => (
        <li key={task.runId}>
          <button type="button" disabled={!onShowTask} onClick={() => onShowTask?.(task.runId)}>
            <strong>
              任务 · {runStatusLabel(task.status as Parameters<typeof runStatusLabel>[0])}
            </strong>
            <small>{task.title}</small>
          </button>
        </li>
      ))}
      {references.hasMore ? (
        <li className="is-status">还有 {total - shown} 条更早的引用没有列出。</li>
      ) : null}
    </ul>
  );
}

/** ChannelFilesTrash artboard: the second confirmation before anything is permanently deleted. */
function PurgeConfirm({
  files,
  kept,
  busy,
  retry,
  error,
  onCancel,
  onConfirm,
}: {
  files: UploadedComposerAttachment[];
  kept: UploadedComposerAttachment[];
  busy: boolean;
  retry: boolean;
  error: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  const names = files.slice(0, 3).map((file) => file.name);
  const more = files.length - names.length;
  return (
    <Dialog
      title={
        files.length === 1 ? `永久删除「${files[0]?.name}」？` : `永久删除 ${files.length} 个文件？`
      }
      width={400}
      className="channel-files-confirm"
      onClose={busy ? () => undefined : onCancel}
      footer={
        <>
          <button type="button" className="ob-pill" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button type="button" className="ob-pill is-danger" disabled={busy} onClick={onConfirm}>
            {busy ? "正在删除…" : retry ? "重试" : "永久删除"}
          </button>
        </>
      }
    >
      <p className="channel-files-confirm-text">
        {files.length > 1 ? `${names.join("、")}${more > 0 ? ` 等 ${files.length} 个` : ""}，` : ""}
        共 {totalSize(files)}。删除后不能恢复，会记入审计。
      </p>
      {kept.length > 0 ? (
        <small className="channel-files-confirm-kept">
          {kept.length === 1
            ? `「${kept[0]?.name}」还被 ${kept[0] ? referenceLabel(kept[0]) : ""}，会保留。`
            : `${kept.length} 个还被消息或任务引用的文件会保留。`}
        </small>
      ) : null}
      {error ? (
        <p className="ob-dialog-error" role="alert">
          {error}
        </p>
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
