// In-memory per-channel cache for the workspace session: drafts, loaded message pages, scroll
// position and older-page cursors. Holds no authority and writes nothing to disk.
import type { CreateMessageInput, Message, Run, SubmitTaskResult } from "@openbot/domain";
import { type ComposerAttachment, type ComposerSkill, composeTaskText } from "./composer-context";
import { selectedRecipientIds } from "./recipient-utils";
import { mergeRuns } from "./run-state";

export interface ConversationDraft {
  text: string;
  targetBotId: string;
  targetBotIds?: string[];
  replyTo?: Message | undefined;
  attachments?: ComposerAttachment[];
  skills?: ComposerSkill[];
  revision: number;
}

/**
 * Older pages (LongLists, C18). `cursor` points just before the oldest message loaded so far;
 * `exhausted` means the Server has nothing older.
 */
export interface ConversationHistory {
  cursor?: string | undefined;
  exhausted: boolean;
  loading: boolean;
  error?: string | undefined;
}

/** Messages kept per channel in this session; older pages beyond it are read again on demand. */
export const CONVERSATION_MESSAGE_LIMIT = 1000;

export interface ConversationSnapshot {
  draft: ConversationDraft;
  messages: Message[];
  history: ConversationHistory;
  runs: Run[];
  loading: boolean;
  loadError?: string | undefined;
  sendError?: string | undefined;
  sending: boolean;
  capacityError?: string | undefined;
}

export interface ConversationScroll {
  top: number;
  atBottom: boolean;
}

export interface ConversationChannel {
  getSnapshot(): ConversationSnapshot;
  subscribe(listener: () => void): () => void;
  edit(
    update: Partial<
      Pick<
        ConversationDraft,
        "text" | "targetBotId" | "targetBotIds" | "replyTo" | "attachments" | "skills"
      >
    >,
  ): void;
  merge(messages: Message[], runs?: Run[]): void;
  /** Older messages from a page; never trims the oldest ones away. */
  prepend(messages: Message[]): void;
  setHistory(update: Partial<ConversationHistory>): void;
  loaded(error?: string): void;
  scroll: ConversationScroll;
  send(
    submit: (input: CreateMessageInput) => Promise<SubmitTaskResult>,
  ): Promise<SubmitTaskResult | undefined>;
}

export interface ConversationSession {
  channel(id: string, defaultTarget?: string): ConversationChannel;
  dispose(): void;
}

