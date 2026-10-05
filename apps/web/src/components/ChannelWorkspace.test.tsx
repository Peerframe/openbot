// @vitest-environment jsdom
import type { Bot, Channel, Message, Run, SubmitTaskResult } from "@openbot/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMessage,
  getEmployeeProfile,
  listMessagePage,
  listMessages,
  listRuns,
  subscribeToChannelEvents,
} from "../api";
import { showMessageEvent } from "../composer-events";
import { createConversationSession } from "../conversation-session";
import { listPlugins } from "../plugin-api";
import { deferred, interact, renderComponent } from "../test/render-component";
import { ChannelWorkspace, dateCueLabel } from "./ChannelWorkspace";

vi.mock("../plugin-api", () => ({
  listPlugins: vi.fn(async () => ({ plugins: [], pendingCalls: [] })),
  pluginError: vi.fn(() => "Unavailable"),
}));

vi.mock("../api", () => ({
  createMessage: vi.fn(),
  getEmployeeProfile: vi.fn(),
  getRunOutput: vi.fn(async () => null),
  steerRun: vi.fn(),
  listMessages: vi.fn(),
  listMessagePage: vi.fn(),
  listChannelReactions: vi.fn(async () => []),
  setMessageReaction: vi.fn(async () => []),
  listRuns: vi.fn(),
  subscribeToChannelEvents: vi.fn(() => vi.fn()),
}));
const bot: Bot = {
  id: "bot-a",
  name: "Assistant",
  role: "Research",
  status: "idle",
  computerProfile: "none",
  createdAt: "2026-09-05T00:00:00Z",
};
const callbacks = {
  onJoin: vi.fn(async () => undefined),
  onInspectRun: vi.fn(),
  onOpenBot: vi.fn(),
  onFrame: vi.fn(),
  onProgress: vi.fn(),
  onRun: vi.fn(),
};
const channel = (id: string): Channel => ({
  id,
  name: `Channel ${id}`,
  description: "",
  botIds: [bot.id],
  createdAt: bot.createdAt,
});
const message = (channelId: string, content = "Saved message"): Message => ({
  id: `message-${channelId}-${content}`,
  channelId,
  authorType: "human",
  content,
  createdAt: bot.createdAt,
});
const result = (channelId: string): SubmitTaskResult => {
  const run: Run = {
    id: `run-${channelId}`,
    channelId,
    botId: bot.id,
    executionProfile: "none",
    instruction: "sent",
    title: "sent",
    status: "queued",
    createdAt: bot.createdAt,
    updatedAt: bot.createdAt,
  };
  return { message: message(channelId), run };
};
function view(id: string, session = createConversationSession()) {
  return (
    <ChannelWorkspace
      key={id}
      globalHeader
      channel={channel(id)}
      session={session}
      bots={[bot]}
      artifacts={[]}
      progress={[]}
      {...callbacks}
    />
  );
}
async function typeText(container: HTMLElement, value: string) {
  const input = container.querySelector("textarea") as HTMLTextAreaElement;
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit(container: HTMLElement) {
  await interact(() =>
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
function lastHandlers() {
  const call = vi.mocked(subscribeToChannelEvents).mock.calls.at(-1);
  if (!call) throw new Error("No subscription");
  return call[1];
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listMessages).mockResolvedValue([]);
  vi.mocked(listRuns).mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ChannelWorkspace continuity", () => {
  it("preserves newer draft after send, switches to an independent channel and restores results on return", async () => {
    const session = createConversationSession();
    const response = deferred<SubmitTaskResult>();
    vi.mocked(createMessage).mockReturnValue(response.promise);
    const first = await renderComponent(view("a", session));
    await typeText(first.container, "first draft");
    await submit(first.container);
    await typeText(first.container, "next draft");
    await first.unmount();
    const second = await renderComponent(view("b", session));
    expect((second.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    await typeText(second.container, "B draft");
    await interact(() => response.resolve(result("a")));
    expect(second.container.textContent).not.toContain("Saved message");
    expect((second.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "B draft",
    );
    expect(callbacks.onRun).not.toHaveBeenCalled();
    await second.unmount();
    const restored = await renderComponent(view("a", session));
    expect((restored.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "next draft",
    );
    expect(restored.container.textContent).toContain("Saved message");
    expect(vi.mocked(createMessage)).toHaveBeenCalledTimes(1);
    await restored.unmount();
  });
  it("ignores late reads and callbacks after unmount, even when the transport ignores abort", async () => {
    const session = createConversationSession();
    const read = deferred<Message[]>();
    vi.mocked(listMessages).mockReturnValueOnce(read.promise);
    const first = await renderComponent(view("a", session));
    const stale = lastHandlers();
    await first.unmount();
    const next = await renderComponent(view("b", session));
    await interact(() => {
      stale.onMessage(message("a", "stale event"));
      stale.onRun(result("a").run, []);
      read.resolve([message("a", "stale read")]);
    });
    expect(session.channel("a").getSnapshot().messages).toHaveLength(0);
    expect(next.container.textContent).not.toContain("stale");
    expect(callbacks.onRun).not.toHaveBeenCalled();
    await next.unmount();
  });
  it("keeps the send failure visible after a successful reconnect read", async () => {
    vi.mocked(listMessages).mockRejectedValueOnce(new Error("History unavailable"));
    vi.mocked(createMessage).mockRejectedValueOnce(new Error("Send unavailable"));
    const rendered = await renderComponent(view("a"));
    expect(rendered.container.querySelector(".conversation-load-error")?.textContent).toContain(
      "History unavailable",
    );
    await typeText(rendered.container, "keep draft");
    await submit(rendered.container);
    await interact(() => lastHandlers().onReady());
    expect(rendered.container.querySelector(".conversation-load-error")).toBeNull();
    expect(rendered.container.querySelector(".composer-error")?.textContent).toContain(
      "Send unavailable",
    );
    expect((rendered.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "keep draft",
    );
    await rendered.unmount();
  });
  it("does not treat composition, Shift+Enter or Alt+Enter as submission", async () => {
    const rendered = await renderComponent(view("a"));
    const form = rendered.container.querySelector("form") as HTMLFormElement;
    const request = vi.spyOn(form, "requestSubmit").mockImplementation(() => undefined);
    const input = rendered.container.querySelector("textarea") as HTMLTextAreaElement;
    for (const flags of [
      { isComposing: true },
      { shiftKey: true },
      { altKey: true },
      { keyCode: 229 },
    ]) {
      await interact(() =>
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...flags }),
        ),
      );
    }
    expect(request).not.toHaveBeenCalled();
    await interact(() =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(request).toHaveBeenCalledTimes(1);
    await rendered.unmount();
  });
  it("preserves a reading position when new messages arrive and offers an explicit jump", async () => {
    const session = createConversationSession();
    session.channel("a", bot.id).merge([message("a")]);
    const rendered = await renderComponent(view("a", session));
    const log = rendered.container.querySelector('[role="log"]') as HTMLDivElement;
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 400 },
    });
    await interact(() => {
      log.scrollTop = 140;
      log.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await interact(() =>
      lastHandlers().onMessage({
        ...message("a", "new message"),
        authorType: "bot",
        authorId: bot.id,
      }),
    );
    expect(log.scrollTop).toBe(140);
    const latest = rendered.container.querySelector(".conversation-latest") as HTMLButtonElement;
    expect(latest?.textContent).toBe("↓ 回到最新 · 1 条新消息");
    await interact(() => latest.click());
    expect(session.channel("a").scroll.atBottom).toBe(true);
    expect(log.scrollTop).toBe(1200);
    expect(rendered.container.querySelector(".conversation-latest")).toBeNull();
    await rendered.unmount();
  });
  it("does not save hidden geometry and restores the reading position when settings closes", async () => {
    const observers = new Map<Element, () => void>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
        }
        observe(target: Element) {
          observers.set(target, this.callback);
        }
        disconnect() {}
      },
    );
    const session = createConversationSession();
    session.channel("a", bot.id).merge([message("a")]);
    const rendered = await renderComponent(view("a", session));
    const log = rendered.container.querySelector('[role="log"]') as HTMLDivElement;
    let height = 400;
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, get: () => (height === 0 ? 0 : 1400) },
      clientHeight: { configurable: true, get: () => height },
    });
    await interact(() => observers.get(log)?.());
    await interact(() => {
      log.scrollTop = 170;
      log.dispatchEvent(new Event("scroll"));
    });
    await interact(() => {
      height = 0;
      observers.get(log)?.();
      log.scrollTop = 0;
      log.dispatchEvent(new Event("scroll"));
    });
    await interact(() => lastHandlers().onMessage(message("a", "arrived while hidden")));
    expect(session.channel("a").scroll).toEqual({ top: 170, atBottom: false });
    await interact(() => {
      height = 400;
      observers.get(log)?.();
    });
    expect(log.scrollTop).toBe(170);
    await rendered.unmount();
  });
  it("follows the latest messages through viewport resize without mistaking layout scroll for user intent", async () => {
    const observers = new Map<Element, () => void>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
        }
        observe(target: Element) {
          observers.set(target, this.callback);
        }
        disconnect() {}
      },
    );
    const session = createConversationSession();
    session.channel("a", bot.id).merge([message("a")]);
    const rendered = await renderComponent(view("a", session));
    const log = rendered.container.querySelector('[role="log"]') as HTMLDivElement;
    let width = 900;
    let height = 700;
    let content = 1300;
    let top = 0;
    Object.defineProperties(log, {
      clientWidth: { configurable: true, get: () => width },
      clientHeight: { configurable: true, get: () => height },
      scrollHeight: { configurable: true, get: () => content },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, content - height));
        },
      },
    });
    await interact(() => observers.get(log)?.());
    expect(log.scrollTop).toBe(600);
    await interact(() => {
      width = 520;
      height = 400;
      content = 1900;
      log.scrollTop = 0;
      log.dispatchEvent(new Event("scroll"));
    });
    expect(session.channel("a").scroll.atBottom).toBe(true);
    await interact(() => observers.get(log)?.());
    expect(log.scrollTop).toBe(1500);
    expect(rendered.container.querySelector(".conversation-latest")).toBeNull();
    await interact(() => {
      log.scrollTop = 170;
      log.dispatchEvent(new Event("scroll"));
    });
    await interact(() => {
      width = 840;
      height = 600;
      content = 1400;
      observers.get(log)?.();
    });
    expect(log.scrollTop).toBe(170);
    expect(session.channel("a").scroll.atBottom).toBe(false);
    expect(rendered.container.querySelector(".conversation-latest")).not.toBeNull();
    await rendered.unmount();
  });
});

