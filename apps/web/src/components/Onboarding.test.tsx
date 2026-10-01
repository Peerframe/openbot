// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { interact, renderComponent } from "../test/render-component";
import { LaunchExit, LaunchScreen, OnboardingFrame } from "./Onboarding";

afterEach(() => vi.useRealTimers());

it("plays the opening once, then starts later launch states settled", async () => {
  const first = await renderComponent(<LaunchScreen status="正在打开你的工作区" />);
  expect(first.container.querySelector(".ob-launch")?.classList.contains("is-settled")).toBe(false);
  expect(first.container.querySelector('[role="status"]')?.textContent).toBe("正在打开你的工作区");
  expect(first.container.textContent).toContain("模型设置与已有对话会自动恢复");
  await first.unmount();

  const second = await renderComponent(<LaunchScreen status="正在读取模型设置" keychain />);
  expect(second.container.querySelector(".ob-launch")?.classList.contains("is-settled")).toBe(true);
  expect(second.container.textContent).toContain("系统可能会请求钥匙串密码");
  await second.unmount();
});

it("shows an error with its actions and without the restore footnote", async () => {
  const retry = vi.fn();
  const view = await renderComponent(
    <LaunchScreen
      status="正在打开你的工作区"
      error="offline"
      keychain
      actions={
        <button type="button" onClick={retry}>
          重试
        </button>
      }
    />,
  );
  try {
    expect(view.container.querySelector("h1")?.textContent).toBe("启动需要处理");
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe("offline");
    expect(view.container.querySelector('[role="status"]')).toBeNull();
    expect(view.container.textContent).not.toContain("钥匙串");
    expect(view.container.textContent).not.toContain("自动恢复");
    await interact(() => view.container.querySelector("button")?.click());
    expect(retry).toHaveBeenCalledOnce();
  } finally {
    await view.unmount();
  }
});

it("fades the last launch screen out over the workspace once, even without animation events", async () => {
  vi.useFakeTimers();
  const launch = await renderComponent(<LaunchScreen status="正在打开你的工作区" />);
  await launch.unmount();
  const workspace = await renderComponent(<LaunchExit />);
  expect(workspace.container.querySelector(".ob-launch-exit")?.getAttribute("aria-hidden")).toBe(
    "true",
  );
  await interact(() => vi.advanceTimersByTime(220));
  expect(workspace.container.querySelector(".ob-launch-exit")).toBeNull();
  await workspace.unmount();

  const later = await renderComponent(<LaunchExit />);
  expect(later.container.querySelector(".ob-launch-exit")).toBeNull();
  await later.unmount();
});

it("marks the current setup step and labels the page by its heading", async () => {
  const view = await renderComponent(
    <OnboardingFrame
      step={2}
      avatar={{ character: "round", accent: "green" }}
      title="进入 OpenBot"
      titleId="frame-title"
    >
      <p>content</p>
    </OnboardingFrame>,
  );
  try {
    expect(view.container.querySelector("main")?.getAttribute("aria-labelledby")).toBe(
      "frame-title",
    );
    expect(view.container.querySelector('[aria-current="step"]')?.textContent).toBe("2 登录");
    expect(view.container.querySelector(".ob-setup-avatar")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  } finally {
    await view.unmount();
  }
});
