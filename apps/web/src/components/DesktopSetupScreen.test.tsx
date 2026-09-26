// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { interact, renderComponent } from "../test/render-component";
import { DesktopSetupScreen } from "./DesktopSetupScreen";

describe("Desktop role selection", () => {
  it.each(["host", "client"] as const)(
    "saves the %s role without planning or authorizing workers",
    async (mode) => {
      const onSave = vi.fn(async (plan) => ({ status: "configured" as const, plan }));
      const rendered = await renderComponent(
        <DesktopSetupScreen
          platform="darwin"
          arch="arm64"
          state={{ status: "unconfigured" }}
          onSave={onSave}
        />,
      );
      try {
        expect(rendered.container.querySelectorAll("input[type='radio']")).toHaveLength(2);
        expect(rendered.container.textContent).not.toContain("高级自部署");
        expect(rendered.container.querySelector("input[type='number']")).toBeNull();
        await interact(() =>
          (rendered.container.querySelector(`#desktop-mode-${mode}`) as HTMLInputElement).click(),
        );
        await interact(() =>
          rendered.container
            .querySelector("form")
            ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
        );
        expect(onSave).toHaveBeenCalledWith({ mode, plannedWorkerCount: 0, localWorker: false });
      } finally {
        await rendered.unmount();
      }
    },
  );
  it.each([
    ["linux", "x64"],
    [undefined, undefined],
    ["win32", "x64"],
    ["darwin", "x64"],
    ["darwin", undefined],
  ])(
    "offers a usable client default on %s/%s even with a retained host plan",
    async (platform, arch) => {
      const onSave = vi.fn(async (plan) => ({ status: "configured" as const, plan }));
      const rendered = await renderComponent(
        <DesktopSetupScreen
          platform={platform}
          arch={arch}
          state={{
            status: "configured",
            plan: { mode: "host", localWorker: false, plannedWorkerCount: 0 },
          }}
          onSave={onSave}
        />,
      );
      try {
        expect(rendered.container.querySelector("#desktop-mode-host")).toBeNull();
        expect(
          (rendered.container.querySelector("#desktop-mode-client") as HTMLInputElement).checked,
        ).toBe(true);
        await interact(() =>
          rendered.container
            .querySelector("form")
            ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
        );
        expect(onSave).toHaveBeenCalledWith({
          mode: "client",
          localWorker: false,
          plannedWorkerCount: 0,
        });
      } finally {
        await rendered.unmount();
      }
    },
  );
  it("keeps failed persistence visible and permits retry", async () => {
    const rendered = await renderComponent(
      <DesktopSetupScreen
        state={{ status: "invalid" }}
        onSave={vi.fn(async () => ({ status: "failed", code: "storage_unavailable" }))}
      />,
    );
    try {
      await interact(() =>
        rendered.container
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(rendered.container.textContent).toContain("无法安全保存安装计划");
      expect(
        (rendered.container.querySelector("button[type='submit']") as HTMLButtonElement).disabled,
      ).toBe(false);
    } finally {
      await rendered.unmount();
    }
  });
});
