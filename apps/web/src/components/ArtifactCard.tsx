import type { Artifact } from "@openbot/domain";
import { type ReactNode, useState } from "react";
import { getArtifactShellSaver } from "../artifact-shell-save";

export function ArtifactCard({
  artifact,
  downloadImage = false,
}: {
  artifact: Artifact;
  downloadImage?: boolean;
}) {
  const image = artifact.mediaType === "image/png";
  return (
    <ArtifactDownloadLink
      artifact={artifact}
      downloadImage={downloadImage}
      className={image ? "artifact-card" : "artifact-card artifact-card-document"}
    >
      {image ? (
        <img
          src={`/api/v1/artifacts/${encodeURIComponent(artifact.id)}/content`}
          alt={artifact.name}
          loading="lazy"
        />
      ) : (
        <span className="artifact-document-icon" aria-hidden="true">
          MD
        </span>
      )}
      <span className="artifact-card-label">
        <strong>{artifact.name}</strong>
        <small>
          {image ? "图片" : "Markdown 报告"} · {formatBytes(artifact.sizeBytes)}
          {image && !downloadImage ? "" : " · 下载"}
        </small>
      </span>
    </ArtifactDownloadLink>
  );
}

export function ArtifactDownloadLink({
  artifact,
  children,
  className,
  downloadImage = false,
}: {
  artifact: Artifact;
  children: ReactNode;
  className?: string;
  downloadImage?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string>();
  const image = artifact.mediaType === "image/png";
  const preview = image && !downloadImage;
  const label = image ? "图片" : "报告";
  return (
    <>
      <a
        className={className}
        href={`/api/v1/artifacts/${encodeURIComponent(artifact.id)}/content`}
        download={preview ? undefined : artifact.name}
        target={preview ? "_blank" : undefined}
        rel={preview ? "noreferrer" : undefined}
        aria-label={preview ? `查看 ${artifact.name}` : `下载 ${artifact.name}`}
        aria-busy={saving || undefined}
        onClick={async (event) => {
          const shellSaver = getArtifactShellSaver();
          if (preview || !shellSaver) return;
          event.preventDefault();
          if (saving) return;
          setSaving(true);
          setNotice(undefined);
          try {
            const status = await shellSaver.save(artifact.id);
            setNotice(
              status === "saved"
                ? `${label}已保存`
                : status === "cancelled"
                  ? undefined
                  : status === "exists"
                    ? "文件已存在，请换一个文件名。"
                    : status === "busy"
                      ? "请先完成当前保存操作。"
                      : `无法保存${label}，请检查连接或更新 Desktop。`,
            );
          } catch {
            setNotice(`无法保存${label}，请检查连接后重试。`);
          } finally {
            setSaving(false);
          }
        }}
      >
        {children}
      </a>
      {notice ? (
        <small className="artifact-save-notice" role="status">
          {notice}
        </small>
      ) : null}
    </>
  );
}

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;
}
