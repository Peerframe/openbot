import type { Approval, ApprovalDecision, Bot, Channel, Run } from "@openbot/domain";
import { indexActiveRunsByBot, runStatusLabel } from "../run-state";
import { ApprovalCard } from "./ApprovalCard";
import { ApprovalIcon, BotIcon, HashIcon, NodeIcon, PlusIcon } from "./Icons";
import { RobotAvatar } from "./RobotAvatar";

export type MobilePanel = "channels" | "bots" | "approvals" | undefined;

export function MobileNavigation({
  panel,
  bots,
  channels,
  runs,
  approvals,
  onPanel,
  onDecideApproval,
  onCreateBot,
  onCreateChannel,
  onManageNodes,
  onManageModels,
  onSelectChannel,
  onSelectBot,
}: {
  panel: MobilePanel;
  bots: Bot[];
  channels: Channel[];
  runs: Run[];
  approvals: Approval[];
  onPanel(panel: MobilePanel): void;
  onDecideApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  onCreateBot(): void;
  onCreateChannel(): void;
  onManageNodes(): void;
  onManageModels?: (() => void) | undefined;
  onSelectChannel(channelId: string): void;
  onSelectBot(botId: string): void;
}) {
  const activeRunByBot = indexActiveRunsByBot(runs);
  const botById = new Map(bots.map((bot) => [bot.id, bot]));
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
  return (
    <>
      {panel ? (
        <section className="mobile-sheet" aria-label={panelLabel(panel)}>
          <header className="mobile-sheet-header">
            <h2>{panelLabel(panel)}</h2>
            <button type="button" onClick={() => onPanel(undefined)}>
              完成
            </button>
          </header>
          {panel === "channels" ? (
            <>
              <button className="mobile-create" type="button" onClick={onCreateChannel}>
                <PlusIcon />
                创建频道
              </button>
              {channels.map((channel) => (
                <button
                  className="mobile-list-row"
                  type="button"
                  key={channel.id}
                  onClick={() => onSelectChannel(channel.id)}
                >
                  <HashIcon />
                  <span className="mobile-list-label">{channel.name}</span>
                  <small>{channel.botIds.length} Bots</small>
                </button>
              ))}
            </>
          ) : panel === "bots" ? (
            <>
              <button className="mobile-create" type="button" onClick={onCreateBot}>
                <PlusIcon />
                创建 Bot
              </button>
              {onManageModels ? (
                <button className="mobile-create" type="button" onClick={onManageModels}>
                  模型服务
                </button>
              ) : null}
              {bots.map((bot) => {
                const run = activeRunByBot.get(bot.id);
                return (
                  <button
                    className="mobile-list-row"
                    type="button"
                    onClick={() => onSelectBot(bot.id)}
                    key={bot.id}
                  >
                    <RobotAvatar bot={bot} compact status={run?.status ?? bot.status} />
                    <span className="mobile-list-label">{bot.name}</span>
                    <small>{run ? runStatusLabel(run.status) : "待命"}</small>
                  </button>
                );
              })}
            </>
          ) : pendingApprovals.length === 0 ? (
            <p className="mobile-empty">暂无待审批动作</p>
          ) : (
            <div className="approval-list mobile-approval-list">
              {pendingApprovals.map((approval) => (
                <ApprovalCard
                  approval={approval}
                  bot={botById.get(approval.botId)}
                  channel={channelById.get(approval.channelId)}
                  onDecide={onDecideApproval}
                  key={approval.id}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}
      <nav className="mobile-nav" aria-label="移动端导航">
        <button type="button" onClick={() => onPanel("channels")}>
          <HashIcon />
          <span>频道</span>
        </button>
        <button type="button" onClick={() => onPanel("bots")}>
          <BotIcon />
          <span>Bots</span>
        </button>
        <button type="button" onClick={() => onPanel("approvals")}>
          <ApprovalIcon />
          <span>审批{pendingApprovals.length > 0 ? ` ${pendingApprovals.length}` : ""}</span>
        </button>
        <button type="button" onClick={onManageNodes}>
          <NodeIcon />
          <span>主机</span>
        </button>
      </nav>
    </>
  );
}

function panelLabel(panel: Exclude<MobilePanel, undefined>) {
  return panel === "channels" ? "频道" : panel === "bots" ? "Bots" : "审批";
}
