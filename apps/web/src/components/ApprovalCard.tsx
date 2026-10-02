import type { Approval, ApprovalDecision, Bot, Channel } from "@openbot/domain";
import { useState } from "react";

export function ApprovalCard({
  approval,
  bot,
  channel,
  onDecide,
}: {
  approval: Approval;
  bot: Bot | undefined;
  channel: Channel | undefined;
  onDecide(approvalId: string, decision: ApprovalDecision): Promise<void>;
}) {
  const [decision, setDecision] = useState<ApprovalDecision>();
  const [error, setError] = useState<string>();

  async function decide(nextDecision: ApprovalDecision) {
    if (decision !== undefined) return;
    setDecision(nextDecision);
    setError(undefined);
    try {
      await onDecide(approval.id, nextDecision);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "审批未能保存。");
      setDecision(undefined);
    }
  }

  return (
    <article className={`approval-card risk-${approval.risk}`}>
      <header>
        <span>{riskLabel(approval.risk)}</span>
        <time dateTime={approval.expiresAt}>{expiryLabel(approval.expiresAt)}</time>
      </header>
      <strong>{approval.summary}</strong>
      <p title={approval.target}>{approval.target}</p>
      <small>
        {bot?.name ?? "未知 Bot"} · {channel?.name ?? "未知频道"}
      </small>
      <div className="approval-actions">
        <button
          className="approval-reject"
          type="button"
          disabled={decision !== undefined}
          onClick={() => decide("reject")}
        >
          {decision === "reject" ? "拒绝中…" : "拒绝"}
        </button>
        <button
          className="approval-approve"
          type="button"
          disabled={decision !== undefined}
          onClick={() => decide("approve")}
        >
          {decision === "approve" ? "批准中…" : actionLabel(approval.action)}
        </button>
      </div>
      {error ? <em role="alert">{error}</em> : null}
    </article>
  );
}

export function riskLabel(risk: Approval["risk"]): string {
  return risk === "privileged" ? "高风险权限" : risk === "destructive" ? "不可逆动作" : "写入动作";
}

export function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    "browser.click": "点击这个按钮",
    "email.send": "发送这封邮件",
    "form.submit": "提交这张表单",
    "message.send": "发送这条消息",
    "data.delete": "删除这些数据",
    "software.install": "安装这个软件",
    "permission.change": "修改此权限",
  };
  return labels[action] ?? `批准：${action}`;
}

export function expiryLabel(value: string): string {
  const remainingMs = new Date(value).getTime() - Date.now();
  if (remainingMs <= 0) return "已过期";
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `${minutes} 分钟内有效`;
}
