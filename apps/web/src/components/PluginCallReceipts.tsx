import type { PluginCallReceipt } from "@openbot/protocol";
import { useEffect, useState } from "react";
import { listPluginCallReceipts } from "../plugin-api";
import "./plugin-call-receipts.css";

const stateLabels: Record<PluginCallReceipt["state"], string> = {
  preparing: "准备调用",
  awaiting_approval: "等待审批",
  dispatching: "正在派发调用",
  response_received: "工具答复已收到",
  not_dispatched: "尚未派发",
  outcome_unknown: "结果待核对",
};
const decisionLabels: Record<NonNullable<PluginCallReceipt["approvalDecision"]>, string> = {
  approved: "Owner 已批准",
  rejected: "Owner 已拒绝",
  expired: "审批已过期",
  interrupted: "审批已中断",
};
const readError = "暂时无法读取最新回执。请检查连接后刷新回执；已有记录不代表最新状态。";

interface ReceiptView {
  runId: string;
  calls: PluginCallReceipt[];
  pending: boolean;
  error: boolean;
  paused: boolean;
}

export function PluginCallReceipts({ runId }: { runId: string }) {
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<ReceiptView>({
    runId,
    calls: [],
    pending: true,
    error: false,
    paused: false,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh starts a new bounded read lifetime.
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let reads = 0;
    // Run termination does not settle external effects. Read independently of Run status, with
    // a finite budget and a delay after completion so slow requests can never overlap.
    const read = async () => {
      request = new AbortController();
      reads += 1;
      setView((previous) => ({
        runId,
        calls: previous.runId === runId ? previous.calls : [],
        pending: true,
        error: false,
        paused: false,
      }));
      try {
        const calls = await listPluginCallReceipts(runId, request.signal);
        if (!current) return;
        const paused = reads >= 24;
        setView({ runId, calls, pending: false, error: false, paused });
        if (!paused) timer = setTimeout(() => void read(), 5000);
      } catch {
        if (!current) return;
        setView((previous) => ({ ...previous, pending: false, error: true, paused: true }));
      }
    };
    void read();
    return () => {
      current = false;
      clearTimeout(timer);
      request?.abort();
    };
  }, [runId, revision]);

  // Hide the old Run's data during the render before effect cleanup/setup, including failed reads.
  if (view.runId !== runId || (view.calls.length === 0 && !view.error)) return null;
  const attention: PluginCallReceipt[] = [];
  const settled: PluginCallReceipt[] = [];
  for (const call of view.calls) {
    if (call.state === "response_received" || call.state === "not_dispatched") settled.push(call);
    else attention.push(call);
  }
  const unknown = attention.some((call) => call.state === "outcome_unknown");

  return (
    <section className="inspector-section plugin-call-receipts" aria-label="工具调用回执">
      <header>
        <h3>工具调用回执</h3>
        <button
          className="secondary-button"
          type="button"
          disabled={view.pending}
          onClick={() => setRevision((value) => value + 1)}
        >
          {view.pending ? "读取中…" : "刷新回执"}
        </button>
      </header>
      {unknown ? (
        <p className="receipt-warning" role="note">
          有外部调用结果待核对。任务失败或取消不代表外部动作未发生；请先在原服务核对，再决定是否创建新任务。
        </p>
      ) : null}
      <p className="receipt-explanation">
        回执仅记录派发、审批和工具答复；收到答复不代表已独立证实外部结果。刷新只读取记录，不会重试调用。
      </p>
      {view.error ? <p role="alert">{readError}</p> : null}
      {attention.length > 0 ? <ReceiptList calls={attention} label="待核对与进行中的调用" /> : null}
      {settled.length > 0 ? (
        <details className="receipt-settled">
          <summary>已终结回执（{settled.length}）</summary>
          <ReceiptList calls={settled} label="已终结的调用" />
        </details>
      ) : null}
      {view.calls.length === 256 ? (
        <p className="receipt-explanation">
          已显示本次查询上限 256 条；更早的已终结回执可能未包含。
        </p>
      ) : null}
      {view.paused && !view.error ? (
        <p className="receipt-explanation">自动更新已暂停，可刷新回执继续核对。</p>
      ) : null}
    </section>
  );
}

function ReceiptList({ calls, label }: { calls: PluginCallReceipt[]; label: string }) {
  return (
    <ul className="receipt-list" aria-label={label}>
      {calls.map((call) => (
        <li key={call.id}>
          <strong className={`receipt-state ${call.state}`}>{stateLabels[call.state]}</strong>
          <p className="receipt-tool">
            {call.pluginName} · {call.toolName}
          </p>
          <p>
            {call.approvalDecision
              ? decisionLabels[call.approvalDecision]
              : call.mode === "read"
                ? "只读授权，无需逐次审批"
                : "尚无审批决定"}
          </p>
          <p className="receipt-call-id">
            调用 ID：<code>{call.id}</code>
          </p>
          <details>
            <summary>时间与插件版本</summary>
            <dl>
              <dt>创建</dt>
              <dd>
                <ReceiptTime value={call.createdAt} />
              </dd>
              <dt>更新</dt>
              <dd>
                <ReceiptTime value={call.updatedAt} />
              </dd>
              {call.approvalRequestedAt ? (
                <>
                  <dt>请求审批</dt>
                  <dd>
                    <ReceiptTime value={call.approvalRequestedAt} />
                  </dd>
                </>
              ) : null}
              {call.approvalDecidedAt ? (
                <>
                  <dt>审批决定</dt>
                  <dd>
                    <ReceiptTime value={call.approvalDecidedAt} />
                  </dd>
                </>
              ) : null}
              {call.dispatchedAt ? (
                <>
                  <dt>派发记录</dt>
                  <dd>
                    <ReceiptTime value={call.dispatchedAt} />
                  </dd>
                </>
              ) : null}
              {call.responseReceivedAt ? (
                <>
                  <dt>收到答复</dt>
                  <dd>
                    <ReceiptTime value={call.responseReceivedAt} />
                  </dd>
                </>
              ) : null}
              <dt>插件 ID</dt>
              <dd>
                <code>{call.pluginId}</code>
              </dd>
              <dt>审核版本</dt>
              <dd>
                <code>{call.pluginRevision}</code>
              </dd>
            </dl>
          </details>
        </li>
      ))}
    </ul>
  );
}

function ReceiptTime({ value }: { value: string }) {
  return <time dateTime={value}>{value.replace("T", " ").replace("Z", " UTC")}</time>;
}
