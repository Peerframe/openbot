// @vitest-environment jsdom
import type { EmployeeProfile } from "@openbot/domain";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sidebarOrganization } from "../sidebar-organization";
import { interact, renderComponent, setInputValue } from "../test/render-component";
import { EmployeeProfileRail } from "./EmployeeProfileRail";

const api = vi.hoisted(() => ({ updateEmployeeProfileDetails: vi.fn() }));
vi.mock("../api", () => api);

const profile: EmployeeProfile = {
  employee: {
    id: "bot-1",
    name: "研究助理",
    role: "信息 · 竞品研究",
    status: "idle",
    computerProfile: "docker-linux",
    model: { connectionId: "c1", modelId: "claude-sonnet" },
    createdAt: "2026-09-03T00:00:00.000Z",
  },
  details: { description: "跟踪竞品官网。", revision: 1, updatedAt: "2026-09-03T00:00:00.000Z" },
  evolution: [],
  skills: [],
  memories: [],
  memoryEvents: [],
  records: { runs: [], approvals: [], artifacts: [], decisions: [] },
  statistics: { totalRuns: 0, completedRuns: 0, failedRuns: 0, verifiedSkills: 0 },
  configuration: {
    executionProfile: "docker-linux",
    model: { connectionId: "c1", modelId: "claude-sonnet" },
    portabilityFormat: "openbot.employee/v1",
  },
};

let setShown: (value: EmployeeProfile) => void = () => undefined;
function Harness(props: {
  onRename(name: string): Promise<void>;
  onProfileChanged(): Promise<void>;
  onBack?(): void;
  onCollapse?(): void;
}) {
  const [shown, setShownState] = useState(profile);
  setShown = setShownState;
  return (
    <EmployeeProfileRail
      profile={shown}
      nodes={[]}
      onBack={props.onBack ?? (() => undefined)}
      onCollapse={props.onCollapse ?? (() => undefined)}
      onRename={props.onRename}
      onProfileChanged={props.onProfileChanged}
    />
  );
}

function field(container: HTMLElement, label: string) {
  const element = Array.from(container.querySelectorAll("label")).find((item) =>
    item.textContent?.startsWith(label),
  );
  return element?.querySelector<HTMLInputElement>("input, textarea");
}
function button(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (item) => item.textContent === text,
  );
}

beforeEach(() => {
  api.updateEmployeeProfileDetails.mockReset();
});
afterEach(() => {
  sidebarOrganization.setMuted("bot:bot-1", false);
});

it("saves the name through rename and the tag and description with the revision", async () => {
  const rename = vi.fn(async () => undefined);
  const changed = vi.fn(async () => undefined);
  api.updateEmployeeProfileDetails.mockResolvedValue({
    employee: { ...profile.employee, role: "市场" },
    details: { ...profile.details, revision: 2 },
  });
  const back = vi.fn();
  const collapse = vi.fn();
  const view = await renderComponent(
    <Harness onRename={rename} onProfileChanged={changed} onBack={back} onCollapse={collapse} />,
  );
  try {
    const text = view.container.textContent ?? "";
    expect(text).toContain("claude-sonnet");
    expect(text).toContain("员工浏览器 · Docker");
    expect(text).toContain("不代表有权操作电脑");
    // Nothing to save until a field changes.
    expect(button(view.container, "保存")).toBeUndefined();
    const name = field(view.container, "名称");
    const role = field(view.container, "标签");
    if (!(name instanceof HTMLInputElement) || !(role instanceof HTMLInputElement))
      throw Error("fields missing");
    await setInputValue(name, " 研究员 ");
    await setInputValue(role, "市场");
    await interact(() => button(view.container, "保存")?.click());
    expect(rename).toHaveBeenCalledWith("研究员");
    expect(api.updateEmployeeProfileDetails).toHaveBeenCalledWith("bot-1", {
      role: "市场",
      description: "跟踪竞品官网。",
      expectedRevision: 1,
    });
    expect(changed).toHaveBeenCalledOnce();
    expect(button(view.container, "保存")).toBeUndefined();
    await interact(() =>
      view.container.querySelector<HTMLButtonElement>('[aria-label="返回"]')?.click(),
    );
    await interact(() =>
      view.container.querySelector<HTMLButtonElement>('[aria-label="收起"]')?.click(),
    );
    expect(back).toHaveBeenCalledOnce();
    expect(collapse).toHaveBeenCalledOnce();
  } finally {
    await view.unmount();
  }
});

it("does not overwrite an edit made on another device", async () => {
  const view = await renderComponent(
    <Harness
      onRename={vi.fn(async () => undefined)}
      onProfileChanged={vi.fn(async () => undefined)}
    />,
  );
  try {
    const role = field(view.container, "标签");
    if (!(role instanceof HTMLInputElement)) throw Error("role missing");
    await setInputValue(role, "市场");
    await interact(() =>
      setShown({
        ...profile,
        employee: { ...profile.employee, role: "行政" },
        details: { ...profile.details, revision: 2 },
      }),
    );
    expect(view.container.textContent).toContain("已在另一台设备更新");
    expect(button(view.container, "保存")?.disabled).toBe(true);
    await interact(() => button(view.container, "加载最新值")?.click());
    expect(field(view.container, "标签")?.value).toBe("行政");
    expect(api.updateEmployeeProfileDetails).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});

it("mutes the Bot's notifications on this device, shared with the sidebar", async () => {
  const view = await renderComponent(
    <Harness
      onRename={vi.fn(async () => undefined)}
      onProfileChanged={vi.fn(async () => undefined)}
    />,
  );
  try {
    const toggle = view.container.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    await interact(() => toggle?.click());
    expect(sidebarOrganization.snapshot().muted).toContain("bot:bot-1");
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
  } finally {
    await view.unmount();
  }
});
