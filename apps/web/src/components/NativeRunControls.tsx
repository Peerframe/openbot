import type { Run } from "@openbot/domain";
import { useState } from "react";
import { ApiError, cancelNativeRun, createMessage } from "../api";

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
    server_interrupted: "Server 中断了任务，服务恢复后可重新提交。",
    execution_failed: "任务未能完成，请检查模型配置、频道权限和任务范围。",
  };
  return messages[run.errorCode ?? ""] ?? run.errorMessage ?? "任务已结束。";
}

export function runStatusSummary(run: Run, progressMessage?: string): string | undefined {
  // Durable status outranks progress emitted before approval, blocking, or completion.
  if (run.status === "cancelled")
    return run.executionProfile === "none"
      ? "Owner 已停止此任务。"
      : "Owner 已停止此任务。外部操作可能已经发生，停止不会撤销已有结果。";
  if (run.status === "waiting_approval") return "敏感动作正在等待你的批准。";
  if (run.status === "failed") return nativeRunFailure(run);
  if (run.status === "blocked") return "任务遇到阻塞，需要人工处理。";
  if (run.status === "completed") return run.resultSummary ?? "任务已结束。";
  return progressMessage;
}

export function NativeRunControls({
  run,
  onRun,
  compact = false,
}: {
  run: Run;
  onRun(run: Run): void;
  compact?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const native = run.executionProfile === "none" && run.nodeId === undefined;
  const canStop =
    run.status === "queued" ||
    run.status === "running" ||
    (!native && (run.status === "assigned" || run.status === "waiting_approval"));
  const canResubmit = native && (run.status === "failed" || run.status === "cancelled");
  if (!canStop && !canResubmit) return null;
  return (
    <section
      className={`native-run-controls${compact ? " compact" : ""}`}
      aria-label={native ? "原生任务操作" : "电脑任务操作"}
    >
      <button
        type="button"
        className="secondary-button"
        disabled={pending}
        onClick={async () => {
          if (pending) return;
          setPending(true);
          setError(undefined);
          try {
            const next = canStop
              ? await cancelNativeRun(run.id)
              : (await createMessage(run.channelId, { content: run.instruction, botId: run.botId }))
                  .run;
            onRun(next);
          } catch (cause) {
            setError(
              cause instanceof ApiError && cause.status === 409
                ? "任务状态已变化，请刷新查看最新结果。"
                : "操作未确认，请先查看最新任务状态，避免重复提交。",
            );
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? "正在处理…" : canStop ? "停止任务" : "重新提交任务"}
      </button>
      {!compact && (
        <p>
          {canStop
            ? native
              ? "停止后不会继续发布此任务的回复或报告。"
              : "停止后不再接受任务结果。外部操作可能已经发生，停止不会撤销已有结果。"
            : "将从头创建一个新任务，原任务记录会保留。"}
        </p>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
