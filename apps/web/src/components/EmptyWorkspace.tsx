// 你的工作，从这里开始 (EmptyWorkspace artboard): home screen while the workspace has no conversation.
import type { Bot } from "@openbot/domain";
import { GroupAvatar } from "./GroupAvatar";
import { useModelServices } from "./ModelSelector";
import { RobotAvatar } from "./RobotAvatar";
import "./EmptyWorkspace.css";

const sample = (
  id: string,
  head: "round" | "square" | "cat",
  accent: "green" | "blue" | "yellow",
): Bot => ({
  id,
  name: "",
  role: "",
  status: "idle",
  computerProfile: "none",
  appearance: { head, body: "classic", mobility: "feet", accessory: "none", accent },
  createdAt: "2026-10-01T00:00:00.000Z",
});
// Decorative heads only; they are not Bots in this workspace.
const relay = sample("sample-relay", "square", "blue");
const round = sample("sample-round", "round", "green");
const scout = sample("sample-scout", "cat", "yellow");

function Chevron() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

/**
 * 你的工作，从这里开始 (EmptyWorkspace artboard): shown while the workspace has no conversation.
 * The two starts are the same as 「+」. The status line reports what the 服务电脑 has configured;
 * a 工作电脑 is optional.
 */
export function EmptyWorkspace({
  computers,
  onCreateBot,
  onCreateChannel,
  onImportBot,
  onManageModels,
  onManageComputers,
}: {
  computers: number;
  onCreateBot(): void;
  onCreateChannel(): void;
  onImportBot(): void;
  onManageModels(): void;
  onManageComputers(): void;
}) {
  const { snapshot } = useModelServices();
  const connection = snapshot?.connections.find((item) => item.enabled);
  return (
    <main className="workspace-main empty-workspace">
      <div className="empty-workspace-heads" aria-hidden="true">
        <RobotAvatar bot={relay} className="empty-workspace-side" />
        <RobotAvatar bot={round} className="empty-workspace-center" />
        <RobotAvatar bot={scout} className="empty-workspace-side" />
      </div>
      <div className="empty-workspace-title">
        <h1>你的工作，从这里开始</h1>
        <p>和左上角「+」是同一个入口：新建 Bot，或者选几个 Bot 建一个频道。</p>
      </div>
      <div className="empty-workspace-starts">
        <button type="button" className="empty-workspace-start" onClick={onCreateBot}>
          <RobotAvatar bot={round} className="empty-workspace-start-avatar" />
          <span>
            <strong>新建 Bot</strong>
            <span>马上得到一个随机外观的新 Bot；名字、外观和分工随时在右栏改。</span>
          </span>
          <Chevron />
        </button>
        <button type="button" className="empty-workspace-start" onClick={onCreateChannel}>
          <GroupAvatar name="新频道" members={[]} size={56} />
          <span>
            <strong>创建频道</strong>
            <span>选几个 Bot 组成频道，给一件长期的事一个地方。</span>
          </span>
          <Chevron />
        </button>
        <button type="button" className="empty-workspace-import" onClick={onImportBot}>
          已有 Bot 模板？导入一个
        </button>
      </div>
      <div className="empty-workspace-status">
        <button type="button" onClick={onManageModels}>
          <i className={connection ? "is-on" : "is-attention"} aria-hidden="true" />
          模型服务：{snapshot === undefined ? "正在读取" : (connection?.name ?? "还没连接")}
        </button>
        <button type="button" onClick={onManageComputers}>
          <i className={computers > 0 ? "is-on" : ""} aria-hidden="true" />
          工作电脑：{computers > 0 ? `${computers} 台在线` : "未配对（可选）"}
        </button>
      </div>
    </main>
  );
}
