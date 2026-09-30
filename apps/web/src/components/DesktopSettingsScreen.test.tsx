// @vitest-environment jsdom
import { type DOMWindow, JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopSetupPlanInput } from "../desktop-runtime";
import { interact, renderComponent, setInputValue } from "../test/render-component";

let Settings: typeof import("./DesktopSettingsScreen").DesktopSettingsScreen;
let preferences: typeof import("../workspace-preferences");
let storageWindow: DOMWindow;
beforeEach(async () => {
  vi.resetModules();
  // Use a browser Storage instance even when Node exposes its own global web storage.
  storageWindow = new JSDOM("", { url: "https://openbot.test" }).window;
  vi.stubGlobal("localStorage", storageWindow.localStorage);
  vi.stubGlobal("sessionStorage", storageWindow.sessionStorage);
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
  preferences = await import("../workspace-preferences");
  Settings = (await import("./DesktopSettingsScreen")).DesktopSettingsScreen;
});
afterEach(() => {
  storageWindow.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const hostPlan: DesktopSetupPlanInput = { mode: "host", localWorker: false, plannedWorkerCount: 0 };
function callbacks() {
  return { onBack: vi.fn(), onConnection: vi.fn(), onRole: vi.fn() };
}
function button(container: HTMLElement, name: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name,
  );
  if (!result) throw new Error(`Missing settings button: ${name}`);
  return result;
}
async function select(container: HTMLElement, label: string, value: string) {
  await interact(() => {
    const element = container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function stored() {
  return JSON.parse(localStorage.getItem(preferences.preferencesKey) ?? "null");
}

describe("Desktop settings interactions", () => {
  it("updates actual persisted appearance and chat preferences and restores defaults", async () => {
    const rendered = await renderComponent(
      <Settings plan={hostPlan} material={{ status: "enabled" }} {...callbacks()} />,
    );
    try {
      await interact(() =>
        rendered.container.querySelector<HTMLInputElement>('[aria-label="半透明侧栏"]')?.click(),
      );
      await interact(() =>
        rendered.container
          .querySelector<HTMLInputElement>('[aria-label="显示右侧信息栏"]')
          ?.click(),
      );
      await interact(() =>
        rendered.container.querySelector<HTMLInputElement>('[aria-label="显示左侧导航"]')?.click(),
      );
      await select(rendered.container, "界面密度", "compact");
      await select(rendered.container, "聊天字号", "large");
      await select(rendered.container, "发送消息快捷键", "modifier");
      await select(rendered.container, "消息时间格式", "12");
      await interact(() =>
        rendered.container.querySelector<HTMLInputElement>('[aria-label="减少动态效果"]')?.click(),
      );
      expect(stored()).toEqual({
        sidebarTranslucent: false,
        leftPanelOpen: false,
        rightPanelOpen: false,
        density: "compact",
        fontSize: "large",
        sendShortcut: "modifier",
        reduceMotion: true,
        hour12: true,
        notifyApprovals: false,
        notifyMessages: false,
      });
      await interact(() => button(rendered.container, "恢复默认").click());
      expect(stored()).toEqual(preferences.defaultPreferences);
      expect(rendered.container.querySelector('[role="status"]')?.textContent).toContain(
        "已恢复默认",
      );
      expect(
        (rendered.container.querySelector('[aria-label="半透明侧栏"]') as HTMLInputElement).checked,
      ).toBe(true);
      expect(
        (rendered.container.querySelector('[aria-label="发送消息快捷键"]') as HTMLSelectElement)
          .value,
      ).toBe("enter");
    } finally {
      await rendered.unmount();
    }
  });

  it("reports nonpersistent preferences while controls still work", async () => {
    vi.spyOn(Object.getPrototypeOf(localStorage), "setItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    const rendered = await renderComponent(
      <Settings plan={hostPlan} material={{ status: "reduced" }} {...callbacks()} />,
    );
    try {
      expect(rendered.container.textContent).toContain("系统已启用减少透明度");
      await select(rendered.container, "界面密度", "compact");
      expect(
        (rendered.container.querySelector('[aria-label="界面密度"]') as HTMLSelectElement).value,
      ).toBe("compact");
      expect(rendered.container.querySelector('[role="status"]')?.textContent).toContain(
        "无法保存到此设备",
      );
      expect(localStorage.getItem(preferences.preferencesKey)).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });

  it.each(["host", "client"] as const)(
    "routes %s connection actions without editing runtime state itself",
    async (mode) => {
      const actions = callbacks();
      const rendered = await renderComponent(
        <Settings
          plan={{ ...hostPlan, mode }}
          connection={{ status: "configured", serverUrl: "https://server.example.test" }}
          localWorker={{ status: "requires-approval" }}
          material={{ status: "unsupported" }}
          {...actions}
        />,
      );
      try {
        await interact(() => button(rendered.container, "工作主机").click());
        expect(rendered.container.textContent).toContain("https://server.example.test");
        expect(rendered.container.textContent).toContain("等待你在系统中批准");
        await interact(() => button(rendered.container, "更改用途").click());
        expect(actions.onRole).toHaveBeenCalledOnce();
        if (mode === "client") {
          await interact(() => button(rendered.container, "更改连接").click());
          expect(actions.onConnection).toHaveBeenCalledOnce();
        } else {
          expect(rendered.container.textContent).toContain("仅本机");
          expect(
            Array.from(rendered.container.querySelectorAll("button")).some(
              (item) => item.textContent === "更改连接",
            ),
          ).toBe(false);
        }
        await interact(() => button(rendered.container, "关闭设置").click());
        expect(actions.onBack).toHaveBeenCalledOnce();
        expect(localStorage.getItem(preferences.preferencesKey)).toBeNull();
      } finally {
        await rendered.unmount();
      }
    },
  );

  it("loads and saves the model section through the Server rather than local preferences", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      url === "/api/v1/model-services"
        ? Response.json({ presets: [], connections: [], customBaseUrls: [] })
        : init?.method === "POST"
          ? Response.json({
              status: "configured",
              provider: "anthropic",
              model: "available-model",
              revision: "revision-2",
            })
          : Response.json({ status: "unconfigured", revision: null }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await renderComponent(
      <Settings plan={hostPlan} material={{ status: "enabled" }} {...callbacks()} />,
    );
    try {
      expect(fetchMock).not.toHaveBeenCalled();
      await interact(() => button(rendered.container, "模型服务").click());
      await interact(() =>
        Array.from(
          rendered.container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
        )[1]?.click(),
      );
      await setInputValue(
        rendered.container.querySelector("#model-name") as HTMLInputElement,
        "available-model",
      );
      await setInputValue(
        rendered.container.querySelector("#model-api-key") as HTMLInputElement,
        "test-key-for-ui-validation-only",
      );
      await interact(() =>
        rendered.container
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(call?.[0]).toBe("/api/v1/settings/model");
      expect(JSON.parse(call?.[1]?.body as string)).toEqual({
        agentEnabled: false,
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "available-model",
        apiKey: "test-key-for-ui-validation-only",
        revision: null,
      });
      expect((rendered.container.querySelector("#model-api-key") as HTMLInputElement).value).toBe(
        "",
      );
      expect(rendered.container.querySelector('[role="status"]')?.textContent).toContain(
        "模型配置已验证并保存",
      );
      expect(localStorage.getItem(preferences.preferencesKey)).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });
});

it("opens an initial category and searches settings without changing preferences", async () => {
  const actions = callbacks();
  const rendered = await renderComponent(
    <Settings
      plan={hostPlan}
      material={{ status: "enabled" }}
      initialSection="about"
      {...actions}
    />,
  );
  try {
    expect(rendered.container.querySelector("#settings-section-title")?.textContent).toBe(
      "关于 OpenBot",
    );
    const search = rendered.container.querySelector<HTMLInputElement>(
      '[aria-label="搜索设置"][type="search"]',
    );
    if (!search) throw new Error("Settings search is missing");
    await setInputValue(search, "字号");
    expect(rendered.container.querySelectorAll('nav[aria-label="设置分区"] button')).toHaveLength(
      1,
    );
    await interact(() => button(rendered.container, "通用").click());
    expect(rendered.container.querySelector('[aria-label="聊天字号"]')).not.toBeNull();
    expect(search.value).toBe("");
    await setInputValue(search, "missing-category");
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toContain(
      "没有匹配的设置",
    );
    await interact(() => button(rendered.container, "关闭设置").click());
    expect(actions.onBack).toHaveBeenCalledOnce();
    expect(localStorage.getItem(preferences.preferencesKey)).toBeNull();
  } finally {
    await rendered.unmount();
  }
});

it("retries a failed automation workspace load and keeps its manager inside settings", async () => {
  let failed = true;
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/v1/workspace")
      return failed
        ? Response.json({ error: "Unavailable" }, { status: 503 })
        : Response.json({ bots: [], channels: [] });
    if (url === "/api/v1/automations") return Response.json({ automations: [] });
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetchMock);
  const rendered = await renderComponent(
    <Settings
      plan={hostPlan}
      material={{ status: "enabled" }}
      initialSection="routines"
      {...callbacks()}
    />,
  );
  try {
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain(
      "无法读取工作空间",
    );
    failed = false;
    await interact(() => button(rendered.container, "重试").click());
    expect(rendered.container.querySelector('nav[aria-label="设置分区"]')).not.toBeNull();
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    expect(rendered.container.textContent).toContain("先创建 Bot，并将它加入一个频道");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/workspace",
      "/api/v1/workspace",
      "/api/v1/automations",
    ]);
  } finally {
    await rendered.unmount();
  }
});

describe("Web settings entry", () => {
  it("offers sectioned settings without Desktop-only connection or material rows (hosts via the Server)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ events: [] }))));
    const rendered = await renderComponent(<Settings onBack={vi.fn()} />);
    try {
      const navigation = rendered.container.querySelector('nav[aria-label="设置分区"]');
      const labels = Array.from(navigation?.querySelectorAll("button") ?? []).map((item) =>
        item.textContent?.trim(),
      );
      expect(labels).toEqual(
        expect.arrayContaining([
          "通用",
          "模型服务",
          "例行任务",
          "工作主机",
          "审批与权限",
          "审计记录",
        ]),
      );
      expect(rendered.container.textContent).not.toContain("半透明侧栏");
      await interact(() => button(rendered.container, "审批与权限").click());
      expect(rendered.container.querySelector("#settings-section-title")?.textContent).toBe(
        "审批与权限",
      );
      await interact(() => button(rendered.container, "审计记录").click());
      await interact(() => undefined);
      expect(rendered.container.textContent).toContain("暂无记录");
    } finally {
      await rendered.unmount();
    }
  });
});

describe("Notification settings", () => {
  it("asks the browser for permission from the switch and stores the opt-in only when granted", async () => {
    const requestPermission = vi.fn(async () => "denied" as NotificationPermission);
    // The global must be a constructor; only its static permission surface is exercised here.
    const FakeNotification = Object.assign(function Notification() {}, {
      permission: "default" as NotificationPermission,
      requestPermission,
    });
    vi.stubGlobal("Notification", FakeNotification);
    const rendered = await renderComponent(<Settings onBack={vi.fn()} initialSection="notify" />);
    try {
      const approvals = () =>
        rendered.container.querySelector<HTMLInputElement>('[aria-label="需要你批准"]');
      expect(approvals()?.checked).toBe(false);
      await interact(() => approvals()?.click());
      await interact(() => undefined);
      expect(requestPermission).toHaveBeenCalledOnce();
      expect(stored()?.notifyApprovals ?? false).toBe(false);
      expect(rendered.container.textContent).toContain("浏览器已阻止通知");
      expect(approvals()?.disabled).toBe(true);

      FakeNotification.permission = "default";
      requestPermission.mockResolvedValueOnce("granted");
      await interact(() => button(rendered.container, "通用").click());
      await interact(() => button(rendered.container, "通知").click());
      await interact(() => approvals()?.click());
      await interact(() => undefined);
      expect(stored()?.notifyApprovals).toBe(true);
      expect(stored()?.notifyMessages).toBe(false);
    } finally {
      await rendered.unmount();
    }
  });
});

describe("Settings dialog", () => {
  it("opens as a modal with the artboard's groups and counts, and closes from Esc or the backdrop", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ events: [] })));
    const onBack = vi.fn();
    const rendered = await renderComponent(
      <Settings onBack={onBack} counts={{ model: 3, routines: 0 }} />,
    );
    try {
      const dialog = rendered.container.querySelector<HTMLDialogElement>("dialog.settings-dialog");
      expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
      expect(dialog?.open).toBe(true);
      expect(dialog?.getAttribute("aria-labelledby")).toBe("settings-section-title");
      const titles = Array.from(
        rendered.container.querySelectorAll(".settings-nav-group > p"),
        (item) => item.textContent,
      );
      expect(titles).toEqual(["Bot 能力", "执行与安全", "账户"]);
      expect(button(rendered.container, "模型服务3")).toBeDefined();
      expect(button(rendered.container, "例行任务0")).toBeDefined();
      expect(button(rendered.container, "审批与权限").querySelector("small")).toBeNull();

      await interact(() => dialog?.dispatchEvent(new Event("cancel", { cancelable: true })));
      expect(onBack).toHaveBeenCalledOnce();
      await interact(() => dialog?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
      expect(onBack).toHaveBeenCalledTimes(2);
      // A press inside the frame does not close it.
      await interact(() =>
        rendered.container
          .querySelector(".settings-dialog-body")
          ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
      );
      expect(onBack).toHaveBeenCalledTimes(2);
    } finally {
      await rendered.unmount();
    }
  });
});

