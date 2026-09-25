import type { Run } from "@openbot/domain";
import { useState } from "react";
import { ApiError, steerRun } from "../api";

export function RunSteering({ run, botName }: { run: Run; botName: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  if (
    !["none", "model"].includes(run.executionProfile) ||
    !["queued", "running"].includes(run.status)
  )
    return null;
  return (
    <div className="run-steering">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        补充指令
      </button>
      {open && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending || !text.trim()) return;
            setPending(true);
            setNotice("");
            try {
              await steerRun(run.id, text.trim());
              setText("");
              setOpen(false);
              setNotice("已接收，将在下一步处理。");
            } catch (cause) {
              setNotice(
                cause instanceof ApiError && cause.status === 409
                  ? "任务已结束或待处理指令已满。内容已保留，可改发新消息。"
                  : "未确认接收。内容已保留，请检查任务状态后重试。",
              );
            } finally {
              setPending(false);
            }
          }}
        >
          <label htmlFor={`steering-${run.id}`}>补充给 {botName} 的当前任务</label>
          <textarea
            id={`steering-${run.id}`}
            value={text}
            maxLength={4000}
            rows={3}
            onChange={(event) => setText(event.target.value)}
            disabled={pending}
          />
          <small>在下一次模型执行步骤生效；已经执行的操作不会被撤回。</small>
          <button type="submit" disabled={pending || !text.trim()}>
            {pending ? "正在提交…" : "提交补充"}
          </button>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
