import type { Bot } from "@openbot/domain";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import {
  type CreateWorkInput,
  cancelWorkTask,
  createWorkTask,
  getWorkTask,
  type WorkSnapshot,
} from "../work-api";
import {
  emptyNativeTaskScope,
  type NativeTaskScopeInput,
  type OwnerAttachment,
} from "../native-task-api";
import {
  NativeTaskScopeForm,
  attachmentNeedsProcessing,
  taskBotSupported,
} from "./NativeTaskScopeForm";
import { NativeTaskScopeView } from "./NativeTaskScopeView";
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
    if (cause.status === 403) return "服务电脑拒绝了此请求，请检查权限与连接来源。";
    if ([404, 405].includes(cause.status)) return "未找到任务或当前服务电脑未启用任务接口。";
    if (cause.status === 409) return "请求与服务电脑当前状态冲突，请刷新任务。";
    if (cause.status === 413)
      return "请求内容过大，服务电脑未接受此请求。请缩短任务目标后重新提交。";
    if (cause.status === 422) return "服务电脑未接受请求参数，请检查输入。";
  }
  return "未能确认请求结果，请检查连接后刷新。";
}

export function WorkTasksScreen({
  bots,
  active,
  initialTaskId = "",
  nativeCapabilitiesEnabled = false,
}: {
  bots: Pick<Bot, "id" | "name" | "computerProfile">[];
  active: boolean;
  initialTaskId?: string | undefined;
  nativeCapabilitiesEnabled?: boolean;
}) {
  const eligibleBots = bots.filter(taskBotSupported);
  const [botId, setBotId] = useState("");
  const selectedBotId = botId || eligibleBots[0]?.id || "";
  const [scope, setScope] = useState<NativeTaskScopeInput>(emptyNativeTaskScope);
  const [files, setFiles] = useState<OwnerAttachment[]>([]);
  const [filesFresh, setFilesFresh] = useState(true);
  const [resourcesBusy, setResourcesBusy] = useState(false);
  const [formGeneration, setFormGeneration] = useState(0);
  const resourcesInvalid =
    scope.attachmentIds.length > 0 &&
    (!filesFresh ||
      scope.attachmentIds.some((id) => {
        const file = files.find((item) => item.id === id);
        return !file || !!file.deletedAt || attachmentNeedsProcessing(file);
      }));
  const [objective, setObjective] = useState("");
  const [tokenLimit, setTokenLimit] = useState("10000");
  const [lookup, setLookup] = useState(initialTaskId);
  const [taskId, setTaskId] = useState(initialTaskId);
  const [snapshot, setSnapshot] = useState<WorkSnapshot>();
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState<CreateWorkInput>();
  const [created, setCreated] = useState(false);
  const [mode, setMode] = useState<"create" | "lookup">(initialTaskId ? "lookup" : "create");
  const request = useRef<AbortController | null>(null);
  const online = useRef(navigator.onLine);
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
      if (!online.current || !taskId || mutating.current || (!replacePending && request.current))
        return;
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
    online.current = navigator.onLine;
    if (!online.current) setFresh(false);
    void refresh();
    const onFocus = () => {
      if (!document.hidden) void refresh();
    };
    const reconnect = () => {
      online.current = true;
      onFocus();
    };
    const disconnected = () => {
      online.current = false;
      // Invalidate responses already in flight. Aborting transport does not undo a Server
      // mutation; an ambiguous creation retains its original body/key for explicit retry.
      request.current?.abort();
      request.current = null;
      setBusy(false);
      setFresh(false);
    };
    window.addEventListener("online", reconnect);
    window.addEventListener("focus", onFocus);
    window.addEventListener("offline", disconnected);
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh(false);
    }, 5000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("focus", onFocus);
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
    if (!online.current) {
      setError("网络已断开，请恢复连接后重试。");
      return;
    }
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
    if (!attempt && (resourcesBusy || resourcesInvalid)) {
      setError("请刷新并完成所选附件的必要处理，或解除选择后再提交。");
      return;
    }
    if (
      !attempt &&
      (!eligibleBots.some((bot) => bot.id === selectedBotId) ||
        scope.collaboratorBotIds.some(
          (id) => id === selectedBotId || !eligibleBots.some((bot) => bot.id === id),
        ) ||
        (!nativeCapabilitiesEnabled &&
          (scope.knowledge || scope.plugins || scope.web || scope.collaboratorBotIds.length > 0)))
    ) {
      setError("所选 Bot 或额外能力当前不可用，请检查本次任务范围。");
      return;
    }
    const input = attempt ?? {
      botId: selectedBotId,
      objective: objective.trim(),
      tokenLimit: Number(tokenLimit),
      requestKey: crypto.randomUUID(),
      scope: {
        ...scope,
        attachmentIds: [...scope.attachmentIds].sort(),
        collaboratorBotIds: [...scope.collaboratorBotIds].sort(),
      },
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
      setNotice("服务电脑已持久化任务；执行状态以快照为准。");
    } catch (cause) {
      if (!controller.signal.aborted) {
        if (cause instanceof ApiError && [401, 403, 404, 405, 413, 422].includes(cause.status)) {
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
      setNotice(next.cancelRequested ? "服务电脑已记录取消请求。" : "已读取服务电脑返回状态。");
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

  const terminal = snapshot
    ? ["completed", "failed", "cancelled"].includes(snapshot.status)
    : false;
  const unknownActions = snapshot?.actions.filter((action) => action.status === "unknown") ?? [];
  const usage = snapshot?.usage;
  const stages: Array<[string, "done" | "current" | ""]> = [
    ["已提交", attempt || snapshot ? "done" : ""],
    ["服务电脑已保存", snapshot ? "done" : attempt ? "current" : ""],
    [
      snapshot?.status === "cancelled"
        ? "已取消"
        : snapshot?.status === "failed"
          ? "没能完成"
          : "工作中",
      terminal ? "done" : snapshot && snapshot.status !== "queued" ? "current" : "",
    ],
    [
      "结果核验",
      snapshot?.status === "completed" && unknownActions.length === 0
        ? "done"
        : unknownActions.length > 0
          ? "current"
          : "",
    ],
  ];

  return (
    <main
      className="workspace-destination work-tasks"
      hidden={!active}
      aria-labelledby="work-tasks-title"
    >
      <div className="work-columns">
        <section className="work-compose">
          <div className="work-heading">
            <h1 id="work-tasks-title">交给 Bot 一个任务</h1>
            <p>不在聊天里，也能下达和追踪任务。服务电脑保存状态，关掉窗口不会取消。</p>
          </div>
          <div className="ob-seg" role="tablist" aria-label="方式">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "create"}
              onClick={() => setMode("create")}
            >
              新建任务
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "lookup"}
              onClick={() => setMode("lookup")}
            >
              按 ID 查找
            </button>
          </div>

          <form
            className="work-form"
            hidden={mode !== "create"}
            onSubmit={(event) => void create(event)}
          >
            {created ? <h2>已提交任务</h2> : null}
            <fieldset hidden={created} disabled={busy || !!attempt || resourcesBusy}>
              <label className="ob-field">
                交给
                <select
                  value={selectedBotId}
                  onChange={(event) => {
                    setBotId(event.target.value);
                    setScope({
                      ...scope,
                      collaboratorBotIds: scope.collaboratorBotIds.filter(
                        (id) => id !== event.target.value,
                      ),
                    });
                  }}
                  required
                >
                  {eligibleBots.map((bot) => (
                    <option value={bot.id} key={bot.id}>
                      {bot.name} · {bot.computerProfile === "model" ? "只用模型回复" : "只对话"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ob-field">
                要做什么
                <textarea
                  value={objective}
                  onChange={(event) => setObjective(event.target.value)}
                  required
                  maxLength={16384}
                  rows={4}
                />
              </label>
              <NativeTaskScopeForm
                key={formGeneration}
                bots={eligibleBots}
                botId={selectedBotId}
                value={scope}
                onChange={setScope}
                files={files}
                onFilesChange={setFiles}
                onBusyChange={setResourcesBusy}
                onFreshChange={setFilesFresh}
                disabled={busy || !!attempt}
                active={active && !created}
                capabilitiesEnabled={nativeCapabilitiesEnabled}
              />
              <label className="ob-field">
                用量上限（tokens）
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
            {resourcesInvalid && !attempt && (
              <p className="work-note is-warning">
                请刷新并完成所选附件的必要处理，或解除选择后再提交。
              </p>
            )}
            <p className="work-note">
              {eligibleBots.length === 0
                ? "还没有不需要电脑的 Bot。要用电脑的任务请在频道里发。"
                : "这里只能交给不需要电脑的 Bot；要用电脑的任务请在频道里发。"}
            </p>
            {!created ? (
              <button
                className="ob-pill is-large is-primary"
                type="submit"
                disabled={
                  busy ||
                  (!attempt && (eligibleBots.length === 0 || resourcesBusy || resourcesInvalid))
                }
              >
                {attempt ? "重试同一创建请求" : "提交任务"}
              </button>
            ) : (
              <button
                type="button"
                className="ob-pill is-large"
                disabled={busy}
                onClick={(event) => {
                  // React reuses this node as the submit button after the state reset.
                  event.preventDefault();
                  setAttempt(undefined);
                  setCreated(false);
                  setObjective("");
                  setNotice("");
                  setScope(emptyNativeTaskScope());
                  setFiles([]);
                  setFilesFresh(true);
                  setFormGeneration((value) => value + 1);
                }}
              >
                创建另一个任务
              </button>
            )}
            {attempt && (
              <small className="work-note">
                创建请求 ID：<code>{attempt.requestKey}</code>
                {!created && " · 请保留此页面，确认后再创建其他任务。"}
              </small>
            )}
          </form>

          <form className="work-lookup" hidden={mode !== "lookup"} onSubmit={open}>
            <label className="ob-field">
              任务 ID
              <input
                required
                maxLength={128}
                value={lookup}
                onChange={(event) => setLookup(event.target.value)}
              />
            </label>
            <button type="submit" className="ob-pill is-large is-primary" disabled={busy}>
              读取任务
            </button>
          </form>
          {error && (
            <p className="work-note is-danger" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="work-note" role="status">
              {notice}
            </p>
          )}
        </section>

        <section className="work-status" aria-label="任务状态">
          {snapshot ? (
            <section className="work-snapshot" aria-label="任务快照">
              <div className="work-snapshot-title">
                <h2>{snapshot.objective}</h2>
                <code title={snapshot.id}>{shortId(snapshot.id)}</code>
              </div>
              <ol className="work-stages">
                {stages.map(([label, state]) => (
                  <li key={label} className={state ? `is-${state}` : ""}>
                    <i aria-hidden="true">{state === "done" ? "✓" : ""}</i>
                    {label}
                  </li>
                ))}
              </ol>
              <dl className="work-card">
                <div>
                  <dt>执行状态</dt>
                  <dd>
                    {statusLabels[snapshot.status]}
                    {snapshot.attention
                      ? ` · 需要处理：${{ approval: "审批", reconciliation: "未知结果核验", budget: "预算" }[snapshot.attention]}`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt>结果核验</dt>
                  <dd>
                    {unknownActions.length > 0
                      ? `${unknownActions.length} 个结果未知，正在核验`
                      : snapshot.resultSummary
                        ? "已有结果"
                        : "尚无结果"}
                  </dd>
                  <small>完成后核对</small>
                </div>
                {usage ? (
                  <div>
                    <dt>用量</dt>
                    <dd>
                      {usage.spentTokens.toLocaleString()} / {usage.tokenLimit.toLocaleString()}{" "}
                      tokens
                    </dd>
                    <span className="work-meter" aria-hidden="true">
                      <i
                        style={{
                          width: `${usage.tokenLimit > 0 ? Math.min(100, (usage.spentTokens / usage.tokenLimit) * 100) : 0}%`,
                        }}
                      />
                    </span>
                  </div>
                ) : null}
                <div>
                  <dt>取消</dt>
                  <dd>{snapshot.cancelRequested ? "服务电脑已持久化取消请求" : "未请求"}</dd>
                  <button
                    type="button"
                    className="ob-pill is-small"
                    disabled={
                      busy ||
                      !fresh ||
                      !snapshot.authorityActive ||
                      snapshot.cancelRequested ||
                      terminal
                    }
                    onClick={() => void cancel()}
                  >
                    取消任务
                  </button>
                </div>
              </dl>
              {snapshot.resultSummary && <p className="work-result">{snapshot.resultSummary}</p>}
              <div className="work-warning">
                <span aria-hidden="true">!</span>
                <span>
                  <strong>结果「未知」不算成功</strong>
                  <span>
                    网络断开时显示「状态待同步」，连接变化不会取消任务；恢复后点「刷新快照」以服务电脑为准。
                  </span>
                </span>
              </div>
              <details className="work-details">
                <summary>技术细节</summary>
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
                  {snapshot.cancelRequested && (
                    <>
                      <dt>取消送达</dt>
                      <dd>服务电脑未提供独立送达回执；请查看 任务状态</dd>
                    </>
                  )}
                  <dt>Token 用量</dt>
                  <dd>
                    已用 {snapshot.usage.spentTokens} / 预留 {snapshot.usage.reservedTokens} / 上限{" "}
                    {snapshot.usage.tokenLimit}
                  </dd>
                </dl>
                <NativeTaskScopeView
                  key={snapshot.id}
                  taskId={snapshot.id}
                  active={active}
                  fresh={fresh}
                />
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
                              核验命令已持久化 ·{" "}
                              {action.reconciliation.delivered ? "已送达" : "待送达"} ·{" "}
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
                {snapshot.artifacts.length > 0 && (
                  <p>服务电脑已登记 {snapshot.artifacts.length} 个产出；这里还不能下载。</p>
                )}
              </details>
            </section>
          ) : (
            <p className="work-empty">
              {taskId ? "正在读取任务…" : "提交或查找一个任务后，状态会显示在这里。"}
            </p>
          )}
          {taskId && (
            <div className="work-controls">
              <button
                type="button"
                className="ob-pill"
                disabled={busy}
                onClick={() => void refresh()}
              >
                {busy ? "正在同步…" : "刷新快照"}
              </button>
              <span role="status">
                {fresh ? "已同步服务电脑快照" : "状态待同步；连接变化不会取消任务"}
              </span>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function shortId(id: string) {
  return id.length > 14 ? `${id.slice(0, 9)}…${id.slice(-4)}` : id;
}
