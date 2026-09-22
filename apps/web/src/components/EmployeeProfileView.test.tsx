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
      configuration.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    expect(configuration.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(configuration);
  });
});
