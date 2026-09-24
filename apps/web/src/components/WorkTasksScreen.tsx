import type { Bot } from "@openbot/domain";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import {
  cancelWorkTask,
  type CreateWorkInput,
  createWorkTask,
  getWorkTask,
  type WorkSnapshot,
} from "../work-api";
import "./destinations.css";
import "./WorkTasksScreen.css";

const statusLabels = {
  queued: "排队中",
  open: "进行中",
  running: "运行中",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
};
function failure(cause: unknown) {
  if (cause instanceof ApiError) {
    if (cause.status === 401) return "登录已失效，请重新登录。";
    if (cause.status === 403) return "Server 拒绝了此请求，请检查权限与连接来源。";
    if ([404, 405].includes(cause.status)) return "未找到任务或当前 Server 未启用任务接口。";
    if (cause.status === 409) return "请求与 Server 当前状态冲突，请刷新任务。";
    if (cause.status === 422) return "Server 未接受请求参数，请检查输入。";
  }
  return "未能确认请求结果，请检查连接后刷新。";
}

export function WorkTasksScreen({
  bots,
  active,
}: {
  bots: Pick<Bot, "id" | "name">[];
  active: boolean;
}) {
  const [botId, setBotId] = useState("");
  const [objective, setObjective] = useState("");
  const [tokenLimit, setTokenLimit] = useState("10000");
  const [lookup, setLookup] = useState("");
  const [taskId, setTaskId] = useState("");
  const [snapshot, setSnapshot] = useState<WorkSnapshot>();
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState<CreateWorkInput>();
  const [created, setCreated] = useState(false);
  const request = useRef<AbortController | null>(null);
  const mutating = useRef(false);
  const current = useRef<WorkSnapshot | undefined>(undefined);

  const accept = useCallback((next: WorkSnapshot) => {
    if (current.current?.id === next.id && current.current.revision > next.revision) return false;
    current.current = next;
    setSnapshot(next);
    setFresh(true);
    return true;
  }, []);

  const refresh = useCallback(
    async (replacePending = true) => {
      if (!taskId || mutating.current || (!replacePending && request.current)) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setBusy(true);
      try {
        const next = await getWorkTask(
          taskId,
          AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        );
        if (controller.signal.aborted) return;
        if (accept(next)) setError("");
      } catch (cause) {
        if (controller.signal.aborted) return;
        setFresh(false);
        setError(failure(cause));
      } finally {
        if (request.current === controller) request.current = null;
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [taskId, accept],
  );

  useEffect(() => {
    if (!active) return;
    void refresh();
    const reconnect = () => {
      if (!document.hidden) void refresh();
    };
    const disconnected = () => setFresh(false);
    window.addEventListener("online", reconnect);
    window.addEventListener("focus", reconnect);
    window.addEventListener("offline", disconnected);
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh(false);
    }, 5000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("focus", reconnect);
      window.removeEventListener("offline", disconnected);
      // Stopping observation never sends a cancellation command.
      if (!mutating.current) {
        request.current?.abort();
        request.current = null;
        setBusy(false);
      }
    };
  }, [active, refresh]);
  useEffect(() => () => request.current?.abort(), []);

  function begin() {
    if (mutating.current) return;
    mutating.current = true;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    return controller;
  }
  function finish(controller: AbortController) {
    mutating.current = false;
    if (request.current === controller) request.current = null;
    if (!controller.signal.aborted) setBusy(false);
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    const input = attempt ?? {
      botId: botId || bots[0]?.id || "",
      objective: objective.trim(),
      tokenLimit: Number(tokenLimit),
      requestKey: crypto.randomUUID(),
    };
    if (
      !input.botId ||
      !input.objective ||
      !Number.isSafeInteger(input.tokenLimit) ||
      input.tokenLimit < 0 ||
      input.tokenLimit > 1000000000
    )
      return;
    const controller = begin();
    if (!controller) return;
    setAttempt(input);
    try {
      const next = await createWorkTask(
        input,
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      );
      if (controller.signal.aborted) return;
      accept(next);
      setTaskId(next.id);
      setLookup(next.id);
      setCreated(true);
      setNotice("Server 已持久化任务；执行状态以快照为准。");
    } catch (cause) {
      if (!controller.signal.aborted) {
        if (cause instanceof ApiError && [401, 403, 404, 405, 422].includes(cause.status)) {
          setAttempt(undefined);
          setError(failure(cause));
        } else {
          setError(`${failure(cause)} 创建是否已持久化尚未确认；重试会复用同一请求。`);
        }
      }
    } finally {
      finish(controller);
    }
  }
  async function cancel() {
    if (!snapshot || !fresh) return;
    const controller = begin();
    if (!controller) return;
    try {
      const next = await cancelWorkTask(
        snapshot.id,
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      );
      if (controller.signal.aborted) return;
      accept(next);
      setNotice(next.cancelRequested ? "Server 已记录取消请求。" : "已读取 Server 返回状态。");
    } catch (cause) {
      if (!controller.signal.aborted) {
        setFresh(false);
        setError(`${failure(cause)} 尚未确认取消，请刷新快照。`);
      }
    } finally {
      finish(controller);
    }
  }
  function open(event: FormEvent) {
    event.preventDefault();
    if (mutating.current || !lookup.trim()) return;
    request.current?.abort();
    setError("");
    setNotice("");
    setFresh(false);
    if (lookup.trim() === taskId) void refresh();
    else {
      current.current = undefined;
      setSnapshot(undefined);
      setTaskId(lookup.trim());
    }
  }

  return (
    <main
      className="workspace-destination work-tasks"
      hidden={!active}
      aria-labelledby="work-tasks-title"
    >
      <header className="destination-header">
        <h1 id="work-tasks-title">任务监督</h1>
      </header>
      <div className="destination-scroll">
        <p>创建任务或输入任务 ID，查看 Server 保存的最新状态。</p>
        <form className="work-form" onSubmit={(event) => void create(event)}>
          <h2>{created ? "已提交任务" : "创建任务"}</h2>
          <fieldset hidden={created} disabled={busy || !!attempt}>
            <label>
              Bot
              <select
                value={botId || bots[0]?.id || ""}
                onChange={(event) => setBotId(event.target.value)}
                required
              >
                {bots.map((bot) => (
                  <option value={bot.id} key={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              任务目标
              <textarea
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                required
                maxLength={16384}
                rows={3}
              />
            </label>
            <label>
              Token 上限
              <input
                type="number"
                min="0"
                max="1000000000"
                step="1"
                required
                value={tokenLimit}
                onChange={(event) => setTokenLimit(event.target.value)}
              />
            </label>
          </fieldset>
          {!created ? (
            <button className="primary-button" type="submit" disabled={busy || bots.length === 0}>
              {attempt ? "重试同一创建请求" : "提交任务"}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setAttempt(undefined);
                setCreated(false);
                setObjective("");
                setNotice("");
              }}
            >
              创建另一个任务
            </button>
          )}
          {attempt && (
            <small>
              创建请求 ID：<code>{attempt.requestKey}</code>
              {!created && " · 请保留此页面，确认后再创建其他任务。"}
            </small>
          )}
          {bots.length === 0 && <p>请先创建 Bot。</p>}
        </form>
        <form className="work-lookup" onSubmit={open}>
          <label>
            任务 ID
            <input
              required
              maxLength={128}
              value={lookup}
              onChange={(event) => setLookup(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>
            读取任务
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {taskId && (
          <div className="work-controls">
            <button type="button" disabled={busy} onClick={() => void refresh()}>
              {busy ? "正在同步…" : "刷新快照"}
            </button>
            <span role="status">
              {fresh ? "已同步 Server 快照" : "状态待同步；连接变化不会取消任务"}
            </span>
          </div>
        )}
        {snapshot && (
          <section className="work-snapshot" aria-label="任务快照">
            <h2>{snapshot.objective}</h2>
            <p>
              任务 ID：<code>{snapshot.id}</code> · 快照版本 {snapshot.revision}
            </p>
            <dl>
              <dt>任务状态</dt>
              <dd>
                {statusLabels[snapshot.status]} ({snapshot.status})
              </dd>
              <dt>执行授权</dt>
              <dd>{snapshot.authorityActive ? "有效" : "已关闭"}</dd>
              <dt>取消请求</dt>
              <dd>{snapshot.cancelRequested ? "Server 已持久化" : "未记录"}</dd>
              {snapshot.cancelRequested && (
                <>
                  <dt>取消送达</dt>
                  <dd>Server 未提供独立送达回执；请查看 Run 状态</dd>
                </>
              )}
              <dt>Token 用量</dt>
              <dd>
                已用 {snapshot.usage.spentTokens} / 预留 {snapshot.usage.reservedTokens} / 上限{" "}
                {snapshot.usage.tokenLimit}
              </dd>
            </dl>
            {snapshot.attention && (
              <p>
                需要处理：
                {
                  { approval: "审批", reconciliation: "未知结果核验", budget: "预算" }[
                    snapshot.attention
                  ]
                }
                。此入口当前支持创建、读取和取消。
              </p>
            )}
            <button
              type="button"
              disabled={
                busy ||
                !fresh ||
                !snapshot.authorityActive ||
                snapshot.cancelRequested ||
                ["completed", "failed", "cancelled"].includes(snapshot.status)
              }
              onClick={() => void cancel()}
            >
              取消任务
            </button>
            <h3>Run 状态</h3>
            <ul>
              {snapshot.runs.map((run) => (
                <li key={run.id}>
                  Run {run.ordinal} · {statusLabels[run.status]} ({run.status}) ·{" "}
                  <code>{run.id}</code>
                </li>
              ))}
            </ul>
            {snapshot.actions.length > 0 && (
              <>
                <h3>操作状态</h3>
                <ul>
                  {snapshot.actions.map((action) => (
                    <li key={action.id}>
                      <code>{action.id}</code> ·{" "}
                      {action.status === "unknown"
                        ? "结果未知（unknown），不能视为成功"
                        : action.status}{" "}
                      · 审批 {action.decision}
                      {action.reconciliation && (
                        <p>
                          核验命令已持久化 · {action.reconciliation.delivered ? "已送达" : "待送达"}{" "}
                          ·{" "}
                          {action.reconciliation.outcome === null
                            ? "尚无核验结果"
                            : action.reconciliation.outcome === "resolved"
                              ? "已查明"
                              : "仍未查明"}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {snapshot.resultSummary && <p className="work-result">{snapshot.resultSummary}</p>}
            {snapshot.artifacts.length > 0 && (
              <p>Server 已登记 {snapshot.artifacts.length} 个产物；此入口的产物下载尚未接入。</p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
