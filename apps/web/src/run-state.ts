import type { Artifact, ExecutionNode, Run, RunProgress } from "@openbot/domain";

const activeStatuses = new Set<Run["status"]>([
  "queued",
  "assigned",
  "running",
  "waiting_approval",
  "blocked",
]);

export function isActiveRun(run: Run): boolean {
  return activeStatuses.has(run.status);
}

export function mergeRuns(primary: Run[], secondary: Run[]): Run[] {
  const byId = new Map<string, Run>();
  for (const run of [...primary, ...secondary]) {
    const existing = byId.get(run.id);
    if (existing === undefined || isNewerProjection(run, existing)) byId.set(run.id, run);
  }
  return Array.from(byId.values())
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 50);
}

export function mergeArtifacts(primary: Artifact[], secondary: Artifact[]): Artifact[] {
  const byId = new Map(primary.map((artifact) => [artifact.id, artifact]));
  for (const artifact of secondary) byId.set(artifact.id, artifact);
  return Array.from(byId.values()).sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

export function mergeProgress(primary: RunProgress[], secondary: RunProgress[]): RunProgress[] {
  const byId = new Map(primary.map((progress) => [progress.id, progress]));
  for (const progress of secondary) byId.set(progress.id, progress);
  return Array.from(byId.values())
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-200);
}

export function mergeNodes(primary: ExecutionNode[], secondary: ExecutionNode[]): ExecutionNode[] {
  const byId = new Map(primary.map((node) => [node.id, node]));
  for (const node of secondary) {
    const existing = byId.get(node.id);
    if (existing === undefined || node.lastSeenAt >= existing.lastSeenAt) byId.set(node.id, node);
  }
  return Array.from(byId.values()).sort((left, right) =>
    right.connectedAt.localeCompare(left.connectedAt),
  );
}

function isNewerProjection(candidate: Run, existing: Run): boolean {
  const timeComparison = candidate.updatedAt.localeCompare(existing.updatedAt);
  if (timeComparison !== 0) return timeComparison > 0;
  return statusRevision(candidate.status) > statusRevision(existing.status);
}

function statusRevision(status: Run["status"]): number {
  const revisions: Record<Run["status"], number> = {
    queued: 0,
    assigned: 1,
    running: 2,
    waiting_approval: 3,
    blocked: 3,
    completed: 4,
    failed: 4,
    cancelled: 4,
  };
  return revisions[status];
}

export function indexActiveRunsByBot(runs: Run[]): Map<string, Run> {
  const result = new Map<string, Run>();
  for (const run of runs) {
    if (isActiveRun(run) && !result.has(run.botId)) result.set(run.botId, run);
  }
  return result;
}

export function projectRunOnNodes(
  nodes: ExecutionNode[],
  previous: Run | undefined,
  current: Run,
): ExecutionNode[] {
  return nodes.map((node) => {
    const activeRunIds = new Set(node.activeRunIds);
    if (previous?.nodeId === node.id && occupiesNode(previous)) activeRunIds.delete(previous.id);
    if (current.nodeId === node.id && occupiesNode(current)) activeRunIds.add(current.id);
    return activeRunIds.size === node.activeRunIds.length &&
      node.activeRunIds.every((runId) => activeRunIds.has(runId))
      ? node
      : { ...node, activeRunIds: Array.from(activeRunIds) };
  });
}

/**
 * C13 stage names in Chinese. The 服务电脑 sends a bounded control-authored dictionary key (and an
 * English description); Work action kinds map onto the same keys. Unknown keys show no name.
 */
const stageLabels: Record<string, string> = {
  context: "读取员工资料",
  planning: "想下一步",
  model: "想下一步",
  observation: "查看结果",
  navigate: "打开网页",
  screenshot: "截取画面",
  action: "执行已授权的操作",
  tool: "执行已授权的操作",
  deferred_tool: "执行已授权的操作",
  approval: "等你确认",
};

export function stageLabel(stage: string | null | undefined): string | undefined {
  return stage ? stageLabels[stage] : undefined;
}

export function runStatusLabel(status: Run["status"]): string {
  const labels: Record<Run["status"], string> = {
    queued: "已接单",
    assigned: "已分配",
    running: "工作中",
    waiting_approval: "待批准",
    blocked: "已阻塞",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return labels[status];
}

function occupiesNode(run: Run): boolean {
  return (
    run.nodeId !== undefined &&
    (run.status === "assigned" ||
      run.status === "running" ||
      run.status === "waiting_approval" ||
      run.status === "blocked")
  );
}

export function nativeRunFailure(run: Run): string {
  const messages: Record<string, string> = {
    model_credentials: "模型密钥被拒绝，请到设置核对提供方和密钥后重新提交。",
    model_rate_limit: "模型服务限流，请稍后重新提交。",
    model_unavailable: "模型服务暂时不可用，请检查模型配置与服务状态。",
    settings_changed: "执行期间模型设置发生变化，请确认当前配置后重新提交。",
    scope_revoked: "Bot 已失去当前频道访问权限，请检查成员关系。",
    invalid_target: "任务引用的协作对象或资料无效，请查看任务详情并确认所需 Bot 和资料仍可用。",
    conflict: "任务状态已变化，本次更新未能保存。请查看最新任务状态后再提交。",
    skills_changed: "执行期间已审阅技能发生变化，请确认当前技能分配后重新提交。",
    memory_changed: "执行期间员工记忆发生变化，请确认当前记忆后重新提交。",
    task_limit: "任务超过执行上限，请拆成更小的任务。",
    tool_unavailable: "工具未能完成，请检查任务中的公开网址和所需能力。",
    task_timeout: "任务超时，请缩小任务范围或检查模型连接。",
    server_interrupted: "服务电脑中断了任务，服务恢复后可重新提交。",
    execution_failed: "任务未能完成，请检查模型配置、频道权限和任务范围。",
  };
  return messages[run.errorCode ?? ""] ?? run.errorMessage ?? "任务已结束。";
}

export function runStatusSummary(run: Run, progressMessage?: string): string | undefined {
  // Durable status outranks progress emitted before approval, blocking, or completion.
  if (run.status === "cancelled") return "Owner 已停止此任务。";
  if (run.status === "waiting_approval") return "敏感动作正在等待你的批准。";
  if (run.status === "failed") return nativeRunFailure(run);
  if (run.status === "blocked") return "任务遇到阻塞，需要人工处理。";
  if (run.status === "completed") return run.resultSummary ?? "任务已结束。";
  return progressMessage;
}
