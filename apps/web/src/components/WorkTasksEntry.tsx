import { useEffect, useState } from "react";
import { listWorkBots } from "../work-api";
import { WorkTasksScreen } from "./WorkTasksScreen";

export function parseWorkEntry(hash: string): { taskId: string } | undefined {
  const [path, query] = hash.split("?", 2);
  if (path !== "#/tasks") return undefined;
  const taskId = new URLSearchParams(query).get("task") ?? "";
  return { taskId: /^[A-Za-z0-9_-]{1,128}$/.test(taskId) ? taskId : "" };
}

// The Python work reference exposes /bots, but not the legacy /workspace aggregate.
export function WorkTasksEntry({
  onLogout,
  initialTaskId = "",
}: {
  onLogout(): Promise<void>;
  initialTaskId?: string | undefined;
}) {
  const [bots, setBots] = useState<Awaited<ReturnType<typeof listWorkBots>>>([]);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retry restarts this bounded read and invalidates its predecessor.
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void listWorkBots(AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]))
      .then((result) => {
        if (!controller.signal.aborted) setBots(result);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("无法读取 Bot，请检查连接后重试；仍可按任务 ID 读取。");
      });
    return () => controller.abort();
  }, [retry]);
  return (
    <div className="work-entry">
      <nav aria-label="任务监督导航">
        <button
          type="button"
          onClick={() => {
            window.location.hash = "";
          }}
        >
          返回工作台
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onLogout();
            } catch {
              setError("退出失败，请重试。");
            } finally {
              setBusy(false);
            }
          }}
        >
          退出登录
        </button>
      </nav>
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            重试
          </button>
        </p>
      )}
      <WorkTasksScreen key={initialTaskId} bots={bots} active initialTaskId={initialTaskId} nativeCapabilitiesEnabled />
    </div>
  );
}
