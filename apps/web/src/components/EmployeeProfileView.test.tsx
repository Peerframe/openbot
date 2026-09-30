// @vitest-environment jsdom
import type { EmployeeProfile } from "@openbot/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { interact, type RenderedComponent, renderComponent } from "../test/render-component";
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
    expect(html.match(/role="tab"/g)).toHaveLength(7);
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
    expect(html).toContain("候选经验须经你审阅");
    expect(html).toContain("不会进入当前员工模板");
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
  if (tabs.length !== 7) throw new Error(`Expected 7 tabs, found ${tabs.length}`);
  return { view, tabs };
}

describe("EmployeeProfileView keyboard DOM regression", () => {
  it("moves aria-selected and focus together for ArrowRight, Home, and End", async () => {
    const { tabs } = await renderProfile();
    const [overview, evolution, , , , , configuration] = tabs;
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
    const [overview, , , , , , configuration] = tabs;
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
    expect(html).toContain("仅供你查看");
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
