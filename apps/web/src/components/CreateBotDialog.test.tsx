// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deferred,
  interact,
  renderComponent,
  setInputValue,
  type RenderedComponent,
} from "../test/render-component";
import { CreateBotDialog } from "./CreateBotDialog";

const views: RenderedComponent[] = [];

function Harness({
  onCreate = async () => undefined,
}: {
  onCreate?: (input: { name: string; role: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        创建 Bot
      </button>
      {open ? (
        <CreateBotDialog
          onClose={() => setOpen(false)}
          onCreate={async (input) => {
            await onCreate(input);
            setOpen(false);
          }}
          onImport={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});

afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
  vi.restoreAllMocks();
});

async function openDialog(onCreate?: (input: { name: string; role: string }) => Promise<void>) {
  const view = await renderComponent(<Harness {...(onCreate ? { onCreate } : {})} />);
  views.push(view);
  const opener = view.container.querySelector<HTMLButtonElement>("button");
  if (!opener) throw new Error("No opener");
  await interact(() => {
    opener.focus();
    opener.click();
  });
  const dialog = view.container.querySelector<HTMLDialogElement>("dialog");
  if (!dialog) throw new Error("No dialog");
  return { view, dialog, opener };
}

async function setTextAreaValue(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter === undefined) throw new Error("Textarea value setter is unavailable.");
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CreateBotDialog modal lifecycle", () => {
  it("opens through showModal with labelled dialog and named icon close", async () => {
    const { dialog } = await openDialog();
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute("aria-labelledby")).toBe("create-bot-title");
    expect(dialog.querySelector('[aria-label="关闭"]')).not.toBeNull();
  });

  it("unmounts on cancel and on the icon close control", async () => {
    const cancelled = await openDialog();
    await interact(() =>
      cancelled.dialog.dispatchEvent(new Event("cancel", { cancelable: true })),
    );
    expect(cancelled.view.container.querySelector("dialog")).toBeNull();

    const closed = await openDialog();
    await interact(() =>
      closed.dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.click(),
    );
    expect(closed.view.container.querySelector("dialog")).toBeNull();
  });

  it("surfaces a failed onCreate rejection with role=alert without closing", async () => {
    const failure = deferred<void>();
    const { view, dialog } = await openDialog(() => failure.promise);

    const nameInput = dialog.querySelector<HTMLInputElement>("input");
    const roleInput = dialog.querySelector<HTMLTextAreaElement>("textarea");
    if (!nameInput || !roleInput) throw new Error("Create Bot fields missing");
    await setInputValue(nameInput, "Ops");
    await setTextAreaValue(roleInput, "值班");

    await interact(() => dialog.querySelector("form")?.requestSubmit());
    expect(dialog.querySelector('[role="alert"]')).toBeNull();

    await interact(() => failure.reject(new Error("名称已占用")));
    const alert = view.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("名称已占用");
    expect(view.container.querySelector("dialog")).not.toBeNull();
  });
});
