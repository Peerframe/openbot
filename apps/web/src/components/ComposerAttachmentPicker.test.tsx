// @vitest-environment jsdom
import { createRef, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposerAttachment, uploadComposerAttachment } from "../composer-context";
import { deferred, interact, renderComponent } from "../test/render-component";
import { ComposerAttachmentPicker, composerAttachmentsFull } from "./ComposerAttachmentPicker";

vi.mock("../composer-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../composer-context")>()),
  uploadComposerAttachment: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const channelId = "00000000-0000-4000-8000-000000000001";
function uploaded(name: string, id = "00000000-0000-4000-8000-000000000011") {
  return {
    id,
    channelId,
    name,
    mediaType: "text/plain" as const,
    sizeBytes: 4,
    sha256: "a".repeat(64),
    createdAt: "2026-09-10T00:00:00.000Z",
  };
}
async function pick(input: HTMLInputElement | null, files: File[]) {
  if (!input) throw new Error("Attachment input is missing.");
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await interact(() => input.dispatchEvent(new Event("change", { bubbles: true })));
}

describe("persistent composer attachment selection", () => {
  it("starts another upload after cancellation and ignores the cancelled response", async () => {
    const cancelled = deferred<ReturnType<typeof uploaded>>();
    const replacement = deferred<ReturnType<typeof uploaded>>();
    vi.mocked(uploadComposerAttachment)
      .mockReturnValueOnce(cancelled.promise)
      .mockReturnValueOnce(replacement.promise);
    let current: ComposerAttachment[] = [];
    const inputRef = createRef<HTMLInputElement>();
    const onUploadingChange = vi.fn();
    const view = await renderComponent(
      <ComposerAttachmentPicker
        channelId={channelId}
        attachments={[]}
        getAttachments={() => current}
        onChange={(next) => {
          current = next;
        }}
        inputRef={inputRef}
        onUploadingChange={onUploadingChange}
      />,
    );
    try {
      await pick(inputRef.current, [new File(["data"], "cancelled.txt")]);
      const signal = vi.mocked(uploadComposerAttachment).mock.calls[0]?.[2];
      const cancel = Array.from(view.container.querySelectorAll("button")).find(
        (button) => button.getAttribute("aria-label") === "取消上传",
      );
      if (!cancel) throw new Error("Missing upload cancellation.");
      await interact(() => cancel.click());
      expect(signal?.aborted).toBe(true);
      expect(onUploadingChange).toHaveBeenLastCalledWith(false);
      await pick(inputRef.current, [new File(["data"], "replacement.txt")]);
      await interact(() => cancelled.resolve(uploaded("cancelled.txt")));
      expect(current).toEqual([]);
      expect(onUploadingChange).toHaveBeenLastCalledWith(true);
      await interact(() => replacement.resolve(uploaded("replacement.txt")));
      expect(current.map((item) => item.name)).toEqual(["replacement.txt"]);
      expect(onUploadingChange).toHaveBeenLastCalledWith(false);
    } finally {
      await view.unmount();
    }
  });
  it("uploads multiple files while appending to the latest draft attachment list", async () => {
    const first = deferred<ReturnType<typeof uploaded>>();
    vi.mocked(uploadComposerAttachment)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(uploaded("second.py", "00000000-0000-4000-8000-000000000012"));
    let current: ComposerAttachment[] = [];
    const onChange = vi.fn((next: ComposerAttachment[]) => {
      current = next;
    });
    const onUploadingChange = vi.fn();
    const inputRef = createRef<HTMLInputElement>();
    const view = await renderComponent(
      <ComposerAttachmentPicker
        channelId={channelId}
        attachments={[]}
        getAttachments={() => current}
        onChange={onChange}
        inputRef={inputRef}
        onUploadingChange={onUploadingChange}
      />,
    );
    try {
      await pick(inputRef.current, [
        new File(["data"], "first.ts"),
        new File(["data"], "second.py"),
      ]);
      expect(inputRef.current?.multiple).toBe(true);
      expect(onUploadingChange).toHaveBeenLastCalledWith(true);
      current = [{ name: "added-during-upload.md", text: "keep" }];
      await interact(() => first.resolve(uploaded("first.ts")));
      expect(current.map((item) => item.name)).toEqual([
        "added-during-upload.md",
        "first.ts",
        "second.py",
      ]);
      expect(onUploadingChange).toHaveBeenLastCalledWith(false);
    } finally {
      await view.unmount();
    }
  });
  it("retains successful attachments and retries only the failed upload", async () => {
    vi.mocked(uploadComposerAttachment)
      .mockResolvedValueOnce(uploaded("first.ts"))
      .mockRejectedValueOnce(new Error("连接中断"))
      .mockResolvedValueOnce(uploaded("second.py", "00000000-0000-4000-8000-000000000012"));
    let current: ComposerAttachment[] = [];
    const inputRef = createRef<HTMLInputElement>();
    const view = await renderComponent(
      <ComposerAttachmentPicker
        channelId={channelId}
        attachments={[]}
        getAttachments={() => current}
        onChange={(next) => {
          current = next;
        }}
        inputRef={inputRef}
      />,
    );
    try {
      await pick(inputRef.current, [
        new File(["data"], "first.ts"),
        new File(["data"], "second.py"),
      ]);
      expect(current.map((item) => item.name)).toEqual(["first.ts"]);
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("连接中断");
      const retry = Array.from(view.container.querySelectorAll("button")).find(
        (button) => button.textContent === "重试失败的附件",
      );
      if (!retry) throw new Error("Missing failed attachment retry.");
      await interact(() => retry.click());
      expect(current.map((item) => item.name)).toEqual(["first.ts", "second.py"]);
      expect(vi.mocked(uploadComposerAttachment).mock.calls.map((call) => call[1].name)).toEqual([
        "first.ts",
        "second.py",
        "second.py",
      ]);
    } finally {
      await view.unmount();
    }
  });
  it("rejects duplicate/oversized batches before uploading", async () => {
    const inputRef = createRef<HTMLInputElement>();
    const current = [uploaded("first.ts")];
    const onChange = vi.fn();
    const view = await renderComponent(
      <ComposerAttachmentPicker
        channelId={channelId}
        attachments={current}
        getAttachments={() => current}
        onChange={onChange}
        inputRef={inputRef}
      />,
    );
    try {
      await pick(inputRef.current, [new File(["data"], "first.ts")]);
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("同名附件");
      expect(uploadComposerAttachment).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });
  it("aborts an unmounted picker without appending its late upload result", async () => {
    const pending = deferred<ReturnType<typeof uploaded>>();
    vi.mocked(uploadComposerAttachment).mockReturnValue(pending.promise);
    const onChange = vi.fn();
    const inputRef = createRef<HTMLInputElement>();
    const view = await renderComponent(
      <ComposerAttachmentPicker
        channelId={channelId}
        attachments={[]}
        getAttachments={() => []}
        onChange={onChange}
        inputRef={inputRef}
      />,
    );
    await pick(inputRef.current, [new File(["data"], "first.ts")]);
    const signal = vi.mocked(uploadComposerAttachment).mock.calls[0]?.[2];
    await view.unmount();
    expect(signal?.aborted).toBe(true);
    await interact(() => pending.resolve(uploaded("first.ts")));
    expect(onChange).not.toHaveBeenCalled();
  });
});

async function transferEvent(target: HTMLElement, type: string, files: File[], isPaste = false) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, isPaste ? "clipboardData" : "dataTransfer", {
    value: {
      files,
      types: files.length ? ["Files"] : ["text/plain"],
      items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
    },
  });
  await interact(() => target.dispatchEvent(event));
  return event;
}

