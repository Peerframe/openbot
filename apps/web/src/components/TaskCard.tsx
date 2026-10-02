import type {
  Approval,
  ApprovalDecision,
  Artifact,
  Bot,
  ExecutionNode,
  Run,
  RunFrame,
  RunProgress,
} from "@openbot/domain";
import { type ReactNode, useState } from "react";
import { runStatusLabel, runStatusSummary } from "../run-state";
import { actionLabel, expiryLabel, riskLabel } from "./ApprovalCard";
import { ArtifactDownloadLink } from "./ArtifactCard";
import { RobotAvatar } from "./RobotAvatar";
import { SteerForm, taskControls, useTaskAction } from "./TaskActions";
import "./TaskCard.css";

export const computerLabels: Record<Run["executionProfile"], string> = {
  none: "服务电脑",
  model: "服务电脑",
  "docker-linux": "员工浏览器",
  "macos-cua": "操作 macOS",
  "lume-vm": "Lume 虚拟机",
  coder: "代码工作区",
};

/** File-type badge for an output: the extension, else the media type's family. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot > name.length - 6 ? name.slice(dot + 1).toUpperCase() : "文件";
}

export function secondsAgo(value: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`;
}

/**
 * One card per task in the conversation (TaskCards artboard), updated in place from queued to
 * done. It shows only what the 服务电脑 has reported: the latest progress line, never an invented
 * step total, and the user-readable failure reason; raw errors stay in 任务详情. Approvals are
 * decided here and in the rail alike — both call the same Server decision.
 */
