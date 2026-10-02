// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { deferred, interact, renderComponent, setInputValue } from "../test/render-component";
import { DesktopConnectionScreen, desktopConnectionErrorMessage } from "./DesktopConnectionScreen";

describe("DesktopConnectionScreen", () => {
  it("labels the Server URL and prevents duplicate checks", async () => {
    const pending = deferred<{ status: "configured"; serverUrl: string }>();
    const onConfigure = vi.fn(() => pending.promise);
    const rendered = await renderComponent(
      <DesktopConnectionScreen connection={{ status: "unconfigured" }} onConfigure={onConfigure} />,
    );
    try {
      const input = getServerInput(rendered.container);
      const form = rendered.container.querySelector("form");
      if (form === null) throw new Error("Connection form not found.");
      expect(input.labels?.[0]).toBe(rendered.container.querySelector("label"));
      expect(input.autocomplete).toBe("url");
      expect(input.getAttribute("spellcheck")).toBe("false");
      expect(getSubmitButton(rendered.container).disabled).toBe(true);

      await setInputValue(input, "https://openbot.example");
      await interact(() =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(onConfigure).toHaveBeenCalledWith("https://openbot.example");
      expect(getSubmitButton(rendered.container).disabled).toBe(true);
      expect(getSubmitButton(rendered.container).textContent).toBe("正在检查…");

      await interact(() =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(onConfigure).toHaveBeenCalledTimes(1);
      pending.resolve({ status: "configured", serverUrl: "https://openbot.example" });
      await pending.promise;
    } finally {
      await rendered.unmount();
    }
  });

  it("shows invalid retained state and maps bounded connection failures", async () => {
    const onConfigure = vi.fn(async () => ({
      status: "failed" as const,
      code: "server_redirected" as const,
    }));
    const rendered = await renderComponent(
      <DesktopConnectionScreen connection={{ status: "invalid" }} onConfigure={onConfigure} />,
    );
    try {
      expect(rendered.container.textContent).toContain("已保存的连接配置无效");
      await setInputValue(getServerInput(rendered.container), "https://redirect.example");
      const form = rendered.container.querySelector("form");
      if (form === null) throw new Error("Connection form not found.");
      await interact(() =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(rendered.container.querySelectorAll("[role='alert']")[1]?.textContent).toBe(
        desktopConnectionErrorMessage("server_redirected"),
      );
      expect(getSubmitButton(rendered.container).disabled).toBe(false);
    } finally {
      await rendered.unmount();
    }
  });

  it("prefills a configured Server and offers a non-destructive return action", async () => {
    const onCancel = vi.fn();
    const rendered = await renderComponent(
      <DesktopConnectionScreen
        canCancel
        connection={{ status: "configured", serverUrl: "https://openbot.example" }}
        onCancel={onCancel}
        onConfigure={vi.fn()}
      />,
    );
    try {
      expect(getServerInput(rendered.container).value).toBe("https://openbot.example");
      const returnButton = [...rendered.container.querySelectorAll("button")].find(
        (button) => button.textContent === "返回",
      );
      if (returnButton === undefined) throw new Error("Return button not found.");
      await interact(() => returnButton.click());
      expect(onCancel).toHaveBeenCalledOnce();
    } finally {
      await rendered.unmount();
    }
  });

  it("lets a remote client return to the role choice", async () => {
    const onChangePlan = vi.fn();
    const rendered = await renderComponent(
      <DesktopConnectionScreen
        connection={{ status: "unconfigured" }}
        onChangePlan={onChangePlan}
        onConfigure={vi.fn()}
        setupPlan={{ mode: "client", plannedWorkerCount: 0, localWorker: false }}
      />,
    );
    try {
      expect(rendered.container.textContent).toContain("连接服务电脑");
      const changeButton = [...rendered.container.querySelectorAll("button")].find(
        (button) => button.textContent === "换一种方式",
      );
      if (changeButton === undefined) throw new Error("Change plan button not found.");
      await interact(() => changeButton.click());
      expect(onChangePlan).toHaveBeenCalledOnce();
    } finally {
      await rendered.unmount();
    }
  });
});

function getServerInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector("#desktop-server-url");
  if (!(input instanceof HTMLInputElement)) throw new Error("Server input not found.");
  return input;
}

function getSubmitButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector("button[type='submit']");
  if (!(button instanceof HTMLButtonElement)) throw new Error("Submit button not found.");
  return button;
}
