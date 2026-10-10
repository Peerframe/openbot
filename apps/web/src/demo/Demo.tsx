// Website demo (demo.html): the real sidebar, conversation and 任务详情 driven by a scripted run,
// with play/pause controls.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChannelWorkspace } from "../components/ChannelWorkspace";
import { RobotAvatar } from "../components/RobotAvatar";
import { Sidebar } from "../components/Sidebar";
import { TaskSheet } from "../components/TaskSheet";
import { createConversationSession } from "../conversation-session";
import type { DemoAdapter } from "./adapter";
import { demoBots, demoChannel } from "./fixtures";

const ignoreProjection = () => undefined;

export function Demo({ adapter }: { adapter: DemoAdapter }) {
  const state = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot);
  const [session, setSession] = useState(createConversationSession);
  const [epoch, setEpoch] = useState(0);
  const [inspection, setInspection] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [profile, setProfile] = useState<string>();
  const [sidebar, setSidebar] = useState(false);
  const closeDialog = useRef<HTMLButtonElement>(null);
  const closeInspection = useCallback(() => setInspection(undefined), []);
  const run = state.runs.find((item) => item.id === inspection);
  const bot = demoBots.find((item) => item.id === profile);
  useEffect(() => {
    const download = (event: Event) =>
      setNotice(`已下载示例文件：${(event as CustomEvent<string>).detail}`);
    window.addEventListener("openbot-demo:download", download);
    const visibility = () => {
      if (document.visibilityState === "hidden") adapter.pause();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("openbot-demo:download", download);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [adapter]);
  useEffect(() => {
    if (!notice && !bot) return;
    const previous = document.activeElement;
    closeDialog.current?.focus();
    const handleDialogKey = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        event.preventDefault();
        closeDialog.current?.focus();
      }
      if (event.key === "Escape") {
        setNotice(undefined);
        setProfile(undefined);
      }
    };
    window.addEventListener("keydown", handleDialogKey);
    return () => {
      window.removeEventListener("keydown", handleDialogKey);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [notice, bot]);
  const scope = (name: string) =>
    setNotice(
      `${name}属于完整工作区功能。这个演示专注频道协作：你可以播放分工过程、回复消息、添加表情、打开任务详情和下载示例文件。`,
    );
  const restart = () => {
    adapter.restart();
    session.dispose();
    setSession(createConversationSession());
    setEpoch((value) => value + 1);
    setInspection(undefined);
    setNotice(undefined);
    adapter.play();
  };
  return (
    <div className="demo-root">
      <header className="demo-toolbar">
        <div className="demo-label">
          <strong>交互演示</strong>
          <span>示例数据，不连接模型</span>
        </div>
        <nav aria-label="演示播放控制">
          <button
            type="button"
            className="demo-sidebar-toggle"
            aria-expanded={sidebar}
            onClick={() => setSidebar(!sidebar)}
          >
            频道
          </button>
          <button
            type="button"
            onClick={state.playing ? adapter.pause : adapter.play}
            disabled={state.tick === 32 && !state.playing}
            aria-label={state.playing ? "暂停演示" : "播放演示"}
          >
            {state.playing ? "Ⅱ 暂停" : "▶ 播放"}
          </button>
          <button type="button" onClick={restart}>
            ↻ 重播
          </button>
          <button type="button" onClick={adapter.finish} disabled={state.tick === 32}>
            看交付
          </button>
        </nav>
      </header>
      <ol className="demo-stages" aria-label="演示阶段">
        {["交代任务", "Bot 分工协作", "交付文件"].map((label, index) => (
          <li key={label} aria-current={state.stage === index ? "step" : undefined}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            {label}
          </li>
        ))}
      </ol>
      <div
        className={`app-shell desktop-workspace channel-view without-context demo-workspace${sidebar ? " demo-sidebar-open" : ""}`}
      >
        <Sidebar
          bots={demoBots}
          channels={[demoChannel]}
          runs={state.runs}
          ownerName="体验者"
          selectedChannelId={demoChannel.id}
          onHome={() => {
            setSidebar(false);
          }}
          onSelectChannel={() => setSidebar(false)}
          onSelectBot={setProfile}
          onOpenBotProfile={setProfile}
          onCreateBot={() => scope("创建 Bot")}
          onCreateChannel={() => scope("新建频道")}
          onManageNodes={() => scope("执行电脑")}
          onSettings={() => scope("设置")}
          onAutomations={() => scope("自动化")}
          onSkills={() => scope("插件与技能")}
          onLogout={async () => scope("账户管理")}
        />
        <ChannelWorkspace
          key={epoch}
          session={session}
          channel={demoChannel}
          bots={demoBots}
          artifacts={state.artifacts}
          progress={[]}
          stepSummaries={state.runProgress}
          onJoin={async () => scope("成员管理")}
          onInspectRun={(id) => {
            adapter.pause();
            setInspection(id);
          }}
          onOpenBot={setProfile}
          onFrame={ignoreProjection}
          onProgress={ignoreProjection}
          onRun={ignoreProjection}
        />
      </div>
      {run ? (
        <TaskSheet
          run={run}
          bot={demoBots.find((item) => item.id === run.botId)}
          botsById={new Map(demoBots.map((item) => [item.id, item]))}
          channelName={demoChannel.name}
          artifacts={state.artifacts.filter((item) => item.runId === run.id)}
          liveFrame={undefined}
          node={undefined}
          progress={[]}
          onClose={closeInspection}
          onRun={ignoreProjection}
        />
      ) : null}
      {notice || bot ? (
        <div className="demo-dialog-backdrop">
          <section
            className="demo-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={bot ? `${bot.name} 的示例身份` : "演示提示"}
          >
            {bot ? (
              <>
                <RobotAvatar bot={bot} />
                <h2>{bot.name}</h2>
                <p>{bot.role}</p>
                <p>
                  这是本次演示的示例 Bot。正式工作区还可管理它的档案、技能和记忆，并直接分享 Bot。
                </p>
              </>
            ) : (
              <p>{notice}</p>
            )}
            <button
              type="button"
              ref={closeDialog}
              onClick={() => {
                setNotice(undefined);
                setProfile(undefined);
              }}
            >
              返回频道
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}