export function TaskCard({
  run,
  bot,
  botsById,
  progress,
  artifacts,
  approvals,
  frame,
  node,
  childRuns,
  waiting,
  collapsed,
  showAvatar,
  onInspect,
  onRun,
  onDecideApproval,
}: {
  run: Run;
  bot: Bot | undefined;
  botsById: Map<string, Bot>;
  /** The latest progress line for this task, if any. */
  progress: RunProgress | undefined;
  artifacts: Artifact[];
  /** Pending approvals for this task. */
  approvals: Approval[];
  frame: RunFrame | undefined;
  node: ExecutionNode | undefined;
  childRuns: Run[];
  /** Queued behind another task of the same 频道. */
  waiting: boolean;
  /** An older finished task: one line only. */
  collapsed: boolean;
  showAvatar: boolean;
  onInspect(runId: string): void;
  onRun(run: Run): void;
  onDecideApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
}) {
  const controls = taskControls(run);
  const action = useTaskAction(run, onRun);
  const [steering, setSteering] = useState(false);
  const [notice, setNotice] = useState<string>();
  const botName = bot?.name ?? "Bot";
  const detailsLink = (label = "任务详情") => (
    <button type="button" className="task-link" onClick={() => onInspect(run.id)}>
      {label} ›
    </button>
  );
  const pill = (label: string, onClick: () => void, primary = false) => (
    <button
      type="button"
      className={`task-pill${primary ? " is-primary" : ""}`}
      disabled={action.pending}
      onClick={onClick}
    >
      {label}
    </button>
  );

  let body: ReactNode;
  let tone = "";
  if (
    run.status === "queued" ||
    run.status === "blocked" ||
    run.status === "cancelled" ||
    (collapsed && (run.status === "completed" || run.status === "failed"))
  ) {
    const label =
      run.status === "queued"
        ? waiting
          ? "等待接续"
          : "排队中"
        : run.status === "blocked"
          ? "需要你接手"
          : run.status === "cancelled"
            ? "已停止"
            : run.status === "completed"
              ? "已完成"
              : "没能完成";
    tone = run.status === "blocked" ? " is-attention" : "";
    body = (
      <div className="task-top is-line">
        <Glyph status={run.status} small />
        <span className="task-text">
          <strong className={run.status === "cancelled" ? "is-muted" : ""}>
            {label} · {run.title}
          </strong>
        </span>
        {run.status === "queued" && controls.canStop ? (
          <button
            type="button"
            className="task-link"
            disabled={action.pending}
            onClick={action.stop}
          >
            取消
          </button>
        ) : run.status === "blocked" ? (
          pill("打开电脑画面", () => onInspect(run.id), true)
        ) : run.status === "cancelled" && controls.canResubmit ? (
          <button
            type="button"
            className="task-link"
            disabled={action.pending}
            onClick={action.resubmit}
          >
            重新提交
          </button>
        ) : (
          detailsLink()
        )}
      </div>
    );
  } else if (run.status === "waiting_approval" && approvals.length > 0) {
    tone = " is-attention";
    body = approvals.map((approval) => (
      <ApprovalBlock
        approval={approval}
        key={approval.id}
        onInspect={() => onInspect(run.id)}
        onDecide={onDecideApproval}
      />
    ));
  } else if (run.status === "completed") {
    body = (
      <>
        <div className="task-top">
          <Glyph status={run.status} />
          <span className="task-text">
            <strong>已完成 · {run.title}</strong>
            <span>
              {artifacts.length > 0
                ? `${artifacts.length} 个产出`
                : (runStatusSummary(run) ?? "任务已结束。")}
            </span>
          </span>
          {detailsLink()}
        </div>
        {artifacts.length > 0 ? (
          <div className="task-files">
            {artifacts.map((artifact) => (
              <ArtifactDownloadLink artifact={artifact} className="task-file" key={artifact.id}>
                <span className="task-ext" aria-hidden="true">
                  {extensionOf(artifact.name)}
                </span>
                <span>{artifact.name}</span>
              </ArtifactDownloadLink>
            ))}
          </div>
        ) : null}
      </>
    );
  } else if (run.status === "failed") {
    body = (
      <>
        <div className="task-top">
          <Glyph status={run.status} />
          <span className="task-text">
            <strong>没能完成 · {run.title}</strong>
            <span>{runStatusSummary(run)}</span>
          </span>
          {detailsLink()}
        </div>
        {controls.canResubmit ? (
          <div className="task-actions">
            {pill("重新提交", action.resubmit)}
            <small>会新建一个任务，原记录保留</small>
          </div>
        ) : null}
      </>
    );
  } else {
    // assigned, running, or waiting for an approval that is not in this snapshot.
    tone = run.status === "waiting_approval" ? " is-attention" : "";
    const where = node ? `在 ${node.name} 上` : undefined;
    const detail =
      run.status === "waiting_approval"
        ? runStatusSummary(run)
        : progress
          ? `现在：${progress.message}`
          : (where ?? "正在处理");
    body = (
      <>
        <div className="task-top">
          <Glyph status={run.status} />
          <span className="task-text">
            <strong>
              {run.status === "waiting_approval" ? "等你确认" : "正在工作"} · {run.title}
            </strong>
            <span>{detail}</span>
          </span>
          {detailsLink()}
        </div>
        {frame ? (
          <div className="task-frame">
            <button type="button" onClick={() => onInspect(run.id)} aria-label="查看电脑画面">
              <img
                src={`/api/v1/runs/${run.id}/frame?revision=${frame.revision}`}
                alt={`${run.title} 的电脑画面`}
              />
            </button>
            <span>
              {node?.name ?? "工作电脑"} · {computerLabels[run.executionProfile]}
              <br />
              画面 {secondsAgo(frame.capturedAt)} · 只在内存里保留
            </span>
          </div>
        ) : null}
        {controls.canSteer || controls.canStop ? (
          <div className="task-actions">
            {controls.canSteer ? pill("补充指令", () => setSteering((open) => !open)) : null}
            {controls.canStop ? pill("停止", action.stop) : null}
          </div>
        ) : null}
        {steering ? (
          <SteerForm
            run={run}
            botName={botName}
            onDone={(text) => {
              setSteering(false);
              setNotice(text);
            }}
          />
        ) : null}
      </>
    );
  }

  return (
    <div className="task-thread">
      {showAvatar && bot ? (
        <RobotAvatar bot={bot} status={run.status} className="task-avatar" />
      ) : (
        <span className="task-avatar" aria-hidden="true" />
      )}
      <section className={`task-card is-${run.status}${tone}`} aria-label={`任务：${run.title}`}>
        {body}
        {childRuns.length > 0 ? (
          <Collaboration
            lead={bot}
            childRuns={childRuns}
            botsById={botsById}
            onInspect={onInspect}
          />
        ) : null}
        {notice ? (
          <p className="task-note" role="status">
            {notice}
          </p>
        ) : null}
        {action.error ? (
          <p className="task-error" role="alert">
            {action.error}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function ApprovalBlock({
  approval,
  onInspect,
  onDecide,
}: {
  approval: Approval;
  onInspect(): void;
  onDecide(approvalId: string, decision: ApprovalDecision): Promise<void>;
}) {
  const [decision, setDecision] = useState<ApprovalDecision>();
  const [error, setError] = useState<string>();
  async function decide(next: ApprovalDecision) {
    if (decision !== undefined) return;
    setDecision(next);
    setError(undefined);
    try {
      await onDecide(approval.id, next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "审批没能保存。");
      setDecision(undefined);
    }
  }
  return (
    <>
      <div className="task-top">
        <Glyph status="waiting_approval" />
        <span className="task-text">
          <strong>{approval.summary}</strong>
          <span>
            {riskLabel(approval.risk)} · {expiryLabel(approval.expiresAt)}
          </span>
        </span>
        <button type="button" className="task-link" onClick={onInspect}>
          看内容 ›
        </button>
      </div>
      <p className="task-quote" title={approval.target}>
        {approval.target}
      </p>
      <div className="task-actions">
        <button
          type="button"
          className="task-pill"
          disabled={decision !== undefined}
          onClick={() => decide("reject")}
        >
          {decision === "reject" ? "拒绝中…" : "拒绝"}
        </button>
        <button
          type="button"
          className="task-pill is-primary"
          disabled={decision !== undefined}
          onClick={() => decide("approve")}
        >
          {decision === "approve" ? "批准中…" : actionLabel(approval.action)}
        </button>
      </div>
      {error ? (
        <p className="task-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** 「A 请 B 协作」: tasks one Bot handed to another; their results return to the lead task. */
function Collaboration({
  lead,
  childRuns,
  botsById,
  onInspect,
}: {
  lead: Bot | undefined;
  childRuns: Run[];
  botsById: Map<string, Bot>;
  onInspect(runId: string): void;
}) {
  const helpers = [...new Set(childRuns.map((child) => child.botId))].flatMap((id) => {
    const helper = botsById.get(id);
    return helper ? [helper] : [];
  });
  return (
    <div className="task-collab">
      <div className="task-collab-head">
        {lead ? <RobotAvatar bot={lead} className="task-collab-avatar" /> : null}
        <strong>{lead?.name ?? "Bot"}</strong>请
        {helpers.map((helper) => (
          <span key={helper.id} className="task-collab-helper">
            <RobotAvatar bot={helper} className="task-collab-avatar" />
            <strong>{helper.name}</strong>
          </span>
        ))}
        协作
      </div>
      {childRuns.map((child) => (
        <button
          type="button"
          className="task-collab-row"
          key={child.id}
          onClick={() => onInspect(child.id)}
        >
          <span className="task-text">
            <strong>{child.title}</strong>
            <span>{botsById.get(child.botId)?.name ?? "频道 Bot"}</span>
          </span>
          <span className={`task-state is-${child.status}`}>{runStatusLabel(child.status)}</span>
        </button>
      ))}
      <small>协作结果回到{lead?.name ?? "它"}的任务里，再由它回复你。</small>
    </div>
  );
}

function Glyph({ status, small = false }: { status: Run["status"]; small?: boolean }) {
  return (
    <span className={`task-glyph is-${status}${small ? " is-small" : ""}`} aria-hidden="true">
      {status === "running" || status === "assigned" ? <i className="task-spin" /> : null}
      {status === "waiting_approval" || status === "blocked" || status === "failed" ? "!" : null}
      {status === "completed" ? (
        <svg
          aria-hidden="true"
          width={small ? 13 : 16}
          height={small ? 13 : 16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="5 12 10 17 19 7" />
        </svg>
      ) : null}
      {status === "cancelled" ? <i className="task-stop" /> : null}
    </span>
  );
}
