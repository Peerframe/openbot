import type { Artifact, Bot, Run, RunFrame, RunProgress } from "@openbot/domain";
import { runStatusLabel, runStatusSummary } from "../run-state";
import { ArtifactCard } from "./ArtifactCard";
import { RobotAvatar } from "./RobotAvatar";
import type { CollaborationRun } from "./RunCollaboration";
import "./RunProgressPanel.css";

const stageLabels: Record<string, string> = {
  context: "员工上下文",
  planning: "模型步骤",
  observation: "工具结果",
  navigate: "打开网页",
  screenshot: "截取画面",
};

export function stageLabel(stage: string): string {
  return stageLabels[stage] ?? stage;
}

export function latestProgressMessage(
  run: Run,
  progress: readonly RunProgress[],
): string | undefined {
  return runStatusSummary(run, progress.at(-1)?.message);
}

export function currentStepLabel(run: Run, progress: readonly RunProgress[]): string {
  // Live run status outranks stale progress stages (especially blocked / approval).
  if (run.status === "waiting_approval") return "等待审批";
  if (run.status === "blocked") return runStatusLabel(run.status);
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    return runStatusLabel(run.status);
  }
  const latest = progress.at(-1);
  return latest ? stageLabel(latest.stage) : runStatusLabel(run.status);
}

export function currentStatusDetail(run: Run, progress: readonly RunProgress[]): string {
  return latestProgressMessage(run, progress) ?? "等待 Server 报告下一步。";
}

/** Real Server projections only: computer preview, roles, step, approval, terminal, artifacts. */
export function RunProgressPanel({
  artifacts,
  bot,
  botsById = new Map(),
  childRuns = [],
  liveFrame,
  onInspectRun,
  progress,
  run,
}: {
  artifacts: Artifact[];
  bot: Bot | undefined;
  botsById?: Map<string, Bot>;
  childRuns?: CollaborationRun[];
  liveFrame: RunFrame | undefined;
  onInspectRun?(runId: string): void;
  progress: RunProgress[];
  run: Run;
}) {
  const terminal =
    run.status === "completed" || run.status === "failed" || run.status === "cancelled";
  const currentMessage = latestProgressMessage(run, progress);
  const statusDetail = currentStatusDetail(run, progress);

  return (
    <div className="run-progress-panel">
      <section aria-label="电脑预览">
        <h3>电脑预览</h3>
        <div className="run-progress-panel__preview">
          {liveFrame ? (
            <img
              src={`/api/v1/runs/${run.id}/frame?revision=${liveFrame.revision}`}
              alt={`${run.title} 的执行画面`}
            />
          ) : (
            <p className="run-progress-panel__empty-preview">暂无执行画面</p>
          )}
        </div>
        {liveFrame ? (
          <p className="frame-meta">
            {frameDimensions(liveFrame)} · {formatTime(liveFrame.capturedAt)} · 临时内存画面
          </p>
        ) : null}
      </section>

      <section aria-label="分工">
        <h3>分工</h3>
        <ul className="run-progress-panel__roles">
          <li>
            {bot ? <RobotAvatar bot={bot} compact status={run.status} /> : null}
            <strong>{bot?.name ?? "未知 Bot"}</strong>
            <span>{bot?.role?.trim() ? bot.role : "未指定职责"}</span>
            <span className="run-progress-panel__status" data-state={run.status}>
              {runStatusLabel(run.status)}
            </span>
          </li>
          {childRuns.map((child) => {
            const childBot = botsById.get(child.botId);
            return (
              <li key={child.id}>
                {childBot ? <RobotAvatar bot={childBot} compact status={child.status} /> : null}
                <strong>{childBot?.name ?? "频道 Bot"}</strong>
                <span>{childBot?.role?.trim() ? childBot.role : "未指定职责"}</span>
                {onInspectRun ? (
                  <button type="button" onClick={() => onInspectRun(child.id)}>
                    <span className="run-progress-panel__status" data-state={child.status}>
                      {runStatusLabel(child.status)}
                    </span>
                  </button>
                ) : (
                  <span className="run-progress-panel__status" data-state={child.status}>
                    {runStatusLabel(child.status)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-label="当前步骤">
        <h3>当前步骤</h3>
        <p>{currentStepLabel(run, progress)}</p>
        {currentMessage ? <p>{currentMessage}</p> : null}
      </section>

      <section aria-label="进度">
        <h3>进度</h3>
        <ol className="run-progress-panel__steps">
          {progress.map((item) => (
            <li data-state="complete" key={item.id}>
              <header>
                <strong>{stageLabel(item.stage)}</strong>
                <time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time>
              </header>
              <p>{item.message}</p>
            </li>
          ))}
          <li data-state={run.status === "failed" ? "failed" : terminal ? "complete" : "current"}>
            <header>
              <strong>{runStatusLabel(run.status)}</strong>
              <time dateTime={run.updatedAt}>{formatTime(run.updatedAt)}</time>
            </header>
            <p>{statusDetail}</p>
          </li>
        </ol>
      </section>

      <section aria-label="成果入口">
        <h3>成果入口</h3>
        {artifacts.length > 0 ? (
          <ul className="run-progress-panel__results">
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <ArtifactCard artifact={artifact} />
              </li>
            ))}
          </ul>
        ) : run.resultSummary ? (
          <p>{run.resultSummary}</p>
        ) : (
          <p className="run-progress-panel__empty-preview">
            暂无产物。任务产生附件或摘要后会出现在这里。
          </p>
        )}
      </section>
    </div>
  );
}

function formatTime(value: string): string {
  return timeFormatter.format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)} KB`;
}

function frameDimensions(frame: RunFrame): string {
  return frame.width !== undefined && frame.height !== undefined
    ? `${frame.width} × ${frame.height}`
    : formatBytes(frame.sizeBytes);
}

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
