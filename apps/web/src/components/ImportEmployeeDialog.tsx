import type {
  Bot,
  EmployeeImportActivationResult,
  EmployeeImportIssue,
  EmployeeImportPreview,
} from "@openbot/domain";
import { useEffect, useRef, useState } from "react";
import { type ApiError, activateEmployeeImport, previewEmployeeImport } from "../api";
import { Dialog } from "./Dialog";
import { DialogCheck } from "./ExportEmployeeDialog";
import { PortableProfileSummaryCard, PortableSkillList } from "./PortableEmployeeReview";
import { RobotAvatar } from "./RobotAvatar";

const employeePackageAccept =
  ".json,application/json,application/vnd.openbot.employee+json,application/vnd.openbot.employee.dsse+json";

/**
 * 导入 Bot 模板 (DialogImport artboard). The 服务电脑 checks the file in quarantine first; the
 * Owner then confirms, which creates a new identity with no computer authority and skills
 * disabled pending review. An unsigned package needs that confirmation to name the risk.
 */
export function ImportEmployeeDialog({
  onClose,
  onActivated,
}: {
  onClose(): void;
  onActivated(result: EmployeeImportActivationResult): void;
}) {
  const [preview, setPreview] = useState<EmployeeImportPreview>();
  const [file, setFile] = useState<File>();
  const [employeeName, setEmployeeName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [activating, setActivating] = useState(false);
  const idempotencyKey = useRef(crypto.randomUUID());
  const requestController = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => requestController.current?.abort(), []);

  async function inspect(selectedFile: File) {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setFile(selectedFile);
    setPreview(undefined);
    setConfirmed(false);
    setError(undefined);
    setLoading(true);
    idempotencyKey.current = crypto.randomUUID();
    try {
      const result = await previewEmployeeImport(selectedFile, controller.signal);
      setPreview(result);
      setEmployeeName(result.employee.name);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(importErrorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  const activationReady =
    file !== undefined &&
    preview !== undefined &&
    !preview.blocked &&
    preview.quarantine.canActivate &&
    confirmed &&
    employeeName.trim().length > 0;

  async function activate() {
    if (!activationReady || file === undefined || preview === undefined) return;
    setActivating(true);
    setError(undefined);
    try {
      const result = await activateEmployeeImport(file, preview, {
        employeeName,
        // The single confirmation names the unsigned risk whenever the package is unsigned.
        allowUnsigned: preview.signature.status === "unsigned" && confirmed,
        idempotencyKey: idempotencyKey.current,
      });
      onActivated(result);
    } catch (cause) {
      setError(importErrorMessage(cause));
    } finally {
      setActivating(false);
    }
  }

  const step = preview ? 3 : file ? 2 : 1;
  const filePicker = (label: string, primary: boolean) => (
    <label className={`ob-pill ${primary ? "is-large is-primary" : "is-small"} ob-file-pill`}>
      {label}
      <input
        type="file"
        accept={employeePackageAccept}
        onChange={(event) => {
          const selectedFile = event.target.files?.[0];
          if (selectedFile) void inspect(selectedFile);
        }}
      />
    </label>
  );

  return (
    <Dialog
      title="导入 Bot 模板"
      intro="先在隔离区检查，再由你确认创建一个没有电脑权限的新 Bot。"
      width={680}
      className="import-employee-dialog"
      onClose={onClose}
      footerStart={<small className="ob-dialog-foot-note">激活只创建新身份和待审核技能</small>}
      footer={
        <>
          <button type="button" className="ob-pill is-large" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="ob-pill is-large is-primary"
            disabled={!activationReady || activating}
            onClick={() => void activate()}
          >
            {activating ? "正在激活…" : "激活 Bot"}
          </button>
        </>
      }
    >
      <ol className="ob-dialog-steps" aria-label="导入步骤">
        {["选择文件", "检查", "激活"].map((label, index) => (
          <li
            key={label}
            className={index + 1 === step ? "is-current" : index + 1 < step ? "is-done" : ""}
            aria-current={index + 1 === step ? "step" : undefined}
          >
            <span>{index + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      {file ? (
        <div className="ob-dialog-file">
          <span className="ob-dialog-file-type" aria-hidden="true">
            JSON
          </span>
          <span>
            <strong>{file.name}</strong>
            <small>
              {loading
                ? "正在隔离区检查…"
                : `${formatSize(file.size)} · 在隔离区检查，不会改动你的工作区`}
            </small>
          </span>
          {loading ? null : filePicker("换一个", false)}
        </div>
      ) : (
        <div className="ob-dialog-drop">
          <strong>选择 Bot 模板文件</strong>
          <small>
            支持不超过 2 MiB 的 openbot.employee/v1、v2 或 DSSE JSON。未知字段会直接拒绝。
          </small>
          {filePicker("选择文件", true)}
        </div>
      )}

      {preview ? (
        <ImportPreviewDetails
          preview={preview}
          employeeName={employeeName}
          confirmed={confirmed}
          onEmployeeNameChange={setEmployeeName}
          onConfirmedChange={setConfirmed}
        />
      ) : null}

      {error ? (
        <p className="ob-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

export function ImportPreviewDetails({
  preview,
  employeeName,
  confirmed,
  onEmployeeNameChange,
  onConfirmedChange,
}: {
  preview: EmployeeImportPreview;
  employeeName: string;
  confirmed: boolean;
  onEmployeeNameChange(value: string): void;
  onConfirmedChange(value: boolean): void;
}) {
  const employee: Bot = {
    id: `preview:${preview.packageId}`,
    name: preview.employee.name,
    role: preview.employee.role,
    status: "idle",
    computerProfile: preview.recommendedExecutionProfile,
    ...(preview.employee.appearance ? { appearance: preview.employee.appearance } : {}),
    createdAt: preview.generatedAt,
  };
  const unsigned = preview.signature.status === "unsigned";
  return (
    <>
      <div className="ob-dialog-columns">
        <section>
          <h3>检查结果</h3>
          <ul className="ob-dialog-checks">
            <li>
              <DialogCheck on />
              <span>
                <strong>格式与字段</strong>
                <small>{preview.format} · 无未声明字段</small>
              </span>
            </li>
            <li>
              <DialogCheck on={preview.integrity.valid} />
              <span>
                <strong>完整性</strong>
                <small className={preview.integrity.valid ? "" : "is-danger"}>
                  {preview.integrity.valid ? "校验和一致" : "校验和不一致"}
                </small>
              </span>
            </li>
            <li>
              {unsigned ? (
                <span className="ob-dialog-check is-warning">!</span>
              ) : (
                <DialogCheck on />
              )}
              <span>
                <strong>签名</strong>
                <small className={unsigned ? "is-warning" : ""}>
                  {preview.signature.status === "dsse"
                    ? `已签名 · ${preview.signature.keyid}`
                    : "未签名，发布者身份无法验证"}
                </small>
              </span>
            </li>
            <li>
              <DialogCheck on />
              <span>
                <strong>技能 · {preview.skills.length}</strong>
                <small>导入后先禁用，等你审核</small>
              </span>
            </li>
            <li>
              <DialogCheck on />
              <span>
                <strong>电脑权限</strong>
                <small>零权限：不绑定主机、不带凭证</small>
              </span>
            </li>
            {preview.issues.map((issue) => (
              <li key={`${issue.code}:${issue.locations.join(",")}`}>
                <DialogCheck on={false} />
                <span>
                  <strong className="is-danger">{issueLabel(issue)}</strong>
                  <small>{issue.locations.join("、")}</small>
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3>激活为</h3>
          <div className="ob-dialog-activate">
            <RobotAvatar bot={employee} className="ob-dialog-activate-avatar" />
            <small>新身份 · 零权限</small>
            <label className="ob-field">
              新 Bot 名称
              <input
                value={employeeName}
                maxLength={64}
                disabled={preview.blocked}
                onChange={(event) => onEmployeeNameChange(event.target.value)}
              />
            </label>
          </div>
        </section>
      </div>

      {/* The exact untrusted content, reviewable before activation. */}
      <details className="ob-dialog-review">
        <summary>查看模板内容</summary>
        <PortableProfileSummaryCard
          employee={preview.employee}
          requestedCapabilities={preview.requestedCapabilities}
          headingId="import-profile-summary-title"
          note="这些内容只用于说明 Bot，不会授予技能、电脑或账号权限。"
        />
        <PortableSkillList
          skills={preview.skills}
          stateLabel="禁用，等待审核"
          emptyLabel="模板没有技能。"
        />
        <p className="ob-dialog-loading">
          {preview.compatibility.compatibleHosts.length > 0
            ? `兼容的工作电脑：${preview.compatibility.compatibleHosts.map((host) => host.name).join("、")}`
            : preview.compatibility.hostRequired
              ? "没有满足全部要求的在线工作电脑。"
              : "不需要工作电脑。"}
          {preview.compatibility.missingCapabilities.length > 0
            ? ` 缺少：${preview.compatibility.missingCapabilities.join("、")}`
            : ""}
        </p>
      </details>

      {preview.blocked ? null : (
        <label className="ob-dialog-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => onConfirmedChange(event.target.checked)}
          />
          <span>
            {unsigned
              ? "我知道发布者身份无法验证，已核对资料、技能和零权限边界，仍要激活。"
              : "我已核对资料、技能和零权限边界。"}
          </span>
        </label>
      )}
    </>
  );
}

function formatSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

function issueLabel(issue: EmployeeImportIssue): string {
  const labels: Record<EmployeeImportIssue["code"], string> = {
    "invalid-skill-content": "技能正文、摘要或分发许可不符合要求",
    "checksum-mismatch": "校验和不匹配",
    "capability-set-mismatch": "能力声明与技能不一致",
    "duplicate-skill": "技能标识重复",
    "missing-skill-dependency": "缺少技能依赖",
    "sensitive-content": "包含疑似敏感内容",
    "missing-capability": "当前缺少所需能力",
    "no-compatible-host": "没有兼容的工作电脑",
  };
  return labels[issue.code];
}

function importErrorMessage(cause: unknown): string {
  const error = cause as ApiError;
  const translations: Record<string, string> = {
    "Employee package must not exceed 2 MiB.": "Bot 模板不能超过 2 MiB。",
    "Employee package must be valid JSON.": "Bot 模板必须是有效的 JSON 文件。",
    "Employee package does not match a supported format.":
      "模板格式不受支持，或文件包含未声明字段。",
    "Employee activation is blocked until every preview issue is resolved.":
      "模板仍有阻止项，不能激活。",
    "Unsigned Employee activation requires explicit Owner risk acceptance.":
      "请先确认你愿意承担未签名模板的来源风险。",
    "The Employee package changed after preview. Review the current package before activating it.":
      "文件在检查后变了，请重新检查。",
    "This Employee package was already activated.": "这个模板已经激活过。",
  };
  return translations[error.message] ?? error.message ?? "没能检查或激活 Bot 模板。";
}
