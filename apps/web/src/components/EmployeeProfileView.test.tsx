// @vitest-environment jsdom
import type { EmployeeProfile } from "@openbot/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { interact, type RenderedComponent, renderComponent } from "../test/render-component";

const api = vi.hoisted(() => ({
  updateEmployeeMemory: vi.fn(async () => ({})),
  getKnowledgeProposals: vi.fn(async () => []),
}));
vi.mock("../api", async (original) => ({ ...(await original<typeof import("../api")>()), ...api }));

import {
  EmployeeMemoryPanel,
  EmployeeProfileView,
  profileTabForNavigationKey,
} from "./EmployeeProfileView";

const profile: EmployeeProfile = {
  employee: {
    id: "employee-1",
    name: "Coder",
    role: "代码开发与验证",
    status: "idle",
    computerProfile: "coder",
    createdAt: "2026-09-03T00:00:00.000Z",
  },
  details: {
    description: "Build and verify changes within the assigned repository.",
    revision: 1,
    updatedAt: "2026-09-03T00:00:00.000Z",
  },
  evolution: [],
  skills: [],
  memories: [],
  memoryEvents: [],
  records: { runs: [], approvals: [], artifacts: [], decisions: [] },
  statistics: { totalRuns: 0, completedRuns: 0, failedRuns: 0, verifiedSkills: 0 },
  configuration: { executionProfile: "coder", portabilityFormat: "openbot.employee/v1" },
};

function skill(
  id: string,
  name: string,
  state: EmployeeProfile["skills"][number]["state"],
): EmployeeProfile["skills"][number] {
  return {
    id,
    slug: id,
    name,
    description: "",
    version: "1.0.0",
    source: "learned",
    state,
    confidence: 80,
    requiredCapabilities: [],
    dependencyIds: [],
    evidence: [],
    acquiredAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  } as EmployeeProfile["skills"][number];
}

describe("EmployeeProfileView", () => {
  it("connects the active tab to a single labelled tab panel", () => {
    const html = renderToStaticMarkup(
      <EmployeeProfileView
        profile={profile}
        loading={false}
        error={undefined}
        onRetry={() => undefined}
        onAssign={() => undefined}
        onExport={() => undefined}
        onProfileChanged={async () => undefined}
      />,
    );

    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(6);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toMatch(/aria-controls="[^"]+-overview-panel"/);
    expect(html).toMatch(/aria-labelledby="[^"]+-overview-tab"/);
  });

  it("implements the standard horizontal tab navigation keys with wrapping", () => {
    expect(profileTabForNavigationKey("overview", "ArrowLeft")).toBe("configuration");
    expect(profileTabForNavigationKey("configuration", "ArrowRight")).toBe("overview");
    expect(profileTabForNavigationKey("memory", "Home")).toBe("overview");
    expect(profileTabForNavigationKey("memory", "End")).toBe("configuration");
    expect(profileTabForNavigationKey("memory", "ArrowDown")).toBeUndefined();
  });

  it("makes Owner memory controls and the no-transfer boundary explicit", () => {
    const html = renderToStaticMarkup(
      <EmployeeMemoryPanel profile={profile} onProfileChanged={async () => undefined} />,
    );

    expect(html).toContain("添加记忆");
    expect(html).toContain("审阅前不会成为记忆");
    expect(html).toContain("记忆不会进入 Bot 模板");
  });

  it("renders the artboard overview from Server records", async () => {
    const onExport = vi.fn();
    const detailed: EmployeeProfile = {
      ...profile,
      evolution: [
        {
          id: "e1",
          botId: "employee-1",
          type: "skill_verified",
          title: "新增技能「读取更新日志」",
          summary: "通过确定性测试",
          source: "run",
          evidence: [],
          createdAt: "2026-09-28T12:00:00.000Z",
        },
      ],
      skills: [skill("s1", "读取更新日志", "verified"), skill("s2", "社交媒体监控", "candidate")],
      records: {
        ...profile.records,
        runs: [
          {
            id: "r1",
            channelId: "c1",
            botId: "employee-1",
            instruction: "",
            title: "整理本周竞品动态",
            status: "failed",
            executionProfile: "coder",
            createdAt: "2026-09-26T12:00:00.000Z",
          } as EmployeeProfile["records"]["runs"][number],
        ],
      },
    };
    const view = await renderComponent(
      <EmployeeProfileView
        profile={detailed}
        channels={[
          { id: "c1", name: "市场周报", botIds: [], createdAt: "2026-09-01T00:00:00.000Z" },
        ]}
        loading={false}
        error={undefined}
        onRetry={() => undefined}
        onAssign={() => undefined}
        onExport={onExport}
        onProfileChanged={async () => undefined}
      />,
    );
    interactiveViews.push(view);
    const text = view.container.textContent ?? "";
    expect(view.container.querySelector(".ep-name .ob-tag")?.textContent).toBe("代码开发与验证");
    expect(text).toContain("Build and verify changes within the assigned repository.");
    expect(text).toContain("通过确定性测试 · 9/28");
    expect(text).toContain("# 市场周报 · 9/26");
    expect(view.container.querySelector(".ep-run-status.failed")?.textContent).toBe("失败");
    expect(view.container.querySelector(".ep-skill.verified")?.textContent).toBe("读取更新日志");
    expect(view.container.querySelector(".ep-skill.candidate")?.textContent).toBe(
      "候选：社交媒体监控 · 待审核",
    );
    const all = view.container.querySelectorAll<HTMLButtonElement>(
      ".ep-card-section header button",
    );
    await interact(() => all[1]?.click());
    expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      "工作记录",
    );
    const configuration = [
      ...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ].at(-1);
    await interact(() => configuration?.click());
    await interact(() =>
      [...view.container.querySelectorAll("button")]
        .find((button) => button.textContent === "导出模板")
        ?.click(),
    );
    expect(onExport).toHaveBeenCalledOnce();
  });
});

