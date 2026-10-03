// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentPurgedError,
  getAttachmentImage,
  getChannelAttachment,
} from "../channel-attachment-client";
import { deferred, interact, renderComponent } from "../test/render-component";
import { MessageAttachments } from "./MessageAttachments";

vi.mock("../channel-attachment-client", async (original) => ({
  ...(await original<typeof import("../channel-attachment-client")>()),
  getAttachmentImage: vi.fn(),
  getChannelAttachment: vi.fn(),
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const id = "00000000-0000-4000-8000-000000000011";
const attachment = {
  id,
  channelId: "channel",
  name: "image.png",
  mediaType: "image/png" as const,
  sizeBytes: 8,
  sha256: "a".repeat(64),
  createdAt: "2026-09-10T00:00:00Z",
};
describe("sent message attachment cards", () => {
  it("opens the image in a modal and closes through native Escape and explicit close", async () => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    });
    vi.mocked(getChannelAttachment).mockResolvedValue(attachment);
    vi.mocked(getAttachmentImage).mockResolvedValue(new Blob(["image"], { type: "image/png" }));
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn().mockReturnValue("blob:scoped-preview"),
      revokeObjectURL: vi.fn(),
    });
    const view = await renderComponent(
      <MessageAttachments channelId="channel" content={`[OpenBot attachment: ${id}]`} />,
    );
    const button = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="预览 image.png"]',
    );
    if (!button) throw new Error("Preview button missing.");
    button.focus();
    await interact(() => button.click());
    expect(view.container.querySelector("dialog")?.open).toBe(true);
    expect(view.container.querySelector("dialog img")?.getAttribute("src")).toBe(
      "blob:scoped-preview",
    );
    await interact(() =>
      view.container
        .querySelector("dialog")
        ?.dispatchEvent(new Event("cancel", { cancelable: true })),
    );
    expect(view.container.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
    await interact(() => button.click());
    await interact(() =>
      view.container.querySelector<HTMLButtonElement>('button[aria-label="关闭图片预览"]')?.click(),
    );
    expect(view.container.querySelector("dialog")).toBeNull();
    await view.unmount();
  });

  it("renders safe named cards instead of machine markers and releases image URLs", async () => {
    vi.mocked(getChannelAttachment).mockResolvedValue(attachment);
    vi.mocked(getAttachmentImage).mockResolvedValue(new Blob(["image"], { type: "image/png" }));
    const create = vi.fn().mockReturnValue("blob:scoped-preview");
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    const view = await renderComponent(
      <MessageAttachments
        channelId="channel"
        content={`**Please inspect**\n\nUser-provided attachment: image.png (image/png, 8 bytes)\n[OpenBot attachment: ${id}]`}
      />,
    );
    expect(view.container.textContent).toContain("Please inspect");
    expect(view.container.textContent).toContain("image.png");
    expect(view.container.textContent).not.toContain("OpenBot attachment");
    expect(view.container.textContent).not.toContain("User-provided");
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe("blob:scoped-preview");
    expect(view.container.querySelector("strong")?.textContent).toBe("Please inspect");
    await view.unmount();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:scoped-preview");
  });
  it("does not fetch bytes after metadata is denied", async () => {
    vi.mocked(getChannelAttachment).mockRejectedValue(new Error("forbidden"));
    const view = await renderComponent(
      <MessageAttachments channelId="channel" content={`[OpenBot attachment: ${id}]`} />,
    );
    expect(view.container.textContent).toBe("附件暂不可用或无权访问");
    expect(getAttachmentImage).not.toHaveBeenCalled();
    await view.unmount();
  });
  it("shows a quiet placeholder for a permanently deleted file", async () => {
    vi.mocked(getChannelAttachment).mockRejectedValue(new AttachmentPurgedError());
    const view = await renderComponent(
      <MessageAttachments channelId="channel" content={`见附件\n[OpenBot attachment: ${id}]`} />,
    );
    expect(view.container.querySelector(".message-attachment-card.is-purged")?.textContent).toBe(
      "—附件已永久删除",
    );
    expect(getAttachmentImage).not.toHaveBeenCalled();
    await view.unmount();
  });
  it("aborts stale metadata and cannot create a blob URL after unmount", async () => {
    vi.mocked(getChannelAttachment).mockResolvedValue(attachment);
    const image = deferred<Blob>();
    vi.mocked(getAttachmentImage).mockReturnValue(image.promise);
    const create = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: vi.fn() });
    const view = await renderComponent(
      <MessageAttachments channelId="channel" content={`[OpenBot attachment: ${id}]`} />,
    );
    const signal = vi.mocked(getAttachmentImage).mock.calls[0]?.[1];
    await view.unmount();
    expect(signal?.aborted).toBe(true);
    await interact(() => image.resolve(new Blob(["image"])));
    expect(create).not.toHaveBeenCalled();
  });
});
