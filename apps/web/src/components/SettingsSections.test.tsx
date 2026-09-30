// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { interact, renderComponent } from "../test/render-component";
import { ApprovalPolicySettings, AuditLogSettings } from "./SettingsSections";

afterEach(() => vi.unstubAllGlobals());

function respond(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

it("presents the approval policy as read-only facts without controls", async () => {
  const view = await renderComponent(<ApprovalPolicySettings />);
  try {
    expect(view.container.textContent).toContain("每次确认");
    expect(view.container.textContent).toContain("仅供查看");
    expect(view.container.querySelectorAll("input, select, button")).toHaveLength(0);
  } finally {
    await view.unmount();
  }
});

it("lists audit events with tombstone labels and pages by the Server cursor", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      respond({
        events: [
          {
            id: "1",
            type: "CHANNEL_RENAMED",
            createdAt: "2026-09-30T08:00:00.000Z",
            channelId: "c",
            channelName: "Research",
            channelDeleted: false,
            details: { from: "Design", to: "Research" },
          },
          {
            id: "2",
            type: "BOT_DELETED",
            createdAt: "2026-09-30T07:00:00.000Z",
            botId: "b",
            botName: "Reviewer",
            botDeleted: true,
            details: { name: "Reviewer" },
          },
        ],
        nextBefore: "2026-09-30T07:00:00.000Z",
      }),
    )
    .mockResolvedValueOnce(
      respond({
        events: [
          { id: "3", type: "UNKNOWN_KIND", createdAt: "2026-09-29T07:00:00.000Z", details: {} },
        ],
      }),
    );
  vi.stubGlobal("fetch", fetch);
  const view = await renderComponent(<AuditLogSettings />);
  try {
    await interact(() => undefined);
    const text = view.container.textContent ?? "";
    expect(text).toContain("重命名频道：Design → Research");
    expect(text).toContain("Reviewer（已删除的 Bot）");
    const more = Array.from(view.container.querySelectorAll("button")).find(
      (button) => button.textContent === "显示更早的记录",
    );
    await interact(() => more?.click());
    await interact(() => undefined);
    expect(fetch).toHaveBeenLastCalledWith(
      `/api/v1/audit?before=${encodeURIComponent("2026-09-30T07:00:00.000Z")}`,
      expect.anything(),
    );
    expect(view.container.querySelectorAll(".audit-list li")).toHaveLength(3);
    expect(view.container.textContent).toContain("unknown kind");
    expect(view.container.textContent).not.toContain("显示更早的记录");
  } finally {
    await view.unmount();
  }
});

it("rejects a malformed audit page instead of rendering it", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ events: [{ id: 1 }] })));
  const view = await renderComponent(<AuditLogSettings />);
  try {
    await interact(() => undefined);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "无法读取审计记录",
    );
  } finally {
    await view.unmount();
  }
});

it("groups audit events by day and filters loaded events by category", async () => {
  const today = new Date();
  today.setHours(10, 31, 0, 0);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      respond({
        events: [
          {
            id: "1",
            type: "CHANNEL_CREATED",
            createdAt: today.toISOString(),
            channelName: "市场周报",
            details: {},
          },
          { id: "2", type: "RUN_FAILED", createdAt: today.toISOString(), details: {} },
          { id: "3", type: "BOT_CREATED", createdAt: "2026-09-01T07:00:00.000Z", details: {} },
        ],
      }),
    ),
  );
  const view = await renderComponent(<AuditLogSettings />);
  try {
    await interact(() => undefined);
    const headings = Array.from(
      view.container.querySelectorAll(".settings-group > h3"),
      (item) => item.textContent,
    );
    expect(headings).toEqual(["今天", "9 月 1 日"]);
    const chips = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>(".settings-filters button"),
    );
    // Only categories present in the loaded events are offered.
    expect(chips.map((chip) => chip.textContent)).toEqual(["全部", "频道", "Bot", "任务"]);
    await interact(() => chips[3]?.click());
    expect(view.container.querySelectorAll(".audit-list li")).toHaveLength(1);
    expect(view.container.querySelector(".audit-list .ob-tag")?.textContent).toBe("任务");
    await interact(() => chips[0]?.click());
    expect(view.container.querySelectorAll(".audit-list li")).toHaveLength(3);
  } finally {
    await view.unmount();
  }
});
