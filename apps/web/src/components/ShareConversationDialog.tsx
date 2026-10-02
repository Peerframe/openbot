import type { Artifact, Bot, Channel, Run } from "@openbot/domain";
import { useEffect, useRef, useState } from "react";
import { ArtifactDownloadLink } from "./ArtifactCard";
import { Dialog } from "./Dialog";
import { RobotAvatar } from "./RobotAvatar";
import { extensionOf } from "./TaskCard";

type Tab = "files" | "bots";

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 分享 (DialogShare artboard): save this 频道's outputs, or pack one of its Bots as a template.
 * Sharing only produces files the Owner saves; nothing is sent to anyone or published. Only
 * outputs of tasks in this 频道 and its own Bots are listed; transcripts are never loaded.
 */
export function ShareConversationDialog({
  channel,
  bots,
  artifacts,
  runs,
  onShareBot,
  onClose,
}: {
  channel: Channel;
  bots: Bot[];
  artifacts: Artifact[];
  runs: Run[];
  onShareBot(botId: string): void;
  onClose(): void;
}) {
  const [tab, setTab] = useState<Tab>("files");
  const [preview, setPreview] = useState<Artifact>();
  const [text, setText] = useState("");
  const [previewState, setPreviewState] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const members = bots.filter((bot) => channel.botIds.includes(bot.id));
  const runById = new Map(
    runs.filter((run) => run.channelId === channel.id).map((run) => [run.id, run]),
  );
  const files = artifacts
    .filter((artifact) => runById.has(artifact.runId))
    .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));

  useEffect(() => {
    setText("");
    if (!preview) return;
    const controller = new AbortController();
    setPreviewState("正在读取文件…");
    void fetch(`/api/v1/artifacts/${encodeURIComponent(preview.id)}/content`, {
      credentials: "include",
      signal: controller.signal,
      redirect: "error",
    })
      .then(async (response) => {
        if (!response.ok || response.headers.get("content-type") !== "text/markdown")
          throw new Error("无法读取文件。");
        const content = await response.text();
        if (controller.signal.aborted) return;
        setText(content);
        setPreviewState("");
      })
      .catch(() => {
        if (!controller.signal.aborted) setPreviewState("无法读取文件，请重新预览。");
      });
    return () => controller.abort();
  }, [preview]);

  return (
    <Dialog
      title="分享"
      intro="保存频道里的产出，或把一个 Bot 打包成模板给别人导入。"
      width={640}
      className="share-dialog"
      onClose={onClose}
    >
      <div className="ob-seg" role="tablist" aria-label="分享内容">
        {(
          [
            ["files", "产出文件"],
            ["bots", "Bot 模板"],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            role="tab"
            key={id}
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "files" ? (
        <>
          <section className="ob-dialog-section" aria-labelledby="share-files-title">
            <h3 id="share-files-title">这个频道最近的产出 · {files.length}</h3>
            {files.length === 0 ? (
              <p className="ob-dialog-empty">还没有产出。Bot 完成任务后，文件会出现在这里。</p>
            ) : (
              <ul className="ob-dialog-rows">
                {files.map((artifact) => {
                  const run = runById.get(artifact.runId);
                  const author = bots.find((bot) => bot.id === run?.botId)?.name;
                  return (
                    <li key={artifact.id}>
                      <span className="ob-dialog-file-type" aria-hidden="true">
                        {extensionOf(artifact.name)}
                      </span>
                      <span>
                        <strong>{artifact.name}</strong>
                        <small>
                          {[
                            author,
                            artifact.createdAt
                              ? timeFormatter.format(new Date(artifact.createdAt))
                              : undefined,
                            formatSize(artifact.sizeBytes),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      </span>
                      <span className="ob-dialog-row-actions">
                        {artifact.mediaType === "text/markdown" ? (
                          <button
                            type="button"
                            className="ob-pill is-small"
                            onClick={() => setPreview({ ...artifact })}
                          >
                            预览
                          </button>
                        ) : null}
                        <ArtifactDownloadLink
                          artifact={artifact}
                          downloadImage
                          className="ob-pill is-small"
                        >
                          保存
                        </ArtifactDownloadLink>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {preview ? (
            <section className="ob-dialog-preview" aria-label="文件预览">
              <small>预览 · {preview.name}</small>
              {previewState ? (
                <p role="status" className="ob-dialog-loading">
                  {previewState}
                </p>
              ) : null}
              <textarea ref={textarea} aria-label="文件内容预览" value={text} readOnly rows={8} />
              <span className="ob-dialog-row-actions">
                <button
                  type="button"
                  className="ob-pill"
                  disabled={!text}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(text);
                      setPreviewState("已复制文件内容。");
                    } catch {
                      textarea.current?.select();
                      setPreviewState("请用系统复制快捷键复制已选中的内容。");
                    }
                  }}
                >
                  复制内容
                </button>
                <ArtifactDownloadLink artifact={preview} className="ob-pill is-primary">
                  保存为 Markdown
                </ArtifactDownloadLink>
              </span>
            </section>
          ) : null}
        </>
      ) : (
        <section className="ob-dialog-section" aria-labelledby="share-bots-title">
          <h3 id="share-bots-title">这个频道的 Bot · {members.length}</h3>
          {members.length === 0 ? (
            <p className="ob-dialog-empty">先在这个频道加入一个 Bot。</p>
          ) : (
            <ul className="ob-dialog-rows">
              {members.map((bot) => (
                <li key={bot.id}>
                  <RobotAvatar bot={bot} className="ob-dialog-row-avatar" />
                  <span>
                    <strong>{bot.name}</strong>
                    <small>{bot.role || "还没有分工"}</small>
                  </span>
                  <button
                    type="button"
                    className="ob-pill is-small"
                    onClick={() => onShareBot(bot.id)}
                  >
                    打包模板
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="ob-dialog-empty">
            包含角色、外观和已验证技能；记忆、密钥与电脑权限不会打包。
          </p>
        </section>
      )}

      <small className="ob-dialog-foot-note">
        分享只会生成你能保存的文件，不会发给任何人，也不会公开链接。
      </small>
    </Dialog>
  );
}