describe("ChannelWorkspace recipient and attachment interactions", () => {
  const secondBot: Bot = { ...bot, id: "bot-b", name: "Coder" };
  const outsider: Bot = { ...bot, id: "outsider", name: "Outside" };
  function multi(session = createConversationSession()) {
    return (
      <ChannelWorkspace
        globalHeader
        channel={{ ...channel("a"), botIds: [bot.id, secondBot.id] }}
        session={session}
        bots={[bot, secondBot, outsider]}
        artifacts={[]}
        progress={[]}
        {...callbacks}
      />
    );
  }
  it("adds two Bot recipients and sends one request while publishing every returned task", async () => {
    const primary = result("a");
    const secondRun = { ...primary.run, id: "run-coder", botId: secondBot.id };
    vi.mocked(createMessage).mockResolvedValue({ ...primary, runs: [primary.run, secondRun] });
    const rendered = await renderComponent(multi());
    try {
      await typeText(rendered.container, "Review @Assistant");
      await interact(() =>
        rendered.container.querySelector<HTMLButtonElement>("#mention-bot-a")?.click(),
      );
      await typeText(rendered.container, "Review @Coder");
      await interact(() =>
        rendered.container.querySelector<HTMLButtonElement>("#mention-bot-b")?.click(),
      );
      expect(rendered.container.querySelectorAll(".composer-mention")).toHaveLength(2);
      await submit(rendered.container);
      expect(createMessage).toHaveBeenCalledTimes(1);
      expect(createMessage).toHaveBeenCalledWith("a", {
        content: "Review",
        botIds: [bot.id, secondBot.id],
      });
      expect(callbacks.onRun.mock.calls.map(([run]) => run.id)).toEqual([
        primary.run.id,
        secondRun.id,
      ]);
      expect(rendered.container.querySelectorAll(".task-card")).toHaveLength(2);
    } finally {
      await rendered.unmount();
    }
  });
  it("selects a recipient at the caret without losing the remaining draft", async () => {
    vi.mocked(createMessage).mockResolvedValue(result("a"));
    const rendered = await renderComponent(multi());
    try {
      await typeText(rendered.container, "Review @Coder carefully");
      const input = rendered.container.querySelector("textarea") as HTMLTextAreaElement;
      await interact(() => {
        input.focus();
        input.setSelectionRange(10, 10);
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      });
      expect(rendered.container.querySelector("#mention-bot-b")).not.toBeNull();
      await interact(() =>
        rendered.container.querySelector<HTMLButtonElement>("#mention-bot-b")?.click(),
      );
      expect(input.value).toBe("Review carefully");
      expect(input.selectionStart).toBe(6);
      await submit(rendered.container);
      expect(createMessage).toHaveBeenCalledWith("a", {
        content: "Review carefully",
        botId: "bot-b",
      });
    } finally {
      await rendered.unmount();
    }
  });
  it("sends a group message without @ for Server-owned routing", async () => {
    vi.mocked(createMessage).mockResolvedValue(result("a"));
    const rendered = await renderComponent(multi());
    try {
      await typeText(rendered.container, "Please coordinate this work");
      expect(rendered.container.querySelector<HTMLButtonElement>(".composer-send")?.disabled).toBe(
        false,
      );
      await submit(rendered.container);
      expect(createMessage).toHaveBeenCalledWith("a", { content: "Please coordinate this work" });
    } finally {
      await rendered.unmount();
    }
  });
  it("selects everyone from the actual channel membership without including an outside Bot", async () => {
    vi.mocked(createMessage).mockResolvedValue(result("a"));
    const rendered = await renderComponent(multi());
    try {
      await typeText(rendered.container, "Coordinate @everyone");
      await interact(() =>
        rendered.container.querySelector<HTMLButtonElement>(".mention-everyone")?.click(),
      );
      expect(rendered.container.querySelectorAll(".composer-mention")).toHaveLength(2);
      await submit(rendered.container);
      expect(createMessage).toHaveBeenCalledWith("a", {
        content: "Coordinate",
        botIds: [bot.id, secondBot.id],
      });
    } finally {
      await rendered.unmount();
    }
  });
  it("chooses everyone with Enter as a recipient action without prematurely sending", async () => {
    const session = createConversationSession();
    const rendered = await renderComponent(multi(session));
    try {
      await typeText(rendered.container, "Coordinate @");
      const input = rendered.container.querySelector("textarea");
      await interact(() =>
        input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
      expect(session.channel("a").getSnapshot().draft).toMatchObject({
        text: "Coordinate",
        targetBotIds: [bot.id, secondBot.id],
      });
      expect(createMessage).not.toHaveBeenCalled();
      expect(rendered.container.querySelector('[role="listbox"]')).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });
  it("addresses a replied Bot and navigates an existing quote to its exact source", async () => {
    const source: Message = {
      ...message("a", "Coder result"),
      authorType: "bot",
      authorId: secondBot.id,
    };
    // A message in between keeps the quote: replies to the message directly above show none.
    const between = message("a", "Unrelated note");
    const quoted: Message = { ...message("a", "Follow-up"), replyToMessageId: source.id };
    vi.mocked(listMessages).mockResolvedValue([source, between, quoted]);
    vi.mocked(createMessage).mockResolvedValue(result("a"));
    const session = createConversationSession();
    const rendered = await renderComponent(multi(session));
    try {
      await interact(() =>
        rendered.container
          .querySelector<HTMLButtonElement>('.message-row.bot [aria-label="回复"]')
          ?.click(),
      );
      expect(session.channel("a").getSnapshot().draft).toMatchObject({
        targetBotIds: [secondBot.id],
        replyTo: source,
      });
      expect(document.activeElement).toBe(rendered.container.querySelector("textarea"));
      await typeText(rendered.container, "Please explain");
      await submit(rendered.container);
      expect(createMessage).toHaveBeenCalledWith("a", {
        content: "Please explain",
        botId: secondBot.id,
        replyToMessageId: source.id,
      });
      const sourceRow = document.getElementById(`channel-message-${source.id}`);
      if (!sourceRow) throw new Error("Source message missing");
      const scrollIntoView = vi.fn();
      sourceRow.scrollIntoView = scrollIntoView;
      await interact(() =>
        rendered.container.querySelector<HTMLButtonElement>(".message-quote")?.click(),
      );
      // Telegram-like: the quote glides to its source and flashes it once.
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
      expect(sourceRow.classList.contains("is-flash")).toBe(true);
      expect(document.activeElement).toBe(sourceRow);
      expect(session.channel("a").scroll.atBottom).toBe(false);
    } finally {
      await rendered.unmount();
    }
  });
  it("does not quote a reply to the message directly above it", async () => {
    const asked = message("a", "Sum 7 and 13");
    const reply: Message = {
      ...message("a", "SUM: 20"),
      authorType: "bot",
      authorId: secondBot.id,
      replyToMessageId: asked.id,
    };
    vi.mocked(listMessages).mockResolvedValue([asked, reply]);
    const rendered = await renderComponent(multi(createConversationSession()));
    try {
      await interact(() => undefined);
      expect(rendered.container.textContent).toContain("SUM: 20");
      expect(rendered.container.querySelector(".message-quote")).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });
  it("chooses only channel members using @ and submits the chosen structured id", async () => {
    vi.mocked(createMessage).mockResolvedValue(result("a"));
    const session = createConversationSession();
    const rendered = await renderComponent(multi(session));
    try {
      await typeText(rendered.container, "Review @");
      const choices = rendered.container.querySelectorAll('[role="option"]');
      expect(choices).toHaveLength(3);
      expect(rendered.container.querySelector('[role="listbox"]')?.textContent).not.toContain(
        "Outside",
      );
      await interact(() =>
        rendered.container.querySelector<HTMLButtonElement>("#mention-bot-b")?.click(),
      );
      expect(session.channel("a").getSnapshot().draft).toMatchObject({
        text: "Review",
        targetBotId: "bot-b",
      });
      expect(rendered.container.querySelector(".composer-mention")?.textContent).toContain("Coder");
      expect(rendered.container.querySelector(".message-composer select")).toBeNull();
      await submit(rendered.container);
      expect(createMessage).toHaveBeenCalledWith("a", { content: "Review", botId: "bot-b" });
    } finally {
      await rendered.unmount();
    }
  });
  it("lists channel Bots' reviewed skills under / and addresses the chosen skill's Bot", async () => {
    const skill = (id: string, name: string, state: "verified" | "candidate") => ({
      id,
      slug: id,
      name,
      description: `${name} 的说明`,
      version: "1.0.0",
      source: "learned" as const,
      state,
      confidence: 1,
      requiredCapabilities: [],
      dependencyIds: [],
      evidence: [],
      acquiredAt: bot.createdAt,
      updatedAt: bot.createdAt,
    });
    vi.mocked(getEmployeeProfile).mockImplementation(async (id: string) => {
      const owner = id === secondBot.id ? secondBot : bot;
      return {
        employee: owner,
        skills: [
          skill(`${id}-ok`, id === secondBot.id ? "周报整理" : "资料检索", "verified"),
          skill(`${id}-new`, "未审核技能", "candidate"),
        ],
      } as unknown as Awaited<ReturnType<typeof getEmployeeProfile>>;
    });
    const session = createConversationSession();
    const rendered = await renderComponent(multi(session));
    try {
      await typeText(rendered.container, "/");
      await interact(() => undefined);
      const listbox = () => rendered.container.querySelector(".slash-options");
      // Without a recipient every channel Bot's verified skills are offered, candidates never.
      expect(getEmployeeProfile).toHaveBeenCalledWith("bot-a", expect.any(AbortSignal));
      expect(getEmployeeProfile).toHaveBeenCalledWith("bot-b", expect.any(AbortSignal));
      const options = () => Array.from(listbox()?.querySelectorAll('[role="option"]') ?? []);
      expect(options().map((option) => option.textContent)).toEqual([
        expect.stringContaining("资料检索"),
        expect.stringContaining("周报整理"),
      ]);
      expect(listbox()?.textContent).toContain("Coder · 周报整理 的说明");
      expect(listbox()?.textContent).not.toContain("未审核技能");
      // No slash actions are listed when the host supplies none.
      expect(listbox()?.textContent).not.toContain("操作");

      await typeText(rendered.container, "Review /周报");
      await interact(() => undefined);
      expect(options()).toHaveLength(1);
      await interact(() => (options()[0] as HTMLButtonElement).click());
      expect(listbox()).toBeNull();
      expect(session.channel("a").getSnapshot().draft).toMatchObject({
        text: "Review",
        targetBotIds: [secondBot.id],
        skills: [{ id: "bot-b-ok", name: "周报整理", version: "1.0.0" }],
      });
    } finally {
      await rendered.unmount();
    }
  });
  it("offers the design's slash actions when the host supplies them", async () => {
    vi.mocked(getEmployeeProfile).mockResolvedValue({
      employee: bot,
      skills: [],
    } as unknown as Awaited<ReturnType<typeof getEmployeeProfile>>);
    const members = vi.fn();
    const routine = vi.fn();
    const settings = vi.fn();
    const hosts = vi.fn();
    const rendered = await renderComponent(
      <ChannelWorkspace
        globalHeader
        channel={{ ...channel("a"), botIds: [bot.id, secondBot.id] }}
        bots={[bot, secondBot]}
        artifacts={[]}
        progress={[]}
        {...callbacks}
        onOpenMembers={members}
        onNewRoutine={routine}
        onOpenSettings={settings}
        onOpenHosts={hosts}
      />,
    );
    try {
      await typeText(rendered.container, "/");
      await interact(() => undefined);
      const labels = Array.from(
        rendered.container.querySelectorAll('.slash-options [role="option"]'),
      ).map((option) => option.textContent);
      expect(labels).toEqual([
        expect.stringContaining("成员"),
        expect.stringContaining("新建例行任务"),
        expect.stringContaining("设置：通用"),
        expect.stringContaining("设置：工作主机"),
      ]);
      await typeText(rendered.container, "/设置：通");
      await interact(() =>
        rendered.container
          .querySelector<HTMLButtonElement>('.slash-options [role="option"]')
          ?.click(),
      );
      expect(settings).toHaveBeenCalledWith("general");
      expect(rendered.container.querySelector("textarea")?.value).toBe("");
    } finally {
      await rendered.unmount();
    }
  });
  it("does not send an unresolved @ mention to the previous recipient", async () => {
    const session = createConversationSession();
    session.channel("a", bot.id);
    const rendered = await renderComponent(multi(session));
    try {
      await typeText(rendered.container, "Review @unknown");
      expect(
        rendered.container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
      ).toBe(true);
      await submit(rendered.container);
      expect(createMessage).not.toHaveBeenCalled();
      expect(session.channel("a").getSnapshot().draft.text).toBe("Review @unknown");
    } finally {
      await rendered.unmount();
    }
  });
  it("keeps an explicitly removed recipient empty for default channel routing", async () => {
    const session = createConversationSession();
    const rendered = await renderComponent(view("a", session));
    try {
      await interact(() =>
        rendered.container
          .querySelector<HTMLButtonElement>('[aria-label="移除接收 Bot Assistant"]')
          ?.click(),
      );
      expect(session.channel("a").getSnapshot().draft.targetBotId).toBe("");
      expect(rendered.container.querySelector(".composer-mention")).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });
  it("retains a removed recipient and blocks submission rather than silently using default routing", async () => {
    const session = createConversationSession();
    session.channel("a", secondBot.id).edit({
      text: "Unsent work",
      skills: [{ id: "skill-b", name: "Coding", version: "1" }],
      attachments: [{ name: "brief.md", text: "Instructions" }],
    });
    const rendered = await renderComponent(view("a", session));
    try {
      expect(session.channel("a").getSnapshot().draft).toMatchObject({
        targetBotId: secondBot.id,
        text: "Unsent work",
        attachments: [{ name: "brief.md", text: "Instructions" }],
      });
      expect(rendered.container.querySelector(".composer-mention")?.textContent).toContain(
        "已离开的 Bot",
      );
      expect(rendered.container.querySelector<HTMLButtonElement>(".composer-send")?.disabled).toBe(
        true,
      );
      await submit(rendered.container);
      expect(createMessage).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });
  it("does not select a mention while an IME confirms text", async () => {
    const session = createConversationSession();
    const rendered = await renderComponent(multi(session));
    try {
      await typeText(rendered.container, "Review @");
      const textarea = rendered.container.querySelector("textarea");
      await interact(() =>
        textarea?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }),
        ),
      );
      expect(session.channel("a").getSnapshot().draft.targetBotId).toBe("");
      expect(rendered.container.querySelector('[role="listbox"]')).not.toBeNull();
      expect(createMessage).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });
  it("blocks a ninth attachment and keeps selected context after transport failure", async () => {
    const session = createConversationSession();
    const attachments = Array.from({ length: 8 }, (_, index) => `${index}.md`).map((name) => ({
      name,
      text: "Review",
    }));
    session.channel("a", bot.id).edit({
      text: "keep draft",
      attachments,
      skills: [{ id: "skill-a", name: "Review", version: "1" }],
    });
    vi.mocked(createMessage).mockRejectedValue(new Error("offline"));
    const rendered = await renderComponent(view("a", session));
    try {
      const input = rendered.container.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input) throw new Error("Attachment input missing");
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [new File(["nine"], "nine.md")],
      });
      await interact(() => input.dispatchEvent(new Event("change", { bubbles: true })));
      expect(rendered.container.textContent).toContain("最多添加 8 个附件");
      expect(session.channel("a").getSnapshot().draft.attachments).toEqual(attachments);
      await submit(rendered.container);
      expect(session.channel("a").getSnapshot().draft).toMatchObject({
        attachments,
        skills: [{ id: "skill-a", name: "Review", version: "1" }],
      });
      expect(rendered.container.textContent).toContain("offline");
    } finally {
      await rendered.unmount();
    }
  });
});

