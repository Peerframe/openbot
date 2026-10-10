// 分享 Bot 模板 dialog (DialogExport artboard): review the Server's redacted preview, then download
// that exact package. Preview parts are reused by the import dialog.
import type { Bot, EmployeeExportExclusion, EmployeeExportPreview } from "@openbot/domain";
import { useEffect, useState } from "react";
import { type ApiError, getEmployeeExportPreview } from "../api";
import { downloadEmployeeTemplate } from "../employee-template-delivery";
import { Dialog } from "./Dialog";
import { PortableProfileSummaryCard, PortableSkillList } from "./PortableEmployeeReview";
import { RobotAvatar } from "./RobotAvatar";

/**
 * 分享 Bot 模板 (DialogExport artboard). The 服务电脑 builds a redacted preview first; only that
 * reviewed package can be downloaded, and a package that changed since review is refused (412)
 * and re-previewed. Templates never carry identity, memory, authority or work history.
 */
export function ExportEmployeeDialog({
  employee,
  onClose,
  onDownloaded,
}: {
  employee: Bot;
  onClose(): void;
  onDownloaded(fileName: string): void;
}) {
  const [includeSkillContent, setIncludeSkillContent] = useState(true);
  const [preview, setPreview] = useState<EmployeeExportPreview>();
  const [error, setError] = useState<string>();
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    setPreview(undefined);
    void getEmployeeExportPreview(employee.id, controller.signal, includeSkillContent)
      .then((next) => {
        if (!controller.signal.aborted) setPreview(next);
      })
      .catch((cause: ApiError | DOMException) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause.message ?? "没能生成分享预览。");
      });
    return () => controller.abort();
  }, [employee.id, includeSkillContent]);

  async function download() {
    if (preview === undefined || preview.blocked) return;
    setDownloading(true);
    setError(undefined);
    try {
      const result = await downloadEmployeeTemplate(employee.id, preview);
      if (result === "saved") onDownloaded(preview.fileName);
    } catch (cause) {
      const apiError = cause as ApiError;
      if (apiError.status === 412) {
        setPreview(undefined);
        try {
          const refreshed = await getEmployeeExportPreview(
            employee.id,
            undefined,
            includeSkillContent,
          );
          setPreview(refreshed);
          setError("Bot 的内容在预览后变了，预览已刷新。请重新检查后再下载。");
        } catch (refreshCause) {
          setError((refreshCause as ApiError).message ?? "没能刷新分享预览。");
        }
      } else {
        setError(apiError.message ?? "下载 Bot 模板失败。");
      }
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Dialog
      title="分享 Bot 模板"
      intro="只打包角色、外观和审核过的技能，别人导入后得到自己的 Bot。"
      width={680}
      className="export-employee-dialog"
      onClose={onClose}
      footerStart={
        <label className="ob-dialog-option">
          <input
            type="checkbox"
            checked={includeSkillContent}
            disabled={downloading}
            onChange={(event) => {
              setPreview(undefined);
              setIncludeSkillContent(event.target.checked);
            }}
          />
          包含技能正文
        </label>
      }
      footer={
        <>
          <button type="button" className="ob-pill is-large" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="ob-pill is-large is-primary"
            disabled={preview === undefined || preview.blocked || downloading}
            onClick={() => void download()}
          >
            {downloading ? "正在下载…" : "下载 Bot 模板"}
          </button>
        </>
      }
    >
      <div className="ob-dialog-identity">
        <RobotAvatar bot={employee} className="ob-dialog-identity-avatar" />
        <span>
          <strong>{employee.name}</strong>
          <small>导入后会在对方那里创建一个新 Bot，零权限开始</small>
        </span>
      </div>
      {preview ? (
        <ExportPreviewDetails preview={preview} />
      ) : error === undefined ? (
        <p className="ob-dialog-loading" aria-live="polite">
          正在生成脱敏预览…
        </p>
      ) : null}
      {error ? (
        <p className="ob-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

export function DialogCheck({ on }: { on: boolean }) {
  return (
    <span className={`ob-dialog-check${on ? " is-on" : ""}`} aria-hidden="true">
      <svg
        aria-hidden="true"
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {on ? (
          <polyline points="5 12 10 17 19 7" />
        ) : (
          <>
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </>
        )}
      </svg>
    </span>
  );
}

export function shortChecksum(value: string) {
  const groups = value.replace(/[^0-9a-f]/gi, "").match(/.{1,4}/g) ?? [];
  return groups.length > 6
    ? `${groups.slice(0, 4).join(" ")} … ${groups.slice(-2).join(" ")}`
    : groups.join(" ");
}

/** What the reviewed package contains and leaves out, its signature state and checksum. */
export function ExportPreviewDetails({ preview }: { preview: EmployeeExportPreview }) {
  const skillNames = preview.skills.map((skill) => skill.name);
  return (
    <>
      <div className="ob-dialog-columns">
        <section>
          <h3>会包含</h3>
          <ul className="ob-dialog-checks">
            <li>
              <DialogCheck on />
              <span>
                <strong>职责与外观</strong>
                <small>
                  {preview.employee.name} · {preview.employee.role}
                </small>
              </span>
            </li>
            <li>
              <DialogCheck on />
              <span>
                <strong>已验证技能 · {preview.verifiedSkillCount}</strong>
                <small>
                  {skillNames.length > 0
                    ? `${skillNames.slice(0, 3).join("、")}${skillNames.length > 3 ? " …" : ""}`
                    : "没有已验证技能会进入模板"}
                </small>
              </span>
            </li>
            <li>
              <DialogCheck on />
              <span>
                <strong>需要的能力</strong>
                <small>
                  {preview.requestedCapabilities.length > 0
                    ? preview.requestedCapabilities.join("、")
                    : "不需要额外能力"}
                </small>
              </span>
            </li>
          </ul>
        </section>
        <section>
          <h3>不会包含</h3>
          <ul className="ob-dialog-checks">
            {preview.exclusions.map((exclusion) => (
              <li key={exclusion.category}>
                <DialogCheck on={false} />
                <span>
                  <strong>{exclusionLabels[exclusion.category]}</strong>
                  <small>{exclusionReasons[exclusion.category]}</small>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* The exact descriptive content leaving this 服务电脑, reviewable before download. */}
      <details className="ob-dialog-review">
        <summary>查看将分享的内容</summary>
        <PortableProfileSummaryCard
          employee={preview.employee}
          requestedCapabilities={preview.requestedCapabilities}
          headingId="export-profile-summary-title"
          note="这些说明会写进模板，但不会带上来源身份或电脑权限。"
        />
        <PortableSkillList
          skills={preview.skills}
          stateLabel="已验证，将包含"
          emptyLabel="没有已验证技能会进入模板。"
        />
      </details>

      {preview.findings.length > 0 ? (
        <section className="ob-dialog-notice is-danger" aria-label="阻止原因">
          <strong>分享内容需要处理</strong>
          <span>OpenBot 已阻止下载，请先修正下面的字段。</span>
          <ul>
            {preview.findings.map((finding) => (
              <li key={`${finding.code}:${finding.location}`}>
                <code>{finding.location}</code> {finding.message}
              </li>
            ))}
          </ul>
        </section>
      ) : preview.signatureStatus === "dsse" ? (
        <section className="ob-dialog-notice">
          <strong>已签名模板</strong>
          <span>
            由发布密钥 {preview.publisherKeyId ?? "未知"} 签名；对方仍需信任这个密钥并审核内容。
          </span>
        </section>
      ) : (
        <section className="ob-dialog-notice is-warning">
          <strong>未签名模板</strong>
          <span>这台服务电脑还没有发布密钥。对方导入时会看到「未签名」，需要自己确认来源。</span>
        </section>
      )}

      <div className="ob-dialog-checksum">
        <span>SHA-256</span>
        <code title={preview.checksum}>{shortChecksum(preview.checksum)}</code>
        <span className={preview.blocked ? "is-warning" : "is-ok"}>
          {preview.blocked ? "分享内容需要处理" : "分享内容检查已通过"}
        </span>
      </div>
    </>
  );
}

const exclusionLabels: Record<EmployeeExportExclusion["category"], string> = {
  identity: "来源身份",
  authority: "电脑权限与授权",
  memory: "记忆",
  "work-history": "工作与审计历史",
};

const exclusionReasons: Record<EmployeeExportExclusion["category"], string> = {
  identity: "来源 Bot 的编号和归属不会进入模板",
  authority: "不含主机绑定、审批、凭证、会话",
  memory: "不导出任何记忆",
  "work-history": "任务、决策、产出留在这台服务电脑",
};
