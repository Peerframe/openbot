// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from "vitest";
import { interact, renderComponent } from "../test/render-component";
import { Dialog } from "./Dialog";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});

it("opens one labelled modal frame with intro, actions and a named close", async () => {
  const onClose = vi.fn();
  const confirm = vi.fn();
  const view = await renderComponent(
    <Dialog
      title="永久删除这个 Bot？"
      intro="删除后不能恢复。"
      width={480}
      onClose={onClose}
      footer={
        <button type="button" className="ob-pill is-large is-danger" onClick={confirm}>
          永久删除
        </button>
      }
    >
      <p>details</p>
    </Dialog>,
  );
  try {
    const dialog = view.container.querySelector("dialog");
    if (!dialog) throw new Error("dialog missing");
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
    expect(dialog.classList.contains("ob-dialog")).toBe(true);
    expect(dialog.style.getPropertyValue("--ob-dialog-width")).toBe("480px");
    const title = dialog.querySelector("h2");
    expect(dialog.getAttribute("aria-labelledby")).toBe(title?.id);
    expect(dialog.getAttribute("aria-describedby")).toBe(dialog.querySelector("header p")?.id);
    await interact(() =>
      dialog.querySelector<HTMLButtonElement>(".ob-dialog-actions button")?.click(),
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    await interact(() => dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.click());
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    await view.unmount();
  }
});

it("cancelling with Escape closes without confirming", async () => {
  const onClose = vi.fn();
  const view = await renderComponent(
    <Dialog title="分享" onClose={onClose}>
      <p>body</p>
    </Dialog>,
  );
  try {
    const dialog = view.container.querySelector("dialog");
    await interact(() => dialog?.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(onClose).toHaveBeenCalledOnce();
    expect(view.container.querySelector("footer")).toBeNull();
  } finally {
    await view.unmount();
  }
});
