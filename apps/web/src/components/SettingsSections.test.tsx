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
    expect(view.container.textContent).toContain("以上规则由 OpenBot 服务执行");
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
    // An unknown type shows its category in Chinese, never the internal code.
    expect(view.container.textContent).toContain("其他事件");
    expect(view.container.textContent).not.toContain("unknown kind");
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

it("groups audit events by day, filters by Server category and exports the same filter", async () => {
  const today = new Date();
  today.setHours(10, 31, 0, 0);
  const fetch = vi.fn(async (url: string) =>
    respond({
      events: url.includes("category=runs")
        ? [
            {
              id: "2",
              type: "RUN_FAILED",
              category: "runs",
              createdAt: today.toISOString(),
              details: {},
            },
          ]
        : [
            {
              id: "1",
              type: "CHANNEL_CREATED",
              category: "channels",
              createdAt: today.toISOString(),
              channelName: "市场周报",
              details: {},
            },
            {
              id: "3",
              type: "BOT_CREATED",
              category: "bots",
              createdAt: "2026-09-01T07:00:00.000Z",
              details: {},
            },
          ],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const view = await renderComponent(<AuditLogSettings />);
  try {
    await interact(() => undefined);
    const headings = Array.from(
      view.container.querySelectorAll(".settings-group > h3"),
      (item) => item.textContent,
    );
    expect(headings).toEqual(["今天", "9 月 1 日"]);
    const chips = () =>
      Array.from(view.container.querySelectorAll<HTMLButtonElement>(".settings-filters button"));
    expect(chips().map((chip) => chip.textContent)).toEqual([
      "全部",
      "审批",
      "设置变更",
      "登录",
      "主机",
      "频道",
      "Bot",
      "任务",
      "插件",
    ]);
    expect(view.container.querySelector(".audit-list .ob-tag")?.textContent).toBe("频道");
    await interact(() => chips()[7]?.click());
    await interact(() => undefined);
    expect(fetch).toHaveBeenLastCalledWith("/api/v1/audit?category=runs", expect.anything());
    expect(view.container.querySelectorAll(".audit-list li")).toHaveLength(1);
  } finally {
    await view.unmount();
  }
});

it("links CSV export to the active category", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => respond({ events: [] })),
  );
  const { auditExportUrl } = await import("../api");
  expect(auditExportUrl()).toBe("/api/v1/audit/export");
  expect(auditExportUrl("hosts")).toBe("/api/v1/audit/export?category=hosts");
});

it.each([
  [{ previousBotId: null, primaryBotId: "internal-new", to: "研究员" }, "未设置 → 研究员"],
  [
    { previousBotId: "internal-old", primaryBotId: "internal-new", from: "复核员", to: "研究员" },
    "复核员 → 研究员",
  ],
  [{ previousBotId: "internal-old", primaryBotId: null, from: "复核员" }, "复核员 → 未设置"],
  [{ previousBotId: "internal-old", primaryBotId: "internal-new" }, "未知 Bot → 未知 Bot"],
])("shows projected primary Bot names without leaking internal IDs: %o", async (details, title) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      respond({
        events: [
          {
            id: "primary-event",
            type: "SETTINGS_PRIMARY_BOT_UPDATED",
            category: "settings",
            createdAt: "2026-10-07T00:00:00.000Z",
            details,
          },
        ],
      }),
    ),
  );
  const view = await renderComponent(<AuditLogSettings />);
  try {
    await interact(() => undefined);
    expect(view.container.textContent).toContain(`更改主 Bot：${title}`);
    expect(view.container.textContent).not.toContain("internal-");
  } finally {
    await view.unmount();
  }
});

it("names every audit event in Chinese, falling back to its category for an unknown type", async () => {
  const event = (id: string, type: string, category: string) => ({
    id,
    type,
    category,
    createdAt: "2026-10-10T00:00:00.000Z",
    details: {},
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      respond({
        events: [
          event("a", "AUTH_LOGIN_SUCCEEDED", "authentication"),
          event("b", "MODEL_CONNECTION_CREATED", "settings"),
          event("c", "AUTOMATION_PAUSED", "other"),
          event("d", "AUTH_PASSKEY_ENROLLED", "authentication"),
        ],
      }),
    ),
  );
  const view = await renderComponent(<AuditLogSettings />);
  try {
    await interact(() => undefined);
    const titles = Array.from(view.container.querySelectorAll("strong")).map(
      (item) => item.textContent,
    );
    expect(titles).toEqual(
      expect.arrayContaining(["登录成功", "添加模型服务", "暂停例行任务", "登录事件"]),
    );
    expect(view.container.textContent).not.toMatch(/auth|passkey|automation/iu);
  } finally {
    await view.unmount();
  }
});
