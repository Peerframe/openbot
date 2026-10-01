// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { deferred, interact, renderComponent, setInputValue } from "../test/render-component";
import { LoginScreen } from "./LoginScreen";

describe("LoginScreen", () => {
  it("labels the password control and prevents duplicate submission while pending", async () => {
    const pending = deferred();
    const onLogin = vi.fn(() => pending.promise);
    const rendered = await renderComponent(<LoginScreen ownerName="Owner" onLogin={onLogin} />);

    try {
      const input = getPasswordInput(rendered.container);
      const label = rendered.container.querySelector<HTMLLabelElement>("label");
      const button = getSubmitButton(rendered.container);
      const form = rendered.container.querySelector("form");
      if (form === null) throw new Error("Login form not found.");

      expect(rendered.container.querySelector("main")?.getAttribute("aria-labelledby")).toBe(
        "login-title",
      );
      expect(input.labels?.[0]).toBe(label);
      expect(input.autocomplete).toBe("current-password");
      expect(button.disabled).toBe(true);

      await setInputValue(input, "correct-owner-password");
      expect(button.disabled).toBe(false);
      await interact(() =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );

      expect(onLogin).toHaveBeenCalledTimes(1);
      expect(onLogin).toHaveBeenCalledWith("correct-owner-password");
      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe("正在验证…");

      await interact(() =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(onLogin).toHaveBeenCalledTimes(1);

      pending.resolve();
      await pending.promise;
    } finally {
      await rendered.unmount();
    }
  });

  it("announces stable authentication errors and permits a retry", async () => {
    const onLogin = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("Unauthorized", 401))
      .mockRejectedValueOnce(new ApiError("Rate limited", 429));
    const rendered = await renderComponent(<LoginScreen onLogin={onLogin} />);

    try {
      const input = getPasswordInput(rendered.container);
      const form = rendered.container.querySelector("form");
      if (form === null) throw new Error("Login form not found.");
      await setInputValue(input, "incorrect-owner-password");

      await interact(() =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(rendered.container.querySelector("[role='alert']")?.textContent).toBe(
        "密码不正确，请重试。",
      );
      expect(getSubmitButton(rendered.container).disabled).toBe(false);

      await interact(() =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(rendered.container.querySelector("[role='alert']")?.textContent).toBe(
        "尝试次数过多，请稍后再试。",
      );
      expect(onLogin).toHaveBeenCalledTimes(2);
      expect(getSubmitButton(rendered.container).disabled).toBe(false);
    } finally {
      await rendered.unmount();
    }
  });
});

function getPasswordInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector("#owner-password");
  if (!(input instanceof HTMLInputElement)) throw new Error("Password input not found.");
  return input;
}

function getSubmitButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector("button[type='submit']");
  if (!(button instanceof HTMLButtonElement)) throw new Error("Submit button not found.");
  return button;
}
