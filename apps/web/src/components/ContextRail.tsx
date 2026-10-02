import type {
  ApprovalDecision,
  Artifact,
  ExecutionNode,
  Run,
  RunProgress,
  WorkspaceSnapshot,
} from "@openbot/domain";
import { useCallback, useId, useState } from "react";
import { formatAttachmentSize } from "../channel-attachment-client";
import { composerAttachEvent } from "../composer-events";
import { runStatusSummary } from "../run-state";
import { requestNotificationPermission } from "../system-notifications";
import { updatePreferences, useWorkspacePreferences } from "../workspace-preferences";
import { ApprovalStack } from "./ApprovalStack";
import { ArtifactDownloadLink } from "./ArtifactCard";
import { AttachmentsManagerDialog, useChannelAttachments } from "./AttachmentsManager";
import type { DesktopSettingsSection } from "./DesktopSettingsScreen";
import "./ContextRail.css";
import { isActiveRun, runStatusLabel } from "../run-state";
import { AddMemberPopover } from "./AddMemberPopover";
import { GroupAvatar } from "./GroupAvatar";
import { CheckIcon, NodeIcon, PlusIcon } from "./Icons";
import { RobotAvatar } from "./RobotAvatar";
import { sidebarTime } from "./Sidebar";

export function ContextRail({
  selectedChannelId,
  workspace,
  onDecideApproval,
  onInspectRun,
  onOpenBot,
  onJoin,
  onRemove,
  onCollapse,
  onOpenSettings,
}: {
  selectedChannelId?: string | undefined;
  workspace: WorkspaceSnapshot;
  onDecideApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  onInspectRun(runId: string): void;
  onOpenBot?: ((botId: string) => void) | undefined;
  /** Member management (Main artboard: 成员 · N with 添加 Bot). */
  onJoin?: ((botId: string) => Promise<void>) | undefined;
  onRemove?: ((botId: string) => Promise<void>) | undefined;
  onCollapse?: (() => void) | undefined;
  /** 「全部 N 个 ›」 under a capped list opens its settings section. */
  onOpenSettings?: ((section: DesktopSettingsSection) => void) | undefined;
}) {
  const [adding, setAdding] = useState(false);
  const [memberBusy, setMemberBusy] = useState<string>();
  const [memberError, setMemberError] = useState<string>();
  const closeAdding = useCallback(() => setAdding(false), []);
  const [picked, setPicked] = useState<{ channelId: string | undefined; tab: RailTab }>();
  const tabId = useId();
  const scopedRuns = workspace.runs.filter(
    (run) => selectedChannelId === undefined || run.channelId === selectedChannelId,
  );
  const runById = new Map(workspace.runs.map((run) => [run.id, run]));
  const activeRuns = scopedRuns
    .filter(isActiveRun)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const completedCount = workspace.runs.filter((run) => run.status === "completed").length;
  const workspaceActiveCount = workspace.runs.filter(isActiveRun).length;
  const pendingApprovals = workspace.approvals.filter((approval) => {
    if (approval.status !== "pending") return false;
    if (selectedChannelId === undefined) return true;
    if (approval.channelId !== selectedChannelId) return false;
    // Approvals may outlive the bounded recent-run snapshot; a known conflict is not shown.
    const run = runById.get(approval.runId);
    return run === undefined || run.channelId === selectedChannelId;
  });
  const recentResults = scopedRuns
    .filter((run) => !isActiveRun(run))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 3);
  const botById = new Map(workspace.bots.map((bot) => [bot.id, bot]));
  const channelById = new Map(workspace.channels.map((channel) => [channel.id, channel]));
  const nodeById = new Map(workspace.nodes.map((node) => [node.id, node]));
  const latestProgress = new Map<string, RunProgress>();
  for (const progress of workspace.progress) {
    const run = runById.get(progress.runId);
    if (run === undefined || run.channelId !== progress.channelId) continue;
    const previous = latestProgress.get(progress.runId);
    if (previous === undefined || progress.createdAt > previous.createdAt) {
      latestProgress.set(progress.runId, progress);
    }
  }
  const latestArtifact = new Map<string, Artifact>();
  for (const artifact of workspace.artifacts) {
    const previous = latestArtifact.get(artifact.runId);
    if (previous === undefined || artifact.createdAt > previous.createdAt) {
      latestArtifact.set(artifact.runId, artifact);
    }
  }
  const observed = scopedRuns.flatMap((run) => (run.modelUsage ? [run.modelUsage] : []));
  const knownInput = observed.filter((usage) => usage.inputTokens !== null);
  const knownOutput = observed.filter((usage) => usage.outputTokens !== null);
  const hasActivity = pendingApprovals.length > 0 || scopedRuns.length > 0;

  const channel = selectedChannelId === undefined ? undefined : channelById.get(selectedChannelId);
  const activeBotIds = new Set(activeRuns.map((run) => run.botId));
  // LongLists: members at work come first; otherwise the 频道's own order.
  const members = (
    channel
      ? channel.botIds.flatMap((id) => {
          const bot = botById.get(id);
          return bot ? [bot] : [];
        })
      : []
  ).sort((left, right) => Number(activeBotIds.has(right.id)) - Number(activeBotIds.has(left.id)));
  const available = channel ? workspace.bots.filter((bot) => !channel.botIds.includes(bot.id)) : [];

  // A 单聊 uses the Bot 信息 rail instead (BotInfoRail).
  const tabs: RailTab[] = channel ? ["details", "library", "members"] : [];
  // Until the Owner picks a tab for this conversation, open where attention is needed.
  const defaultTab: RailTab =
    tabs.includes("members") && pendingApprovals.length === 0 ? "members" : "details";
  const tab: RailTab =
    tabs.length === 0
      ? "details"
      : picked !== undefined && picked.channelId === selectedChannelId && tabs.includes(picked.tab)
        ? picked.tab
        : defaultTab;
  const title = selectedChannelId === undefined ? "工作区动态" : "频道信息";
  const channelArtifacts = workspace.artifacts
    .filter((artifact) => {
      const run = runById.get(artifact.runId);
      return run !== undefined && run.channelId === selectedChannelId;
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return (
    <aside className="context-rail channel-info" aria-label={title}>
      <header className="ci-header">
        <h2 className="visually-hidden">{title}</h2>
        {onCollapse ? (
          <button
            type="button"
            className="ci-icon"
            aria-label="收起"
            title="收起"
            onClick={onCollapse}
          >
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="6 17 11 12 6 7" />
              <polyline points="13 17 18 12 13 7" />
            </svg>
          </button>
        ) : null}
      </header>

      <div className="ci-identity">
        {channel ? (
          <GroupAvatar
            name={channel.name}
            members={members}
            size={84}
            statusOf={(bot) => (activeBotIds.has(bot.id) ? "running" : "idle")}
          />
        ) : null}
        <strong>{selectedChannelId === undefined ? title : (channel?.name ?? "当前频道")}</strong>
        {channel ? <span>{channel.description || `${members.length} 名 Bot`}</span> : null}
      </div>

      {tabs.length > 0 ? (
        <div
          className="ci-tabs"
          role="tablist"
          aria-label={`${title}分页`}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const next =
              tabs[
                (tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) %
                  tabs.length
              ] ?? tab;
            setPicked({ channelId: selectedChannelId, tab: next });
            event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
          }}
        >
          {tabs.map((id) => (
            <button
              type="button"
              role="tab"
              id={`${tabId}-${id}`}
              aria-controls={`${tabId}-panel`}
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              data-tab={id}
              key={id}
              onClick={() => setPicked({ channelId: selectedChannelId, tab: id })}
            >
              {tabLabels[id]}
              {id === "details" && pendingApprovals.length > 0 && tab !== "details" ? (
                <span className="ci-tab-count">{pendingApprovals.length}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <div
        className="ci-body"
        id={`${tabId}-panel`}
        {...(tabs.length > 0
          ? { role: "tabpanel", "aria-labelledby": `${tabId}-${tab}` }
          : undefined)}
      >
        {channel && tab === "members" ? (
          <section className="ci-members" aria-label="频道成员">
            {members.map((bot) => (
              <div className="ci-member" key={bot.id}>
                <button
                  type="button"
                  className="ci-member-open"
                  disabled={!onOpenBot}
                  onClick={() => onOpenBot?.(bot.id)}
                  aria-label={`打开 ${bot.name} 的员工档案`}
                >
                  <RobotAvatar
                    bot={bot}
                    className="ci-member-avatar"
                    status={activeBotIds.has(bot.id) ? "running" : "idle"}
                    presence="motion"
                  />
                  <span className="ci-member-text">
                    <strong className="ci-member-name">{bot.name}</strong>
                    {bot.role ? <small className="ci-member-role">{bot.role}</small> : null}
                  </span>
                </button>
                {activeBotIds.has(bot.id) ? (
                  <span className="ci-status is-active">
                    <i aria-hidden="true" />
                    工作中
                  </span>
                ) : null}
                {onRemove ? (
                  <button
                    type="button"
                    className="ci-member-remove"
                    aria-label={`将 ${bot.name} 移出频道`}
                    disabled={memberBusy !== undefined}
                    onClick={async () => {
                      setMemberBusy(bot.id);
                      setMemberError(undefined);
                      try {
                        await onRemove(bot.id);
                      } catch {
                        setMemberError("无法移除这个 Bot，请重试。");
                      } finally {
                        setMemberBusy(undefined);
                      }
                    }}
                  >
                    移除
                  </button>
                ) : null}
              </div>
            ))}
            {members.length === 0 ? (
              <p className="ci-empty">还没有 Bot。添加后，频道里的消息会交给它们处理。</p>
            ) : null}
            {onJoin && available.length > 0 ? (
              <button
                type="button"
                className="ci-member-add"
                aria-expanded={adding}
                onClick={() => {
                  setAdding((open) => !open);
                  setMemberError(undefined);
                }}
              >
                <span className="ci-member-add-icon" aria-hidden="true">
                  <PlusIcon />
                </span>
                添加成员
              </button>
            ) : null}
            {adding && available.length > 0 ? (
              <AddMemberPopover
                candidates={available}
                busy={memberBusy !== undefined}
                onClose={closeAdding}
                onAdd={async (bot) => {
                  if (!onJoin) return;
                  setMemberBusy(bot.id);
                  setMemberError(undefined);
                  try {
                    await onJoin(bot.id);
                  } catch {
                    setMemberError("无法添加这个 Bot，请重试。");
                  } finally {
                    setMemberBusy(undefined);
                  }
                }}
              />
            ) : null}
            {memberError ? (
              <p className="form-error" role="alert">
                {memberError}
              </p>
            ) : null}
          </section>
        ) : null}

        {channel && tab === "library" ? (
          <ChannelLibrary
            channelId={channel.id}
            artifacts={channelArtifacts}
            channelName={channel.name}
            botNameForRun={(runId) => {
              const run = runById.get(runId);
              return run ? botById.get(run.botId)?.name : undefined;
            }}
          />
        ) : null}

        {tab === "details" ? (
          <>
            {pendingApprovals.length > 0 ? (
              <section className="ci-section" aria-label="需要确认的操作">
                <h3>需要处理 · {pendingApprovals.length}</h3>
                <ApprovalStack
                  approvals={pendingApprovals}
                  botFor={(approval) => botById.get(approval.botId)}
                  channelFor={(approval) => channelById.get(approval.channelId)}
                  onDecide={onDecideApproval}
                />
              </section>
            ) : null}

            {activeRuns.length > 0 ? (
              <section className="ci-section" aria-label="当前任务">
                <h3>
                  进行中
                  {activeRuns.length > 4 ? (
                    <span className="ci-section-meta">显示最近 4 条</span>
                  ) : null}
                </h3>
                <div className="ci-card">
                  {activeRuns.slice(0, 4).map((run) => {
                    const bot = botById.get(run.botId);
                    const node = run.nodeId === undefined ? undefined : nodeById.get(run.nodeId);
                    return (
                      <RunRow
                        run={run}
                        detail={
                          runStatusSummary(run, latestProgress.get(run.id)?.message) ??
                          `${bot?.name ?? "未知 Bot"} · ${run.executionProfile === "none" || run.executionProfile === "model" ? "正在处理" : (node?.name ?? "等待分配电脑")}`
                        }
                        onInspect={onInspectRun}
                        key={run.id}
                      />
                    );
                  })}
                </div>
              </section>
            ) : null}

            {!hasActivity ? (
              <div className="ci-empty-state">
                <CheckIcon />
                <p>{selectedChannelId === undefined ? "暂无任务动态" : "这个频道暂无任务动态"}</p>
                <span className="ci-empty-hint">任务进度与需要确认的操作会显示在这里。</span>
              </div>
            ) : null}

            <section className="ci-section" aria-label="工作电脑">
              <h3>
                电脑<span className="ci-section-meta">{workspace.nodes.length} 台已连接</span>
              </h3>
              {workspace.nodes.length === 0 ? (
                <div className="ci-card ci-no-computer">
                  <NodeIcon />
                  <p>尚未连接工作电脑</p>
                </div>
              ) : (
                <div className="ci-card">
                  {workspace.nodes.slice(0, RAIL_PREVIEW).map((node) => (
                    <NodeRow node={node} key={node.id} />
                  ))}
                </div>
              )}
              {workspace.nodes.length > RAIL_PREVIEW && onOpenSettings ? (
                <button type="button" className="ci-more" onClick={() => onOpenSettings("hosts")}>
                  全部 {workspace.nodes.length} 个 ›
                </button>
              ) : null}
            </section>

            <NotificationToggle />

            <details className="ci-overview">
              <summary>任务记录与用量</summary>
              <section className="ci-section" aria-label="最近任务统计">
                <h3>
                  最近任务<span className="ci-section-meta">{workspace.runs.length} 条记录</span>
                </h3>
                <dl className="ci-metrics">
                  <Metric label="进行中" value={workspaceActiveCount} />
                  <Metric label="已完成" value={completedCount} />
                  <Metric label="记录数" value={workspace.runs.length} />
                </dl>
                <p className="ci-caption">统计范围为当前已加载的工作区任务记录</p>
              </section>
              {recentResults.length > 0 ? (
                <section className="ci-section" aria-label="最近结果">
                  <h3>最近结果</h3>
                  <div className="ci-card">
                    {recentResults.map((run) => {
                      const artifact = latestArtifact.get(run.id);
                      return (
                        <div className="ci-result" key={run.id}>
                          <RunRow
                            run={run}
                            detail={runStatusSummary(run) ?? botById.get(run.botId)?.name}
                            onInspect={onInspectRun}
                          />
                          {artifact ? (
                            <ArtifactDownloadLink artifact={artifact}>
                              {artifact.mediaType === "text/markdown" ? "下载报告" : "查看附件"}：
                              {artifact.name} <span aria-hidden="true">↗</span>
                            </ArtifactDownloadLink>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}
              <section className="ci-section ci-tokens" aria-label="Token 用量">
                <h3>Token 用量</h3>
                {observed.length ? (
                  <>
                    <p>
                      输入{" "}
                      {knownInput.length
                        ? knownInput
                            .reduce((sum, usage) => sum + (usage.inputTokens ?? 0), 0)
                            .toLocaleString()
                        : "未知"}{" "}
                      · 输出{" "}
                      {knownOutput.length
                        ? knownOutput
                            .reduce((sum, usage) => sum + (usage.outputTokens ?? 0), 0)
                            .toLocaleString()
                        : "未知"}
                    </p>
                    <p className="ci-caption">
                      已加载范围内 {observed.length}{" "}
                      个任务的已知记录；未记录部分不计入，不代表账单。
                    </p>
                  </>
                ) : (
                  <>
                    <p>暂无用量记录</p>
                    <p className="ci-caption">当前范围没有已记录的模型用量</p>
                  </>
                )}
              </section>
            </details>
          </>
        ) : null}
      </div>
    </aside>
  );
}

type RailTab = "details" | "library" | "members";
const tabLabels: Record<RailTab, string> = { details: "详情", library: "资料库", members: "成员" };

/**
 * 资料库 (ChannelInfo artboard): task outputs from the loaded snapshot and the channel's uploaded
 * files. Uploading goes through the composer, so a file is always tied to a message the Owner
 * sends; 管理 opens the existing file manager for download, extraction and the recycle bin.
 */
/** ChannelInfo LongLists rule: each section shows at most four, then 「全部 N 个 ›」. */
const LIBRARY_PREVIEW = 4;
const RAIL_PREVIEW = LIBRARY_PREVIEW;

export function ChannelLibrary({
  channelId,
  channelName,
  artifacts,
  botNameForRun,
}: {
  channelId: string;
  channelName?: string | undefined;
  artifacts: Artifact[];
  botNameForRun(runId: string): string | undefined;
}) {
  const { files, status } = useChannelAttachments(channelId);
  const [managing, setManaging] = useState(false);
  const available = files
    .filter((file) => !file.deletedAt)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const more = (count: number) =>
    count > LIBRARY_PREVIEW ? (
      <button type="button" className="ci-more" onClick={() => setManaging(true)}>
        全部 {count} 个 ›
      </button>
    ) : null;
  return (
    <>
      <section className="ci-section" aria-label="任务产出">
        <h3>任务产出 · {artifacts.length}</h3>
        {artifacts.length > 0 ? (
          <div className="ci-card">
            {artifacts.slice(0, LIBRARY_PREVIEW).map((artifact) => (
              <ArtifactDownloadLink artifact={artifact} className="ci-file" key={artifact.id}>
                <FileTile name={artifact.name} />
                <span>
                  <strong>{artifact.name}</strong>
                  <small>
                    {[
                      botNameForRun(artifact.runId),
                      sidebarTime(artifact.createdAt),
                      formatAttachmentSize(artifact.sizeBytes),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </span>
              </ArtifactDownloadLink>
            ))}
          </div>
        ) : (
          <p className="ci-empty">Bot 完成任务后，报告和图片会出现在这里。</p>
        )}
        {more(artifacts.length)}
      </section>
      <section className="ci-section" aria-label="频道文件">
        <h3>频道文件 · {available.length}</h3>
        {available.length > 0 ? (
          <div className="ci-card">
            {available.slice(0, LIBRARY_PREVIEW).map((file) => (
              <div className="ci-file" key={file.id}>
                <FileTile name={file.name} />
                <span>
                  <strong>{file.name}</strong>
                  <small>
                    {sidebarTime(file.createdAt)} · {formatAttachmentSize(file.sizeBytes)}
                  </small>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="ci-empty" role={status ? "status" : undefined}>
            {status || "在消息里添加的附件会保存在这里。"}
          </p>
        )}
        {more(available.length)}
      </section>
      <div className="ci-library-actions">
        <button
          type="button"
          className="ob-pill is-small"
          onClick={() => window.dispatchEvent(new CustomEvent(composerAttachEvent))}
        >
          上传文件
        </button>
        <button
          type="button"
          className="ob-pill is-small is-outline"
          onClick={() => setManaging(true)}
        >
          管理
        </button>
      </div>
      {managing ? (
        <AttachmentsManagerDialog
          channelId={channelId}
          channelName={channelName}
          outputs={artifacts}
          botNameForRun={botNameForRun}
          onClose={() => setManaging(false)}
        />
      ) : null}
    </>
  );
}

function FileTile({ name }: { name: string }) {
  const extension = /\.([a-z0-9]{1,4})$/iu.exec(name)?.[1]?.toUpperCase() ?? "FILE";
  return (
    <span className="ci-file-tile" aria-hidden="true">
      {extension}
    </span>
  );
}

/** Same opt-in as Settings → 通知 (ADR-0048); enabling asks the browser once when needed. */
function NotificationToggle() {
  const { values } = useWorkspacePreferences();
  const [blocked, setBlocked] = useState(false);
  const enabled = values.notifyApprovals || values.notifyMessages;
  return (
    <div className="ci-notify">
      <span className="ci-notify-text">
        <strong className="ci-notify-title">通知</strong>
        <small className="ci-notify-hint">
          {blocked
            ? "浏览器已阻止通知，可在设置中查看原因。"
            : "OpenBot 在后台时，有操作待批准或 Bot 回复会提醒你"}
        </small>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="通知"
        className="ob-switch"
        onClick={async () => {
          if (enabled) {
            updatePreferences({ notifyApprovals: false, notifyMessages: false });
            return;
          }
          const support = await requestNotificationPermission();
          if (support !== "desktop" && support !== "granted") {
            setBlocked(true);
            return;
          }
          setBlocked(false);
          updatePreferences({ notifyApprovals: true, notifyMessages: true });
        }}
      />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function RunRow({
  run,
  detail,
  onInspect,
}: {
  run: Run;
  detail: string | undefined;
  onInspect(runId: string): void;
}) {
  return (
    <button
      className="ci-run"
      type="button"
      onClick={() => onInspect(run.id)}
      aria-label={`查看任务：${run.title}`}
    >
      <span className={`ci-run-dot ${run.status}`} aria-hidden="true" />
      <span className="ci-run-copy">
        <strong>{run.title}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
      <span className={`ci-run-status ${run.status}`}>{runStatusLabel(run.status)}</span>
    </button>
  );
}

export function NodeRow({ node }: { node: ExecutionNode }) {
  return (
    <div className="ci-computer">
      <span className="ci-computer-icon">
        <NodeIcon />
      </span>
      <div>
        <strong>{node.name}</strong>
        <small>
          {node.platform} · {node.activeRunIds.length}/{node.maxConcurrentRuns} 任务
        </small>
      </div>
      <span className="ci-online" role="img" aria-label="在线" />
    </div>
  );
}
