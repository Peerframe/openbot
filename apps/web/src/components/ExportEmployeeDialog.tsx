import type { Bot, EmployeeExportExclusion, EmployeeExportPreview } from "@openbot/domain";
import { useEffect, useState } from "react";
import { type ApiError, getEmployeeExportPreview } from "../api";
import { downloadEmployeeTemplate } from "../employee-template-delivery";
import { CloseIcon } from "./Icons";
import { PortableProfileSummaryCard, PortableSkillList } from "./PortableEmployeeReview";
import { RobotAvatar } from "./RobotAvatar";
import { useModalDialog } from "./useModalDialog";

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
  const { dialogRef, closeDialog } = useModalDialog(onClose);

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
        setError(cause.message ?? "无法生成导出预览。");
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
          setError("员工内容在审核后发生变化，预览已刷新。请重新检查后再下载。");
        } catch (refreshCause) {
          setError((refreshCause as ApiError).message ?? "无法刷新员工导出预览。");
        }
      } else {
        setError(apiError.message ?? "下载 Bot 失败。");
      }
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="dialog-backdrop">
      <dialog
        ref={dialogRef}
        className="create-dialog export-employee-dialog"
        aria-labelledby="export-title"
      >
        <header className="dialog-header">
          <div>
            <h2 id="export-title">分享 Bot</h2>
            <p>分享角色、外观和经过审核的技能，让对方创建自己的 Bot。</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={closeDialog}>
            <CloseIcon />
          </button>
        </header>

        <section className="export-employee-identity">
          <RobotAvatar bot={employee} status={employee.status} />
          <div>
            <strong>{employee.name}</strong>
            <span>{employee.role}</span>
          </div>
        </section>

        <label className="export-content-choice">
          <input
            type="checkbox"
            checked={includeSkillContent}
            disabled={downloading}
            onChange={(event) => {
              setPreview(undefined);
              setIncludeSkillContent(event.target.checked);
            }}
          />
          包含已审核的 SKILL.md 正文（需允许分发的许可；导入后重新审核）
        </label>
        {preview === undefined && error === undefined ? (
          <section className="export-preview-loading" aria-live="polite">
            <span className="loading-mark">O</span>
            <p>正在生成脱敏预览…</p>
          </section>
        ) : null}

        {preview ? <ExportPreviewDetails preview={preview} /> : null}

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <footer className="export-dialog-footer">
          <div>
            <strong>导入后会创建新员工</strong>
            <span>模板不携带任何工作主机权限。</span>
          </div>
          <button className="secondary-button" type="button" onClick={closeDialog}>
            取消
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={preview === undefined || preview.blocked || downloading}
            onClick={() => void download()}
          >
            {downloading ? "下载中…" : preview?.blocked ? "导出已阻止" : "下载 Bot"}
          </button>
        </footer>
      </dialog>
    </div>
  );
}

export function ExportPreviewDetails({ preview }: { preview: EmployeeExportPreview }) {
  return (
    <div className="export-preview-body">
      <section className={`export-safety-summary ${preview.blocked ? "blocked" : "safe"}`}>
        <strong>{preview.blocked ? "分享内容需要处理" : "分享内容检查已通过"}</strong>
        <span>
          {preview.blocked
            ? "OpenBot 已阻止下载，请先修正下列字段。"
            : "可下载内容只包含角色、外观、执行偏好与已验证技能。"}
        </span>
      </section>

      <PortableProfileSummaryCard
        employee={preview.employee}
        requestedCapabilities={preview.requestedCapabilities}
        headingId="export-profile-summary-title"
        note="这些说明性内容会写入模板，但不会携带来源身份或电脑权限。"
      />

      <div className="export-preview-columns">
        <section>
          <h3>将包含</h3>
          <dl className="export-included-list">
            <div>
              <dt>员工模板</dt>
              <dd>职责与外观</dd>
            </div>
            <div>
              <dt>已验证技能</dt>
              <dd>{preview.verifiedSkillCount}</dd>
            </div>
            <div>
              <dt>记忆</dt>
              <dd>{preview.includedMemoryCount}</dd>
            </div>
            <div>
              <dt>请求能力</dt>
              <dd>
                {preview.requestedCapabilities.length > 0
                  ? preview.requestedCapabilities.join("、")
                  : "无"}
              </dd>
            </div>
          </dl>
        </section>

        <section>
          <h3>明确排除</h3>
          <ul className="export-exclusion-list">
            {preview.exclusions.map((exclusion) => (
              <li key={exclusion.category}>
                <strong>{exclusionLabel(exclusion)}</strong>
                <span>{exclusionReason(exclusion.category)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="export-skill-review">
        <h3>将包含的已验证技能</h3>
        <PortableSkillList
          skills={preview.skills}
          stateLabel="已验证，将包含"
          emptyLabel="没有已验证技能会进入模板。"
        />
      </section>

      {preview.findings.length > 0 ? (
        <section className="export-findings">
          <h3>阻止原因</h3>
          <ul>
            {preview.findings.map((finding) => (
              <li key={`${finding.code}:${finding.location}`}>
                <code>{finding.location}</code>
                <span>{finding.message}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="export-integrity">
        <div>
          <span>完整性</span>
          <strong>SHA-256 校验</strong>
        </div>
        <code title={preview.checksum}>{preview.checksum}</code>
        <p>
          {preview.signatureStatus === "dsse"
            ? `此模板将由发布密钥 ${preview.publisherKeyId ?? "未知"} 签名；接收端仍须显式信任并审核。`
            : "当前 Server 未配置发布密钥，模板会明确标记为未签名；接收端必须单独接受风险。"}
        </p>
      </section>
    </div>
  );
}

function exclusionLabel(exclusion: EmployeeExportExclusion): string {
  const labels: Record<EmployeeExportExclusion["category"], string> = {
    identity: "来源身份",
    authority: "电脑权限与授权",
    memory: "全部记忆",
    "work-history": "工作与审计历史",
  };
  return `${labels[exclusion.category]} · ${exclusion.count}`;
}

function exclusionReason(category: EmployeeExportExclusion["category"]): string {
  const reasons: Record<EmployeeExportExclusion["category"], string> = {
    identity: "来源员工 ID 与所有权不会进入模板。",
    authority: "不包含主机绑定、审批、凭证、会话或能力授权。",
    memory: "Bot 分享包不导出任何记忆。",
    "work-history": "Run、决策、产物、审批和进化历史留在来源 Server。",
  };
  return reasons[category];
}