describe("direct attachment input", () => {
  it("aborts a previous channel's upload without appending the result to the new draft", async () => {
    const response = deferred<ReturnType<typeof uploaded>>();
    vi.mocked(uploadComposerAttachment).mockReturnValue(response.promise);
    const change = vi.fn();
    function SwitchingPicker() {
      const [selected, setSelected] = useState(channelId);
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <>
          <button type="button" onClick={() => setSelected("other-channel")}>
            切换频道
          </button>
          <ComposerAttachmentPicker
            channelId={selected}
            attachments={[]}
            getAttachments={() => []}
            onChange={change}
            inputRef={inputRef}
          />
        </>
      );
    }
    const view = await renderComponent(<SwitchingPicker />);
    await pick(view.container.querySelector("input"), [new File(["data"], "first.ts")]);
    const signal = vi.mocked(uploadComposerAttachment).mock.calls[0]?.[2];
    await interact(() => view.container.querySelector("button")?.click());
    expect(signal?.aborted).toBe(true);
    await interact(() => response.resolve(uploaded("first.ts")));
    expect(change).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain("正在上传");
    await view.unmount();
  });

  it("routes real drops through the same uploader, shows drop feedback and removes listeners", async () => {
    vi.mocked(uploadComposerAttachment).mockResolvedValue(uploaded("dropped.md"));
    const dropTargetRef = createRef<HTMLDivElement>();
    let current: ComposerAttachment[] = [];
    const view = await renderComponent(
      <div ref={dropTargetRef}>
        <ComposerAttachmentPicker
          channelId={channelId}
          attachments={[]}
          getAttachments={() => current}
          onChange={(next) => {
            current = next;
          }}
          inputRef={createRef<HTMLInputElement>()}
          dropTargetRef={dropTargetRef}
        />
      </div>,
    );
    const target = dropTargetRef.current;
    if (!target) throw new Error("Drop target missing.");
    const files = [new File(["data"], "dropped.md")];
    expect((await transferEvent(target, "dragenter", files)).defaultPrevented).toBe(true);
    expect(target.classList.contains("attachment-drop-active")).toBe(true);
    expect(view.container.textContent).toContain("松开");
    expect((await transferEvent(target, "drop", files)).defaultPrevented).toBe(true);
    expect(target.classList.contains("attachment-drop-active")).toBe(false);
    expect(current.map((item) => item.name)).toEqual(["dropped.md"]);
    await view.unmount();
    expect((await transferEvent(target, "drop", files)).defaultPrevented).toBe(false);
    expect(uploadComposerAttachment).toHaveBeenCalledTimes(1);
  });
  it("preserves text paste and gives pasted screenshots distinct supported names", async () => {
    const existing = { ...uploaded("粘贴图片-1.png"), mediaType: "image/png" as const };
    let current: ComposerAttachment[] = [existing];
    vi.mocked(uploadComposerAttachment).mockImplementation(async (_channel, file) => ({
      ...uploaded(file.name),
      mediaType: "image/png" as const,
    }));
    const dropTargetRef = createRef<HTMLDivElement>();
    const view = await renderComponent(
      <div ref={dropTargetRef}>
        <textarea />
        <ComposerAttachmentPicker
          channelId={channelId}
          attachments={[]}
          getAttachments={() => current}
          onChange={(next) => {
            current = next;
          }}
          inputRef={createRef<HTMLInputElement>()}
          dropTargetRef={dropTargetRef}
        />
      </div>,
    );
    const textarea = view.container.querySelector("textarea");
    if (!textarea) throw new Error("Textarea missing.");
    expect((await transferEvent(textarea, "paste", [], true)).defaultPrevented).toBe(false);
    expect(uploadComposerAttachment).not.toHaveBeenCalled();
    expect(
      (
        await transferEvent(
          textarea,
          "paste",
          [new File(["data"], "image.png", { type: "image/png" })],
          true,
        )
      ).defaultPrevented,
    ).toBe(true);
    expect(current.map((item) => item.name)).toEqual(["粘贴图片-1.png", "粘贴图片-2.png"]);
    await view.unmount();
  });
  it("prevents disabled file-drop navigation without initiating uploads", async () => {
    const targetRef = createRef<HTMLDivElement>();
    const view = await renderComponent(
      <div ref={targetRef}>
        <ComposerAttachmentPicker
          channelId={channelId}
          disabled
          attachments={[]}
          getAttachments={() => []}
          onChange={vi.fn()}
          inputRef={createRef<HTMLInputElement>()}
          dropTargetRef={targetRef}
        />
      </div>,
    );
    const target = targetRef.current;
    if (!target) throw new Error("Drop target missing.");
    expect(
      (await transferEvent(target, "drop", [new File(["data"], "a.md")])).defaultPrevented,
    ).toBe(true);
    expect(uploadComposerAttachment).not.toHaveBeenCalled();
    await view.unmount();
  });
  it("continues a batch after one failed file while keeping all successful uploads", async () => {
    vi.mocked(uploadComposerAttachment)
      .mockResolvedValueOnce(uploaded("first.md"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(uploaded("last.md", "00000000-0000-4000-8000-000000000013"));
    let current: ComposerAttachment[] = [];
    const inputRef = createRef<HTMLInputElement>();
    const view = await renderComponent(
      <ComposerAttachmentPicker
        channelId={channelId}
        attachments={[]}
        getAttachments={() => current}
        onChange={(next) => {
          current = next;
        }}
        inputRef={inputRef}
      />,
    );
    await pick(inputRef.current, [
      new File(["data"], "first.md"),
      new File(["data"], "bad.md"),
      new File(["data"], "last.md"),
    ]);
    expect(current.map((item) => item.name)).toEqual(["first.md", "last.md"]);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "bad.md：offline",
    );
    await view.unmount();
  });
});

