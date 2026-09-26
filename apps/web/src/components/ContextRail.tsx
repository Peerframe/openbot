import type {
  ApprovalDecision,
  Artifact,
  ExecutionNode,
  Run,
  RunProgress,
  WorkspaceSnapshot,
} from "@openbot/domain";
import type { RealtimeConnectionState } from "../api";
import { ArtifactDownloadLink } from "./ArtifactCard";
import { runStatusSummary } from "./NativeRunControls";
import "../context-rail.css";
import { isActiveRun, runStatusLabel } from "../run-state";
import { ApprovalCard } from "./ApprovalCard";
import { CheckIcon, NodeIcon } from "./Icons";

export function ContextRail({
  realtimeState,
  selectedChannelId,
  workspace,
  onDecideApproval,
  onInspectRun,
}: {
  realtimeState: RealtimeConnectionState;
  selectedChannelId?: string | undefined;
  workspace: WorkspaceSnapshot;
  onDecideApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  onInspectRun(runId: string): void;
}) {
  const scopedRuns = workspace.runs.filter(
    (run) => selectedChannelId === undefined || run.channelId === selectedChannelId,
  );
  const runById = new Map(workspace.runs.map((run) => [run.id, run]));
  const activeRuns = scopedRuns
    .filter(isActiveRun)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const completedCount = workspace.runs.filter((run) => run.status === "completed").length;
  const workspaceActiveCount = workspace.runs.filter(isActiveRun).length;
  const pendingApprovals = workspace.approvals.filter((approval) => {
    if (approval.status !== "pending") return false;
    if (selectedChannelId === undefined) return true;
    if (approval.channelId !== selectedChannelId) return false;
    // Approvals may outlive the bounded recent-run snapshot; a known conflict is not shown.
    const run = runById.get(approval.runId);
    return run === undefined || run.channelId === selectedChannelId;
  });
  const recentResults = scopedRuns
    .filter((run) => !isActiveRun(run))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 3);
  const botById = new Map(workspace.bots.map((bot) => [bot.id, bot]));
  const channelById = new Map(workspace.channels.map((channel) => [channel.id, channel]));
  const nodeById = new Map(workspace.nodes.map((node) => [node.id, node]));
  const latestProgress = new Map<string, RunProgress>();
  for (const progress of workspace.progress) {
    const run = runById.get(progress.runId);
    if (run === undefined || run.channelId !== progress.channelId) continue;
    const previous = latestProgress.get(progress.runId);
    if (previous === undefined || progress.createdAt > previous.createdAt) {
      latestProgress.set(progress.runId, progress);
    }
  }
  const latestArtifact = new Map<string, Artifact>();
  for (const artifact of workspace.artifacts) {
    const previous = latestArtifact.get(artifact.runId);
    if (previous === undefined || artifact.createdAt > previous.createdAt) {
      latestArtifact.set(artifact.runId, artifact);
    }
  }
  const observed = scopedRuns.flatMap((run) => (run.modelUsage ? [run.modelUsage] : []));
  const knownInput = observed.filter((usage) => usage.inputTokens !== null);
  const knownOutput = observed.filter((usage) => usage.outputTokens !== null);
  const hasActivity = pendingApprovals.length > 0 || scopedRuns.length > 0;

  return (
    <aside
      className="context-rail usage-rail"
      aria-label={selectedChannelId === undefined ? "工作区任务与详情" : "频道任务与详情"}
    >
      <header className="usage-rail-header">
        <h2>{selectedChannelId === undefined ? "工作区动态" : "频道动态"}</h2>
        <span className={`usage-rail-connection ${realtimeState}`}>
          <i aria-hidden="true" />
          {realtimeState === "live"
            ? "已同步"
            : realtimeState === "retrying"
              ? "重新连接中"
              : "连接中"}
        </span>
      </header>
      {selectedChannelId !== undefined ? (
        <p className="usage-rail-scope" title={channelById.get(selectedChannelId)?.name}>
          {channelById.get(selectedChannelId)?.name ?? "当前频道"}
          <span>{scopedRuns.length} 条最近任务记录</span>
        </p>
      ) : null}

      {pendingApprovals.length > 0 ? (
        <section className="usage-rail-section" aria-label="需要确认的操作">
          <div className="usage-rail-section-heading">
            <h3>需要确认</h3>
            <span className="usage-rail-attention-count">{pendingApprovals.length}</span>
          </div>
          <div className="approval-list">
            {pendingApprovals.map((approval) => (
              <ApprovalCard
                approval={approval}
                bot={botById.get(approval.botId)}
                channel={channelById.get(approval.channelId)}
                onDecide={onDecideApproval}
                key={approval.id}
              />
            ))}
          </div>
        </section>
      ) : null}

      {activeRuns.length > 0 ? (
        <section className="usage-rail-section" aria-label="当前任务">
          <div className="usage-rail-section-heading">
            <h3>进行中</h3>
            {activeRuns.length > 4 ? <span>显示最近 4 条</span> : null}
          </div>
          <div className="usage-rail-run-list">
            {activeRuns.slice(0, 4).map((run) => {
              const bot = botById.get(run.botId);
              const node = run.nodeId === undefined ? undefined : nodeById.get(run.nodeId);
              return (
                <RunRow
                  run={run}
                  detail={
                    runStatusSummary(run, latestProgress.get(run.id)?.message) ??
                    `${bot?.name ?? "未知 Bot"} · ${run.executionProfile === "none" || run.executionProfile === "model" ? "正在处理" : (node?.name ?? "等待分配电脑")}`
                  }
                  onInspect={onInspectRun}
                  key={run.id}
                />
              );
            })}
          </div>
        </section>
      ) : null}

      {recentResults.length > 0 ? (
        <section className="usage-rail-section" aria-label="最近结果">
          <div className="usage-rail-section-heading">
            <h3>最近结果</h3>
          </div>
          <div className="usage-rail-run-list">
            {recentResults.map((run) => {
              const artifact = latestArtifact.get(run.id);
              return (
                <div className="usage-rail-result" key={run.id}>
                  <RunRow
                    run={run}
                    detail={runStatusSummary(run) ?? botById.get(run.botId)?.name}
                    onInspect={onInspectRun}
                  />
                  {artifact ? (
                    <ArtifactDownloadLink artifact={artifact}>
                      {artifact.mediaType === "text/markdown" ? "下载报告" : "查看附件"}：
                      {artifact.name} <span aria-hidden="true">↗</span>
                    </ArtifactDownloadLink>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {!hasActivity ? (
        <div className="usage-rail-empty-state">
          <CheckIcon />
          <p>{selectedChannelId === undefined ? "暂无任务动态" : "这个频道暂无任务动态"}</p>
          <span>任务进度与需要确认的操作会显示在这里。</span>
        </div>
      ) : null}

      <section className="usage-rail-tokens" aria-label="Token 用量">
        <h3>Token 用量</h3>
        {observed.length ? (
          <>
            <p className="usage-rail-unavailable">
              输入{" "}
              {knownInput.length
                ? knownInput
                    .reduce((sum, usage) => sum + (usage.inputTokens ?? 0), 0)
                    .toLocaleString()
                : "未知"}{" "}
              · 输出{" "}
              {knownOutput.length
                ? knownOutput
                    .reduce((sum, usage) => sum + (usage.outputTokens ?? 0), 0)
                    .toLocaleString()
                : "未知"}
            </p>
            <p className="usage-rail-caption">
              已加载范围内 {observed.length} 个任务的已知记录；未记录部分不计入，不代表账单。
            </p>
          </>
        ) : (
          <>
            <p className="usage-rail-unavailable">暂无用量记录</p>
            <p className="usage-rail-caption">当前范围没有已记录的模型用量</p>
          </>
        )}
      </section>

      <details className="usage-rail-workspace-overview">
        <summary>工作区概览</summary>
        <section className="usage-rail-section" aria-label="最近任务统计">
          <div className="usage-rail-section-heading">
            <h3>最近任务</h3>
            <span>{workspace.runs.length} 条记录</span>
          </div>
          <dl className="usage-rail-task-metrics">
            <Metric label="进行中" value={workspaceActiveCount} />
            <Metric label="已完成" value={completedCount} />
            <Metric label="记录数" value={workspace.runs.length} />
          </dl>
          <p className="usage-rail-caption">统计范围为当前已加载的工作区任务记录</p>
        </section>
        <section className="usage-rail-section usage-rail-computers" aria-label="工作电脑">
          <div className="usage-rail-section-heading">
            <h3>工作电脑</h3>
            <span>{workspace.nodes.length} 台已连接</span>
          </div>
          {workspace.nodes.length === 0 ? (
            <div className="usage-rail-no-computer">
              <NodeIcon />
              <p>尚未连接工作电脑</p>
            </div>
          ) : (
            workspace.nodes.map((node) => <NodeRow node={node} key={node.id} />)
          )}
        </section>
      </details>
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function RunRow({
  run,
  detail,
  onInspect,
}: {
  run: Run;
  detail: string | undefined;
  onInspect(runId: string): void;
}) {
  return (
    <button
      className="usage-rail-run"
      type="button"
      onClick={() => onInspect(run.id)}
      aria-label={`查看任务：${run.title}`}
    >
      <span className={`usage-rail-run-dot ${run.status}`} aria-hidden="true" />
      <span className="usage-rail-run-copy">
        <strong>{run.title}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
      <span className={`usage-rail-run-status ${run.status}`}>{runStatusLabel(run.status)}</span>
    </button>
  );
}

function NodeRow({ node }: { node: ExecutionNode }) {
  return (
    <div className="usage-rail-computer">
      <span className="usage-rail-computer-icon">
        <NodeIcon />
      </span>
      <div>
        <strong>{node.name}</strong>
        <small>
          {node.platform} · {node.activeRunIds.length}/{node.maxConcurrentRuns} 任务
        </small>
      </div>
      <span className="usage-rail-online" role="img" aria-label="在线" />
    </div>
  );
}