/** This workspace-lifetime cache contains no authority and never writes transcripts to disk. */
export function createConversationSession(): ConversationSession {
  const channels = new Map<
    string,
    { value: ConversationChannel; retained(): boolean; dispose(): void }
  >();
  let overflow: { id: string; value: ConversationChannel; dispose(): void } | undefined;
  let disposed = false;
  let pendingCount = 0;
  return {
    dispose() {
      disposed = true;
      for (const entry of channels.values()) entry.dispose();
      channels.clear();
      overflow?.dispose();
      overflow = undefined;
    },
    channel(id, defaultTarget = "") {
      if (disposed) throw new Error("此工作空间会话已结束。");
      const existing = channels.get(id);
      if (existing) {
        channels.delete(id);
        channels.set(id, existing);
        return existing.value;
      }
      if (overflow?.id === id) {
        const canRetain = Array.from(channels).some(([, item]) => !item.retained());
        if (!canRetain) return overflow.value;
        overflow.dispose();
        overflow = undefined;
      }
      let capacityError: string | undefined;
      if (channels.size >= 32) {
        const disposable = Array.from(channels).find(([, item]) => !item.retained());
        if (disposable) {
          disposable[1].dispose();
          channels.delete(disposable[0]);
        } else
          capacityError =
            "已保留 32 个频道的草稿。请先发送或清空其他频道的草稿，再返回这里起草消息。";
      }
      const listeners = new Set<() => void>();
      let closed = false;
      let pending: Promise<SubmitTaskResult | undefined> | undefined;
      let state: ConversationSnapshot = {
        draft: { text: "", targetBotId: defaultTarget, revision: 0 },
        messages: [],
        history: { exhausted: false, loading: false },
        runs: [],
        loading: true,
        sending: false,
        capacityError,
      };
      const publish = (update: Partial<ConversationSnapshot>) => {
        if (disposed || closed) return;
        state = { ...state, ...update };
        for (const listener of listeners) listener();
      };
      const value: ConversationChannel = {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        edit(update) {
          if (disposed || closed || capacityError) return;
          const draft = { ...state.draft, ...update, revision: state.draft.revision + 1 };
          // Older single-recipient controls replace a selection rather than leaving hidden recipients.
          if (update.targetBotId !== undefined && update.targetBotIds === undefined)
            draft.targetBotIds = update.targetBotId ? [update.targetBotId] : [];
          let recipients: string[];
          try {
            recipients = selectedRecipientIds(draft);
          } catch (cause) {
            publish({ sendError: cause instanceof Error ? cause.message : "接收 Bot 无效。" });
            return;
          }
          draft.targetBotId = recipients[0] ?? "";
          if (draft.targetBotIds !== undefined) draft.targetBotIds = recipients;
          if (JSON.stringify(recipients) !== JSON.stringify(selectedRecipientIds(state.draft)))
            draft.skills = [];
          draft.text = draft.text.slice(0, 8000);
          publish({ draft });
        },
        merge(messages, runs = []) {
          if (disposed || closed) return;
          const byId = new Map(state.messages.map((message) => [message.id, message]));
          for (const message of messages)
            if (message.channelId === id) byId.set(message.id, message);
          publish({
            messages: Array.from(byId.values())
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              .slice(-CONVERSATION_MESSAGE_LIMIT),
            runs: mergeRuns(
              state.runs,
              runs.filter((run) => run.channelId === id),
            ),
          });
        },
        prepend(messages) {
          if (disposed || closed) return;
          const byId = new Map(state.messages.map((message) => [message.id, message]));
          for (const message of messages)
            if (message.channelId === id) byId.set(message.id, message);
          const sorted = Array.from(byId.values()).sort((a, b) =>
            a.createdAt.localeCompare(b.createdAt),
          );
          // At the limit, the newest are dropped instead: the Owner is reading back in time, and
          // the live sync brings the latest page again when they return.
          publish({ messages: sorted.slice(0, CONVERSATION_MESSAGE_LIMIT) });
        },
        setHistory(update) {
          if (disposed || closed) return;
          publish({ history: { ...state.history, ...update } });
        },
        loaded(error) {
          publish({ loading: false, loadError: error });
        },
        scroll: { top: 0, atBottom: true },
        send(submit) {
          if (disposed || closed || capacityError) return Promise.resolve(undefined);
          if (pending) return pending;
          const sent = state.draft;
          const content = composeTaskText(sent.text, sent.attachments, sent.skills);
          if (!sent.text.trim()) return Promise.resolve(undefined);
          const recipients = selectedRecipientIds(sent);
          if (content.length > 8000) {
            publish({ sendError: "消息与附件合计不能超过 8000 字符，请缩短内容。" });
            return Promise.resolve(undefined);
          }
          if (pendingCount >= 8) {
            publish({ sendError: "已有多条消息正在发送，请稍候再试。" });
            return Promise.resolve(undefined);
          }
          pendingCount += 1;
          publish({ sending: true, sendError: undefined });
          // Capture the draft revision and channel before crossing the asynchronous Server boundary.
          pending = Promise.resolve()
            .then(() =>
              disposed || closed
                ? undefined
                : submit({
                    content,
                    ...(recipients.length > 1
                      ? { botIds: recipients }
                      : recipients.length === 1
                        ? { botId: recipients[0] }
                        : {}),
                    ...(sent.replyTo ? { replyToMessageId: sent.replyTo.id } : {}),
                  }),
            )
            .then((result) => {
              if (disposed || closed || !result) return undefined;
              const receivedRuns = [result.run, ...(result.runs ?? [])];
              if (
                result.message.channelId !== id ||
                receivedRuns.some((run) => run.channelId !== id)
              ) {
                throw new Error("服务返回了不匹配的频道。");
              }
              value.merge([result.message], receivedRuns);
              if (state.draft.revision === sent.revision) {
                publish({
                  draft: {
                    ...state.draft,
                    text: "",
                    attachments: [],
                    skills: [],
                    replyTo: undefined,
                    revision: sent.revision + 1,
                  },
                });
              }
              return result;
            })
            .catch((cause: unknown) => {
              const detail = cause instanceof Error ? cause.message : "网络连接未完成。";
              publish({ sendError: `${detail} 请检查频道记录后再重试；草稿已保留。` });
              return undefined;
            })
            .finally(() => {
              pending = undefined;
              pendingCount -= 1;
              publish({ sending: false });
            });
          return pending;
        },
      };
      const entry = {
        value,
        retained: () =>
          pending !== undefined ||
          listeners.size > 0 ||
          state.draft.text.length > 0 ||
          Boolean(state.draft.attachments?.length) ||
          Boolean(state.draft.skills?.length) ||
          state.draft.replyTo !== undefined,
        dispose() {
          closed = true;
          state = {
            draft: { text: "", targetBotId: "", revision: 0 },
            messages: [],
            history: { exhausted: true, loading: false },
            runs: [],
            loading: false,
            sending: false,
          };
          listeners.clear();
        },
      };
      if (capacityError) {
        overflow?.dispose();
        overflow = { id, value, dispose: entry.dispose };
      } else channels.set(id, entry);
      return value;
    },
  };
}
