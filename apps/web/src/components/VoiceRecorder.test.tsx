// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { uploadComposerAttachment } from "../composer-context";
import { getOpenBotDesktopBridge } from "../desktop-runtime";
import {
  deferred,
  interact,
  type RenderedComponent,
  renderComponent,
} from "../test/render-component";
import { VoiceRecorder } from "./VoiceRecorder";

vi.mock("../desktop-runtime", () => ({ getOpenBotDesktopBridge: vi.fn() }));
vi.mock("../composer-context", async (original) => ({
  ...(await original<typeof import("../composer-context")>()),
  uploadComposerAttachment: vi.fn(),
}));
const views: RenderedComponent[] = [];
const stop = vi.fn();
const getUserMedia = vi.fn();
const beginVoiceCapture = vi.fn();
const endVoiceCapture = vi.fn();
const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
let recorder: Recorder;
class Recorder {
  static isTypeSupported = () => true;
  state = "inactive";
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  onerror?: () => void;
  constructor() {
    recorder = this;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2])], { type: "audio/webm" }),
    });
    this.onstop?.();
  }
}
function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === name || item.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}
async function render() {
  const change = vi.fn();
  const view = await renderComponent(
    <VoiceRecorder channelId="channel" getAttachments={() => []} onChange={change} />,
  );
  views.push(view);
  return { ...view, change };
}
beforeEach(() => {
  vi.resetAllMocks();
  beginVoiceCapture.mockResolvedValue(true);
  endVoiceCapture.mockResolvedValue(undefined);
  getUserMedia.mockResolvedValue(stream);
  vi.mocked(getOpenBotDesktopBridge).mockReturnValue({
    beginVoiceCapture,
    endVoiceCapture,
  } as never);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", Recorder);
  URL.createObjectURL = vi.fn(() => "blob:voice-review");
  URL.revokeObjectURL = vi.fn();
});
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
  vi.unstubAllGlobals();
});
it("acquires only after a click, arms before media and revokes immediately after acquisition", async () => {
  await render();
  expect(beginVoiceCapture).not.toHaveBeenCalled();
  expect(getUserMedia).not.toHaveBeenCalled();
  await interact(() => button("录制语音附件").click());
  expect(beginVoiceCapture).toHaveBeenCalledOnce();
  expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true, video: false });
  expect(beginVoiceCapture.mock.invocationCallOrder[0]).toBeLessThan(
    getUserMedia.mock.invocationCallOrder[0] ?? 0,
  );
  expect(getUserMedia.mock.invocationCallOrder[0]).toBeLessThan(
    endVoiceCapture.mock.invocationCallOrder[0] ?? 0,
  );
  expect(document.querySelector('[role="status"]')?.textContent).toContain("录音中");
  await interact(() => button("结束录音").click());
  expect(stop).toHaveBeenCalled();
  expect(document.querySelector("audio")?.getAttribute("src")).toBe("blob:voice-review");
});
it("keeps denied permission visible without touching media or uploading", async () => {
  beginVoiceCapture.mockResolvedValue(false);
  await render();
  await interact(() => button("录制语音附件").click());
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(uploadComposerAttachment).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("未获得麦克风权限");
  expect(button("录制语音附件").disabled).toBe(false);
});
it("stops all tracks on unmount during recording", async () => {
  await render();
  await interact(() => button("录制语音附件").click());
  await views.pop()?.unmount();
  expect(recorder.state).toBe("inactive");
  expect(stop).toHaveBeenCalled();
  expect(uploadComposerAttachment).not.toHaveBeenCalled();
});
it("does not acquire after leaving while the OS permission prompt is pending", async () => {
  const pending = deferred<boolean>();
  beginVoiceCapture.mockReturnValue(pending.promise);
  await render();
  await interact(() => button("录制语音附件").click());
  await views.pop()?.unmount();
  expect(endVoiceCapture).toHaveBeenCalled();
  await interact(() => pending.resolve(true));
  expect(getUserMedia).not.toHaveBeenCalled();
});
it("stops a late acquired stream after unmount", async () => {
  const pending = deferred<MediaStream>();
  getUserMedia.mockReturnValue(pending.promise);
  await render();
  await interact(() => button("录制语音附件").click());
  await views.pop()?.unmount();
  await interact(() => pending.resolve(stream));
  expect(stop).toHaveBeenCalled();
  expect(uploadComposerAttachment).not.toHaveBeenCalled();
});
it("retains review audio and retry after upload failure", async () => {
  vi.mocked(uploadComposerAttachment).mockRejectedValue(new Error("Upload unavailable"));
  const view = await render();
  await interact(() => button("录制语音附件").click());
  await interact(() => button("结束录音").click());
  await interact(() => button("添加到草稿").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Upload unavailable");
  expect(document.querySelector("audio")?.getAttribute("src")).toBe("blob:voice-review");
  expect(button("添加到草稿").disabled).toBe(false);
  expect(view.change).not.toHaveBeenCalled();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
});
it("revokes the lease when browser media permission is denied", async () => {
  getUserMedia.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
  await render();
  await interact(() => button("录制语音附件").click());
  expect(endVoiceCapture).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("未获得麦克风权限");
  expect(button("录制语音附件").disabled).toBe(false);
});
it("keeps an acquired stream owned when lease cleanup IPC fails", async () => {
  endVoiceCapture.mockRejectedValue(new Error("IPC unavailable"));
  await render();
  await interact(() => button("录制语音附件").click());
  expect(document.querySelector('[role="status"]')?.textContent).toContain("录音中");
  await views.pop()?.unmount();
  expect(stop).toHaveBeenCalled();
});

it("cancels attachment upload without losing local review or appending a late response", async () => {
  const upload = deferred<Awaited<ReturnType<typeof uploadComposerAttachment>>>();
  vi.mocked(uploadComposerAttachment).mockReturnValue(upload.promise);
  const view = await render();
  await interact(() => button("录制语音附件").click());
  await interact(() => button("结束录音").click());
  await interact(() => button("添加到草稿").click());
  const signal = vi.mocked(uploadComposerAttachment).mock.calls[0]?.[2];
  await interact(() => button("取消添加").click());
  expect(signal?.aborted).toBe(true);
  expect(document.querySelector("audio")).not.toBeNull();
  expect(button("添加到草稿").disabled).toBe(false);
  await interact(() => upload.resolve({ id: "late" } as never));
  expect(view.change).not.toHaveBeenCalled();
  expect(document.querySelector("audio")).not.toBeNull();
});
it("取消 while recording releases the microphone and keeps nothing", async () => {
  const active = vi.fn();
  const view = await renderComponent(
    <VoiceRecorder
      channelId="channel"
      getAttachments={() => []}
      onChange={vi.fn()}
      onActiveChange={active}
    />,
  );
  views.push(view);
  await interact(() => button("录制语音附件").click());
  expect(active).toHaveBeenLastCalledWith(true);
  await interact(() => button("取消").click());
  expect(stop).toHaveBeenCalled();
  expect(document.querySelector("audio")).toBeNull();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(active).toHaveBeenLastCalledWith(false);
  expect(button("录制语音附件").disabled).toBe(false);
});
it("重录 discards the review and opens the microphone again", async () => {
  await render();
  await interact(() => button("录制语音附件").click());
  await interact(() => button("结束录音").click());
  expect(document.querySelector(".voice-text strong")?.textContent).toMatch(/^语音 0:0\d$/);
  await interact(() => button("重录").click());
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice-review");
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="status"]')?.textContent).toContain("录音中");
});