describe("ChannelWorkspace delegated identities", () => {
  it("groups consecutive same-author messages and separates a later conversation", async () => {
    const first: Message = { ...message("a", "First answer"), authorType: "bot", authorId: bot.id };
    const continuation: Message = {
      ...first,
      id: "continuation",
      content: "More detail",
      createdAt: "2026-09-05T00:01:00Z",
    };
    const later: Message = {
      ...first,
      id: "later",
      content: "A later answer",
      createdAt: "2026-09-05T00:10:00Z",
    };
    vi.mocked(listMessages).mockResolvedValue([first, continuation, later]);
    const rendered = await renderComponent(view("a"));
    try {
      const rows = rendered.container.querySelectorAll(".message-row");
      expect(rows[0]?.classList.contains("group-start")).toBe(true);
      expect(rows[0]?.classList.contains("group-end")).toBe(false);
      expect(rows[1]?.classList.contains("group-continuation")).toBe(true);
      expect(rows[1]?.classList.contains("group-end")).toBe(true);
      expect(rows[2]?.classList.contains("group-start")).toBe(true);
      expect(rendered.container.querySelectorAll(".message-time-divider")).toHaveLength(2);
      expect(rows[1]?.textContent).toContain("More detail");
    } finally {
      await rendered.unmount();
    }
  });
  it("shows every live or failed task inline and keeps queued supplementary messages distinct", async () => {
    const running: Run = {
      ...result("a").run,
      id: "running",
      status: "running",
      title: "Researching",
    };
    const queued: Run = {
      ...running,
      id: "queued",
      status: "queued",
      title: "Supplementary task",
      createdAt: "2026-09-05T00:01:00Z",
    };
    const failed: Run = {
      ...running,
      id: "failed",
      status: "failed",
      title: "Failed work",
      errorCode: "model_credentials",
      errorMessage: "synthetic-provider-raw-error",
    };
    const complete: Run = {
      ...running,
      id: "complete",
      status: "completed",
      title: "Finished work",
    };
    vi.mocked(listRuns).mockResolvedValue([running, queued, failed, complete]);
    const rendered = await renderComponent(view("a"));
    try {
      expect(rendered.container.querySelector(".active-task-strip")).toBeNull();
      const log = rendered.container.querySelector('[role="log"]');
      // A finished task without a reply keeps its card; the others are live or failed.
      expect(log?.querySelectorAll(".task-card")).toHaveLength(4);
      expect(log?.querySelector(".task-card.is-running")?.textContent).toContain("Researching");
      expect(log?.querySelector(".task-card.is-queued")?.textContent).toContain(
        "等待接续 · Supplementary task",
      );
      expect(log?.querySelector(".task-card.is-failed")?.textContent).toContain("模型密钥被拒绝");
      expect(rendered.container.textContent).not.toContain("synthetic-provider-raw-error");
      expect(rendered.container.querySelectorAll(".task-spin")).toHaveLength(1);
      await interact(() =>
        rendered.container
          .querySelector<HTMLButtonElement>(".task-card.is-failed .task-link")
          ?.click(),
      );
      expect(callbacks.onInspectRun).toHaveBeenCalledWith(failed.id);
      await typeText(rendered.container, "Next independent task");
      expect(rendered.container.querySelector<HTMLButtonElement>(".composer-send")?.disabled).toBe(
        false,
      );
    } finally {
      await rendered.unmount();
    }
  });
  it("keeps historical failures out of current activity after a newer request completes", async () => {
    const previous: Run = {
      ...result("a").run,
      id: "previous-failure",
      status: "failed",
      createdAt: "2026-09-04T00:00:00Z",
    };
    const completed: Run = {
      ...previous,
      id: "later-completed",
      status: "completed",
      createdAt: "2026-09-05T00:00:00Z",
    };
    vi.mocked(listRuns).mockResolvedValue([
      previous,
      { ...previous, id: "previous-cancelled", status: "cancelled" },
      completed,
    ]);
    const rendered = await renderComponent(view("a"));
    try {
      expect(rendered.container.querySelector(".task-card.is-failed")).toBeNull();
      expect(rendered.container.querySelector(".task-card.is-cancelled")).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });
  it("renders sender and recipient independently and attaches output only to its producing Bot", async () => {
    const recipient: Bot = { ...bot, id: "researcher", name: "Researcher" };
    const parent: Run = { ...result("a").run, id: "parent", sourceMessageId: "request" };
    const child: Run = {
      ...parent,
      id: "child",
      botId: recipient.id,
      parentRunId: parent.id,
      rootRunId: parent.id,
      delegatedByBotId: bot.id,
      sourceMessageId: "delegation",
      status: "completed",
    };
    const delegation: Message = {
      ...message("a", "Please verify sources"),
      id: "delegation",
      authorType: "bot",
      authorId: bot.id,
      runId: child.id,
    };
    const answer: Message = {
      ...delegation,
      id: "answer",
      authorId: recipient.id,
      content: "Sources verified",
    };
    vi.mocked(listMessages).mockResolvedValue([delegation, answer]);
    vi.mocked(listRuns).mockResolvedValue([parent, child]);
    const rendered = await renderComponent(
      <ChannelWorkspace
        channel={{ ...channel("a"), botIds: [bot.id, recipient.id] }}
        bots={[bot, recipient]}
        artifacts={[
          {
            id: "report",
            runId: child.id,
            name: "sources.md",
            mediaType: "text/markdown",
            sha256: "a".repeat(64),
            sizeBytes: 10,
            createdAt: bot.createdAt,
          },
        ]}
        progress={[]}
        {...callbacks}
      />,
    );
    try {
      const rows = rendered.container.querySelectorAll(".message-row");
      expect(rows[0]?.querySelector("header strong")?.textContent).toBe(bot.name);
      expect(rows[1]?.querySelector("header strong")?.textContent).toBe(recipient.name);
      expect(rows[0]?.querySelector(".delegation-notice")?.textContent).toContain(recipient.name);
      expect(rows[1]?.querySelector(".delegated-reply-context")?.textContent).toContain(bot.name);
      expect(rows[0]?.querySelector(".message-artifacts")).toBeNull();
      expect(rows[1]?.querySelector(".message-artifacts")?.textContent).toContain("sources.md");
      await interact(() =>
        rows[1]?.querySelector<HTMLButtonElement>(".delegated-reply-context button")?.click(),
      );
      expect(callbacks.onInspectRun).toHaveBeenCalledWith(parent.id);
    } finally {
      await rendered.unmount();
    }
  });
});

describe("23e: older pages, banners and the date cue", () => {
  const stamp = (index: number) => new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString();
  const numbered = (index: number): Message => ({
    ...message("a", `m${index}`),
    id: `m${String(index).padStart(3, "0")}`,
    createdAt: stamp(index),
  });

  // A full latest page (100) is what makes the UI ask for older ones; rendering it in jsdom can
  // pass Vitest's default 5 s when the whole suite runs in parallel.
  it("reads the page before the oldest message at the top and keeps the reading position", {
    timeout: 20_000,
  }, async () => {
    const latest = Array.from({ length: 100 }, (_, index) => numbered(index + 10));
    vi.mocked(listMessages).mockResolvedValue(latest);
    vi.mocked(listMessagePage)
      .mockResolvedValueOnce({ messages: latest, hasMore: true, nextCursor: "c-latest" })
      .mockResolvedValueOnce({
        messages: Array.from({ length: 10 }, (_, index) => numbered(index)),
        hasMore: false,
      });
    const session = createConversationSession();
    const rendered = await renderComponent(view("a", session));
    const log = rendered.container.querySelector('[role="log"]') as HTMLDivElement;
    let height = 5000;
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 400 },
    });
    await interact(async () => {
      height = 7500;
      log.scrollTop = 10;
      log.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await interact(async () => undefined);
    expect(vi.mocked(listMessagePage).mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["a"],
      ["a", "c-latest"],
    ]);
    expect(session.channel("a").getSnapshot().messages).toHaveLength(110);
    expect(session.channel("a").getSnapshot().history.exhausted).toBe(true);
    await rendered.unmount();
  });

  it("jumps to a referenced message, reading an older page when it is not loaded", async () => {
    const latest = Array.from({ length: 100 }, (_, index) => numbered(index + 10));
    vi.mocked(listMessages).mockResolvedValue(latest);
    vi.mocked(listMessagePage)
      .mockResolvedValueOnce({ messages: latest, hasMore: true, nextCursor: "c-latest" })
      .mockResolvedValueOnce({
        messages: Array.from({ length: 10 }, (_, index) => numbered(index)),
        hasMore: false,
      });
    const session = createConversationSession();
    const rendered = await renderComponent(view("a", session));
    await interact(() =>
      window.dispatchEvent(
        new CustomEvent(showMessageEvent, { detail: { channelId: "a", messageId: "m003" } }),
      ),
    );
    // Reading the older page and scrolling take a few ticks; wait for the result, not a fixed delay.
    await vi.waitFor(
      async () => {
        await interact(async () => undefined);
        expect(document.activeElement?.id).toBe("channel-message-m003");
      },
      { timeout: 5_000, interval: 20 },
    );
    expect(listMessagePage).toHaveBeenCalledTimes(2);
    // Another channel's request is ignored.
    await interact(() =>
      window.dispatchEvent(
        new CustomEvent(showMessageEvent, { detail: { channelId: "b", messageId: "m050" } }),
      ),
    );
    expect(document.activeElement?.id).toBe("channel-message-m003");
    await rendered.unmount();
  }, 20_000);

  it("does not ask for older pages when the latest page already holds everything", async () => {
    vi.mocked(listMessages).mockResolvedValue([numbered(1), numbered(2)]);
    const session = createConversationSession();
    const rendered = await renderComponent(view("a", session));
    const log = rendered.container.querySelector('[role="log"]') as HTMLDivElement;
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 400 },
    });
    await interact(() => {
      log.scrollTop = 0;
      log.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(listMessagePage).not.toHaveBeenCalled();
    await rendered.unmount();
  });

  it("shows the reconnect banner while retrying, and 立即重连 restarts the connection", async () => {
    const rendered = await renderComponent(view("a"));
    await interact(() => lastHandlers().onState("retrying"));
    const banner = rendered.container.querySelector(".conversation-banner.is-warning");
    expect(banner?.textContent).toContain("草稿不会丢");
    const calls = vi.mocked(subscribeToChannelEvents).mock.calls.length;
    const reconnect = banner?.querySelector("button");
    if (!reconnect) throw new Error("No 立即重连");
    await interact(() => reconnect.click());
    expect(vi.mocked(subscribeToChannelEvents).mock.calls.length).toBe(calls + 1);
    await interact(() => lastHandlers().onState("live"));
    expect(rendered.container.querySelector(".conversation-banner")).toBeNull();
    await rendered.unmount();
  });

  it("labels the date cue as 今天, 昨天 or the day with its weekday", () => {
    const now = new Date(2026, 9, 3, 12);
    expect(dateCueLabel(new Date(2026, 9, 3, 8).toISOString(), now)).toBe("今天");
    expect(dateCueLabel(new Date(2026, 9, 2, 8).toISOString(), now)).toBe("昨天");
    expect(dateCueLabel(new Date(2026, 8, 25, 8).toISOString(), now)).toBe("9 月 25 日 · 周五");
  });
});

