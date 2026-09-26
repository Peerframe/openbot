// @vitest-environment jsdom
import type { EmployeeProfile } from "@openbot/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { interact, renderComponent, type RenderedComponent } from "../test/render-component";
import {
  EmployeeMemoryPanel,
  EmployeeProfileDetailsEditor,
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

  it("renders a revision-bound descriptive profile editor without authority controls", () => {
    const html = renderToStaticMarkup(
      <EmployeeProfileDetailsEditor profile={profile} onProfileChanged={async () => undefined} />,
    );

    expect(html).toContain("个人主页");
    expect(html).toContain("修订 1");
    expect(html).toContain("Build and verify changes within the assigned repository.");
    expect(html).toContain("不会授予技能或电脑权限");
    expect(html).not.toContain('name="computerProfile"');
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