const interactiveViews: RenderedComponent[] = [];

afterEach(async () => {
  for (const view of interactiveViews.splice(0)) await view.unmount();
});

async function renderProfile() {
  const view = await renderComponent(
    <EmployeeProfileView
      profile={profile}
      loading={false}
      error={undefined}
      onRetry={() => undefined}
      onAssign={() => undefined}
      onExport={() => undefined}
      onProfileChanged={async () => undefined}
    />,
  );
  interactiveViews.push(view);
  const tabs = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  if (tabs.length !== 6) throw new Error(`Expected 6 tabs, found ${tabs.length}`);
  return { view, tabs };
}

describe("EmployeeProfileView keyboard DOM regression", () => {
  it("moves aria-selected and focus together for ArrowRight, Home, and End", async () => {
    const { tabs } = await renderProfile();
    const [overview, evolution, , , , configuration] = tabs;
    await interact(() => overview.focus());
    expect(document.activeElement).toBe(overview);
    expect(overview.getAttribute("aria-selected")).toBe("true");

    await interact(() =>
      overview.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    expect(evolution.getAttribute("aria-selected")).toBe("true");
    expect(overview.getAttribute("aria-selected")).toBe("false");
    expect(document.activeElement).toBe(evolution);
    expect(evolution.tabIndex).toBe(0);
    expect(overview.tabIndex).toBe(-1);

    await interact(() =>
      evolution.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
    );
    expect(configuration.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(configuration);

    await interact(() =>
      configuration.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })),
    );
    expect(overview.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(overview);
  });

  it("wraps ArrowLeft from overview and ignores ArrowDown", async () => {
    const { tabs } = await renderProfile();
    const [overview, , , , , configuration] = tabs;
    await interact(() => overview.focus());

    await interact(() =>
      overview.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })),
    );
    expect(configuration.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(configuration);

    await interact(() =>
      configuration.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    expect(configuration.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(configuration);
  });
});

describe("reviewed knowledge memory provenance", () => {
  function memoryProfile(provenance: Record<string, unknown>): EmployeeProfile {
    return {
      ...profile,
      memories: [
        {
          id: "memory",
          botId: "employee-1",
          kind: "procedural",
          title: "Reviewed evidence",
          content: "Synthetic reviewed content",
          sensitivity: "internal",
          portability: "never",
          provenance,
          modelUseEnabled: false,
          revision: 1,
          createdAt: "2026-09-25T00:00:00Z",
          updatedAt: "2026-09-25T00:00:00Z",
        },
      ],
    };
  }
  it("shows the actual reviewed native Task and Work Run without inventing a channel source", () => {
    const html = renderToStaticMarkup(
      <EmployeeMemoryPanel
        profile={memoryProfile({
          source: "reviewed-work-proposal",
          actor: "owner",
          proposalId: "proposal",
          sourceTaskId: "native-task",
          sourceWorkRunId: "native-work-run",
        })}
        onProfileChanged={async () => {}}
      />,
    );
    expect(html).toContain('href="#/tasks?task=native-task"');
    expect(html).toContain("native-work-run");
    expect(html).toContain("Work Run");
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain("来源频道 Run");
  });
  it("retains legacy channel Run provenance without granting a native Task identity", () => {
    const html = renderToStaticMarkup(
      <EmployeeMemoryPanel
        profile={memoryProfile({ source: "reviewed-agent-proposal", sourceRunId: "channel-run" })}
        onProfileChanged={async () => {}}
      />,
    );
    expect(html).toContain("来源频道 Run：channel-run");
    expect(html).not.toContain("#/tasks?task=");
  });
  it("does not fall back to a misleading legacy identity when native provenance is incomplete", () => {
    const html = renderToStaticMarkup(
      <EmployeeMemoryPanel
        profile={memoryProfile({
          source: "reviewed-work-proposal",
          sourceTaskId: "native-task",
          sourceRunId: "not-the-source",
        })}
        onProfileChanged={async () => {}}
      />,
    );
    expect(html).toContain("原生任务来源信息不完整");
    expect(html).not.toContain("not-the-source");
    expect(html).not.toContain("#/tasks?task=");
  });
  it("does not invent a source link for manually authored Owner memory", () => {
    const html = renderToStaticMarkup(
      <EmployeeMemoryPanel
        profile={memoryProfile({ source: "owner", actor: "owner" })}
        onProfileChanged={async () => {}}
      />,
    );
    expect(html).not.toContain("#/tasks?task=");
    expect(html).not.toContain("来源频道 Run");
  });
});

