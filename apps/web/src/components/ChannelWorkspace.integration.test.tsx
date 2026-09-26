// @vitest-environment jsdom
import type { Bot, Channel, Message, Run, RunOutput } from "@openbot/domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ApiError,
  createMessage,
  getRunOutput,
  listMessages,
  listRuns,
  setMessageReaction,
  steerRun,
  subscribeToChannelEvents,
} from "../api";
import { createConversationSession } from "../conversation-session";
import { interact, type RenderedComponent, renderComponent } from "../test/render-component";
import { ChannelWorkspace } from "./ChannelWorkspace";

vi.mock("../plugin-api", () => ({
  listPlugins: vi.fn(async () => ({ plugins: [], pendingCalls: [] })),
  pluginError: vi.fn(() => "Unavailable"),
}));
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  createMessage: vi.fn(),
  getRunOutput: vi.fn(),
  steerRun: vi.fn(),
  listMessages: vi.fn(),
  listRuns: vi.fn(),
  listChannelReactions: vi.fn(async () => []),
  setMessageReaction: vi.fn(async () => []),
  subscribeToChannelEvents: vi.fn(() => vi.fn()),
}));
const bot: Bot = {
  id: "bot",
  name: "Researcher",
  role: "Research",
  status: "idle",
  computerProfile: "none",
  createdAt: "2026-09-10T08:00:00Z",
};
const channel: Channel = {
  id: "channel",
  name: "Research",
  description: "",
  botIds: [bot.id],
  createdAt: bot.createdAt,
};
const run: Run = {
  id: "run",
  channelId: channel.id,
  botId: bot.id,
  status: "running",
  executionProfile: "none",
  title: "Research task",
  instruction: "Research",
  createdAt: bot.createdAt,
  updatedAt: bot.createdAt,
};
const output = (sequence: number, text: string): RunOutput => ({
  runId: run.id,
  channelId: channel.id,
  botId: bot.id,
  sequence,
  text,
  reset: false,
});
const final: Message = {
  id: "final",
  channelId: channel.id,
  authorType: "bot",
  authorId: bot.id,
  runId: run.id,
  content: "Verified final answer",
  createdAt: bot.createdAt,
};
const views: RenderedComponent[] = [];
async function render() {
  const session = createConversationSession();
  const view = await renderComponent(
    <ChannelWorkspace
      channel={channel}
      session={session}
      bots={[bot]}
      artifacts={[]}
      progress={[]}
      onJoin={vi.fn()}
      onInspectRun={vi.fn()}
      onOpenBot={vi.fn()}
      onFrame={vi.fn()}
      onProgress={vi.fn()}
      onRun={vi.fn()}
    />,
  );
  views.push(view);
  return { ...view, session };
}
function handlers() {
  const value = vi.mocked(subscribeToChannelEvents).mock.calls.at(-1)?.[1];
  if (!value) throw new Error("Missing channel subscription");
  return value;
}
function button(name: string): HTMLButtonElement {
  const result = [...document.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === name || item.textContent === name,
  );
  if (!result) throw new Error(`Missing button ${name}`);
  return result;
}
async function type(selector: string, value: string) {
  const input = document.querySelector<HTMLTextAreaElement>(selector);
  if (!input) throw new Error(`Missing ${selector}`);
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listMessages).mockResolvedValue([]);
  vi.mocked(listRuns).mockResolvedValue([run]);
  vi.mocked(getRunOutput).mockResolvedValue(null);
});
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
  vi.restoreAllMocks();
});
it("recovers output on ready and merges forward SSE projections before the formal message replaces them", async () => {
  vi.mocked(getRunOutput).mockResolvedValueOnce(output(1, "Recovered partial"));
  const view = await render();
  expect(view.container.querySelector(".streaming-message")?.textContent).toContain(
    "Recovered partial",
  );
  await interact(() => handlers().onOutput?.(output(2, "Growing response")));
  expect(view.container.querySelector(".streaming-message")?.textContent).toContain(
    "Growing response",
  );
  await interact(() => {
    handlers().onOutput?.(output(1, "Stale response"));
    handlers().onOutput?.({ ...output(3, "Other channel"), channelId: "other" });
    handlers().onOutput?.({ ...output(3, "Other bot"), botId: "other" });
  });
  expect(view.container.querySelector(".streaming-message")?.textContent).toContain(
    "Growing response",
  );
  vi.mocked(getRunOutput).mockResolvedValue(output(4, "Reconnect snapshot"));
  await interact(() => handlers().onReady());
  expect(getRunOutput).toHaveBeenCalledTimes(2);
  expect(view.container.querySelector(".streaming-message")?.textContent).toContain(
    "Reconnect snapshot",
  );
  await interact(() =>
    handlers().onMessage({
      ...final,
      id: "other-author",
      authorId: "other-bot",
      content: "Other author's message",
    }),
  );
  expect(view.container.querySelector(".streaming-message")?.textContent).toContain(
    "Reconnect snapshot",
  );
  await interact(() => handlers().onMessage(final));
  expect(view.container.textContent).toContain(final.content);
  expect(view.container.querySelector(".streaming-message")).toBeNull();
  await interact(() => handlers().onRun({ ...run, status: "completed" }, []));
  await interact(() => handlers().onOutput?.(output(5, "Late terminal output")));
  expect(view.container.textContent).not.toContain("Late terminal output");
});
it.each(["none", "model"] as const)(
  "retains conflicting %s steering input and clears it only after acceptance",
  async (executionProfile) => {
    vi.mocked(listRuns).mockResolvedValue([{ ...run, executionProfile }]);
    await render();
    await interact(() => button("补充指令").click());
    await type(".run-steering textarea", "Keep the source citations");
    vi.mocked(steerRun).mockRejectedValueOnce(new ApiError("Ended", 409));
    await interact(() =>
      document
        .querySelector(".run-steering form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(document.querySelector<HTMLTextAreaElement>(".run-steering textarea")?.value).toBe(
      "Keep the source citations",
    );
    expect(document.querySelector(".run-steering")?.textContent).toContain("内容已保留");
    vi.mocked(steerRun).mockResolvedValueOnce(undefined);
    await interact(() =>
      document
        .querySelector(".run-steering form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(steerRun).toHaveBeenLastCalledWith(run.id, "Keep the source citations");
    expect(document.querySelector(".run-steering textarea")).toBeNull();
    expect(document.querySelector(".run-steering")?.textContent).toContain("已接收");
    await interact(() => button("补充指令").click());
    expect(document.querySelector<HTMLTextAreaElement>(".run-steering textarea")?.value).toBe("");
  },
);
it("wires side actions to reply targets, persistent emoji intent and overflow copy", async () => {
  vi.mocked(listMessages).mockResolvedValue([final]);
  vi.mocked(listRuns).mockResolvedValue([{ ...run, status: "completed" }]);
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const view = await render();
  const bar = view.container.querySelector(".message-content > .message-action-bar");
  expect(bar).not.toBeNull();
  expect(bar?.querySelectorAll("button")).toHaveLength(3);
  expect(bar?.textContent).not.toContain("复制");
  await interact(() => button("回复").click());
  expect(view.session.channel(channel.id).getSnapshot().draft.replyTo?.id).toBe(final.id);
  expect(view.container.querySelector(".composer-reply")?.textContent).toContain(final.content);
  await interact(() => button("添加回应").click());
  await interact(() => button("赞同").click());
  expect(setMessageReaction).toHaveBeenCalledExactlyOnceWith(channel.id, final.id, "👍", true);
  await interact(() => button("更多操作").click());
  expect(document.querySelector('[role="menu"]')?.parentElement).toBe(document.body);
  await interact(() => button("复制").click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith(final.content);
  expect(createMessage).not.toHaveBeenCalled();
});
