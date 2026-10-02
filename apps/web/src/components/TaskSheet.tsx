import type { Artifact, Bot, ExecutionNode, Run, RunFrame, RunProgress } from "@openbot/domain";
import { useEffect, useRef, useState } from "react";
import { runStatusLabel, runStatusSummary } from "../run-state";
import { ArtifactCard } from "./ArtifactCard";
import { RobotAvatar } from "./RobotAvatar";
import { SteerForm, taskControls, useTaskAction } from "./TaskActions";
import { computerLabels, secondsAgo } from "./TaskCard";
import { TaskSteps } from "./TaskSteps";
import "./TaskSheet.css";

const stageLabels: Record<string, string> = {
  context: "读取员工资料",
  planning: "想下一步",
  observation: "查看结果",
  navigate: "打开网页",
  screenshot: "截取画面",
};

export function stageLabel(stage: string): string {
  return stageLabels[stage] ?? stage;
}

const statusTone: Partial<Record<Run["status"], string>> = {
  assigned: "is-working",
  running: "is-working",
  waiting_approval: "is-attention",
  blocked: "is-attention",
  failed: "is-failed",
};

const timeFormatter = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });
const dayFormatter = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });
function startedLabel(value: string) {
  const date = new Date(value);
  const today = new Date().toDateString() === date.toDateString();
  return `${today ? "今天" : dayFormatter.format(date)} ${timeFormatter.format(date)} 开始`;
}

/**
 * 任务详情 (TaskInspector artboard): a 460px sheet from the right with the task's status, computer
 * frame, 分工, reported progress, outputs and model use. Escape or the close button dismisses it
 * and focus returns to where the Owner was. The failure code is shown here, never on the card.
 */