describe("composer popovers (owner feedback 2026-10-03)", () => {
  it("closes the 「+」 menu on a press outside it", async () => {
    const rendered = await renderComponent(view("a"));
    const menu = rendered.container.querySelector<HTMLDetailsElement>(".composer-add-menu");
    if (!menu) throw new Error("No 「+」 menu");
    await interact(() => {
      menu.open = true;
    });
    await interact(() =>
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
    );
    expect(menu.open).toBe(false);
    await rendered.unmount();
  });

  it("lists plugins under @: a connected one is written in, an ungranted one opens the panel", async () => {
    const plugin = (id: string, name: string, granted: boolean) => ({
      id,
      name,
      endpoint: `https://plugins.example.test/${id}`,
      tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
      digest: "0".repeat(64),
      revision: "00000000-0000-4000-8000-000000000001",
      enabled: true,
      createdAt: bot.createdAt,
      grants: granted
        ? [{ botId: bot.id, tools: [{ name: "search", mode: "read" as const }] }]
        : [],
    });
    vi.mocked(listPlugins).mockResolvedValue({
      plugins: [plugin("github", "GitHub", true), plugin("gmail", "Gmail", false)],
      pendingCalls: [],
    } as never);
    const onOpenPlugins = vi.fn();
    const rendered = await renderComponent(
      <ChannelWorkspace
        globalHeader
        channel={channel("a")}
        session={createConversationSession()}
        bots={[bot]}
        artifacts={[]}
        progress={[]}
        onOpenPlugins={onOpenPlugins}
        {...callbacks}
      />,
    );
    await typeText(rendered.container, "Check this @");
    await interact(async () => undefined);
    const github = rendered.container.querySelector<HTMLButtonElement>("#mention-plugin-github");
    const gmail = rendered.container.querySelector<HTMLButtonElement>("#mention-plugin-gmail");
    expect(github?.textContent).toContain("已连接");
    expect(gmail?.textContent).toContain("需要授权");
    // Rows are one line: no role text under the Bot's name.
    expect(rendered.container.querySelector(`#mention-${bot.id} small`)).toBeNull();
    await interact(() => github?.click());
    const input = rendered.container.querySelector("textarea") as HTMLTextAreaElement;
    expect(input.value).toBe("Check this @GitHub ");
    await typeText(rendered.container, "Check this @GitHub and @Gm");
    await interact(async () => undefined);
    await interact(() =>
      rendered.container.querySelector<HTMLButtonElement>("#mention-plugin-gmail")?.click(),
    );
    expect(onOpenPlugins).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("Check this @GitHub and @Gm");
    await rendered.unmount();
  });
});

