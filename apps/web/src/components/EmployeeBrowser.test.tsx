// @vitest-environment jsdom
import type { Bot } from "@openbot/domain";
import type { BrowserSessionView } from "@openbot/protocol";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, browserCommand, closeBrowser, openBrowser } from "../api";
import {
  deferred,
  interact,
  type RenderedComponent,
  renderComponent,
  setInputValue,
} from "../test/render-component";
import { EmployeeBrowser } from "./EmployeeBrowser";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  openBrowser: vi.fn(),
  browserCommand: vi.fn(),
  closeBrowser: vi.fn(),
}));
const bot: Bot = {
  id: "synthetic-bot",
  name: "Browser Bot",
  role: "Fixture",
  status: "idle",
  computerProfile: "docker-linux",
  createdAt: "2026-09-25T00:00:00Z",
};
const available: BrowserSessionView = {
  id: "view",
  botId: bot.id,
  nodeId: "worker",
  nodeName: "Synthetic Worker",
  control: "available",
};
let view: RenderedComponent | undefined;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  vi.mocked(openBrowser).mockResolvedValue(available);
  vi.mocked(browserCommand).mockResolvedValue(available);
  vi.mocked(closeBrowser).mockResolvedValue(undefined);
});
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  vi.resetAllMocks();
});
function button(text: string) {
  const result = [...view!.container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!result) throw new Error(`Missing ${text}`);
  return result;
}
it("acquires a single grant in Strict Mode and closes a late acquisition after unmount", async () => {
  const pending = deferred<BrowserSessionView>();
  vi.mocked(openBrowser).mockReturnValue(pending.promise);
  view = await renderComponent(
    <StrictMode>
      <EmployeeBrowser bot={bot} onClose={vi.fn()} />
    </StrictMode>,
  );
  expect(openBrowser).toHaveBeenCalledTimes(1);
  await view.unmount();
  view = undefined;
  await interact(() => pending.resolve(available));
  expect(closeBrowser).toHaveBeenCalledExactlyOnceWith("view");
  expect(browserCommand).not.toHaveBeenCalled();
});
it("queues explicit takeover behind an observation without silently dropping it", async () => {
  const observation = deferred<BrowserSessionView>();
  vi.mocked(browserCommand).mockReturnValueOnce(observation.promise);
  view = await renderComponent(<EmployeeBrowser bot={bot} onClose={vi.fn()} />);
  expect(browserCommand).toHaveBeenCalledExactlyOnceWith("view", { kind: "observe" });
  await interact(() => button("接管浏览器").click());
  expect(browserCommand).toHaveBeenCalledTimes(1);
  await interact(() => observation.resolve(available));
  expect(browserCommand).toHaveBeenLastCalledWith("view", { kind: "take" });
});
it("clears typed input before dispatch, never retries uncertainty, and only closes the view", async () => {
  const mine = {
    ...available,
    control: "mine" as const,
    controlExpiresAt: new Date(Date.now() + 30000).toISOString(),
  };
  vi.mocked(browserCommand).mockResolvedValue(mine);
  view = await renderComponent(<EmployeeBrowser bot={bot} onClose={vi.fn()} />);
  vi.mocked(browserCommand).mockRejectedValueOnce(new ApiError("Unconfirmed input", 503));
  const input = view.container.querySelector<HTMLInputElement>("#browser-text-input");
  if (!input) throw new Error("No text input");
  await setInputValue(input, "合成文本");
  await interact(() =>
    view!.container
      .querySelector(".browser-input")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(input.value).toBe("");
  expect(browserCommand).toHaveBeenLastCalledWith("view", { kind: "type", text: "合成文本" });
  expect(browserCommand).toHaveBeenCalledTimes(2);
  expect(view.container.textContent).toContain("Unconfirmed input");
  expect(input.disabled).toBe(true);
  expect(view.container.querySelector(".browser-screen")).toBeNull();
  expect(view.container.textContent).not.toContain("交还员工");
  await view.unmount();
  view = undefined;
  expect(closeBrowser).toHaveBeenCalledExactlyOnceWith("view");
  expect(vi.mocked(browserCommand).mock.calls.some(([, action]) => action.kind === "release")).toBe(
    false,
  );
});
it("shows observation-only availability without offering unavailable takeover", async () => {
  vi.mocked(browserCommand).mockResolvedValueOnce({ ...available, controlAvailable: false });
  view = await renderComponent(<EmployeeBrowser bot={bot} onClose={vi.fn()} />);
  expect(button("仅查看").disabled).toBe(true);
  expect(view.container.querySelector<HTMLInputElement>("#browser-text-input")?.disabled).toBe(
    true,
  );
  expect(browserCommand).toHaveBeenCalledTimes(1);
});
it("disables input for another controller and exposes reconnect after grant loss", async () => {
  vi.mocked(browserCommand).mockResolvedValueOnce({ ...available, control: "other" });
  view = await renderComponent(<EmployeeBrowser bot={bot} onClose={vi.fn()} />);
  expect(button("接管浏览器").disabled).toBe(true);
  expect(view.container.querySelector<HTMLInputElement>("#browser-text-input")?.disabled).toBe(
    true,
  );
  vi.mocked(browserCommand).mockRejectedValueOnce(new ApiError("Expired view", 404));
  await interact(() => button("刷新画面").click());
  expect(button("重新连接")).toBeDefined();
});

it.each([
  [409, "browser_host_identity_changed"],
  [409, "browser_host_connection_changed"],
  [401, "Authentication required."],
  [403, "browser_employee_profile_changed"],
])("clears the old frame and unsent text on authority loss (%s/%s)", async (status, code) => {
  vi.mocked(browserCommand).mockResolvedValueOnce({
    ...available,
    control: "mine",
    controlExpiresAt: new Date(Date.now() + 30000).toISOString(),
    frame: {
      base64: "c3ludGhldGlj",
      width: 1,
      height: 1,
      capturedAt: new Date().toISOString(),
      url: "https://synthetic.invalid/private",
    },
  });
  view = await renderComponent(<EmployeeBrowser bot={bot} onClose={vi.fn()} />);
  const input = view.container.querySelector<HTMLInputElement>("#browser-text-input")!;
  await setInputValue(input, "unsent synthetic login");
  expect(view.container.querySelector(".browser-screen")).not.toBeNull();
  vi.mocked(browserCommand).mockRejectedValueOnce(new ApiError(code, status));
  await interact(() => button("刷新画面").click());
  expect(view.container.querySelector(".browser-screen")).toBeNull();
  expect(input.value).toBe("");
  expect(input.disabled).toBe(true);
  expect(view.container.textContent).not.toContain("交还员工");
  expect(button("重新连接")).toBeDefined();
  if (code === "browser_host_identity_changed") {
    expect(view.container.textContent).toContain("设备身份已变化");
    expect(view.container.textContent).not.toContain(code);
  }
  expect(browserCommand).toHaveBeenCalledTimes(2);
});
