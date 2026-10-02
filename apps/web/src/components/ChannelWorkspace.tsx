import type {
  Approval,
  ApprovalDecision,
  Artifact,
  Bot,
  Channel,
  ExecutionNode,
  Message,
  MessageReaction,
  ReactionEmoji,
  Run,
  RunFrame,
  RunOutput,
  RunProgress,
} from "@openbot/domain";
import {
  type FormEvent,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  createMessage,
  getEmployeeProfile,
  getRunOutput,
  listChannelReactions,
  listMessagePage,
  listMessages,
  listRuns,
  type RealtimeConnectionState,
  setMessageReaction,
  subscribeToChannelEvents,
  updateEmployeeProfileDetails,
} from "../api";
import { composeTaskText } from "../composer-context";
import { type ConversationSession, createConversationSession } from "../conversation-session";
import { shortcutLabel } from "../desktop-shortcuts";
import { findMentionQuery, type MentionQuery, removeMentionQuery } from "../mention-query";
import { needsRoleSetup } from "../quick-bot";
import {
  addRecipient,
  removeRecipient,
  selectEveryone,
  selectedRecipientIds,
} from "../recipient-utils";
import { mergeRunOutput } from "../run-output-state";
import { isActiveRun, runStatusLabel } from "../run-state";
import { findSlashQuery, removeSlashQuery, type SlashQuery } from "../slash-query";
import { useWorkspacePreferences } from "../workspace-preferences";
import { AttachmentsManagerDialog } from "./AttachmentsManager";
import { MessageActionBar } from "./MessageActionBar";
import { MessageReactions } from "./MessageReactions";
import { NewBotSetupCard } from "./NewBotSetupCard";
import { RichMessage } from "./RichMessage";
import { VoiceRecorder } from "./VoiceRecorder";
import "./ChannelMessagePresentation.css";
import { composerAttachEvent } from "../composer-events";
import { runStatusSummary } from "../run-state";
import { ArtifactCard } from "./ArtifactCard";
import { ComposerAttachmentPicker, composerAttachmentsFull } from "./ComposerAttachmentPicker";
import { HashIcon, PlusIcon, SendIcon } from "./Icons";
import { MessageAttachments } from "./MessageAttachments";
import { OpenBotMark } from "./OpenBotMark";
import { PluginCallApprovals } from "./PluginCallApprovals";
import { RobotAvatar } from "./RobotAvatar";
import {
  type CollaborationRun,
  DelegatedReplyContext,
  DelegationNotice,
  indexRunCollaboration,
  RunCollaboration,
} from "./RunCollaboration";
import { TaskCard } from "./TaskCard";