describe("Telegram-like arrival", () => {
  it("slides in messages that arrive while open, not the history it opened with", async () => {
    vi.mocked(listMessages).mockResolvedValue([message("a", "Earlier")]);
    const rendered = await renderComponent(view("a"));
    await interact(async () => undefined);
    const rows = () => [...rendered.container.querySelectorAll(".message-row")];
    expect(rows().some((row) => row.classList.contains("is-arriving"))).toBe(false);
    await interact(() =>
      lastHandlers().onMessage({
        ...message("a", "Just now"),
        id: "message-new",
        authorType: "bot",
        authorId: bot.id,
        createdAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    expect(document.getElementById("channel-message-message-new")?.classList).toContain(
      "is-arriving",
    );
    expect(
      document
        .getElementById("channel-message-message-a-Earlier")
        ?.classList.contains("is-arriving"),
    ).toBe(false);
    await rendered.unmount();
  });
});

describe("new-Bot greeting (C11)", () => {
  it("keeps the role card under the Server's greeting until the Owner speaks", async () => {
    const fresh: Bot = { ...bot, id: "bot-new", name: "新建 Bot", role: "通用助手" };
    vi.mocked(listMessages).mockResolvedValue([
      {
        ...message("d", "嗨，我刚上岗，你希望我负责哪一块？"),
        authorType: "bot",
        authorId: fresh.id,
        origin: "greeting",
      },
    ]);
    const rendered = await renderComponent(
      <ChannelWorkspace
        globalHeader
        channel={{ ...channel("d"), botIds: [fresh.id], directBotId: fresh.id }}
        session={createConversationSession()}
        bots={[fresh]}
        artifacts={[]}
        progress={[]}
        {...callbacks}
      />,
    );
    await interact(async () => undefined);
    const text = () => rendered.container.textContent ?? "";
    expect(text()).toContain("嗨，我刚上岗");
    expect(text()).toContain("你最想让我先帮你做什么");
    await interact(() =>
      lastHandlers().onMessage({
        ...message("d", "先帮我整理周报"),
        id: "message-owner",
        createdAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    expect(text()).not.toContain("你最想让我先帮你做什么");
    await rendered.unmount();
  });
});

describe("conversation polish (owner feedback 2026-10-05)", () => {
  const run = (id: string, status: Run["status"], sourceMessageId?: string): Run => ({
    id,
    channelId: "p",
    botId: bot.id,
    executionProfile: "none",
    instruction: "做",
    title: "做",
    status,
    createdAt: bot.createdAt,
    updatedAt: bot.createdAt,
    ...(sourceMessageId ? { sourceMessageId } : {}),
  });

  it("shows who is working, the Bots an Owner message went to, and no idle send button", async () => {
    const owner = { ...message("p", "整理周报"), id: "m-owner" };
    vi.mocked(listMessages).mockResolvedValue([owner]);
    vi.mocked(listRuns).mockResolvedValue([run("r-1", "running", "m-owner")]);
    const rendered = await renderComponent(view("p"));
    await interact(async () => undefined);
    expect(rendered.container.querySelector(".conversation-working")?.textContent).toBe(
      "Assistant 正在工作",
    );
    const bubble = document.getElementById("channel-message-m-owner");
    expect(bubble?.querySelector(".message-recipients .rich-mention")?.textContent).toBe(
      "Assistant",
    );
    const form = rendered.container.querySelector("form.message-composer");
    expect(form?.classList).toContain("is-empty");
    await typeText(rendered.container, "继续");
    expect(form?.classList).not.toContain("is-empty");
    await rendered.unmount();
  });

  it("marks where the unread replies start when the 频道 opens", async () => {
    vi.mocked(listMessages).mockResolvedValue([
      { ...message("u", "早先"), id: "m-1", authorType: "bot", authorId: bot.id },
      { ...message("u", "我的问题"), id: "m-2" },
      { ...message("u", "回复一"), id: "m-3", authorType: "bot", authorId: bot.id },
      { ...message("u", "回复二"), id: "m-4", authorType: "bot", authorId: bot.id },
    ]);
    const rendered = await renderComponent(
      <ChannelWorkspace
        globalHeader
        channel={channel("u")}
        session={createConversationSession()}
        bots={[bot]}
        artifacts={[]}
        progress={[]}
        unreadCount={2}
        {...callbacks}
      />,
    );
    await interact(async () => undefined);
    const divider = rendered.container.querySelector(".message-new-divider");
    expect(
      divider?.nextElementSibling?.id ?? divider?.nextElementSibling?.nextElementSibling?.id,
    ).toBe("channel-message-m-3");
    expect(rendered.container.querySelectorAll(".message-new-divider")).toHaveLength(1);
    await rendered.unmount();
  });
});