describe("Account and about sections", () => {
  it("shows the Owner, signs out, links to the audit log and lists public resources", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ events: [] })));
    const onLogout = vi.fn(async () => undefined);
    const rendered = await renderComponent(
      <Settings onBack={vi.fn()} initialSection="account" ownerName="雨贺" onLogout={onLogout} />,
    );
    try {
      expect(rendered.container.querySelector("#settings-section-title")?.textContent).toBe(
        "账户与安全",
      );
      expect(rendered.container.textContent).toContain("雨贺");
      // Password and session actions stay hidden until the Server supports them (backlog C2).
      expect(rendered.container.textContent).not.toContain("修改密码");
      await interact(() => button(rendered.container, "退出登录").click());
      expect(onLogout).toHaveBeenCalledOnce();
      await interact(() => button(rendered.container, "查看").click());
      expect(rendered.container.querySelector("#settings-section-title")?.textContent).toBe(
        "审计记录",
      );
      await interact(() => button(rendered.container, "关于 OpenBot").click());
      const links = Array.from(
        rendered.container.querySelectorAll<HTMLAnchorElement>(".settings-dialog-body a"),
        (link) => [link.getAttribute("aria-label"), link.target, link.rel],
      );
      expect(links).toEqual([
        ["打开更新日志", "_blank", "noreferrer"],
        ["打开源代码", "_blank", "noreferrer"],
        ["打开开源许可与致谢", "_blank", "noreferrer"],
        ["打开安全说明", "_blank", "noreferrer"],
      ]);
      expect(rendered.container.textContent).toContain("Hermes Agent");
    } finally {
      await rendered.unmount();
    }
  });
});