export function ChannelWorkspace({
  headerAction,
  globalHeader = false,
  session: suppliedSession,
  channel,
  bots,
  artifacts,
  progress,
  onJoin,
  onRemove,
  onChannel,
  onInspectRun,
  onOpenBot,
  onFrame,
  onProgress,
  onRun,
  onOpenMembers,
  onNewRoutine,
  onOpenSettings,
  onOpenHosts,
  onBotChanged,
  approvals = [],
  nodes = [],
  frames,
  onDecideApproval,
}: {
  headerAction?: ReactNode;
  globalHeader?: boolean;
  session?: ConversationSession;
  channel: Channel;
  bots: Bot[];
  artifacts: Artifact[];
  progress: RunProgress[];
  onJoin(botId: string): Promise<void>;
  onRemove?(botId: string): Promise<void>;
  onChannel?(channel: Channel): void;
  onInspectRun(runId: string): void;
  onOpenBot(botId: string): void;
  onFrame(frame: RunFrame): void;
  onProgress(progress: RunProgress): void;
  onRun(run: Run, artifacts?: Artifact[]): void;
  /** Slash-menu actions from the Slash artboard; each is listed only when the host supplies it. */
  onOpenMembers?: (() => void) | undefined;
  onNewRoutine?: (() => void) | undefined;
  onOpenSettings?: ((section: "general") => void) | undefined;
  onOpenHosts?: (() => void) | undefined;
  /** Called after the 定分工 card changes the Bot's role, so the host can refresh its lists. */
  onBotChanged?: (() => void | Promise<void>) | undefined;
  /** Workspace approvals; the pending ones for this 频道's tasks are decided on their cards. */
  approvals?: readonly Approval[];
  nodes?: readonly ExecutionNode[];
  /** Latest live computer frame per task, kept by the host from frame events. */
  frames?: ReadonlyMap<string, RunFrame> | undefined;
  onDecideApproval?:
    | ((approvalId: string, decision: ApprovalDecision) => Promise<void>)
    | undefined;
}) {
  const { values: preferences } = useWorkspacePreferences();
  const [ownSession] = useState(createConversationSession);
  const session = suppliedSession ?? ownSession;
  const firstMemberId =
    channel.directBotId ?? (channel.botIds.length === 1 ? (channel.botIds[0] ?? "") : "");
  const conversation = useMemo(
    () => session.channel(channel.id, firstMemberId),
    [session, channel.id, firstMemberId],
  );
  const state = useSyncExternalStore(
    conversation.subscribe,
    conversation.getSnapshot,
    conversation.getSnapshot,
  );
  const { messages, runs, draft, loading, loadError, sendError, sending, capacityError, history } =
    state;
  const members = bots.filter((bot) => channel.botIds.includes(bot.id));
  const directBot = channel.directBotId
    ? members.find((bot) => bot.id === channel.directBotId)
    : undefined;
  const [setupSkipped, setSetupSkipped] = useState(false);
  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const runsById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const collaboration = useMemo(
    () => indexRunCollaboration(channel.id, runs, messages),
    [channel.id, runs, messages],
  );
  const artifactMessageByRun = useMemo(() => {
    const result = new Map<string, string>();
    for (const message of messages) {
      if (
        message.runId &&
        message.authorType === "bot" &&
        message.authorId === runsById.get(message.runId)?.botId &&
        !collaboration.delegationByMessage.has(message.id)
      )
        result.set(message.runId, message.id);
    }
    return result;
  }, [messages, runsById, collaboration]);
  const [realtimeState, setRealtimeState] = useState<RealtimeConnectionState>("connecting");
  const [readAttempt, setReadAttempt] = useState(0);
  const olderAnchor = useRef<{ height: number; top: number } | undefined>(undefined);
  const [dateCue, setDateCue] = useState<string>();
  const dateCueTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(dateCueTimer.current), []);
  // The newest message when the Owner scrolled away; later ones count as new in 回到最新.
  const awayFrom = useRef<string | undefined>(undefined);
  const [reactions, setReactions] = useState<MessageReaction[]>([]);
  const [filesOpen, setFilesOpen] = useState(false);
  const [outputs, setOutputs] = useState<ReadonlyMap<string, RunOutput>>(new Map());
  const [awayFromLatest, setAwayFromLatest] = useState(!conversation.scroll.atBottom);
  const messageList = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  const restored = useRef(false);
  const viewportSize = useRef({ width: 0, height: 0 });
  const mounted = useRef(false);
  const recipientIds = selectedRecipientIds(draft);
  const targetBot = recipientIds.length === 1 ? botsById.get(recipientIds[0] ?? "") : undefined;
  const [mention, setMention] = useState<MentionQuery>();
  const mentionQuery = mention?.query;
  const mentionCaret = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (mentionCaret.current === undefined) return;
    const caret = Math.min(mentionCaret.current, draft.text.length);
    textarea.current?.focus();
    textarea.current?.setSelectionRange(caret, caret);
    mentionCaret.current = undefined;
  }, [draft.text]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slash, setSlash] = useState<SlashQuery>();
  const [slashIndex, setSlashIndex] = useState(0);
  const [contextError, setContextError] = useState<string>();
  const [skillChoices, setSkillChoices] = useState<
    Array<{ id: string; name: string; version: string }>
  >([]);
  // The `/` menu lists the reviewed skills of the @ recipient, or of the channel's Bots when no
  // single recipient is chosen; picking one then addresses that Bot (Slash artboard).
  const [slashCatalog, setSlashCatalog] = useState<SlashSkill[]>([]);
  const [slashLoading, setSlashLoading] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [recording, setRecording] = useState(false);
  const attachmentsFull = composerAttachmentsFull(draft.attachments ?? []);
  // Composer artboard: with attachments, skills, recipients or a reply, the buttons move to a
  // bottom row; an empty draft keeps the one-row composer of the Main artboard.
  const composerExpanded =
    (draft.attachments?.length ?? 0) > 0 ||
    (draft.skills?.length ?? 0) > 0 ||
    (recipientIds.length > 0 && !channel.directBotId) ||
    draft.replyTo !== undefined ||
    uploadingAttachments;
  const addMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    // 频道信息 › 资料库 › 上传文件 reuses this composer's picker and upload checks.
    const open = () => {
      if (!sending) fileInput.current?.click();
    };
    window.addEventListener(composerAttachEvent, open);
    return () => window.removeEventListener(composerAttachEvent, open);
  }, [sending]);
  const matchingMembers = members.filter(
    (bot) =>
      mentionQuery !== undefined &&
      bot.name.toLocaleLowerCase().includes(mentionQuery.toLocaleLowerCase()),
  );
  const showEveryone =
    mentionQuery !== undefined &&
    members.length > 1 &&
    (!mentionQuery ||
      "所有人".includes(mentionQuery) ||
      "everyone".startsWith(mentionQuery.toLowerCase()));
  const mentionCount = matchingMembers.length + (showEveryone ? 1 : 0);
  const skillBotId = targetBot?.id;
  const slashActive = slash !== undefined;
  const slashTerm = slash?.query.toLocaleLowerCase() ?? "";
  const slashSkills = slashActive
    ? slashCatalog.filter((skill) =>
        `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(slashTerm),
      )
    : [];
  const availableActions: ComposerAction[] = [
    ...(onOpenMembers && !channel.directBotId
      ? [{ id: "members" as const, label: "成员", detail: "当前频道" }]
      : []),
    ...(onNewRoutine
      ? [{ id: "routine" as const, label: "新建例行任务", detail: "当前频道" }]
      : []),
    ...(onOpenSettings
      ? [{ id: "settings-general" as const, label: "设置：通用", detail: "设置" }]
      : []),
    ...(onOpenHosts
      ? [{ id: "settings-hosts" as const, label: "设置：工作主机", detail: "设置" }]
      : []),
  ];
  const slashActions = slashActive
    ? availableActions.filter((action) => action.label.toLocaleLowerCase().includes(slashTerm))
    : [];
  const slashCount = slashSkills.length + slashActions.length;
  const activeSlashIndex = Math.min(slashIndex, Math.max(slashCount - 1, 0));
  function closeSlash(keepText = true) {
    if (!keepText && slash) {
      mentionCaret.current = draft.text.slice(0, slash.start).trimEnd().length;
      conversation.edit({ text: removeSlashQuery(draft.text, slash) });
    }
    setSlash(undefined);
    setSlashIndex(0);
  }
  function chooseSlashSkill(skill: SlashSkill) {
    const attached = draft.skills ?? [];
    if (attached.some((item) => item.id === skill.id)) {
      closeSlash(false);
      return;
    }
    if (attached.length >= 2) {
      setContextError("一条消息最多使用 2 个技能。");
      return;
    }
    let recipients = {};
    if (targetBot?.id !== skill.botId && !channel.directBotId) {
      if (attached.length > 0) {
        setContextError("已选的技能属于另一个 Bot，请先移除再选择。");
        return;
      }
      try {
        // The skill runs on its own Bot, so that Bot becomes the recipient.
        recipients = addRecipient({ ...draft, targetBotIds: [] }, skill.botId, channel.botIds);
      } catch (cause) {
        setContextError(cause instanceof Error ? cause.message : "无法选择这个 Bot。");
        return;
      }
    }
    mentionCaret.current = slash ? draft.text.slice(0, slash.start).trimEnd().length : undefined;
    // Changing recipients clears attached skills in the session, so address the Bot first.
    if (Object.keys(recipients).length > 0) conversation.edit(recipients);
    conversation.edit({
      text: removeSlashQuery(draft.text, slash),
      skills: [...attached, { id: skill.id, name: skill.name, version: skill.version }],
    });
    setContextError(undefined);
    setSlash(undefined);
    setSlashIndex(0);
  }
  function chooseSlashAction(id: ComposerAction["id"]) {
    closeSlash(false);
    if (id === "members") onOpenMembers?.();
    else if (id === "routine") onNewRoutine?.();
    else if (id === "settings-general") onOpenSettings?.("general");
    else onOpenHosts?.();
  }
  function chooseSlashOption(index: number) {
    const skill = slashSkills[index];
    if (skill) chooseSlashSkill(skill);
    else {
      const action = slashActions[index - slashSkills.length];
      if (action) chooseSlashAction(action.id);
    }
  }
  const invalidRecipient = recipientIds.some(
    (id) => !channel.botIds.includes(id) || !botsById.has(id),
  );
  function chooseEveryone() {
    try {
      mentionCaret.current = mention
        ? draft.text.slice(0, mention.start).trimEnd().length
        : undefined;
      conversation.edit({
        ...selectEveryone(channel.botIds),
        text: removeMentionQuery(draft.text, mention),
      });
      setMention(undefined);
      setMentionIndex(0);
      setContextError(undefined);
      textarea.current?.focus();
    } catch (cause) {
      setContextError(cause instanceof Error ? cause.message : "无法选择所有人。");
    }
  }
  const activeRun = runs.find((run) => run.status === "running") ?? runs.find(isActiveRun);
  const contextLength = composeTaskText(draft.text, draft.attachments, draft.skills).length;
  function chooseMention(bot: Bot) {
    try {
      mentionCaret.current = mention
        ? draft.text.slice(0, mention.start).trimEnd().length
        : undefined;
      conversation.edit({
        ...addRecipient(draft, bot.id, channel.botIds),
        text: removeMentionQuery(draft.text, mention),
      });
      setContextError(undefined);
    } catch (cause) {
      setContextError(cause instanceof Error ? cause.message : "无法添加接收者。");
      return;
    }
    setMention(undefined);
    setMentionIndex(0);
    textarea.current?.focus();
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity changes must discard the previous Bot catalog.
  useEffect(() => {
    setSkillsOpen(false);
    setSkillChoices([]);
  }, [skillBotId]);
  const slashBotIds = (targetBot ? [targetBot.id] : channel.botIds.filter((id) => botsById.has(id)))
    .slice(0, 4)
    .join(",");
  useEffect(() => {
    if (!slashActive || !slashBotIds) {
      setSlashCatalog([]);
      return;
    }
    const controller = new AbortController();
    const ids = slashBotIds.split(",");
    setSlashLoading(true);
    void Promise.all(
      ids.map((id) =>
        getEmployeeProfile(id, controller.signal).then((profile) =>
          profile.skills
            .filter((skill) => skill.state === "verified")
            .map((skill) => ({
              id: skill.id,
              name: skill.name,
              version: skill.version,
              description: skill.description,
              botId: id,
              botName: profile.employee.name,
            })),
        ),
      ),
    )
      .then((lists) => {
        if (!controller.signal.aborted) setSlashCatalog(lists.flat());
      })
      .catch(() => {
        if (!controller.signal.aborted) setContextError("无法读取技能，请重试。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setSlashLoading(false);
      });
    return () => controller.abort();
  }, [slashActive, slashBotIds]);
  useEffect(() => {
    if (!skillsOpen || !skillBotId) return;
    const controller = new AbortController();
    setSkillsLoading(true);
    setContextError(undefined);
    void getEmployeeProfile(skillBotId, controller.signal)
      .then((profile) => {
        if (!controller.signal.aborted)
          setSkillChoices(profile.skills.filter((skill) => skill.state === "verified"));
      })
      .catch(() => {
        if (!controller.signal.aborted) setContextError("无法读取技能，请重试。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setSkillsLoading(false);
      });
    return () => controller.abort();
  }, [skillsOpen, skillBotId]);
  const artifactsByRun = useMemo(() => {
    const result = new Map<string, Artifact[]>();
    for (const artifact of artifacts) {
      const items = result.get(artifact.runId) ?? [];
      items.push(artifact);
      result.set(artifact.runId, items);
    }
    return result;
  }, [artifacts]);
  const latestProgressByRun = useMemo(() => {
    const result = new Map<string, RunProgress>();
    for (const item of progress) result.set(item.runId, item);
    return result;
  }, [progress]);
  const latestCompletedRequest = runs.reduce(
    (latest, run) =>
      run.status === "completed" && !run.parentRunId
        ? Math.max(latest, Date.parse(run.createdAt))
        : latest,
    0,
  );
  // One card per top-level task, in place (TaskCards artboard): after the Bot's latest message
  // for it, else after the message that started it, else at the end. A finished task the Bot
  // already answered needs no card — its reply carries the outputs and 任务详情. Delegated tasks
  // appear inside their lead task's card.
  const taskCards = useMemo(() => {
    const messageIds = new Set(messages.map((message) => message.id));
    const replied = new Map<string, Message>();
    for (const message of messages)
      if (message.runId && message.authorType === "bot") replied.set(message.runId, message);
    const shown = runs
      .filter((run) => {
        if (run.parentRunId && runsById.has(run.parentRunId)) return false;
        if (run.status === "completed") return !replied.has(run.id);
        if (run.status === "failed" || run.status === "cancelled")
          return Date.parse(run.createdAt) >= latestCompletedRequest;
        return true;
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const newest = shown.at(-1)?.id;
    const byAnchor = new Map<string, Run[]>();
    const trailing: Run[] = [];
    for (const run of shown) {
      const anchor =
        replied.get(run.id)?.id ??
        (run.sourceMessageId && messageIds.has(run.sourceMessageId)
          ? run.sourceMessageId
          : undefined);
      if (anchor === undefined) trailing.push(run);
      else byAnchor.set(anchor, [...(byAnchor.get(anchor) ?? []), run]);
    }
    return { byAnchor, trailing, newest, ids: new Set(shown.map((run) => run.id)) };
  }, [messages, runs, runsById, latestCompletedRequest]);
  const renderTask = (run: Run, after?: Message) => (
    <TaskCard
      key={`task-${run.id}`}
      run={run}
      bot={botsById.get(run.botId)}
      botsById={botsById}
      progress={latestProgressByRun.get(run.id)}
      artifacts={artifactsByRun.get(run.id) ?? []}
      approvals={approvals.filter(
        (approval) => approval.runId === run.id && approval.status === "pending",
      )}
      frame={frames?.get(run.id)}
      node={nodes.find((node) => node.id === run.nodeId)}
      childRuns={collaboration.childrenByParent.get(run.id) ?? []}
      waiting={run.status === "queued" && activeRun?.id !== run.id}
      collapsed={run.status === "completed" && run.id !== taskCards.newest}
      showAvatar={!(after?.authorType === "bot" && after.authorId === run.botId)}
      onInspect={onInspectRun}
      onRun={(next) => {
        conversation.merge([], [next]);
        onRun(next);
      }}
      onDecideApproval={onDecideApproval ?? (async () => undefined)}
    />
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a user retry deliberately restarts this bounded subscription/read lifecycle.
  useEffect(() => {
    const controller = new AbortController();
    let revision = 0;
    const syncChannel = async () => {
      const requestedRevision = ++revision;
      try {
        const [messageItems, runItems] = await Promise.all([
          listMessages(channel.id, controller.signal),
          listRuns(channel.id, controller.signal),
        ]);
        if (controller.signal.aborted || requestedRevision !== revision) return;
        conversation.merge(messageItems, runItems);
        // The latest page holds up to 100; fewer means the whole history is already here.
        if (messageItems.length < 100 && conversation.getSnapshot().history.cursor === undefined)
          conversation.setHistory({ exhausted: true });
        conversation.loaded();
        for (const run of runItems) if (run.channelId === channel.id) onRun(run);
        void listChannelReactions(channel.id, controller.signal)
          .then((items) => {
            if (!controller.signal.aborted && requestedRevision === revision) setReactions(items);
          })
          .catch(() => undefined);
        await Promise.allSettled(
          runItems
            .filter(
              (run) =>
                run.channelId === channel.id &&
                run.executionProfile === "none" &&
                ["queued", "running"].includes(run.status),
            )
            .map(async (run) => {
              const output = await getRunOutput(run.id, controller.signal);
              if (!controller.signal.aborted && output)
                setOutputs((current) =>
                  mergeRunOutput(current, output, channel.id, conversation.getSnapshot().runs),
                );
            }),
        );
      } catch (cause: unknown) {
        if (controller.signal.aborted || requestedRevision !== revision) return;
        conversation.loaded(cause instanceof Error ? cause.message : "无法读取频道消息。");
      }
    };
    const unsubscribe = subscribeToChannelEvents(channel.id, {
      onMessage(message) {
        if (!controller.signal.aborted) conversation.merge([message]);
      },
      onFrame(frame) {
        if (!controller.signal.aborted) onFrame(frame);
      },
      onProgress(item) {
        if (!controller.signal.aborted) onProgress(item);
      },
      onRun(run, projectedArtifacts) {
        if (controller.signal.aborted || run.channelId !== channel.id) return;
        conversation.merge([], [run]);
        onRun(run, projectedArtifacts);
      },
      onOutput(output) {
        if (!controller.signal.aborted)
          setOutputs((current) =>
            mergeRunOutput(current, output, channel.id, conversation.getSnapshot().runs),
          );
      },
      onReactions(messageId, items) {
        if (!controller.signal.aborted)
          setReactions((current) => [
            ...current.filter((item) => item.messageId !== messageId),
            ...items,
          ]);
      },
      onChannel(updated) {
        if (!controller.signal.aborted) onChannel?.(updated);
      },
      onReady() {
        if (!controller.signal.aborted) void syncChannel();
      },
      onState(value) {
        if (!controller.signal.aborted) setRealtimeState(value);
      },
    });
    void syncChannel();
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [channel.id, conversation, onFrame, onProgress, onRun, onChannel, readAttempt]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: message count changes invalidate DOM scroll geometry.
  useLayoutEffect(() => {
    const list = messageList.current;
    if (!list || loading || list.clientHeight === 0) return;
    const anchor = olderAnchor.current;
    if (anchor) {
      // Older messages were added above: keep what the Owner was reading in place.
      olderAnchor.current = undefined;
      list.scrollTop = anchor.top + (list.scrollHeight - anchor.height);
      conversation.scroll.top = list.scrollTop;
      return;
    }
    if (!restored.current) {
      list.scrollTop = conversation.scroll.atBottom ? list.scrollHeight : conversation.scroll.top;
      restored.current = true;
    } else if (conversation.scroll.atBottom) {
      list.scrollTo?.({
        top: list.scrollHeight,
        behavior:
          preferences.reduceMotion ||
          window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
      });
    }
  }, [conversation, loading, messages.length, outputs, preferences.reduceMotion]);

  useLayoutEffect(() => {
    const list = messageList.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    viewportSize.current = { width: list.clientWidth, height: list.clientHeight };
    const observer = new ResizeObserver(() => {
      viewportSize.current = { width: list.clientWidth, height: list.clientHeight };
      if (list.clientHeight === 0) return;
      const snapshot = conversation.getSnapshot();
      if (snapshot.loading && snapshot.messages.length === 0) return;
      // Resizing a sidebar, composer or window must preserve the user's existing follow intent.
      list.scrollTop = conversation.scroll.atBottom ? list.scrollHeight : conversation.scroll.top;
      conversation.scroll.top = list.scrollTop;
      conversation.scroll.atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      setAwayFromLatest(!conversation.scroll.atBottom);
      restored.current = true;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [conversation]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: textarea value and font changes invalidate measured content height.
  useLayoutEffect(() => {
    const input = textarea.current;
    if (!input) return;
    const resize = () => {
      const style = window.getComputedStyle(input);
      const lineHeight = Number.parseFloat(style.lineHeight) || 24;
      const padding =
        (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
      input.style.height = "auto";
      input.style.height = `${Math.max(lineHeight + padding, Math.min(input.scrollHeight, 8 * lineHeight + padding))}px`;
    };
    resize();
    let width = input.clientWidth;
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            if (input.clientWidth !== width) {
              width = input.clientWidth;
              resize();
            }
          });
    observer?.observe(input);
    return () => observer?.disconnect();
  }, [draft.text, preferences.fontSize]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      sending ||
      uploadingAttachments ||
      mentionQuery !== undefined ||
      members.length === 0 ||
      recipientIds.some((id) => !members.some((bot) => bot.id === id))
    )
      return;
    const result = await conversation.send((input) => createMessage(channel.id, input));
    if (result && mounted.current) for (const run of result.runs ?? [result.run]) onRun(run);
  }
  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      slashActive &&
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229 &&
      !event.shiftKey &&
      !event.altKey
    ) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSlash();
        return;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && slashCount > 0) {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSlashIndex((activeSlashIndex + step + slashCount) % slashCount);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && slashCount > 0) {
        event.preventDefault();
        chooseSlashOption(activeSlashIndex);
        return;
      }
    }
    if (
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229 &&
      !event.shiftKey &&
      !event.altKey &&
      mentionQuery !== undefined
    ) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(undefined);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((value) =>
          Math.max(0, Math.min(mentionCount - 1, value + (event.key === "ArrowDown" ? 1 : -1))),
        );
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && mentionCount > 0) {
        event.preventDefault();
        if (showEveryone && mentionIndex === 0) chooseEveryone();
        else {
          const choice = matchingMembers[mentionIndex - (showEveryone ? 1 : 0)];
          if (choice) chooseMention(choice);
        }
        return;
      }
    }
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      event.altKey
    )
      return;
    if (preferences.sendShortcut === "modifier" && !event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
  if (!awayFromLatest) awayFrom.current = undefined;
  else if (awayFrom.current === undefined) awayFrom.current = messages.at(-1)?.id ?? "";
  const awayIndex = awayFrom.current
    ? messages.findIndex((item) => item.id === awayFrom.current)
    : -1;
  const unseen =
    awayFromLatest && awayIndex >= 0
      ? messages.slice(awayIndex + 1).filter((item) => item.authorType !== "human").length
      : 0;
  /** C18: read the page before the oldest message loaded; the latest page has no cursor yet. */
  async function loadOlder() {
    const current = conversation.getSnapshot().history;
    if (current.loading || current.exhausted) return;
    conversation.setHistory({ loading: true, error: undefined });
    try {
      let cursor = current.cursor;
      if (!cursor) {
        const latest = await listMessagePage(channel.id);
        if (!latest.hasMore || !latest.nextCursor) {
          conversation.setHistory({ loading: false, exhausted: true });
          return;
        }
        cursor = latest.nextCursor;
      }
      const page = await listMessagePage(channel.id, cursor);
      const list = messageList.current;
      if (list && page.messages.length > 0)
        olderAnchor.current = { height: list.scrollHeight, top: list.scrollTop };
      conversation.prepend(page.messages);
      conversation.setHistory({
        loading: false,
        cursor: page.nextCursor ?? cursor,
        exhausted: !page.hasMore,
      });
    } catch {
      conversation.setHistory({ loading: false, error: "没能加载更早的消息。" });
    }
  }
  /** LongLists: while scrolling, the date of the topmost visible message floats at the top. */
  function showDateCue(list: HTMLElement) {
    window.clearTimeout(dateCueTimer.current);
    if (list.scrollTop < 40) {
      setDateCue(undefined);
      return;
    }
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-time]"));
    const top = list.getBoundingClientRect().top + 8;
    let low = 0;
    let high = rows.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((rows[middle]?.getBoundingClientRect().bottom ?? 0) > top) high = middle;
      else low = middle + 1;
    }
    const time = rows[low]?.dataset.time;
    setDateCue(time ? dateCueLabel(time) : undefined);
    dateCueTimer.current = window.setTimeout(() => setDateCue(undefined), 1200);
  }
  function showLatest() {
    conversation.scroll.atBottom = true;
    const list = messageList.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
      conversation.scroll.top = list.scrollTop;
    }
    setAwayFromLatest(false);
  }
  function showMessage(id: string) {
    const row = document.getElementById(`channel-message-${id}`);
    if (!row) return;
    conversation.scroll.atBottom = false;
    row.scrollIntoView?.({ block: "center", behavior: "auto" });
    row.focus({ preventScroll: true });
    if (messageList.current) conversation.scroll.top = messageList.current.scrollTop;
    setAwayFromLatest(true);
  }
  return (
    <main
      className={`workspace-main channel-workspace channel-native${globalHeader ? " has-global-header" : ""}`}
    >
      {filesOpen && (
        <AttachmentsManagerDialog
          channelId={channel.id}
          channelName={channel.directBotId ? botsById.get(channel.directBotId)?.name : channel.name}
          outputs={runs.flatMap((run) => artifactsByRun.get(run.id) ?? [])}
          botNameForRun={(runId) => {
            const run = runs.find((item) => item.id === runId);
            return run ? botsById.get(run.botId)?.name : undefined;
          }}
          onClose={() => setFilesOpen(false)}
        />
      )}
      <PluginCallApprovals channelId={channel.id} bots={bots} onInspectRun={onInspectRun} />
      <section
        className="conversation-panel channel-conversation"
        aria-label={`${channel.name} 消息`}
      >
        {/* Notices artboard: one banner at a time, the more serious first. */}
        {loadError ? (
          <div className="conversation-load-error conversation-banner is-error" role="alert">
            <span>没能读取消息：{loadError}</span>
            <button
              type="button"
              className="ob-pill is-small"
              onClick={() => setReadAttempt((value) => value + 1)}
            >
              重新读取
            </button>
          </div>
        ) : realtimeState === "retrying" ? (
          <div className="conversation-banner is-warning" role="status">
            <span>
              <i aria-hidden="true" />
              和服务电脑的连接断了，正在重新连接…草稿不会丢。
            </span>
            <button
              type="button"
              className="ob-pill is-small"
              onClick={() => setReadAttempt((value) => value + 1)}
            >
              立即重连
            </button>
          </div>
        ) : null}
        <div
          className="message-list"
          ref={messageList}
          onScroll={(event) => {
            const list = event.currentTarget;
            // Hidden settings content has zero geometry; it must not erase the saved reading position.
            if (list.clientHeight === 0) return;
            if (
              typeof ResizeObserver !== "undefined" &&
              (list.clientWidth !== viewportSize.current.width ||
                list.clientHeight !== viewportSize.current.height)
            )
              return;
            conversation.scroll.top = list.scrollTop;
            conversation.scroll.atBottom =
              list.scrollHeight - list.scrollTop - list.clientHeight < 80;
            setAwayFromLatest(!conversation.scroll.atBottom);
            showDateCue(list);
            const older = conversation.getSnapshot().history;
            if (list.scrollTop < 120 && !older.exhausted && !older.loading && !older.error)
              void loadOlder();
          }}
          role="log"
          aria-label="频道消息记录"
          aria-live="polite"
        >
          {history.loading ? (
            <p className="conversation-older" role="status">
              正在加载更早的消息…
            </p>
          ) : history.error ? (
            <p className="conversation-older" role="alert">
              {history.error}
              <button
                type="button"
                className="ob-pill is-small"
                onClick={() => {
                  conversation.setHistory({ error: undefined });
                  void loadOlder();
                }}
              >
                重试
              </button>
            </p>
          ) : null}
          {loading && messages.length === 0 ? (
            <p className="conversation-status">正在读取频道消息…</p>
          ) : messages.length === 0 && directBot && needsRoleSetup(directBot) && !setupSkipped ? (
            <NewBotSetupCard
              bot={directBot}
              onSkip={() => setSetupSkipped(true)}
              onChoose={async ({ role, description, message }) => {
                // The Server keeps role and description under a revision; read it, then write.
                const profile = await getEmployeeProfile(directBot.id);
                await updateEmployeeProfileDetails(directBot.id, {
                  role,
                  description,
                  expectedRevision: profile.details.revision,
                });
                await onBotChanged?.();
                conversation.edit({ text: message });
                const result = await conversation.send((input) => createMessage(channel.id, input));
                if (result && mounted.current)
                  for (const run of result.runs ?? [result.run]) onRun(run);
              }}
            />
          ) : messages.length === 0 ? (
            <div className="conversation-empty">
              <span className="conversation-icon">
                <HashIcon />
              </span>
              <h2>{channel.name} 的第一条消息</h2>
              <p>
                {members.length === 0
                  ? "先从顶部菜单添加一名 Bot。"
                  : channel.directBotId
                    ? "直接交代第一件工作。"
                    : "直接发送到频道，或 @ 指定协作伙伴。"}
              </p>
            </div>
          ) : (
            messages.map((message, index) => (
              <Fragment key={message.id}>
                {needsTimeDivider(messages[index - 1], message) ? (
                  <div className="message-time-divider">
                    <time dateTime={message.createdAt}>
                      {formatDivider(message.createdAt, preferences.hour12)}
                    </time>
                  </div>
                ) : null}
                <MessageRow
                  message={message}
                  reactions={reactions.filter((item) => item.messageId === message.id)}
                  onReactionChange={async (emoji, active) => {
                    const items = await setMessageReaction(channel.id, message.id, emoji, active);
                    if (mounted.current)
                      setReactions((current) => [
                        ...current.filter((item) => item.messageId !== message.id),
                        ...items,
                      ]);
                  }}
                  groupStart={!sameMessageGroup(messages[index - 1], message)}
                  groupEnd={!sameMessageGroup(message, messages[index + 1])}
                  direct={Boolean(channel.directBotId)}
                  author={
                    message.authorId === undefined ? undefined : botsById.get(message.authorId)
                  }
                  replyTarget={
                    // A reply to the message directly above needs no quote; the design shows none.
                    message.replyToMessageId === undefined ||
                    messages[index - 1]?.id === message.replyToMessageId
                      ? undefined
                      : messageById.get(message.replyToMessageId)
                  }
                  botsById={botsById}
                  artifacts={
                    message.runId === undefined
                      ? []
                      : (artifactsByRun.get(message.runId) ?? []).filter((artifact) =>
                          message.authorType === "bot"
                            ? message.id === artifactMessageByRun.get(message.runId ?? "")
                            : artifact.mediaType === "image/png",
                        )
                  }
                  run={message.runId === undefined ? undefined : runsById.get(message.runId)}
                  delegation={collaboration.delegationByMessage.get(message.id)}
                  delegatedRun={
                    message.runId ? collaboration.linkedRuns.get(message.runId) : undefined
                  }
                  parentRun={
                    message.runId && collaboration.linkedRuns.get(message.runId)?.parentRunId
                      ? runsById.get(collaboration.linkedRuns.get(message.runId)?.parentRunId ?? "")
                      : undefined
                  }
                  childRuns={
                    message.runId &&
                    !taskCards.ids.has(message.runId) &&
                    runsById.get(message.runId)?.sourceMessageId === message.id
                      ? (collaboration.childrenByParent.get(message.runId) ?? [])
                      : []
                  }
                  onReply={() => {
                    conversation.edit({
                      replyTo: message,
                      ...(message.authorType === "bot" &&
                      message.authorId &&
                      channel.botIds.includes(message.authorId)
                        ? { targetBotId: message.authorId, targetBotIds: [message.authorId] }
                        : {}),
                    });
                    textarea.current?.focus();
                  }}
                  onShowMessage={showMessage}
                  onInspectRun={onInspectRun}
                  onOpenBot={onOpenBot}
                />
                {taskCards.byAnchor.get(message.id)?.map((run) => renderTask(run, message))}
              </Fragment>
            ))
          )}
          {runs
            .filter(
              (run) =>
                isActiveRun(run) &&
                outputs.get(run.id)?.text &&
                botsById.has(run.botId) &&
                !artifactMessageByRun.has(run.id),
            )
            .map((run) => (
              <article
                className="message-row bot group-start group-end streaming-message"
                key={`output-${run.id}`}
                aria-label={`${botsById.get(run.botId)?.name} 正在回复`}
                aria-busy="true"
              >
                <div className="message-avatar">
                  <RobotAvatar bot={botsById.get(run.botId) as Bot} compact />
                </div>
                <div className="message-content">
                  <header className="message-sender">
                    <strong>{botsById.get(run.botId)?.name} · 正在回复</strong>
                  </header>
                  <RichMessage content={outputs.get(run.id)?.text ?? ""} />
                </div>
              </article>
            ))}
          {taskCards.trailing.map((run) => renderTask(run))}
        </div>
        {dateCue ? (
          <span className="conversation-date-cue" aria-hidden="true">
            {dateCue}
          </span>
        ) : null}
        {awayFromLatest ? (
          <button type="button" className="conversation-latest" onClick={showLatest}>
            ↓ 回到最新{unseen > 0 ? ` · ${unseen} 条新消息` : ""}
          </button>
        ) : null}
        {capacityError ? (
          <p className="conversation-capacity-error" role="alert">
            {capacityError}
          </p>
        ) : null}
        <form
          className={`message-composer${composerExpanded ? " is-expanded" : ""}${recording ? " is-recording" : ""}`}
          ref={composer}
          onSubmit={sendMessage}
        >
          {draft.replyTo ? (
            <div className="composer-reply">
              <span>
                回复 {messageAuthorName(draft.replyTo, botsById)}：{draft.replyTo.content}
              </span>
              <button
                type="button"
                onClick={() => conversation.edit({ replyTo: undefined })}
                aria-label="取消回复"
              >
                ×
              </button>
            </div>
          ) : null}
          <div className="composer-writing-row">
            {recipientIds.length > 0 && !channel.directBotId && (
              <div className="composer-recipients">
                {recipientIds.map((id) => (
                  <span className="composer-mention" key={id}>
                    <span>@ {botsById.get(id)?.name ?? "已离开的 Bot"}</span>
                    <button
                      type="button"
                      aria-label={`移除接收 Bot ${botsById.get(id)?.name ?? id}`}
                      onClick={() => {
                        conversation.edit(removeRecipient(draft, id));
                        setContextError(undefined);
                        textarea.current?.focus();
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {draft.skills?.length ? (
              <div className="composer-chips">
                {draft.skills?.map((skill) => (
                  <span className="context-chip" key={skill.id}>
                    <span>/ {skill.name}</span>
                    <button
                      type="button"
                      aria-label={`移除技能 ${skill.name}`}
                      onClick={() =>
                        conversation.edit({
                          skills: draft.skills?.filter((item) => item.id !== skill.id) ?? [],
                        })
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            {slashActive && (
              <div
                className="mention-options slash-options"
                role="listbox"
                id={`slash-${channel.id}`}
                aria-label="技能与操作"
              >
                {slashLoading && slashSkills.length === 0 ? (
                  <p role="status">正在读取技能…</p>
                ) : null}
                {slashSkills.map((skill, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === activeSlashIndex}
                    id={`slash-${channel.id}-${index}`}
                    key={skill.id}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseSlashSkill(skill)}
                  >
                    <SlashSkillGlyph />
                    <span>
                      {skill.name}
                      <small>
                        {!targetBot && !channel.directBotId ? `${skill.botName} · ` : ""}
                        {skill.description || `v${skill.version}`}
                      </small>
                    </span>
                    <em>技能</em>
                  </button>
                ))}
                {slashSkills.length > 0 && slashActions.length > 0 ? (
                  <span className="slash-separator" aria-hidden="true" />
                ) : null}
                {slashActions.map((action, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index + slashSkills.length === activeSlashIndex}
                    id={`slash-${channel.id}-${index + slashSkills.length}`}
                    key={action.id}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseSlashAction(action.id)}
                  >
                    <SlashActionGlyph />
                    <span>
                      {action.label}
                      <small>{action.detail}</small>
                    </span>
                    <em>操作</em>
                  </button>
                ))}
                {slashCount === 0 && !slashLoading ? <p>没有匹配的技能或操作</p> : null}
                <p className="slash-hint">继续输入可筛选 · ↑ ↓ 选择 · 回车确认 · Esc 关闭</p>
              </div>
            )}
            {mentionQuery !== undefined && (
              <div
                className="mention-options"
                role="listbox"
                id={`mentions-${channel.id}`}
                aria-label="提及 Bot"
              >
                {showEveryone ? (
                  <button
                    type="button"
                    role="option"
                    aria-selected={mentionIndex === 0}
                    id={`mention-everyone-${channel.id}`}
                    className="mention-everyone"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={chooseEveryone}
                  >
                    <HashIcon />
                    <span>
                      所有人<small>{members.length} 位频道成员</small>
                    </span>
                  </button>
                ) : null}
                {matchingMembers.map((bot, index) => (
                  <button
                    role="option"
                    aria-selected={index + (showEveryone ? 1 : 0) === mentionIndex}
                    id={`mention-${bot.id}`}
                    key={bot.id}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseMention(bot)}
                  >
                    <RobotAvatar bot={bot} compact />
                    <span>
                      {bot.name}
                      <small>{bot.role}</small>
                    </span>
                  </button>
                ))}
                {matchingMembers.length === 0 && <p>没有匹配的频道 Bot</p>}
              </div>
            )}
            <textarea
              ref={textarea}
              id={`message-${channel.id}`}
              aria-label="消息内容"
              value={draft.text}
              maxLength={8000}
              rows={1}
              disabled={members.length === 0 || Boolean(capacityError)}
              placeholder={
                members.length === 0
                  ? "先从顶部菜单添加一名 Bot"
                  : channel.directBotId
                    ? `给 ${targetBot?.name ?? "Bot"} 发消息`
                    : `给 ${channel.name} 发消息`
              }
              aria-controls={
                slashActive
                  ? `slash-${channel.id}`
                  : mentionQuery !== undefined
                    ? `mentions-${channel.id}`
                    : undefined
              }
              aria-activedescendant={
                slashActive
                  ? slashCount > 0
                    ? `slash-${channel.id}-${activeSlashIndex}`
                    : undefined
                  : mentionQuery === undefined
                    ? undefined
                    : showEveryone && mentionIndex === 0
                      ? `mention-everyone-${channel.id}`
                      : matchingMembers[mentionIndex - (showEveryone ? 1 : 0)]
                        ? `mention-${matchingMembers[mentionIndex - (showEveryone ? 1 : 0)]?.id}`
                        : undefined
              }
              onChange={(event) => {
                conversation.edit({ text: event.target.value });
                setSlash(findSlashQuery(event.target.value, event.target.selectionStart));
                setSlashIndex(0);
                setMention(
                  channel.directBotId
                    ? undefined
                    : findMentionQuery(event.target.value, event.target.selectionStart),
                );
                setMentionIndex(0);
              }}
              onSelect={(event) => {
                setSlash(
                  findSlashQuery(event.currentTarget.value, event.currentTarget.selectionStart),
                );
                setMention(
                  channel.directBotId
                    ? undefined
                    : findMentionQuery(
                        event.currentTarget.value,
                        event.currentTarget.selectionStart,
                      ),
                );
                setMentionIndex(0);
              }}
              onKeyDown={handleComposerKeyDown}
            />
          </div>
          <div className="composer-toolbar">
            <div className="composer-context-controls">
              <details
                className="composer-add-menu"
                ref={addMenu}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && addMenu.current) {
                    addMenu.current.open = false;
                    addMenu.current.querySelector("summary")?.focus();
                  }
                }}
              >
                <summary className="composer-add" aria-label="添加附件或技能">
                  <PlusIcon />
                </summary>
                <div className="composer-add-popover">
                  <button
                    type="button"
                    disabled={attachmentsFull}
                    onClick={() => {
                      if (addMenu.current) addMenu.current.open = false;
                      fileInput.current?.click();
                    }}
                  >
                    添加附件
                    <small>
                      {attachmentsFull
                        ? "已到上限：每条最多 8 个、合计 20 MB"
                        : "文本、图片、Office、PDF、音频和视频"}
                    </small>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (addMenu.current) addMenu.current.open = false;
                      setFilesOpen(true);
                    }}
                  >
                    频道文件<small>下载、提取文字、转写和管理回收站</small>
                  </button>
                  <button
                    type="button"
                    disabled={!targetBot}
                    onClick={() => {
                      if (addMenu.current) addMenu.current.open = false;
                      setSkillsOpen(true);
                    }}
                  >
                    使用技能
                    <small>
                      {targetBot ? `${targetBot.name} 已审核的技能` : "先 @ 提及一名 Bot"}
                    </small>
                  </button>
                </div>
              </details>
              <VoiceRecorder
                channelId={channel.id}
                disabled={sending || uploadingAttachments}
                getAttachments={() => conversation.getSnapshot().draft.attachments ?? []}
                onChange={(attachments) => conversation.edit({ attachments })}
                onActiveChange={setRecording}
              />
              <ComposerAttachmentPicker
                channelId={channel.id}
                attachments={draft.attachments ?? []}
                getAttachments={() => conversation.getSnapshot().draft.attachments ?? []}
                onChange={(attachments) => conversation.edit({ attachments })}
                inputRef={fileInput}
                dropTargetRef={composer}
                disabled={sending}
                onUploadingChange={setUploadingAttachments}
              />
            </div>
            <button
              className="composer-send"
              type="submit"
              disabled={
                sending ||
                uploadingAttachments ||
                Boolean(capacityError) ||
                members.length === 0 ||
                recipientIds.some((id) => !members.some((bot) => bot.id === id)) ||
                !draft.text.trim() ||
                contextLength > 8000 ||
                mentionQuery !== undefined
              }
              aria-label="发送消息"
              title={
                preferences.sendShortcut === "modifier"
                  ? `${shortcutLabel("Enter")} 发送`
                  : "Enter 发送"
              }
            >
              {sending ? <span aria-hidden="true">…</span> : <SendIcon />}
            </button>
          </div>
          {skillsOpen && (
            <div className="composer-skills-panel">
              <header>
                <strong>使用 {targetBot?.name} 的技能</strong>
                <button
                  type="button"
                  aria-label="关闭技能选择"
                  onClick={() => setSkillsOpen(false)}
                >
                  ×
                </button>
              </header>
              {skillsLoading ? (
                <p role="status">正在读取…</p>
              ) : skillChoices.length === 0 ? (
                <p>暂无已审核技能，可在插件中添加并审核。</p>
              ) : (
                skillChoices.map((skill) => (
                  <button
                    type="button"
                    key={skill.id}
                    disabled={
                      (draft.skills?.length ?? 0) >= 2 ||
                      draft.skills?.some((item) => item.id === skill.id)
                    }
                    onClick={() => {
                      conversation.edit({
                        skills: [
                          ...(draft.skills ?? []),
                          { id: skill.id, name: skill.name, version: skill.version },
                        ],
                      });
                      setSkillsOpen(false);
                    }}
                  >
                    {skill.name}
                    <small>v{skill.version}</small>
                  </button>
                ))
              )}
            </div>
          )}
          {(contextError || invalidRecipient) && (
            <p className="composer-error" role="alert">
              {invalidRecipient ? "接收 Bot 已离开频道，请重新选择后发送。" : contextError}
            </p>
          )}
          {contextLength > 8000 && (
            <p className="composer-error" role="alert">
              消息与附件合计不能超过 8000 字符。
            </p>
          )}
          {sending ? (
            <p className="composer-pending" role="status">
              正在发送，你可以继续起草下一条。
            </p>
          ) : null}
          {sendError ? (
            <p className="composer-error" role="alert">
              {sendError}
            </p>
          ) : null}
        </form>
        <div className="conversation-footer">
          <span>
            {preferences.sendShortcut === "modifier"
              ? `${shortcutLabel("Enter")} 发送 · Enter 换行`
              : "Enter 发送 · Shift + Enter 换行"}
          </span>
          <span className={`realtime-state ${realtimeState}`}>
            <i />
            {realtimeLabel(realtimeState)}
          </span>
        </div>
      </section>
    </main>
  );
}

function MessageRow({
  message,
  reactions,
  onReactionChange,
  groupStart,
  groupEnd,
  direct,
  author,
  replyTarget,
  botsById,
  artifacts,
  run,
  delegation,
  delegatedRun,
  parentRun,
  childRuns,
  onReply,
  onShowMessage,
  onInspectRun,
  onOpenBot,
}: {
  message: Message;
  reactions: MessageReaction[];
  onReactionChange(emoji: ReactionEmoji, active: boolean): Promise<void>;
  groupStart: boolean;
  groupEnd: boolean;
  direct: boolean;
  author: Bot | undefined;
  replyTarget: Message | undefined;
  botsById: Map<string, Bot>;
  artifacts: Artifact[];
  run: Run | undefined;
  delegation: CollaborationRun | undefined;
  delegatedRun: CollaborationRun | undefined;
  parentRun: Run | undefined;
  childRuns: CollaborationRun[];
  onReply(): void;
  onShowMessage(id: string): void;
  onInspectRun(runId: string): void;
  onOpenBot(botId: string): void;
}) {
  const { values: preferences } = useWorkspacePreferences();
  const name = message.authorType === "human" ? "你" : (author?.name ?? "OpenBot");
  return (
    <article
      id={`channel-message-${message.id}`}
      data-time={message.createdAt}
      tabIndex={-1}
      aria-label={`${name} 的消息`}
      className={`message-row ${message.authorType}${groupStart ? " group-start" : " group-continuation"}${groupEnd ? " group-end" : ""}${direct ? " direct-message" : ""}`}
    >
      <div className="message-avatar">
        {author ? (
          <button
            type="button"
            aria-label={`打开 ${author.name} 的员工档案`}
            onClick={() => onOpenBot(author.id)}
          >
            <RobotAvatar bot={author} compact status={run?.status ?? author.status} />
          </button>
        ) : message.authorType === "human" ? (
          <span>你</span>
        ) : (
          <OpenBotMark />
        )}
      </div>
      <div className="message-content">
        <header className="message-sender">
          <strong>{name}</strong>
          <time dateTime={message.createdAt}>
            {formatMessageTime(message.createdAt, preferences.hour12)}
          </time>
        </header>
        {delegation ? (
          <DelegationNotice run={delegation} botsById={botsById} onInspectRun={onInspectRun} />
        ) : null}
        {delegatedRun && message.authorType === "bot" && message.authorId === delegatedRun.botId ? (
          <DelegatedReplyContext
            run={delegatedRun}
            parent={parentRun}
            botsById={botsById}
            onInspectRun={onInspectRun}
          />
        ) : null}
        {replyTarget ? (
          <button
            type="button"
            className="message-quote"
            onClick={() => onShowMessage(replyTarget.id)}
            aria-label={`跳转到 ${messageAuthorName(replyTarget, botsById)} 的原消息`}
          >
            <blockquote>
              {messageAuthorName(replyTarget, botsById)}：{replyTarget.content}
            </blockquote>
          </button>
        ) : null}
        <MessageAttachments content={message.content} channelId={message.channelId} />
        {artifacts.length > 0 ? (
          <div className="message-artifacts">
            {artifacts.map((artifact) => (
              <ArtifactCard artifact={artifact} key={artifact.id} />
            ))}
          </div>
        ) : null}
        {childRuns.length ? (
          <details className="message-work-details">
            <summary>协作 · {childRuns.length} 位 Bot</summary>
            <RunCollaboration
              childRuns={childRuns}
              botsById={botsById}
              onInspectRun={onInspectRun}
            />
          </details>
        ) : null}
        <MessageReactions
          messageId={message.id}
          reactions={reactions}
          onChange={onReactionChange}
        />
        <MessageActionBar
          message={message}
          onReply={onReply}
          onInspectRun={onInspectRun}
          run={run}
          reactions={reactions}
          onReactionChange={onReactionChange}
        />
      </div>
    </article>
  );
}

function messageAuthorName(message: Message, botsById: Map<string, Bot> = new Map()) {
  if (message.authorType === "human") return "你";
  return (
    (message.authorId === undefined ? undefined : botsById.get(message.authorId)?.name) ?? "OpenBot"
  );
}

function formatMessageTime(value: string, hour12: boolean) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12 }).format(
    new Date(value),
  );
}

function needsTimeDivider(previous: Message | undefined, message: Message) {
  if (!previous) return true;
  return (
    new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() > 5 * 60_000
  );
}

function sameMessageGroup(previous: Message | undefined, message: Message | undefined) {
  return Boolean(
    previous &&
      message &&
      previous.authorType === message.authorType &&
      previous.authorId === message.authorId &&
      !message.replyToMessageId &&
      !needsTimeDivider(previous, message),
  );
}

function formatDivider(value: string, hour12: boolean) {
  const date = new Date(value);
  const today = new Date();
  const day =
    date.toDateString() === today.toDateString()
      ? "今天"
      : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
  return `${day} ${formatMessageTime(value, hour12)}`;
}

/** 「今天」, 「昨天」 or 「9 月 25 日 · 周四」 (LongLists date cue). */
export function dateCueLabel(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return "今天";
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${weekday}`;
}

function realtimeLabel(state: RealtimeConnectionState) {
  const labels: Record<RealtimeConnectionState, string> = {
    connecting: "连接中",
    live: "实时连接",
    retrying: "正在重连",
  };
  return labels[state];
}

interface ComposerAction {
  id: "members" | "routine" | "settings-general" | "settings-hosts";
  label: string;
  detail: string;
}

interface SlashSkill {
  id: string;
  name: string;
  version: string;
  description: string;
  botId: string;
  botName: string;
}

function SlashSkillGlyph() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    >
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </svg>
  );
}

function SlashActionGlyph() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 6H6.5a2.5 2.5 0 1 1 2.5-2.5V18a2.5 2.5 0 1 1-2.5-2.5H18a2.5 2.5 0 1 1-2.5 2.5V6a2.5 2.5 0 1 1 2.5 2.5H6" />
    </svg>
  );
}
