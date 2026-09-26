// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import * as native from "../native-task-api";
import * as work from "../work-api";
import { nativeIds, nativeScope, ownerFile } from "../test/native-task-fixture";
import {
  deferred,
  interact,
  renderComponent,
  setInputValue,
  type RenderedComponent,
} from "../test/render-component";
import { workFixture } from "../test/work-fixture";
import { WorkTasksScreen } from "./WorkTasksScreen";
vi.mock("../work-api", () => ({
  createWorkTask: vi.fn(),
  getWorkTask: vi.fn(),
  cancelWorkTask: vi.fn(),
}));
vi.mock("../native-task-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../native-task-api")>()),
  getNativeTaskScope: vi.fn(),
  listOwnerAttachments: vi.fn(),
  uploadOwnerAttachment: vi.fn(),
  updateOwnerAttachment: vi.fn(),
}));
const bots = [
  { id: nativeIds.self, name: "Self", computerProfile: "none" as const },
  { id: nativeIds.peer, name: "Peer", computerProfile: "model" as const },
  {
    id: "10000000-0000-4000-8000-000000000004",
    name: "Browser",
    computerProfile: "macos-cua" as const,
  },
];
let ui: RenderedComponent;
function button(text: string) {
  return [...ui.container.querySelectorAll("button")].find((node) => node.textContent === text)!;
}
function checkbox(label: string) {
  return [...ui.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
    (node) =>
      node.getAttribute("aria-label") === label || node.parentElement?.textContent === label,
  )!;
}
async function mount(ready = true, taskId?: string) {
  ui = await renderComponent(
    <WorkTasksScreen bots={bots} active nativeCapabilitiesEnabled={ready} initialTaskId={taskId} />,
  );
}
async function load() {
  await interact(() => button("刷新附件列表").click());
}
async function pick() {
  await load();
  await interact(() => checkbox("选择附件 evidence.txt").click());
}
async function submit() {
  await interact(() => {
    const input = ui.container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      "Review evidence",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await interact(() =>
    ui.container
      .querySelector(".work-form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
async function upload(file: File) {
  await interact(() => {
    const input = ui.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(native.listOwnerAttachments).mockResolvedValue([ownerFile()]);
  vi.mocked(native.getNativeTaskScope).mockResolvedValue(null);
  vi.mocked(work.createWorkTask).mockResolvedValue(workFixture());
  vi.mocked(work.getWorkTask).mockImplementation(async (id) => workFixture({ id }));
});
afterEach(async () => {
  await ui?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("starts with empty scope, no file network/processing, compatible Bots only and no self collaborator", async () => {
  await mount();
  expect(
    [...ui.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(
      (node) => !node.checked,
    ),
  ).toBe(true);
  expect(
    [...ui.container.querySelectorAll("select option")].map((node) => node.textContent),
  ).toEqual(["Self", "Peer"]);
  expect(checkbox("允许协作 Self")).toBeUndefined();
  expect(checkbox("允许协作 Browser")).toBeUndefined();
  expect(native.listOwnerAttachments).not.toHaveBeenCalled();
  expect(native.updateOwnerAttachment).not.toHaveBeenCalled();
  await submit();
  expect(vi.mocked(work.createWorkTask).mock.calls[0]![0].scope).toEqual(
    native.emptyNativeTaskScope(),
  );
});
it("keeps extra capabilities unavailable until composition explicitly enables them", async () => {
  await mount(false);
  expect(checkbox("允许使用此 Bot 的知识").matches(":disabled")).toBe(true);
  await interact(() => checkbox("允许使用此 Bot 的知识").click());
  await pick();
  await submit();
  expect(vi.mocked(work.createWorkTask).mock.calls[0]![0].scope).toEqual({
    ...native.emptyNativeTaskScope(),
    attachmentIds: [nativeIds.file],
  });
});
it("freezes selected attachments and all grants with the original request key after an ambiguous create", async () => {
  vi.mocked(work.createWorkTask).mockRejectedValueOnce(new TypeError("lost response"));
  await mount();
  await pick();
  for (const label of [
    "允许使用此 Bot 的知识",
    "允许使用此 Bot 的插件",
    "允许访问网页",
    "允许协作 Peer",
  ])
    await interact(() => checkbox(label).click());
  await submit();
  const original = vi.mocked(work.createWorkTask).mock.calls[0]![0];
  expect(original.scope).toEqual({
    version: 1,
    attachmentIds: [nativeIds.file],
    collaboratorBotIds: [nativeIds.peer],
    knowledge: true,
    plugins: true,
    web: true,
  });
  expect(checkbox("选择附件 evidence.txt").matches(":disabled")).toBe(true);
  expect(button("移到回收站").matches(":disabled")).toBe(true);
  await interact(() => {
    window.dispatchEvent(new Event("online"));
    checkbox("允许访问网页").click();
  });
  expect(work.createWorkTask).toHaveBeenCalledOnce();
  await interact(() => button("重试同一创建请求").click());
  expect(vi.mocked(work.createWorkTask).mock.calls[1]![0]).toEqual(original);
});
it("resets scope for the next task and never carries a grant silently", async () => {
  await mount();
  await pick();
  await interact(() => checkbox("允许访问网页").click());
  await submit();
  await interact(() => button("创建另一个任务").click());
  await submit();
  expect(vi.mocked(work.createWorkTask).mock.calls[1]![0].scope).toEqual(
    native.emptyNativeTaskScope(),
  );
});
it("removes the newly selected owner Bot from collaborator choices", async () => {
  await mount();
  await interact(() => checkbox("允许协作 Peer").click());
  await interact(() => {
    const select = ui.container.querySelector("select")!;
    select.value = nativeIds.peer;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(checkbox("允许协作 Peer")).toBeUndefined();
  await submit();
  expect(vi.mocked(work.createWorkTask).mock.calls[0]![0]).toMatchObject({
    botId: nativeIds.peer,
    scope: { collaboratorBotIds: [] },
  });
});
it("uploads only on file selection and waits for explicit attachment selection", async () => {
  const pending = deferred<native.OwnerAttachment>();
  vi.mocked(native.uploadOwnerAttachment).mockReturnValue(pending.promise);
  await mount();
  const file = new File(["evidence"], "evidence.txt", { type: "text/plain" });
  await upload(file);
  expect(native.uploadOwnerAttachment).toHaveBeenCalledExactlyOnceWith(
    file,
    expect.any(AbortSignal),
  );
  expect(button("提交任务").disabled).toBe(true);
  await interact(() => pending.resolve(ownerFile()));
  expect(checkbox("选择附件 evidence.txt").checked).toBe(false);
  expect(native.updateOwnerAttachment).not.toHaveBeenCalled();
  await interact(() => checkbox("选择附件 evidence.txt").click());
  await submit();
  expect(vi.mocked(work.createWorkTask).mock.calls[0]![0].scope?.attachmentIds).toEqual([
    nativeIds.file,
  ]);
});
it.each([
  ["huge.txt", 262145],
  ["huge.png", 5 * 1024 * 1024 + 1],
  ["huge.pdf", 10 * 1024 * 1024 + 1],
  ["empty.txt", 0],
  ["unknown.exe", 1],
])("rejects an invalid file before upload: %s", async (name, size) => {
  await mount();
  const file = new File(["x"], name);
  Object.defineProperty(file, "size", { value: size });
  await upload(file);
  expect(native.uploadOwnerAttachment).not.toHaveBeenCalled();
  expect(ui.container.querySelector('[role="alert"]')).not.toBeNull();
});
it("keeps metadata intact, unselects without deletion and applies soft deletion only after its response", async () => {
  await mount();
  await pick();
  expect(ui.container.textContent).toContain(ownerFile().sha256);
  expect(ui.container.textContent).toContain("text/plain · 19 字节");
  await interact(() => checkbox("选择附件 evidence.txt").click());
  expect(native.updateOwnerAttachment).not.toHaveBeenCalled();
  await interact(() => checkbox("选择附件 evidence.txt").click());
  const pending = deferred<native.OwnerAttachment>();
  vi.mocked(native.updateOwnerAttachment).mockReturnValue(pending.promise);
  await interact(() => button("移到回收站").click());
  expect(checkbox("选择附件 evidence.txt").checked).toBe(true);
  await interact(() => pending.resolve(ownerFile({ deletedAt: "2026-09-25T00:00:00Z" })));
  expect(checkbox("选择附件 evidence.txt").checked).toBe(false);
  expect(checkbox("选择附件 evidence.txt").disabled).toBe(true);
  vi.mocked(native.updateOwnerAttachment).mockResolvedValueOnce(ownerFile());
  await interact(() => button("恢复附件").click());
  expect(checkbox("选择附件 evidence.txt").checked).toBe(false);
});
it("does not retry a lost deletion and requires refresh before submitting a selected file", async () => {
  vi.mocked(native.updateOwnerAttachment).mockRejectedValueOnce(
    new TypeError("private diagnostic"),
  );
  await mount();
  await pick();
  await interact(() => button("移到回收站").click());
  expect(button("提交任务").disabled).toBe(true);
  expect(ui.container.textContent).not.toContain("private diagnostic");
  await interact(() => window.dispatchEvent(new Event("online")));
  expect(native.updateOwnerAttachment).toHaveBeenCalledOnce();
  await load();
  expect(button("提交任务").disabled).toBe(false);
});
it("never processes PDF/image/audio automatically; a PDF password is transient and absent from task input", async () => {
  const pdf = ownerFile({ name: "evidence.pdf", mediaType: "application/pdf" });
  vi.mocked(native.listOwnerAttachments).mockResolvedValue([pdf]);
  vi.mocked(native.updateOwnerAttachment).mockResolvedValue({
    ...pdf,
    processing: {
      operation: "extract",
      characters: 20,
      truncated: false,
      processedAt: "2026-09-25T00:00:00Z",
    },
  });
  await mount();
  await load();
  await interact(() => checkbox("选择附件 evidence.pdf").click());
  expect(native.updateOwnerAttachment).not.toHaveBeenCalled();
  const password = ui.container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await setInputValue(password, "synthetic-secret");
  await interact(() => button("提取文档文字").click());
  expect(password.value).toBe("");
  expect(native.updateOwnerAttachment).toHaveBeenCalledExactlyOnceWith(
    nativeIds.file,
    "extract",
    expect.any(AbortSignal),
    "synthetic-secret",
  );
  await submit();
  expect(JSON.stringify(vi.mocked(work.createWorkTask).mock.calls[0]![0])).not.toContain(
    "synthetic-secret",
  );
});
it.each([
  ["image.png", "image/png", "识别图片文字", "ocr", false],
  ["voice.mp3", "audio/mpeg", "发送至 OpenAI 转写", "transcribe", true],
  [
    "office.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "提取文档文字",
    "extract",
    true,
  ],
])(
  "offers explicit processing for %s and blocks required unprocessed inputs",
  async (name, mediaType, label, operation, required) => {
    const file = ownerFile({ name, mediaType });
    vi.mocked(native.listOwnerAttachments).mockResolvedValue([file]);
    vi.mocked(native.updateOwnerAttachment).mockResolvedValue({
      ...file,
      processing: {
        operation,
        characters: 10,
        truncated: true,
        processedAt: "2026-09-25T00:00:00Z",
      },
    });
    await mount();
    await load();
    await interact(() => checkbox(`选择附件 ${name}`).click());
    expect(native.updateOwnerAttachment).not.toHaveBeenCalled();
    expect(button("提交任务").disabled).toBe(required);
    await interact(() => button(label).click());
    expect(button("提交任务").disabled).toBe(false);
    expect(ui.container.textContent).toContain("（已截断）");
  },
);
it("enforces the selection count and total byte budgets without dropping existing selections", async () => {
  const files = Array.from({ length: 9 }, (_, index) =>
    ownerFile({
      id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `f${index}.txt`,
    }),
  );
  vi.mocked(native.listOwnerAttachments).mockResolvedValue(files);
  await mount();
  await load();
  for (const file of files) await interact(() => checkbox(`选择附件 ${file.name}`).click());
  expect(ui.container.querySelectorAll(".native-task-files input:checked")).toHaveLength(8);
  expect(ui.container.textContent).toContain("最多选择 8 个附件");
  await ui.unmount();
  vi.mocked(native.listOwnerAttachments).mockResolvedValue(
    files
      .slice(0, 3)
      .map((file) => ({ ...file, mediaType: "application/pdf", sizeBytes: 10 * 1024 * 1024 })),
  );
  await mount();
  await load();
  for (const file of files.slice(0, 3))
    await interact(() => checkbox(`选择附件 ${file.name}`).click());
  expect(ui.container.querySelectorAll(".native-task-files input:checked")).toHaveLength(2);
});
it("aborts an in-flight upload on offline and ignores its late response without repeating it on reconnect", async () => {
  const pending = deferred<native.OwnerAttachment>();
  vi.mocked(native.uploadOwnerAttachment).mockReturnValue(pending.promise);
  await mount();
  await upload(new File(["x"], "evidence.txt"));
  const signal = vi.mocked(native.uploadOwnerAttachment).mock.calls[0]![1];
  await interact(() => window.dispatchEvent(new Event("offline")));
  await interact(() => pending.resolve(ownerFile()));
  expect(signal.aborted).toBe(true);
  expect(checkbox("选择附件 evidence.txt")).toBeUndefined();
  await interact(() => window.dispatchEvent(new Event("online")));
  expect(native.uploadOwnerAttachment).toHaveBeenCalledOnce();
  await load();
  expect(checkbox("选择附件 evidence.txt").checked).toBe(false);
});
it("recovers from upload 413 without creating a task or silently retrying", async () => {
  vi.mocked(native.uploadOwnerAttachment).mockRejectedValueOnce(new ApiError("private", 413));
  await mount();
  await upload(new File(["x"], "evidence.txt"));
  expect(ui.container.textContent).toContain("附件超过大小限制");
  expect(work.createWorkTask).not.toHaveBeenCalled();
  expect(native.uploadOwnerAttachment).toHaveBeenCalledOnce();
});
it("shows submitted scope read-only and leaves exact approvals/reconciliation unchanged", async () => {
  vi.mocked(native.getNativeTaskScope).mockResolvedValue(
    nativeScope({ knowledge: true, collaboratorBotIds: [nativeIds.peer] }),
  );
  await mount(true, "task-one");
  const section = ui.container.querySelector(".native-task-scope-readonly")!;
  expect(section.textContent).toContain("已授权");
  expect(section.textContent).toContain(nativeIds.peer);
  expect(section.textContent).toContain("元数据 SHA-256");
  expect(section.querySelectorAll("input,select,textarea")).toHaveLength(0);
  expect(work.createWorkTask).not.toHaveBeenCalled();
  expect(native.updateOwnerAttachment).not.toHaveBeenCalled();
});
it("clears old scope on lookup and discards a late previous task response", async () => {
  const old = deferred<native.NativeTaskScope>();
  vi.mocked(native.getNativeTaskScope)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(nativeScope({ knowledge: true }));
  await mount(true, "task-one");
  const signal = vi.mocked(native.getNativeTaskScope).mock.calls[0]![1];
  await setInputValue(
    ui.container.querySelector<HTMLInputElement>(".work-lookup input")!,
    "task-two",
  );
  await interact(() => button("读取任务").click());
  await interact(() => old.resolve(nativeScope({ web: true })));
  expect(signal.aborted).toBe(true);
  const section = ui.container.querySelector(".native-task-scope-readonly")!;
  expect(section.textContent).toContain("知识已授权");
  expect(section.textContent).toContain("网页未授权");
});
it("discards late scope reads after offline and does not portray a failed scope GET as empty authority", async () => {
  const pending = deferred<native.NativeTaskScope>();
  vi.mocked(native.getNativeTaskScope)
    .mockReturnValueOnce(pending.promise)
    .mockRejectedValueOnce(new ApiError("private", 403));
  await mount(true, "task-one");
  const signal = vi.mocked(native.getNativeTaskScope).mock.calls[0]![1];
  await interact(() => window.dispatchEvent(new Event("offline")));
  await interact(() => pending.resolve(nativeScope()));
  expect(signal.aborted).toBe(true);
  expect(ui.container.querySelector(".native-task-scope-readonly")!.textContent).not.toContain(
    ownerFile().name,
  );
  await interact(() => window.dispatchEvent(new Event("online")));
  expect(ui.container.textContent).toContain("不能据此判断任务没有额外权限");
  expect(ui.container.textContent).not.toContain("private");
});
