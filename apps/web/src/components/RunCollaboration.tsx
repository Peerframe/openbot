// Bot-to-Bot delegation in a conversation: links child runs to their parent from Server records and
// shows the 参与协作 list, delegation notices and the delegated reply's context.
import type { Bot, Message, Run } from "@openbot/domain";
import { runStatusLabel, runStatusSummary, runTitle } from "../run-state";
import { RobotAvatar } from "./RobotAvatar";
import "./RunCollaboration.css";

export type CollaborationRun = Run;

export interface CollaborationIndex {
  childrenByParent: Map<string, CollaborationRun[]>;
  delegationByMessage: Map<string, CollaborationRun>;
  linkedRuns: Map<string, CollaborationRun>;
}

export function indexRunCollaboration(
  channelId: string,
  runs: CollaborationRun[],
  messages: Message[],
): CollaborationIndex {
  const byId = new Map(
    runs.filter((run) => run.channelId === channelId).map((run) => [run.id, run]),
  );
  const messageById = new Map(
    messages
      .filter((message) => message.channelId === channelId)
      .map((message) => [message.id, message]),
  );
  const childrenByParent = new Map<string, CollaborationRun[]>();
  const delegationByMessage = new Map<string, CollaborationRun>();
  const linkedRuns = new Map<string, CollaborationRun>();
  for (const child of byId.values()) {
    if (!child.parentRunId || !child.delegatedByBotId || child.botId === child.delegatedByBotId)
      continue;
    const parent = byId.get(child.parentRunId);
    if (parent && parent.botId !== child.delegatedByBotId) continue;
    const seen = new Set([child.id]);
    let ancestor: CollaborationRun | undefined = child;
    let valid = true;
    while (ancestor?.parentRunId) {
      if (seen.has(ancestor.parentRunId)) {
        valid = false;
        break;
      }
      seen.add(ancestor.parentRunId);
      ancestor = byId.get(ancestor.parentRunId);
    }
    if (!valid) continue;
    linkedRuns.set(child.id, child);
    if (parent) {
      const children = childrenByParent.get(parent.id) ?? [];
      children.push(child);
      childrenByParent.set(parent.id, children);
    }
    const source = child.sourceMessageId ? messageById.get(child.sourceMessageId) : undefined;
    // Identity and linkage come only from Server records, never from mentions or message text.
    if (source?.authorType === "bot" && source.authorId === child.delegatedByBotId) {
      delegationByMessage.set(source.id, child);
    }
  }
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  return { childrenByParent, delegationByMessage, linkedRuns };
}

export function DelegationNotice({
  run,
  botsById,
  onInspectRun,
}: {
  run: CollaborationRun;
  botsById: Map<string, Bot>;
  onInspectRun(id: string): void;
}) {
  const recipient = botsById.get(run.botId);
  return (
    <div className="delegation-notice">
      <span>邀请协作</span>
      {recipient ? <RobotAvatar bot={recipient} compact /> : null}
      <span>{recipient?.name ?? "频道 Bot"}</span>
      <button
        type="button"
        onClick={() => onInspectRun(run.id)}
        aria-label={`查看 ${recipient?.name ?? "Bot"} 的协作任务`}
      >
        {runStatusLabel(run.status)}
        <span aria-hidden="true"> ›</span>
      </button>
    </div>
  );
}

export function DelegatedReplyContext({
  run,
  parent,
  botsById,
  onInspectRun,
}: {
  run: CollaborationRun;
  parent: Run | undefined;
  botsById: Map<string, Bot>;
  onInspectRun(id: string): void;
}) {
  const sender = run.delegatedByBotId ? botsById.get(run.delegatedByBotId) : undefined;
  return (
    <div className="delegated-reply-context">
      <span>回应 {sender?.name ?? "协作 Bot"} 的委派</span>
      {parent ? (
        <button type="button" onClick={() => onInspectRun(parent.id)}>
          查看原任务
        </button>
      ) : (
        <small>原任务暂未加载</small>
      )}
    </div>
  );
}

export function RunCollaboration({
  childRuns,
  botsById,
  onInspectRun,
}: {
  childRuns: CollaborationRun[];
  botsById: Map<string, Bot>;
  onInspectRun(id: string): void;
}) {
  if (!childRuns.length) return null;
  return (
    <div className="run-collaboration">
      <span>参与协作</span>
      <ul aria-label="协作 Bot">
        {childRuns.map((run) => {
          const bot = botsById.get(run.botId);
          const role = bot?.role?.trim() ? bot.role : "未指定职责";
          const stateLabel =
            run.status === "waiting_approval"
              ? "等待审批"
              : run.status === "failed"
                ? "失败"
                : run.status === "completed"
                  ? "已完成"
                  : runStatusLabel(run.status);
          const detail = runStatusSummary(run) ?? runTitle(run);
          return (
            <li key={run.id}>
              <button
                type="button"
                onClick={() => onInspectRun(run.id)}
                aria-label={`查看 ${bot?.name ?? "Bot"}（${role}）的协作任务：${runTitle(run)}`}
                title={detail}
              >
                {bot ? <RobotAvatar bot={bot} compact /> : null}
                <span>{bot?.name ?? "频道 Bot"}</span>
                <span className="collaboration-role">{role}</span>
                <span className="collaboration-task-state" data-state={run.status}>
                  {stateLabel}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
