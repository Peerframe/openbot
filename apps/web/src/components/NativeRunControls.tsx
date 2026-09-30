import type { Run } from "@openbot/domain";
import { useState } from "react";
import { ApiError, cancelNativeRun, createMessage } from "../api";

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
  if (!["none", "model"].includes(run.executionProfile) || run.nodeId !== undefined) return null;
  const canStop = run.status === "queued" || run.status === "running";
  const canResubmit = run.status === "failed" || run.status === "cancelled";
  if (!canStop && !canResubmit) return null;
  return (
    <section
      className={`native-run-controls${compact ? " compact" : ""}`}
      aria-label="原生任务操作"
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
            ? "停止后不会继续发布此任务的回复或报告。"
            : "将从头创建一个新任务，原任务记录会保留。"}
        </p>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
