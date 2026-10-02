// @vitest-environment jsdom
import type { Artifact } from "@openbot/domain";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { updateAttachment } from "../channel-attachment-client";
import type { UploadedComposerAttachment } from "../composer-context";
import { interact, type RenderedComponent, renderComponent } from "../test/render-component";
import { AttachmentsManagerDialog } from "./AttachmentsManager";

vi.mock("../channel-attachment-client", async (original) => ({
  ...(await original<typeof import("../channel-attachment-client")>()),
  updateAttachment: vi.fn(),
  downloadAttachment: vi.fn(async () => undefined),
}));

const views: RenderedComponent[] = [];
const upload = (id: string, name: string, deletedAt?: string): UploadedComposerAttachment =>
  ({
    id,
    channelId: "channel",
    name,
    mediaType: "text/markdown",
    sizeBytes: 2048,
    sha256: "a".repeat(64),
    createdAt: `2026-09-2${id.length}T00:00:00.000Z`,
    ...(deletedAt ? { deletedAt } : {}),
  }) as UploadedComposerAttachment;
const output: Artifact = {
  id: "art-1",
  runId: "run-1",
  name: "竞品定价对比.png",
  mediaType: "image/png",
  sha256: "b".repeat(64),
  sizeBytes: 248 * 1024,
  createdAt: "2026-09-29T00:00:00.000Z",
};
let listed: UploadedComposerAttachment[] = [];

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开频道文件
      </button>
      {open && (
        <AttachmentsManagerDialog
          channelId="channel"
          channelName="市场周报"
          outputs={[output]}
          botNameForRun={() => "研究助理"}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}
beforeEach(() => {
  listed = [
    upload("u1", "competitors.md"),
    upload("u22", "旧版需求.docx", "2026-09-20T00:00:00.000Z"),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/cleanup")
        ? Response.json({ removed: 1, retained: 0 })
        : Response.json({ attachments: listed }),
    ),
  );
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
  vi.unstubAllGlobals();
});
async function open() {
  const view = await renderComponent(<Harness />);
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

it("opens as a modal and closes on Escape, restoring the opener", async () => {
  const { view, dialog, opener } = await open();
  expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
  expect(dialog.querySelector("h2")?.textContent).toBe("市场周报 的文件");
  await interact(() => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
  expect(view.container.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it("aborts the file list request when closed", async () => {
  const { view } = await open();
  const signal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;
  expect(signal?.aborted).toBe(false);
  await interact(() => button("关闭").click());
  expect(view.container.querySelector("dialog")).toBeNull();
  expect(signal?.aborted).toBe(true);
});

it("lists uploads and outputs with counts; only uploads can go to the 回收站", async () => {
  await open();
  expect(button("文件 · 2").getAttribute("aria-selected")).toBe("true");
  expect(button("回收站 · 1")).toBeTruthy();
  expect(
    [...document.querySelectorAll(".channel-files-filters button")].map((item) => item.textContent),
  ).toEqual(["全部 2", "你上传 1", "Bot 产出 1"]);
  const rows = [...document.querySelectorAll(".channel-files-list li")];
  expect(rows.map((row) => row.querySelector("small")?.textContent?.split(" · ")[0])).toEqual([
    "研究助理 产出",
    "你上传",
  ]);
  expect(rows[0]?.textContent).not.toContain("移到回收站");
  vi.mocked(updateAttachment).mockResolvedValue({
    ...listed[0],
    deletedAt: "2026-10-02T00:00:00.000Z",
  } as UploadedComposerAttachment);
  await interact(() => button("移到回收站").click());
  expect(updateAttachment).toHaveBeenCalledWith(listed[0], "delete");
  expect(button("回收站 · 2")).toBeTruthy();
  await interact(() => button("Bot 产出 1").click());
  expect(document.querySelectorAll(".channel-files-list li")).toHaveLength(1);
});

it("offers no permanent cleanup and shows how many messages and tasks use a file", async () => {
  listed = [
    { ...upload("u1", "competitors.md"), referenceCount: { messages: 3, tasks: 1 } },
    {
      ...upload("u22", "旧版需求.docx", "2026-09-20T00:00:00.000Z"),
      referenceCount: { messages: 0, tasks: 0 },
    },
  ];
  await open();
  // C20 (#159): the 服务电脑 has no permanent cleanup route, so nothing offers one.
  expect(
    [...document.querySelectorAll("button")].some((item) => item.textContent?.includes("清理")),
  ).toBe(false);
  expect(document.querySelector(".channel-files-note")?.textContent).toContain("永久清理暂未提供");
  expect(document.body.textContent).toContain("3 条消息引用、1 个任务引用");
  await interact(() => button("回收站 · 1").click());
  expect(document.querySelector(".channel-files-list small")?.textContent).toContain(
    "没有消息或任务引用",
  );
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("cleanup"))).toBe(false);
});
