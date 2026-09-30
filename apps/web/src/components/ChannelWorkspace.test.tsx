// @vitest-environment jsdom
import type { Bot, Channel, Message, Run, SubmitTaskResult } from "@openbot/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMessage,
  getEmployeeProfile,
  listMessages,
  listRuns,
  subscribeToChannelEvents,
} from "../api";
import { createConversationSession } from "../conversation-session";
import { deferred, interact, renderComponent } from "../test/render-component";
import { ChannelWorkspace } from "./ChannelWorkspace";

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
    await interact(() => lastHandlers().onMessage(message("a", "new message")));
    expect(log.scrollTop).toBe(140);
    const latest = rendered.container.querySelector(".conversation-latest") as HTMLButtonElement;
    expect(latest).not.toBeNull();
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
      expect(rendered.container.querySelectorAll(".channel-work-item")).toHaveLength(2);
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
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
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
  it("attaches a reviewed skill from the / menu without leaving the command in the text", async () => {
    const skill = (id: string, name: string, state: "verified" | "candidate") => ({
      id,
      slug: id,
      name,
      description: "",
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
    vi.mocked(getEmployeeProfile).mockResolvedValue({
      skills: [skill("s-ok", "周报整理", "verified"), skill("s-new", "未审核技能", "candidate")],
    } as unknown as Awaited<ReturnType<typeof getEmployeeProfile>>);
    const session = createConversationSession();
    const rendered = await renderComponent(multi(session));
    try {
      await typeText(rendered.container, "/");
      const listbox = () => rendered.container.querySelector(".slash-options");
      // Without a single @ recipient only the composer actions are offered.
      expect(listbox()?.textContent).toContain("先 @ 提及一名 Bot");
      expect(listbox()?.querySelectorAll('[role="option"]')).toHaveLength(2);
      expect(getEmployeeProfile).not.toHaveBeenCalled();

      await typeText(rendered.container, "Review @Coder");
      await interact(() =>
        rendered.container.querySelector<HTMLButtonElement>("#mention-bot-b")?.click(),
      );
      await typeText(rendered.container, "Review /周报");
      expect(getEmployeeProfile).toHaveBeenCalledWith("bot-b", expect.any(AbortSignal));
      const options = Array.from(listbox()?.querySelectorAll('[role="option"]') ?? []);
      expect(options.map((option) => option.textContent)).toEqual([
        expect.stringContaining("周报整理"),
      ]);
      await interact(() => (options[0] as HTMLButtonElement).click());
      expect(listbox()).toBeNull();
      expect(session.channel("a").getSnapshot().draft).toMatchObject({
        text: "Review",
        skills: [{ id: "s-ok", name: "周报整理", version: "1.0.0" }],
      });
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
      expect(
        rendered.container.querySelector('[role="log"] .channel-work-activity'),
      ).not.toBeNull();
      expect(rendered.container.querySelectorAll(".channel-work-item")).toHaveLength(3);
      expect(rendered.container.querySelector(".channel-work-item.running")?.textContent).toContain(
        "Researching",
      );
      expect(rendered.container.querySelector(".channel-work-item.queued")?.textContent).toContain(
        "Supplementary task",
      );
      expect(rendered.container.querySelector(".channel-work-item.failed")?.textContent).toContain(
        "模型密钥被拒绝",
      );
      expect(rendered.container.textContent).not.toContain("synthetic-provider-raw-error");
      expect(rendered.container.querySelectorAll(".work-ellipsis")).toHaveLength(1);
      await interact(() =>
        rendered.container
          .querySelector<HTMLButtonElement>(".channel-work-item.failed > div > button")
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
      expect(rendered.container.querySelector(".channel-work-activity")).toBeNull();
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
