// @vitest-environment jsdom
import type { EmployeeProfile } from "@openbot/domain";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { interact, renderComponent, setInputValue } from "../test/render-component";
import { EmployeeDescriptionForm } from "./EmployeeDescriptionForm";

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
function Harness(props: { onProfileChanged(): Promise<void> }) {
  const [shown, setShownState] = useState(profile);
  setShown = setShownState;
  return <EmployeeDescriptionForm profile={shown} onProfileChanged={props.onProfileChanged} />;
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

it("saves the description with the revision and keeps the tag", async () => {
  const changed = vi.fn(async () => undefined);
  api.updateEmployeeProfileDetails.mockResolvedValue({
    employee: profile.employee,
    details: { ...profile.details, description: "跟踪竞品和价格。", revision: 2 },
  });
  const view = await renderComponent(<Harness onProfileChanged={changed} />);
  try {
    // Name and tag live in the Bot 信息 rail.
    expect(field(view.container, "名称")).toBeUndefined();
    expect(button(view.container, "保存")?.disabled).toBe(true);
    const description = field(view.container, "描述");
    if (!(description instanceof HTMLTextAreaElement)) throw Error("description missing");
    await setInputValue(description, "跟踪竞品和价格。");
    await interact(() => button(view.container, "保存")?.click());
    expect(api.updateEmployeeProfileDetails).toHaveBeenCalledWith("bot-1", {
      role: "信息 · 竞品研究",
      description: "跟踪竞品和价格。",
      expectedRevision: 1,
    });
    expect(changed).toHaveBeenCalledOnce();
    expect(button(view.container, "保存")?.disabled).toBe(true);
  } finally {
    await view.unmount();
  }
});

it("does not overwrite an edit made on another device", async () => {
  const view = await renderComponent(<Harness onProfileChanged={vi.fn(async () => undefined)} />);
  try {
    const description = field(view.container, "描述");
    if (!(description instanceof HTMLTextAreaElement)) throw Error("description missing");
    await setInputValue(description, "只看价格。");
    await interact(() =>
      setShown({
        ...profile,
        details: { ...profile.details, description: "跟踪竞品官网和博客。", revision: 2 },
      }),
    );
    expect(view.container.textContent).toContain("已在另一台设备更新");
    expect(button(view.container, "保存")?.disabled).toBe(true);
    await interact(() => button(view.container, "加载最新值")?.click());
    expect(field(view.container, "描述")?.value).toBe("跟踪竞品官网和博客。");
    expect(api.updateEmployeeProfileDetails).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});
