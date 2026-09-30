import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopNotifier, parseDesktopNotification } from "./desktop-notifications.js";

class FakeNotification extends EventEmitter {
  shown = false;
  closed = false;
  constructor(readonly input: { title: string; body: string }) {
    super();
  }
  show() {
    this.shown = true;
  }
  close() {
    this.closed = true;
  }
}

function notifier(options: { supported?: boolean; timeoutMs?: number } = {}) {
  const created: FakeNotification[] = [];
  const focus = vi.fn();
  const instance = new DesktopNotifier({
    isSupported: () => options.supported ?? true,
    create: (input) => {
      const notification = new FakeNotification(input);
      created.push(notification);
      return notification;
    },
    focus,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { instance, created, focus };
}

afterEach(() => vi.useRealTimers());

describe("desktop notification input", () => {
  it("accepts only exact, bounded, single-line text", () => {
    expect(
      parseDesktopNotification({ title: " 需要你批准 ", body: "研究助理 · 市场周报" }),
    ).toEqual({
      title: "需要你批准",
      body: "研究助理 · 市场周报",
    });
    for (const value of [
      null,
      "text",
      [],
      { title: "a" },
      { title: "a", body: "b", extra: 1 },
      { title: "", body: "b" },
      { title: "a".repeat(41), body: "" },
      { title: "a", body: "b".repeat(81) },
      { title: "a\nb", body: "" },
      { title: "a", body: "b c" },
      { title: 1, body: "b" },
    ])
      expect(parseDesktopNotification(value)).toBeUndefined();
  });
});

describe("desktop notifier", () => {
  it("focuses the window only when the notification is clicked", async () => {
    const { instance, created, focus } = notifier();
    const result = instance.show({ title: "需要你批准", body: "研究助理" });
    expect(created[0]?.shown).toBe(true);
    expect(focus).not.toHaveBeenCalled();
    created[0]?.emit("click");
    await expect(result).resolves.toEqual({ status: "clicked" });
    expect(focus).toHaveBeenCalledOnce();
    created[0]?.emit("close");
    expect(focus).toHaveBeenCalledOnce();
  });

  it("refuses invalid or unsupported requests without touching the OS", async () => {
    const unsupported = notifier({ supported: false });
    await expect(unsupported.instance.show({ title: "a", body: "" })).resolves.toEqual({
      status: "unsupported",
    });
    const invalid = notifier();
    await expect(invalid.instance.show({ title: "a", body: "", url: "x" })).resolves.toEqual({
      status: "failed",
    });
    expect(unsupported.created).toHaveLength(0);
    expect(invalid.created).toHaveLength(0);
  });

  it("reports OS failure and expires unanswered notifications", async () => {
    vi.useFakeTimers();
    const { instance, created } = notifier({ timeoutMs: 1000 });
    const failed = instance.show({ title: "a", body: "" });
    created[0]?.emit("failed");
    await expect(failed).resolves.toEqual({ status: "failed" });
    const waiting = instance.show({ title: "b", body: "" });
    vi.advanceTimersByTime(1000);
    await expect(waiting).resolves.toEqual({ status: "expired" });
    expect(created[1]?.closed).toBe(true);
  });

  it("keeps at most four pending notifications by closing the oldest", async () => {
    const { instance, created } = notifier();
    const results = Array.from({ length: 5 }, (_, index) =>
      instance.show({ title: `n${index}`, body: "" }),
    );
    await expect(results[0]).resolves.toEqual({ status: "expired" });
    expect(created[0]?.closed).toBe(true);
    instance.closeAll();
    for (const result of results.slice(1))
      await expect(result).resolves.toEqual({ status: "expired" });
  });
});
