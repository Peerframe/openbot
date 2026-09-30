// @vitest-environment jsdom
import type { Approval, Bot, Channel } from "@openbot/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NotificationTracker,
  notificationSupport,
  showSystemNotification,
} from "./system-notifications";

const bots = [{ id: "b1", name: "研究助理" }] as Bot[];
const channels = [
  { id: "c1", name: "市场周报", botIds: ["b1"] },
  { id: "d1", name: "研究助理", directBotId: "b1", botIds: ["b1"] },
] as Channel[];
function approval(id: string, status = "pending"): Approval {
  return {
    id,
    channelId: "c1",
    botId: "b1",
    status,
    summary: "发送邮件给 secret@example.com",
  } as Approval;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { openbotDesktop?: unknown }).openbotDesktop;
});

describe("notification tracker", () => {
  it("treats the first snapshot as a baseline and never exposes approval details", () => {
    const tracker = new NotificationTracker();
    expect(tracker.approvals([approval("a1")], bots, channels)).toEqual([]);
    const notices = tracker.approvals(
      [approval("a1"), approval("a2"), approval("a3", "approved")],
      bots,
      channels,
    );
    expect(notices).toEqual([
      { title: "需要你批准", body: "研究助理 · 市场周报", channelId: "c1" },
    ]);
    expect(JSON.stringify(notices)).not.toContain("secret@example.com");
    expect(tracker.approvals([approval("a2")], bots, channels)).toEqual([]);
  });

  it("announces rising unread counts once per channel per minute without message text", () => {
    let now = 0;
    const tracker = new NotificationTracker(() => now);
    expect(tracker.messages({ c1: 1 }, bots, channels)).toEqual([]);
    expect(tracker.messages({ c1: 2, d1: 1 }, bots, channels)).toEqual([
      { title: "「市场周报」有新消息", body: "2 条未读", channelId: "c1" },
      { title: "研究助理 回复了你", body: "1 条未读", channelId: "d1" },
    ]);
    now = 30_000;
    expect(tracker.messages({ c1: 3, d1: 1 }, bots, channels)).toEqual([]);
    now = 61_000;
    expect(tracker.messages({ c1: 4, d1: 1, gone: 5 }, bots, channels)).toHaveLength(1);
  });
});

describe("notification delivery", () => {
  it("uses the browser API only after permission and navigates on click", async () => {
    const created: Array<{
      title: string;
      options: NotificationOptions;
      onclick?: () => void;
      close: () => void;
    }> = [];
    class FakeNotification {
      static permission: NotificationPermission = "denied";
      onclick?: () => void;
      close = vi.fn();
      constructor(title: string, options: NotificationOptions) {
        created.push(Object.assign(this, { title, options }));
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    const click = vi.fn();
    expect(notificationSupport()).toBe("denied");
    expect(await showSystemNotification({ title: "t", body: "b" }, click)).toBe(false);
    FakeNotification.permission = "granted";
    expect(
      await showSystemNotification({ title: "需要你批准", body: "x".repeat(200) }, click),
    ).toBe(true);
    expect(created[0]?.options.body).toHaveLength(80);
    created[0]?.onclick?.();
    expect(click).toHaveBeenCalledOnce();
  });

  it("prefers the Desktop bridge and navigates only when clicked", async () => {
    let settle: (value: { status: string }) => void = () => undefined;
    const showNotification = vi.fn(() => new Promise((resolve) => (settle = resolve)));
    (window as { openbotDesktop?: unknown }).openbotDesktop = {
      showNotification,
      getConnectionState: vi.fn(),
      configureServer: vi.fn(),
      getSetupPlanState: vi.fn(),
      saveSetupPlan: vi.fn(),
      getLocalWorkerState: vi.fn(),
      setupLocalWorker: vi.fn(),
      enableLocalWorker: vi.fn(),
      openLocalWorkerSettings: vi.fn(),
      getRuntimeInfo: () => ({
        kind: "desktop",
        platform: "darwin",
        arch: "arm64",
        shellVersion: "44.3.0",
      }),
    };
    expect(notificationSupport()).toBe("desktop");
    const click = vi.fn();
    expect(await showSystemNotification({ title: "需要你批准", body: "研究助理" }, click)).toBe(
      true,
    );
    expect(showNotification).toHaveBeenCalledWith({ title: "需要你批准", body: "研究助理" });
    settle({ status: "closed" });
    await Promise.resolve();
    expect(click).not.toHaveBeenCalled();
    await showSystemNotification({ title: "需要你批准", body: "研究助理" }, click);
    settle({ status: "clicked" });
    await Promise.resolve();
    await Promise.resolve();
    expect(click).toHaveBeenCalledOnce();
    showNotification.mockImplementationOnce(() => Promise.reject(new Error("closing")));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      expect(await showSystemNotification({ title: "a", body: "" }, click)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
