import type { Run } from "@openbot/domain";
import { useState } from "react";
import { ApiError, cancelNativeRun, createMessage, steerRun } from "../api";

/**
 * What the Owner may do with a task from a card or the 任务详情 sheet. Stopping and resubmitting
 * exist only for tasks the 服务电脑 runs itself; a Worker task is controlled by its 工作电脑 and
 * offers neither. 补充指令 reaches the next model step of a queued or running 服务电脑 task.
 */
export function taskControls(run: Run) {
  const serverModel = run.executionProfile === "none" || run.executionProfile === "model";
  const native = serverModel && run.nodeId === undefined;
  const live = run.status === "queued" || run.status === "running";
  return {
    canStop: native && live,
    canResubmit: native && (run.status === "failed" || run.status === "cancelled"),
    canSteer: serverModel && live,
  };
}

/**
 * Stop or resubmit, waiting for the Server's answer. One request at a time, and a lost answer is
 * reported as unconfirmed so the Owner checks before trying again instead of submitting twice.
 */
export function useTaskAction(run: Run, onRun: (run: Run) => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function act(kind: "stop" | "resubmit") {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const next =
        kind === "stop"
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
  }

  return { pending, error, stop: () => act("stop"), resubmit: () => act("resubmit") };
}

/** 补充指令: text for the running task's next model step; nothing already done is undone. */
export function SteerForm({
  run,
  botName,
  onDone,
  onClose,
}: {
  run: Run;
  botName: string;
  onDone(notice: string): void;
  /** 收起 closes the form without sending (Composer artboard). */
  onClose?(): void;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const id = `steer-${run.id}`;
  return (
    <form
      className="task-steer"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending || !text.trim()) return;
        setPending(true);
        setNotice("");
        try {
          await steerRun(run.id, text.trim());
          setText("");
          onDone("已收到，会在下一步处理。");
        } catch (cause) {
          setNotice(
            cause instanceof ApiError && cause.status === 409
              ? "任务已结束或待处理指令已满。内容已保留，可改发新消息。"
              : "未确认收到。内容已保留，请检查任务状态后重试。",
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <label htmlFor={id}>补充给 {botName} 的当前任务</label>
      <textarea
        id={id}
        value={text}
        maxLength={4000}
        rows={3}
        // biome-ignore lint/a11y/noAutofocus: the Owner just chose 补充指令.
        autoFocus
        disabled={pending}
        onChange={(event) => setText(event.target.value)}
      />
      <span className="task-steer-foot">
        <small>下一步生效；已经做完的操作不会撤回。</small>
        {onClose ? (
          <button type="button" className="ob-pill is-small" disabled={pending} onClick={onClose}>
            收起
          </button>
        ) : null}
        <button
          type="submit"
          className="ob-pill is-small is-primary"
          disabled={pending || !text.trim()}
        >
          {pending ? "正在提交…" : "发送"}
        </button>
      </span>
      {notice ? <p role="alert">{notice}</p> : null}
    </form>
  );
}
