import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { decideApproval } from "../api";
import { ChannelWorkspace } from "../components/ChannelWorkspace";
import { ContextRail } from "../components/ContextRail";
import { RunInspector } from "../components/RunInspector";
import { Sidebar } from "../components/Sidebar";
import { createConversationSession } from "../conversation-session";
import { demoBots, demoChannel } from "../demo/fixtures";
import {
  type ClientFixtureAdapter,
  type ClientScenario,
  clientScenarios,
  fixtureRunId,
} from "./adapter";

const ignore = () => undefined;

export function ClientFixtures({ adapter }: { adapter: ClientFixtureAdapter }) {
  const state = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot);
  const [epoch, setEpoch] = useState(0);
  const [inspection, setInspection] = useState<string>();
  const [panel, setPanel] = useState<"conversation" | "details" | "channels">("conversation");
  const [notice, setNotice] = useState<string>();
  const closeInspection = useCallback(() => setInspection(undefined), []);
  const run = state.runs.find((item) => item.id === inspection);
  const selected = clientScenarios.find((item) => item.id === state.scenario);
  const load = (scenario: ClientScenario) => {
    adapter.load(scenario);
    setEpoch((value) => value + 1);
    setInspection(undefined);
    setNotice(undefined);
  };
  const explain = () =>
    setNotice("此入口仅验证公开合成场景；账户、设置、模型和新任务不会连接真实服务。");
  useEffect(() => {
    const download = (event: Event) =>
      setNotice(`已下载合成文件：${(event as CustomEvent<string>).detail}`);
    window.addEventListener("openbot-demo:download", download);
    return () => window.removeEventListener("openbot-demo:download", download);
  }, []);
  return (
    <div className="client-fixtures-root">
      <header className="client-fixtures-toolbar">
        <div>
          <strong>共享客户端故障夹具</strong>
          <span>正式 Web / Desktop 组件 · 合成数据 · 无网络执行</span>
        </div>
        <label>
          场景{" "}
          <select
            aria-label="选择客户端场景"
            value={state.scenario}
            onChange={(event) => load(event.target.value as ClientScenario)}
          >
            {clientScenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => load(state.scenario)}>
          重置场景
        </button>
      </header>
      <section className="client-fixtures-controls" aria-label="场景控制">
        <p>{selected?.instruction}</p>
        {state.scenario === "tool-fault" ? (
          <button
            type="button"
            disabled={state.runs[0]?.status !== "running"}
            onClick={adapter.triggerFault}
          >
            触发工具故障
          </button>
        ) : null}
        {state.scenario === "partial-output" ? (
          <button
            type="button"
            disabled={state.runs[0]?.status !== "running"}
            onClick={adapter.advanceOutput}
          >
            {state.step === 0 ? "下一段（含重复和旧事件）" : "完成回复"}
          </button>
        ) : null}
        {state.scenario === "cancellation" ? (
          <button
            type="button"
            disabled={state.runs[0]?.status !== "cancelled"}
            onClick={adapter.emitLateOutput}
          >
            注入迟到输出
          </button>
        ) : null}
        {state.scenario === "reconnect" ? (
          <>
            <button type="button" disabled={!state.online} onClick={adapter.disconnect}>
              断开事件流
            </button>
            <button
              type="button"
              disabled={state.online || state.runs[0]?.status !== "running"}
              onClick={adapter.completeOffline}
            >
              离线期间完成
            </button>
            <button type="button" disabled={state.online} onClick={adapter.reconnect}>
              恢复连接
            </button>
          </>
        ) : null}
        {state.scenario === "plugin-receipts" ? (
          <button type="button" onClick={adapter.toggleReceiptReadFailure}>
            {state.receiptReadFails ? "恢复回执读取" : "模拟回执读取失败"}
          </button>
        ) : null}
        <button type="button" onClick={() => setInspection(fixtureRunId)}>
          任务详情
        </button>
      </section>
      <nav className="client-fixtures-panels" aria-label="夹具面板">
        {(
          [
            ["conversation", "频道"],
            ["details", "审批与状态"],
            ["channels", "侧栏"],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            aria-pressed={panel === value}
            onClick={() => setPanel(value)}
            key={value}
          >
            {label}
          </button>
        ))}
      </nav>
      {notice ? (
        <p className="client-fixtures-notice" role="status">
          {notice}
          <button type="button" onClick={() => setNotice(undefined)}>
            关闭提示
          </button>
        </p>
      ) : null}
      <div
        className={`app-shell desktop-workspace channel-view client-fixtures-workspace fixture-panel-${panel}`}
      >
        <Sidebar
          bots={demoBots}
          channels={[demoChannel]}
          runs={state.runs}
          ownerName="合成 Owner"
          selectedChannelId={demoChannel.id}
          onHome={() => setPanel("conversation")}
          onSelectChannel={() => setPanel("conversation")}
          onSelectBot={explain}
          onOpenBotProfile={explain}
          onCreateBot={explain}
          onCreateChannel={explain}
          onManageNodes={explain}
          onSettings={explain}
          onAutomations={explain}
          onSkills={explain}
          onLogout={async () => explain()}
        />
        <FixtureConversation
          key={epoch}
          adapter={adapter}
          onInspectRun={setInspection}
          onExplain={explain}
        />
        <ContextRail
          realtimeState={state.online ? "live" : "retrying"}
          selectedChannelId={demoChannel.id}
          workspace={adapter.workspace()}
          onDecideApproval={async (id, decision) => {
            await decideApproval(id, decision);
          }}
          onInspectRun={setInspection}
        />
      </div>
      {run ? (
        <RunInspector
          run={run}
          bot={demoBots.find((item) => item.id === run.botId)}
          artifacts={state.artifacts.filter((item) => item.runId === run.id)}
          liveFrame={undefined}
          node={undefined}
          progress={state.progress.filter((item) => item.runId === run.id)}
          onClose={closeInspection}
          onRun={ignore}
        />
      ) : null}
    </div>
  );
}

function FixtureConversation({
  adapter,
  onInspectRun,
  onExplain,
}: {
  adapter: ClientFixtureAdapter;
  onInspectRun(id: string): void;
  onExplain(): void;
}) {
  const [session] = useState(createConversationSession);
  const state = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot);
  useEffect(() => () => session.dispose(), [session]);
  return (
    <ChannelWorkspace
      session={session}
      channel={demoChannel}
      bots={demoBots}
      artifacts={state.artifacts}
      progress={state.progress}
      onJoin={async () => onExplain()}
      onInspectRun={onInspectRun}
      onOpenBot={onExplain}
      onFrame={ignore}
      onProgress={ignore}
      onRun={ignore}
    />
  );
}