describe("工作记录", () => {
  const run = (id: string, status: string, createdAt: string, title = id) =>
    ({
      id,
      channelId: "c1",
      botId: "employee-1",
      instruction: "",
      title,
      status,
      executionProfile: "coder",
      createdAt,
    }) as EmployeeProfile["records"]["runs"][number];
  const records: EmployeeProfile["records"] = {
    runs: [
      run("done", "completed", "2026-09-29T10:00:00.000Z", "整理本周周报"),
      run("live", "running", "2026-09-30T10:00:00.000Z", "抓取竞品更新日志"),
      run("wait", "waiting_approval", "2026-09-30T09:00:00.000Z", "发送周报"),
    ],
    approvals: [
      {
        id: "a1",
        runId: "wait",
        channelId: "c1",
        botId: "employee-1",
        nodeId: "n1",
        action: "email.send",
        target: "team@example.com",
        summary: "发送邮件给 team@example.com",
        risk: "write",
        targetFingerprint: "f",
        beforeState: {},
        status: "pending",
        expiresAt: "2099-01-01T00:00:00.000Z",
        createdAt: "2026-09-30T09:01:00.000Z",
      },
    ],
    artifacts: [
      {
        id: "o1",
        runId: "done",
        name: "weekly.md",
        mediaType: "text/markdown",
        sha256: "x",
        sizeBytes: 5120,
        createdAt: "2026-09-29T10:05:00.000Z",
      },
    ],
    decisions: [],
  };

  it("opens from the retired 运行中 link and lists waiting work first", async () => {
    const onOpenRun = vi.fn();
    const view = await renderComponent(
      <EmployeeProfileView
        initialTab="live"
        profile={{ ...profile, records }}
        loading={false}
        error={undefined}
        onRetry={() => undefined}
        onAssign={() => undefined}
        onExport={() => undefined}
        onProfileChanged={async () => undefined}
        onOpenRun={onOpenRun}
      />,
    );
    interactiveViews.push(view);
    expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      "工作记录",
    );
    const live = [...view.container.querySelectorAll(".ep-live-list strong")].map(
      (item) => item.textContent,
    );
    // The waiting run shows once, as its approval.
    expect(live).toEqual(["等你确认 · 发送邮件给 team@example.com", "正在工作 · 抓取竞品更新日志"]);
    const filters = [...view.container.querySelectorAll(".ep-text-filters button")];
    expect(filters.map((item) => item.textContent)).toEqual([
      "全部 5",
      "任务 3",
      "确认 1",
      "产出 1",
      "决策 0",
    ]);
    await interact(() => (filters[3] as HTMLButtonElement).click());
    const rows = [
      ...view.container.querySelectorAll<HTMLButtonElement>(".ep-record-list .ep-record"),
    ];
    expect(rows.map((row) => row.textContent)).toEqual(["产出weekly.md整理本周周报 · 5 KB已保存"]);
    await interact(() => rows[0]?.click());
    expect(onOpenRun).toHaveBeenCalledWith("done");
  });
});

describe("记忆 · 模型可用", () => {
  const memory = (
    id: string,
    sensitivity: EmployeeProfile["memories"][number]["sensitivity"],
  ): EmployeeProfile["memories"][number] => ({
    id,
    botId: "employee-1",
    kind: "semantic",
    title: id,
    content: "Synthetic fact",
    sensitivity,
    portability: "never",
    provenance: { source: "owner" },
    modelUseEnabled: false,
    revision: 3,
    createdAt: "2026-09-25T00:00:00Z",
    updatedAt: "2026-09-25T00:00:00Z",
  });

  it("sends only the switch with the revision and keeps confidential memory off", async () => {
    api.updateEmployeeMemory.mockClear();
    const changed = vi.fn(async () => undefined);
    const view = await renderComponent(
      <EmployeeMemoryPanel
        profile={{
          ...profile,
          memories: [memory("open", "internal"), memory("secret", "confidential")],
        }}
        onProfileChanged={changed}
      />,
    );
    interactiveViews.push(view);
    const switches = [...view.container.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
    expect(switches.map((item) => item.disabled)).toEqual([false, true]);
    await interact(() => switches[0]?.click());
    expect(api.updateEmployeeMemory).toHaveBeenCalledWith("employee-1", "open", {
      expectedRevision: 3,
      modelUseEnabled: true,
    });
    expect(changed).toHaveBeenCalledOnce();
  });
});
