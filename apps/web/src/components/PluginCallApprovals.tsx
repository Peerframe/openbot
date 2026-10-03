import type { Bot } from "@openbot/domain";
import { useEffect, useState } from "react";
import { ApiError } from "../api";
import {
  listPlugins,
  type PendingPluginCall,
  type PluginSnapshot,
  pluginRequest,
} from "../plugin-api";
import "./PluginManagerPanel.css";

export function PluginCallApprovals({
  channelId,
  bots,
  onInspectRun,
}: {
  channelId: string;
  bots: Bot[];
  onInspectRun(id: string): void;
}) {
  const [snapshot, setSnapshot] = useState<PluginSnapshot>({ plugins: [], pendingCalls: [] });
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Channel changes and decisions replace the approval polling lifecycle.
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    let unavailable = false;
    async function refresh() {
      if (
        running ||
        controller.signal.aborted ||
        unavailable ||
        document.visibilityState === "hidden"
      )
        return;
      running = true;
      try {
        const next = await listPlugins(
          AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
        );
        if (!controller.signal.aborted) {
          setSnapshot(next);
          setError(false);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          unavailable = cause instanceof ApiError && cause.status === 404;
          setError(true);
        }
      } finally {
        running = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [channelId, revision]);
  const calls = snapshot.pendingCalls.filter((call) => call.channelId === channelId);
  if (!calls.length) return null;
  return (
    <section className="plugin-call-approvals" aria-label="插件操作确认">
      <h2>需要确认的插件操作</h2>
      {error ? <p role="alert">审批状态暂时无法更新，请恢复连接后再操作。</p> : null}
      {calls.map((call) => (
        <PluginCallApproval
          key={call.id}
          call={call}
          botName={bots.find((bot) => bot.id === call.botId)?.name ?? "Bot"}
          endpoint={snapshot.plugins.find((plugin) => plugin.id === call.pluginId)?.endpoint}
          unavailable={error}
          onInspectRun={onInspectRun}
          onDecided={() => {
            setSnapshot((current) => ({
              ...current,
              pendingCalls: current.pendingCalls.filter((entry) => entry.id !== call.id),
            }));
            setRevision((value) => value + 1);
          }}
        />
      ))}
    </section>
  );
}

export function PluginCallApproval({
  call,
  botName,
  endpoint,
  unavailable,
  onDecided,
  onInspectRun,
}: {
  call: PendingPluginCall;
  botName: string;
  endpoint: string | undefined;
  unavailable: boolean;
  onDecided(): void;
  onInspectRun(id: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const expired = !Number.isFinite(Date.parse(call.expiresAt)) || Date.parse(call.expiresAt) <= now;
  async function decide(decision: "approve" | "reject") {
    if (busy || unavailable || expired || !endpoint) return;
    setBusy(true);
    setError(undefined);
    try {
      await pluginRequest(`plugin-calls/${encodeURIComponent(call.id)}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      onDecided();
    } catch {
      setError("决定未确认成功，请等待状态刷新，避免重复操作。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="plugin-call-approval">
      <header>
        <strong>
          {botName} 请求调用 {call.pluginName} · {call.toolName}
        </strong>
        <span>
          {expired ? "已过期" : `${Math.ceil((Date.parse(call.expiresAt) - now) / 1000)} 秒内有效`}
        </span>
      </header>
      <p>目标：{endpoint ?? "插件配置暂未加载"}</p>
      <pre>{JSON.stringify(call.arguments, null, 2)}</pre>
      <p>批准只允许以上这一次调用。插件可能产生外部影响，请检查目标和参数。</p>
      <div className="plugin-call-actions">
        <button
          className="ob-pill"
          type="button"
          disabled={busy || unavailable || expired || !endpoint}
          onClick={() => void decide("reject")}
        >
          拒绝
        </button>
        <button
          className="ob-pill is-primary"
          type="button"
          disabled={busy || unavailable || expired || !endpoint}
          onClick={() => void decide("approve")}
        >
          {busy ? "正在处理…" : "批准这次调用"}
        </button>
        <button className="ob-pill" type="button" onClick={() => onInspectRun(call.runId)}>
          查看任务
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </article>
  );
}