export function TaskSheet({
  run,
  bot,
  botsById,
  childRuns = [],
  artifacts,
  progress,
  liveFrame,
  node,
  channelName,
  onClose,
  onRun,
  onInspectRun,
  onOpenBrowser,
}: {
  run: Run;
  bot: Bot | undefined;
  botsById: Map<string, Bot>;
  childRuns?: Run[];
  artifacts: Artifact[];
  progress: RunProgress[];
  liveFrame: RunFrame | undefined;
  node: ExecutionNode | undefined;
  channelName?: string | undefined;
  onClose(): void;
  onRun(run: Run): void;
  onInspectRun?: ((runId: string) => void) | undefined;
  onOpenBrowser?: (() => void) | undefined;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const controls = taskControls(run);
  const action = useTaskAction(run, onRun);
  const [steering, setSteering] = useState(false);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // The sheet does not dim the conversation; a press anywhere outside it closes it.
    const closeOutside = (event: PointerEvent) => {
      if (!sheet.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOutside);
    closeButton.current?.focus();
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOutside);
      previousFocus?.focus();
    };
  }, [onClose]);

  const serverExecuted =
    (run.executionProfile === "none" || run.executionProfile === "model") && !run.nodeId;
  const terminal =
    run.status === "completed" || run.status === "failed" || run.status === "cancelled";
  const usage = run.modelUsage;
  const hasFooter = controls.canSteer || controls.canStop || controls.canResubmit;

  return (
    <aside
      className="task-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="task-title"
      ref={sheet}
    >
      <header className="task-sheet-header">
        <span>任务详情</span>
        <button
          type="button"
          className="task-sheet-close"
          aria-label="关闭任务详情"
          ref={closeButton}
          onClick={onClose}
        >
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      </header>

      <div className="task-sheet-body">
        <div className="task-sheet-title">
          <span className={`task-sheet-status ${statusTone[run.status] ?? ""}`}>
            {statusTone[run.status] === "is-working" ? <i aria-hidden="true" /> : null}
            {runStatusLabel(run.status)}
          </span>
          <h2 id="task-title">{run.title}</h2>
          <span>
            {channelName ? `${channelName} · ` : ""}
            {startedLabel(run.createdAt)}
          </span>
        </div>

        {run.instruction.trim() !== run.title.trim() ? (
          <section className="task-sheet-section" aria-labelledby="task-instruction">
            <h3 id="task-instruction">任务</h3>
            <p className="task-sheet-instruction">{run.instruction}</p>
          </section>
        ) : null}

        {!serverExecuted ? (
          <section className="task-sheet-section" aria-labelledby="task-frame">
            <h3 id="task-frame">电脑画面</h3>
            <div className="task-sheet-frame">
              {liveFrame ? (
                <img
                  src={`/api/v1/runs/${run.id}/frame?revision=${liveFrame.revision}`}
                  alt={`${run.title} 的电脑画面`}
                />
              ) : (
                <span>还没有画面</span>
              )}
            </div>
            {liveFrame ? (
              <small>
                {node?.name ?? "工作电脑"} · {secondsAgo(liveFrame.capturedAt)} ·
                画面默认两分钟后失效
              </small>
            ) : null}
            {onOpenBrowser && run.executionProfile === "docker-linux" ? (
              <button type="button" className="task-sheet-link" onClick={onOpenBrowser}>
                打开员工浏览器 ›
              </button>
            ) : null}
          </section>
        ) : null}

        <section className="task-sheet-section" aria-label="分工">
          <h3>分工</h3>
          <div className="task-sheet-card">
            <div className="task-sheet-person">
              {bot ? (
                <RobotAvatar bot={bot} status={run.status} className="task-sheet-avatar" />
              ) : null}
              <span>
                <strong>{bot?.name ?? "未知 Bot"}</strong>
                <small>负责 · {bot?.role?.trim() ? bot.role : "还没有分工"}</small>
              </span>
              <span className={`task-sheet-state ${statusTone[run.status] ?? ""}`}>
                {runStatusLabel(run.status)}
              </span>
            </div>
            {childRuns.map((child) => {
              const helper = botsById.get(child.botId);
              return (
                <button
                  type="button"
                  className="task-sheet-person"
                  key={child.id}
                  disabled={!onInspectRun}
                  onClick={() => onInspectRun?.(child.id)}
                >
                  {helper ? (
                    <RobotAvatar bot={helper} status={child.status} className="task-sheet-avatar" />
                  ) : null}
                  <span>
                    <strong>{helper?.name ?? "频道 Bot"}</strong>
                    <small>协作 · {child.title}</small>
                  </span>
                  <span className={`task-sheet-state ${statusTone[child.status] ?? ""}`}>
                    {runStatusLabel(child.status)}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="task-sheet-section" aria-label="进度">
          <h3>进度</h3>
          <ol className="task-sheet-card task-sheet-steps">
            <TaskSteps run={run} progress={progress} stageLabel={stageLabel} />
            <li>
              <i
                className={
                  run.status === "failed" ? "is-failed" : terminal ? "is-done" : "is-current"
                }
                aria-hidden="true"
              />
              <span>
                <strong className={terminal ? "" : "is-current"}>
                  {runStatusLabel(run.status)}
                </strong>
                <small>
                  {runStatusSummary(run, progress.at(-1)?.message) ?? "等服务电脑报告下一步。"}
                </small>
              </span>
              <time dateTime={run.updatedAt}>{timeFormatter.format(new Date(run.updatedAt))}</time>
            </li>
          </ol>
        </section>

        {artifacts.length > 0 ? (
          <section className="task-sheet-section" aria-label="产出">
            <h3>产出</h3>
            <div className="task-sheet-outputs">
              {artifacts.map((artifact) => (
                <ArtifactCard artifact={artifact} key={artifact.id} />
              ))}
            </div>
          </section>
        ) : null}

        <section className="task-sheet-section" aria-label="任务信息">
          <h3>任务信息</h3>
          <dl className="task-sheet-card task-sheet-facts">
            <div>
              <dt>电脑</dt>
              <dd>
                {serverExecuted
                  ? "由服务电脑执行"
                  : `${node?.name ?? (run.nodeId ? "工作电脑已离线" : "等待分配")} · ${computerLabels[run.executionProfile]}`}
              </dd>
            </div>
            {run.model ? (
              <div>
                <dt>模型</dt>
                <dd>
                  {run.model.modelId} <small>（创建时选定）</small>
                </dd>
              </div>
            ) : null}
            {usage ? (
              <div>
                <dt>模型用量</dt>
                <dd>
                  输入 {usage.inputTokens?.toLocaleString() ?? "未知"} · 输出{" "}
                  {usage.outputTokens?.toLocaleString() ?? "未知"} <small>· 不代表账单</small>
                </dd>
              </div>
            ) : null}
            {run.workTaskId ? (
              <div>
                <dt>任务监督</dt>
                <dd>
                  <a href={`#/tasks?task=${encodeURIComponent(run.workTaskId)}`}>查看任务 ›</a>
                </dd>
              </div>
            ) : null}
          </dl>
        </section>

        {run.errorCode ? (
          // Only the code: the Server's raw message can quote upstream text, so it is not shown.
          <section className="task-sheet-section" aria-label="技术细节">
            <h3>技术细节</h3>
            <dl className="task-sheet-card task-sheet-facts">
              <div>
                <dt>错误代码</dt>
                <dd>{run.errorCode}</dd>
              </div>
            </dl>
          </section>
        ) : null}

        {steering ? (
          <SteerForm
            run={run}
            botName={bot?.name ?? "Bot"}
            onDone={(text) => {
              setSteering(false);
              setNotice(text);
            }}
            onClose={() => setSteering(false)}
          />
        ) : null}
        {notice ? (
          <p className="task-sheet-note" role="status">
            {notice}
          </p>
        ) : null}
        {action.error ? (
          <p className="task-sheet-error" role="alert">
            {action.error}
          </p>
        ) : null}
      </div>

      {hasFooter ? (
        <footer className="task-sheet-footer">
          {controls.canSteer ? (
            <button
              type="button"
              className="task-sheet-pill"
              aria-expanded={steering}
              onClick={() => setSteering((open) => !open)}
            >
              补充指令
            </button>
          ) : null}
          {controls.canStop ? (
            <button
              type="button"
              className="task-sheet-pill is-danger"
              disabled={action.pending}
              onClick={action.stop}
            >
              {action.pending ? "正在停止…" : "停止任务"}
            </button>
          ) : null}
          {controls.canResubmit ? (
            <button
              type="button"
              className="task-sheet-pill"
              disabled={action.pending}
              onClick={action.resubmit}
            >
              {action.pending ? "正在提交…" : "重新提交"}
            </button>
          ) : null}
        </footer>
      ) : null}
    </aside>
  );
}
