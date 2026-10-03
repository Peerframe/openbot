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
      url.endsWith("/purge")
        ? Response.json({ id: url.split("/").at(-2), purged: true, freedBytes: 2048 })
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

it("shows references and keeps referenced 回收站 files from permanent deletion", async () => {
  listed = [
    { ...upload("u1", "competitors.md"), referenceCount: { messages: 3, tasks: 1 } },
    {
      ...upload("u22", "旧版需求.docx", "2026-09-20T00:00:00.000Z"),
      referenceCount: { messages: 0, tasks: 0 },
    },
    {
      ...upload("u333", "渠道数据-8月.xlsx", "2026-09-18T00:00:00.000Z"),
      referenceCount: { messages: 3, tasks: 0 },
    },
  ];
  await open();
  expect(document.body.textContent).toContain("3 条消息引用、1 个任务引用");
  await interact(() => button("回收站 · 2").click());
  const rows = [...document.querySelectorAll(".channel-files-list li")];
  expect(rows[0]?.textContent).toContain("没有引用");
  const keptDelete = [...(rows[1]?.querySelectorAll("button") ?? [])].find(
    (item) => item.textContent === "永久删除",
  );
  expect(keptDelete?.disabled).toBe(true);
  expect(rows[1]?.textContent).toContain("还有消息在引用它，不能永久删除");
  // Only the unreferenced file counts toward 清空回收站.
  expect(button("清空回收站（1 个 · 2 KB）").disabled).toBe(false);
  expect(vi.mocked(fetch).mock.calls.some(([url]) => /purge|cleanup/.test(String(url)))).toBe(
    false,
  );
});

it("permanently deletes one file only after the second confirmation", async () => {
  const id = "00000000-0000-4000-8000-000000000022";
  listed = [
    {
      ...upload("u1", "旧版需求.docx", "2026-09-20T00:00:00.000Z"),
      id,
      referenceCount: { messages: 0, tasks: 0 },
    },
  ];
  await open();
  await interact(() => button("回收站 · 1").click());
  await interact(() => button("永久删除").click());
  expect(document.querySelector(".channel-files-confirm")?.textContent).toContain(
    "永久删除「旧版需求.docx」？",
  );
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/purge"))).toBe(false);
  await interact(() =>
    document.querySelector<HTMLButtonElement>(".channel-files-confirm .is-danger")?.click(),
  );
  const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/purge"));
  expect(call?.[0]).toBe(`/api/v1/channels/channel/attachments/${id}/purge`);
  expect(call?.[1]).toMatchObject({ method: "DELETE" });
  expect(document.body.textContent).toContain("已永久删除「旧版需求.docx」，释放 2 KB。");
  expect(document.querySelector(".channel-files-confirm")).toBeNull();
});

it("retries an unclear 清空回收站 with the same request key", async () => {
  listed = [
    {
      ...upload("u22", "旧版需求.docx", "2026-09-20T00:00:00.000Z"),
      referenceCount: { messages: 0, tasks: 0 },
    },
  ];
  let attempts = 0;
  vi.mocked(fetch).mockImplementation(async (url) => {
    if (!String(url).endsWith("/cleanup")) return Response.json({ attachments: listed });
    attempts += 1;
    if (attempts === 1) throw new TypeError("Failed to fetch");
    return Response.json({
      removed: 1,
      retained: [],
      retainedCount: 0,
      retainedHasMore: false,
      freedBytes: 2048,
    });
  });
  await open();
  await interact(() => button("回收站 · 1").click());
  await interact(() => button("清空回收站（1 个 · 2 KB）").click());
  const confirm = () =>
    document.querySelector<HTMLButtonElement>(".channel-files-confirm .is-danger");
  await interact(() => confirm()?.click());
  expect(document.querySelector(".channel-files-confirm")?.textContent).toContain("不会重复删除");
  expect(confirm()?.textContent).toBe("重试");
  await interact(() => confirm()?.click());
  const keys = vi
    .mocked(fetch)
    .mock.calls.filter(([url]) => String(url).endsWith("/cleanup"))
    .map(([, init]) => JSON.parse(String(init?.body)).requestKey);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(keys[1]).toBe(keys[0]);
  expect(document.body.textContent).toContain("已永久删除 1 个文件，释放 2 KB。");
});
