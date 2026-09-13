// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  downloadAttachment,
  EMPTY_PDF_EXTRACT_ERROR,
  updateAttachment,
} from "../channel-attachment-client";
import { interact, renderComponent, setInputValue } from "../test/render-component";
import { AttachmentActions } from "./AttachmentActions";

vi.mock("../channel-attachment-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channel-attachment-client")>();
  return {
    ...actual,
    updateAttachment: vi.fn(),
    downloadAttachment: vi.fn(),
  };
});
afterEach(() => vi.clearAllMocks());
const attachment = {
  id: "00000000-0000-4000-8000-000000000001",
  channelId: "00000000-0000-4000-8000-000000000002",
  name: "private.pdf",
  mediaType: "application/pdf" as const,
  sizeBytes: 100,
  sha256: "a".repeat(64),
  createdAt: "2026-09-10T00:00:00.000Z",
};
function button(container: HTMLElement, label: string) {
  const match = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent === label,
  );
  if (!match) throw new Error("Button missing");
  return match;
}
it("submits a PDF password only on explicit extraction and clears it immediately", async () => {
  vi.mocked(updateAttachment).mockResolvedValue(attachment);
  const onChange = vi.fn();
  const view = await renderComponent(
    <AttachmentActions attachment={attachment} onChange={onChange} />,
  );
  const input = view.container.querySelector("input");
  if (!input) throw new Error("Password input missing");
  await setInputValue(input, "ephemeral");
  await interact(() => button(view.container, "提取文档文字").click());
  expect(updateAttachment).toHaveBeenCalledWith(
    attachment,
    "extract",
    "ephemeral",
    expect.any(AbortSignal),
  );
  expect(input.value).toBe("");
  expect(onChange).toHaveBeenCalledWith(attachment);
  await view.unmount();
});
it("keeps transcription explicit and sends no media on mount", async () => {
  const media = { ...attachment, name: "recording.mp3", mediaType: "audio/mpeg" as const };
  vi.mocked(updateAttachment).mockResolvedValue(media);
  const view = await renderComponent(<AttachmentActions attachment={media} onChange={() => {}} />);
  expect(updateAttachment).not.toHaveBeenCalled();
  expect(view.container.textContent).toContain("点击转写会将此媒体发送");
  await interact(() => button(view.container, "发送至 OpenAI 转写").click());
  expect(updateAttachment).toHaveBeenCalledWith(
    media,
    "transcribe",
    undefined,
    expect.any(AbortSignal),
  );
  await view.unmount();
});
it("uses the controlled original downloader", async () => {
  vi.mocked(downloadAttachment).mockResolvedValue();
  const view = await renderComponent(
    <AttachmentActions attachment={attachment} onChange={() => {}} />,
  );
  await interact(() => button(view.container, "下载原文件").click());
  expect(downloadAttachment).toHaveBeenCalledWith(attachment);
  await view.unmount();
});
it("shows Chinese copy for an exact empty-PDF extract failure and keeps the original", async () => {
  const onChange = vi.fn();
  vi.mocked(updateAttachment).mockRejectedValue(new Error(EMPTY_PDF_EXTRACT_ERROR));
  const view = await renderComponent(
    <AttachmentActions attachment={attachment} onChange={onChange} />,
  );
  await interact(() => button(view.container, "提取文档文字").click());
  const alert = view.container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("未找到可读的 PDF 文字");
  expect(alert?.textContent).toContain("扫描件或空白文档");
  expect(alert?.textContent).not.toContain("No readable PDF text");
  expect(onChange).not.toHaveBeenCalled();
  expect(button(view.container, "提取文档文字").disabled).toBe(false);
  await view.unmount();
});
it("does not present an unknown extract failure as a scanned-PDF reason", async () => {
  const onChange = vi.fn();
  vi.mocked(updateAttachment).mockRejectedValue(
    new Error("Attachment parser exceeded resources or failed."),
  );
  const view = await renderComponent(
    <AttachmentActions attachment={attachment} onChange={onChange} />,
  );
  await interact(() => button(view.container, "提取文档文字").click());
  const alert = view.container.querySelector('[role="alert"]');
  expect(alert?.textContent).toBe("Attachment parser exceeded resources or failed.");
  expect(alert?.textContent).not.toContain("扫描件");
  expect(alert?.textContent).not.toContain("未找到可读的 PDF 文字");
  expect(onChange).not.toHaveBeenCalled();
  await view.unmount();
});
it("lets the Owner cancel an in-flight extract without treating it as success", async () => {
  let rejectUpdate: ((reason: Error) => void) | undefined;
  vi.mocked(updateAttachment).mockImplementation(
    (_attachment, _operation, _password, signal) =>
      new Promise((_resolve, reject) => {
        rejectUpdate = reject;
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      }),
  );
  const onChange = vi.fn();
  const view = await renderComponent(
    <AttachmentActions attachment={attachment} onChange={onChange} />,
  );
  await interact(() => button(view.container, "提取文档文字").click());
  expect(button(view.container, "取消处理")).toBeTruthy();
  await interact(() => button(view.container, "取消处理").click());
  rejectUpdate?.(new DOMException("Aborted", "AbortError"));
  expect(onChange).not.toHaveBeenCalled();
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(button(view.container, "提取文档文字").disabled).toBe(false);
  await view.unmount();
});
