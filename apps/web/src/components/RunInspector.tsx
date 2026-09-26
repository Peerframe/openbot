import type { Artifact, Bot, ExecutionNode, Run, RunFrame, RunProgress } from "@openbot/domain";
import { useEffect, useRef } from "react";
import { runStatusLabel } from "../run-state";
import { CloseIcon, NodeIcon } from "./Icons";
import { NativeRunControls } from "./NativeRunControls";
import { RobotAvatar } from "./RobotAvatar";
import type { CollaborationRun } from "./RunCollaboration";
import { RunProgressPanel } from "./RunProgressPanel";

export function RunInspector({
  artifacts,
  bot,
  botsById,
  childRuns = [],
  liveFrame,
  node,
  onClose,
  onOpenBrowser,
  onInspectRun,
  onRun,
  progress,
  run,
}: {
  artifacts: Artifact[];
  bot: Bot | undefined;
  botsById?: Map<string, Bot>;
  childRuns?: CollaborationRun[];
  liveFrame: RunFrame | undefined;
  node: ExecutionNode | undefined;
  onClose(): void;
  onOpenBrowser?: (() => void) | undefined;
  onInspectRun?(runId: string): void;
  onRun(run: Run): void;
  progress: RunProgress[];
  run: Run;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    closeButton.current?.focus();
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      previousFocus?.focus();
    };
  }, [onClose]);

  const serverExecuted =
    (run.executionProfile === "none" || run.executionProfile === "model") && !run.nodeId;

  return (
    <div className="inspector-backdrop">
      <aside className="run-inspector" role="dialog" aria-modal="true" aria-labelledby="run-title">
        <header className="inspector-header">
          <div>
            <span className={`run-status ${run.status}`}>{runStatusLabel(run.status)}</span>
            <h2 id="run-title">{run.title}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭任务详情"
            ref={closeButton}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>

        <div className="inspector-body">
          {bot?.computerProfile === "docker-linux" && onOpenBrowser ? (
            <button className="primary-button" type="button" onClick={onOpenBrowser}>
              打开员工浏览器
            </button>
          ) : null}
          <section className="inspector-section">
            <h3>任务</h3>
            <p className="instruction-copy">{run.instruction}</p>
          </section>

          <section className="inspector-assignment" aria-label="任务分配">
            <div>
              {bot ? (
                <RobotAvatar bot={bot} compact status={run.status} />
              ) : (
                <span className="assignment-placeholder">O</span>
              )}
              <span>
                <small>执行 Bot</small>
                <strong>{bot?.name ?? "未知 Bot"}</strong>
              </span>
            </div>
            <div>
              <span className="assignment-icon">
                <NodeIcon />
              </span>
              <span>
                <small>执行电脑</small>
                <strong>
                  {serverExecuted
                    ? "由 Server 执行"
                    : (node?.name ?? (run.nodeId ? "节点已离线" : "等待分配"))}
                </strong>
              </span>
            </div>
          </section>

          {run.workTaskId ? (
            <section className="inspector-section" aria-label="任务监督入口">
              <a href={`#/tasks?task=${encodeURIComponent(run.workTaskId)}`}>查看任务</a>
            </section>
          ) : null}
          <NativeRunControls key={run.id} run={run} onRun={onRun} />
          {run.model ? (
            <section className="inspector-section" aria-label="任务模型选择">
              <h3>任务模型</h3>
              <p>{run.model.modelId}</p>
              <p className="frame-meta">连接 {run.model.connectionId}</p>
              <p className="frame-meta">保留任务创建时的选择，员工之后切换模型不会改变此任务。</p>
            </section>
          ) : null}
          {run.modelUsage ? (
            <section className="inspector-section" aria-label="任务模型用量">
              <h3>模型用量</h3>
              <p>
                {run.modelUsage.provider} · {run.modelUsage.model} · {run.modelUsage.steps} 轮
              </p>
              <p>
                输入 {run.modelUsage.inputTokens?.toLocaleString() ?? "未知"} · 输出{" "}
                {run.modelUsage.outputTokens?.toLocaleString() ?? "未知"} Token
              </p>
              <p className="frame-meta">仅包含已收到用量的模型步骤，不代表账单或任务成本。</p>
            </section>
          ) : null}

          <section className="inspector-section" aria-label="运行进度面板">
            <RunProgressPanel
              artifacts={artifacts}
              bot={bot}
              {...(botsById === undefined ? {} : { botsById })}
              childRuns={childRuns}
              liveFrame={liveFrame}
              {...(onInspectRun === undefined ? {} : { onInspectRun })}
              progress={progress}
              run={run}
            />
          </section>
        </div>
      </aside>
    </div>
  );
}
