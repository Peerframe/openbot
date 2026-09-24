// @vitest-environment jsdom
import type { Bot } from "@openbot/domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import {
  deferred,
  interact,
  renderComponent,
  type RenderedComponent,
  setInputValue,
} from "../test/render-component";
import { workFixture } from "../test/work-fixture";
import * as api from "../work-api";
import { WorkTasksScreen } from "./WorkTasksScreen";

vi.mock("../work-api", () => ({
  createWorkTask: vi.fn(),
  getWorkTask: vi.fn(),
  cancelWorkTask: vi.fn(),
}));
const bots: Bot[] = [
  {
    id: "bot-one",
    name: "Reviewer",
    role: "Review",
    status: "idle",
    computerProfile: "none",
    createdAt: "2026-09-24T00:00:00Z",
  },
];
let ui: RenderedComponent;
function button(text: string) {
  return [...ui.container.querySelectorAll("button")].find((item) => item.textContent === text)!;
}
async function mount() {
  ui = await renderComponent(<WorkTasksScreen bots={bots} active />);
}
async function open(id = "task-one") {
  await setInputValue(ui.container.querySelector<HTMLInputElement>(".work-lookup input")!, id);
  await interact(() =>
    ui.container
      .querySelector(".work-lookup")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
async function create() {
  await interact(() => {
    const textarea = ui.container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "Review the document",
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await interact(() =>
    ui.container
      .querySelector(".work-form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getWorkTask).mockResolvedValue(workFixture());
  vi.mocked(api.createWorkTask).mockResolvedValue(workFixture());
});
afterEach(async () => {
  await ui?.unmount();
  vi.useRealTimers();
});

it("creates, observes and cancels using the returned task identity without optimistic completion", async () => {
  await mount();
  await create();
  expect(api.createWorkTask).toHaveBeenCalledWith(
    expect.objectContaining({
      botId: "bot-one",
      objective: "Review the document",
      tokenLimit: 10000,
      requestKey: expect.any(String),
    }),
    expect.any(AbortSignal),
  );
  expect(ui.container.textContent).toContain("排队中 (queued)");
  const pending = deferred<api.WorkSnapshot>();
  vi.mocked(api.cancelWorkTask).mockReturnValue(pending.promise);
  await interact(() => button("取消任务").click());
  expect(ui.container.textContent).toContain("排队中 (queued)");
  expect(ui.container.textContent).not.toContain("已取消 (cancelled)");
  await interact(() =>
    pending.resolve(
      workFixture({
        status: "cancelled",
        cancelRequested: true,
        authorityActive: false,
        revision: 2,
        runs: [{ id: "run-one", ordinal: 1, status: "running" }],
      }),
    ),
  );
  expect(ui.container.textContent).toContain("已取消 (cancelled)");
  expect(ui.container.textContent).toContain("运行中 (running)");
  expect(ui.container.textContent).toContain("未提供独立送达回执");
});
it("retries an ambiguous creation only on click with exactly the original body", async () => {
  vi.mocked(api.createWorkTask).mockRejectedValueOnce(new TypeError("offline"));
  await mount();
  await create();
  const first = vi.mocked(api.createWorkTask).mock.calls[0]![0];
  await interact(() => window.dispatchEvent(new Event("online")));
  expect(api.createWorkTask).toHaveBeenCalledTimes(1);
  expect(ui.container.querySelector("fieldset")?.disabled).toBe(true);
  await interact(() => button("重试同一创建请求").click());
  expect(vi.mocked(api.createWorkTask).mock.calls[1]![0]).toEqual(first);
  expect(ui.container.textContent).toContain("Server 已持久化任务");
});
it("allows correcting an explicitly rejected creation", async () => {
  vi.mocked(api.createWorkTask).mockRejectedValueOnce(new ApiError("invalid", 422));
  await mount();
  await create();
  expect(ui.container.querySelector("fieldset")?.disabled).toBe(false);
  expect(button("提交任务")).toBeDefined();
  expect(ui.container.textContent).toContain("Server 未接受请求参数");
});
it("keeps the last snapshot on disconnect, disables cancellation, and recovers on online", async () => {
  await mount();
  await open();
  vi.mocked(api.getWorkTask).mockRejectedValueOnce(new TypeError("offline"));
  await interact(() => button("刷新快照").click());
  expect(ui.container.textContent).toContain("排队中 (queued)");
  expect(button("取消任务").disabled).toBe(true);
  expect(api.cancelWorkTask).not.toHaveBeenCalled();
  vi.mocked(api.getWorkTask).mockResolvedValue(
    workFixture({ status: "completed", authorityActive: false, revision: 3 }),
  );
  await interact(() => window.dispatchEvent(new Event("online")));
  expect(ui.container.textContent).toContain("已完成 (completed)");
});
it("does not mark cancellation from a lost acknowledgement and confirms it by a new snapshot", async () => {
  await mount();
  await open();
  vi.mocked(api.cancelWorkTask).mockRejectedValue(new TypeError("lost response"));
  await interact(() => button("取消任务").click());
  expect(ui.container.textContent).toContain("尚未确认取消");
  expect(ui.container.textContent).toContain("排队中 (queued)");
  vi.mocked(api.getWorkTask).mockResolvedValue(
    workFixture({
      status: "cancelled",
      cancelRequested: true,
      authorityActive: false,
      revision: 2,
    }),
  );
  await interact(() => button("刷新快照").click());
  expect(ui.container.textContent).toContain("已取消 (cancelled)");
  expect(api.cancelWorkTask).toHaveBeenCalledTimes(1);
});
it("ignores a stale read after cancel and never regresses snapshot revision", async () => {
  await mount();
  await open();
  const old = deferred<api.WorkSnapshot>();
  vi.mocked(api.getWorkTask).mockReturnValueOnce(old.promise);
  await interact(() => window.dispatchEvent(new Event("focus")));
  // A second refresh invalidates the first even when transport ignores AbortSignal.
  vi.mocked(api.getWorkTask).mockResolvedValue(
    workFixture({
      status: "cancelled",
      cancelRequested: true,
      authorityActive: false,
      revision: 4,
    }),
  );
  await interact(() => window.dispatchEvent(new Event("online")));
  await interact(() => old.resolve(workFixture()));
  expect(ui.container.textContent).toContain("快照版本 4");
  vi.mocked(api.getWorkTask).mockResolvedValue(workFixture({ revision: 2 }));
  await interact(() => button("刷新快照").click());
  expect(ui.container.textContent).toContain("快照版本 4");
});
it("switches lookup identity without showing the prior task while the new read fails", async () => {
  await mount();
  await open();
  vi.mocked(api.getWorkTask).mockRejectedValue(new ApiError("missing", 404));
  await open("other");
  expect(ui.container.querySelector(".work-snapshot")).toBeNull();
  expect(ui.container.textContent).toContain("未找到任务");
});
it.each([401, 403, 409, 422])(
  "does not claim cancellation after permission/state rejection %i",
  async (status) => {
    await mount();
    await open();
    vi.mocked(api.cancelWorkTask).mockRejectedValue(new ApiError("private", status));
    await interact(() => button("取消任务").click());
    expect(ui.container.textContent).toContain("尚未确认取消");
    expect(ui.container.textContent).not.toContain("private");
    expect(button("取消任务").disabled).toBe(true);
  },
);
it("keeps unknown separate from successful task/command delivery", async () => {
  vi.mocked(api.getWorkTask).mockResolvedValue(
    workFixture({
      status: "cancelled",
      authorityActive: false,
      actions: [
        {
          id: "action",
          runId: "run-one",
          intent: {},
          intentDigest: "a".repeat(64),
          decision: "approved",
          status: "unknown",
          expiresAt: "2026-09-24",
          reservedTokens: 5,
          actualTokens: null,
          evidence: null,
          reconciliation: {
            id: "command",
            actionId: "action",
            sequence: 1,
            requestedBy: "owner",
            reason: "Check receipt",
            createdAt: "2026-09-24",
            delivered: true,
            outcome: null,
          },
        },
      ],
    }),
  );
  await mount();
  await open();
  expect(ui.container.textContent).toContain("结果未知（unknown），不能视为成功");
  expect(ui.container.textContent).toContain("核验命令已持久化 · 已送达 · 尚无核验结果");
});
it("unmounts an in-flight observation without cancelling server work", async () => {
  await mount();
  await open();
  await ui.unmount();
  expect(api.cancelWorkTask).not.toHaveBeenCalled();
  ui = undefined as unknown as RenderedComponent;
});
it("lets a slow read finish instead of aborting it on every poll tick", async () => {
  vi.useFakeTimers();
  const pending = deferred<api.WorkSnapshot>();
  vi.mocked(api.getWorkTask).mockReturnValue(pending.promise);
  await mount();
  await open();
  await interact(() => vi.advanceTimersByTime(5000));
  expect(api.getWorkTask).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.getWorkTask).mock.calls[0]![1].aborted).toBe(false);
  await interact(() => pending.resolve(workFixture()));
  expect(ui.container.textContent).toContain("排队中 (queued)");
});