describe("attachment limits (Composer artboard)", () => {
  it("counts attachments and size and says when the draft is full", async () => {
    const eight = Array.from({ length: 8 }, (_, index) =>
      uploaded(
        `第 ${index + 1} 份很长的渠道数据汇总表-九月.xlsx`,
        `00000000-0000-4000-8000-00000000002${index}`,
      ),
    );
    expect(composerAttachmentsFull(eight.slice(0, 7))).toBe(false);
    expect(composerAttachmentsFull(eight)).toBe(true);
    expect(
      composerAttachmentsFull([{ ...eight[0], sizeBytes: 20 * 1024 * 1024 } as ComposerAttachment]),
    ).toBe(true);
    const view = await renderComponent(
      <ComposerAttachmentPicker
        channelId={channelId}
        attachments={eight}
        getAttachments={() => eight}
        onChange={vi.fn()}
        inputRef={createRef()}
      />,
    );
    expect(view.container.querySelector(".composer-attachment-count")?.textContent).toBe(
      "8 / 8 个附件 · 合计 32 B / 20 MB · 已到上限",
    );
    // Long names keep their extension; the full name stays available on hover.
    const name = view.container.querySelector(".attachment-card-name");
    expect(name?.textContent).toMatch(/…总表-九月\.xlsx$/);
    expect(name?.getAttribute("title")).toBe("第 1 份很长的渠道数据汇总表-九月.xlsx");
    await view.unmount();
  });
});
