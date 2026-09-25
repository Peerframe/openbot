// @vitest-environment jsdom
import type { EmployeeProfile, ModelConnection, ModelServicesSnapshot } from "@openbot/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createModelConnection,
  discoverConnectionModels,
  getEmployeeProfile,
  getModelServices,
  testModelConnection,
  updateEmployeeModel,
  updateModelConnection,
} from "../api";
import {
  deferred,
  interact,
  type RenderedComponent,
  renderComponent,
  setInputValue,
} from "../test/render-component";
import { CreateBotDialog } from "./CreateBotDialog";
import { EmployeeModelEditor } from "./EmployeeModelEditor";
import { EmployeeProfileView } from "./EmployeeProfileView";
import { ModelConnectionEditor } from "./ModelConnectionsDialog";
import { ModelIdField, ModelSelector } from "./ModelSelector";

vi.mock("../api", async (load) => ({
  ...(await load<typeof import("../api")>()),
  createModelConnection: vi.fn(),
  discoverConnectionModels: vi.fn(),
  getEmployeeProfile: vi.fn(),
  getModelServices: vi.fn(),
  testModelConnection: vi.fn(),
  updateEmployeeModel: vi.fn(),
  updateModelConnection: vi.fn(),
}));

const connection: ModelConnection = {
  id: "connection-one",
  name: "工作账户",
  presetId: "deepseek",
  baseUrl: "https://api.deepseek.com",
  protocol: "openai-chat",
  enabled: true,
  hasApiKey: true,
  revision: 2,
  source: "saved",
  createdAt: "2026-09-25T00:00:00Z",
  updatedAt: "2026-09-25T00:00:00Z",
};
const snapshot: ModelServicesSnapshot = {
  connections: [connection],
  customBaseUrls: [],
  presets: [
    {
      id: "deepseek",
      name: "DeepSeek",
      protocol: "openai-chat",
      endpoints: [{ name: "Standard API", baseUrl: connection.baseUrl }],
      suggestedModels: ["fixture-model"],
      discovery: true,
      description: "Fixture",
      docsUrl: "https://api-docs.deepseek.com",
    },
  ],
};
const profile = {
  employee: {
    id: "bot-one",
    name: "Model Bot",
    role: "Fixture",
    status: "idle",
    computerProfile: "model",
    createdAt: connection.createdAt,
    model: { connectionId: connection.id, modelId: "old-model" },
  },
  details: { revision: 3, description: "Fixture", updatedAt: connection.updatedAt },
  configuration: {
    executionProfile: "model",
    model: { connectionId: connection.id, modelId: "old-model" },
    portabilityFormat: "openbot.employee/v1",
  },
} as EmployeeProfile;
let view: RenderedComponent | undefined;

beforeEach(() => {
  vi.mocked(getModelServices).mockResolvedValue(structuredClone(snapshot));
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
});
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  vi.resetAllMocks();
});

function button(text: string): HTMLButtonElement {
  const result = Array.from(view!.container.querySelectorAll("button")).find((item) =>
    item.textContent?.includes(text),
  );
  if (!result) throw new Error(`Missing button ${text}`);
  return result;
}
async function submit() {
  await interact(() =>
    view!.container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

describe("model connection user flows", () => {
  it("saves a new credential once, clears the password field, and never probes automatically", async () => {
    const saved = vi.fn();
    vi.mocked(createModelConnection).mockResolvedValue(connection);
    view = await renderComponent(
      <ModelConnectionEditor
        snapshot={snapshot}
        connection={undefined}
        onSaved={saved}
        onReload={vi.fn()}
      />,
    );
    const key = view.container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await setInputValue(key, "synthetic-key");
    await submit();
    expect(createModelConnection).toHaveBeenCalledWith({
      name: "DeepSeek",
      presetId: "deepseek",
      baseUrl: connection.baseUrl,
      apiKey: "synthetic-key",
    });
    expect(key.value).toBe("");
    expect(saved).toHaveBeenCalledWith(connection, true);
    expect(discoverConnectionModels).not.toHaveBeenCalled();
    expect(testModelConnection).not.toHaveBeenCalled();
  });

  it("disables a saved connection with its revision and keeps a conflict draft until reload", async () => {
    const reload = vi.fn();
    vi.mocked(updateModelConnection).mockRejectedValue(
      new ApiError("model_connection_revision_conflict", 409),
    );
    view = await renderComponent(
      <ModelConnectionEditor
        snapshot={snapshot}
        connection={connection}
        onSaved={vi.fn()}
        onReload={reload}
      />,
    );
    await interact(() =>
      view!.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    await submit();
    expect(updateModelConnection).toHaveBeenCalledWith(connection.id, {
      expectedRevision: 2,
      name: connection.name,
      enabled: false,
    });
    expect(view.container.textContent).toContain("连接已在其他位置更新");
    expect(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(
      false,
    );
    expect(updateModelConnection).toHaveBeenCalledTimes(1);
    await interact(() => button("重新加载连接").click());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("only invokes a metered test after its labeled button, passing an abort signal", async () => {
    const pending = deferred<void>();
    vi.mocked(testModelConnection).mockReturnValue(pending.promise);
    view = await renderComponent(
      <ModelConnectionEditor
        snapshot={snapshot}
        connection={connection}
        onSaved={vi.fn()}
        onReload={vi.fn()}
      />,
    );
    expect(testModelConnection).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("按提供商的 API 用量计费");
    await interact(() => button("测试模型（会调用 API）").click());
    const signal = vi.mocked(testModelConnection).mock.calls[0]?.[2];
    expect(testModelConnection).toHaveBeenCalledWith(
      connection.id,
      "fixture-model",
      expect.any(AbortSignal),
    );
    await view.unmount();
    view = undefined;
    expect(signal?.aborted).toBe(true);
    pending.resolve();
  });

  it("keeps environment connections read-only", async () => {
    view = await renderComponent(
      <ModelConnectionEditor
        snapshot={snapshot}
        connection={{ ...connection, id: "legacy-kimi", source: "environment" }}
        onSaved={vi.fn()}
        onReload={vi.fn()}
      />,
    );
    expect(view.container.querySelector('input[type="password"]')).toBeNull();
    expect(view.container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(view.container.querySelector('button[type="submit"]')).toBeNull();
    expect(updateModelConnection).not.toHaveBeenCalled();
  });

  it("retains the unavailable chosen connection without replacing it with another", async () => {
    vi.mocked(getModelServices).mockResolvedValue({
      ...snapshot,
      connections: [
        { ...connection, enabled: false },
        { ...connection, id: "other" },
      ],
    });
    const change = vi.fn();
    const valid = vi.fn();
    view = await renderComponent(
      <ModelSelector
        value={{ connectionId: connection.id, modelId: "saved-model" }}
        onChange={change}
        onValidityChange={valid}
      />,
    );
    expect(view.container.textContent).toContain("不可用");
    expect(view.container.querySelector("select")!.value).toBe(connection.id);
    expect(change).not.toHaveBeenCalled();
    expect(valid).toHaveBeenLastCalledWith(false);
  });

  it("cancels pending discovery when its field is removed", async () => {
    const pending = deferred<string[]>();
    vi.mocked(discoverConnectionModels).mockReturnValue(pending.promise);
    view = await renderComponent(
      <ModelIdField
        connectionId={connection.id}
        value="manual-model"
        onChange={vi.fn()}
        suggestions={[]}
        discovery
      />,
    );
    await interact(() => button("获取模型列表").click());
    const signal = vi.mocked(discoverConnectionModels).mock.calls[0]?.[1];
    await view.unmount();
    view = undefined;
    expect(signal?.aborted).toBe(true);
    expect(testModelConnection).not.toHaveBeenCalled();
    pending.resolve(["late-model"]);
  });

  it("saves Bot model CAS then explains that queued Runs keep their snapshot", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    vi.mocked(updateEmployeeModel).mockResolvedValue({
      employee: {
        ...profile.employee,
        model: { connectionId: connection.id, modelId: "new-model" },
      },
      details: { ...profile.details, revision: 4 },
      evolution: {},
    } as never);
    view = await renderComponent(
      <EmployeeModelEditor profile={profile} onProfileChanged={refresh} />,
    );
    await setInputValue(
      view.container.querySelector<HTMLInputElement>("input[list]")!,
      "new-model",
    );
    await submit();
    expect(updateEmployeeModel).toHaveBeenCalledWith("bot-one", {
      expectedRevision: 3,
      model: { connectionId: connection.id, modelId: "new-model" },
    });
    expect(view.container.textContent).toContain("已排队的任务保留原模型");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("recovers a Bot CAS conflict only by loading current server values", async () => {
    vi.mocked(updateEmployeeModel).mockRejectedValue(
      new ApiError("employee_profile_revision_conflict", 409),
    );
    vi.mocked(getEmployeeProfile).mockResolvedValue({
      ...profile,
      details: { ...profile.details, revision: 4 },
      configuration: {
        ...profile.configuration,
        model: { connectionId: connection.id, modelId: "server-model" },
      },
    });
    view = await renderComponent(
      <EmployeeModelEditor
        profile={profile}
        onProfileChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await setInputValue(view.container.querySelector<HTMLInputElement>("input[list]")!, "my-model");
    await submit();
    expect(view.container.textContent).toContain("员工配置已在其他位置更新");
    expect(updateEmployeeModel).toHaveBeenCalledTimes(1);
    await interact(() => button("加载最新值").click());
    expect(getEmployeeProfile).toHaveBeenCalledWith("bot-one");
    expect(view.container.querySelector<HTMLInputElement>("input[list]")!.value).toBe(
      "server-model",
    );
  });

  it.each(["model", "docker-linux"])(
    "preserves default none and adds explicit %s creation",
    async (computerProfile) => {
      const onCreate = vi.fn().mockResolvedValue(undefined);
      view = await renderComponent(
        <CreateBotDialog onClose={vi.fn()} onImport={vi.fn()} onCreate={onCreate} />,
      );
      const mode = Array.from(view.container.querySelectorAll("select")).find((select) =>
        Array.from(select.options).some((option) => option.value === "model"),
      )!;
      expect(mode.value).toBe("none");
      expect(getModelServices).not.toHaveBeenCalled();
      await interact(() => {
        mode.value = computerProfile;
        mode.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(button("创建 Bot").disabled).toBe(true);
      const connections = Array.from(view.container.querySelectorAll("select")).find((select) =>
        Array.from(select.options).some((option) => option.value === connection.id),
      )!;
      await interact(() => {
        connections.value = connection.id;
        connections.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(button("创建 Bot").disabled).toBe(false);
      await submit();
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          computerProfile,
          model: { connectionId: connection.id, modelId: "fixture-model" },
        }),
      );
    },
  );
  it("requires an explicit Docker selection even when a Server default exists", async () => {
    vi.mocked(getModelServices).mockResolvedValue({
      ...snapshot,
      connections: [{ ...connection, source: "environment", defaultModel: "fixture-model" }],
    });
    view = await renderComponent(
      <CreateBotDialog onClose={vi.fn()} onImport={vi.fn()} onCreate={vi.fn()} />,
    );
    const mode = Array.from(view.container.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.value === "docker-linux"),
    )!;
    await interact(() => {
      mode.value = "docker-linux";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(button("创建 Bot").disabled).toBe(true);
    expect(view.container.textContent).not.toContain("Server 默认");
    const services = Array.from(view.container.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.value === connection.id),
    )!;
    await interact(() => {
      services.value = connection.id;
      services.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(button("创建 Bot").disabled).toBe(false);
  });

  it.each(["docker-linux", "none", "macos-cua", "lume-vm", "coder"] as const)(
    "shows model editor only for the allowed %s profile",
    async (computerProfile) => {
      const item = {
        ...profile,
        employee: { ...profile.employee, computerProfile },
        configuration: { ...profile.configuration, executionProfile: computerProfile },
        statistics: { totalRuns: 0, completedRuns: 0, failedRuns: 0, verifiedSkills: 0 },
        skills: [],
        memories: [],
        memoryEvents: [],
        evolution: [],
        records: { runs: [], approvals: [], artifacts: [], decisions: [] },
      };
      vi.mocked(updateEmployeeModel).mockResolvedValue({
        employee: {
          ...item.employee,
          model: { connectionId: connection.id, modelId: "docker-model" },
        },
        details: { ...item.details, revision: 4 },
        evolution: {},
      } as never);
      view = await renderComponent(
        <EmployeeProfileView
          profile={item}
          loading={false}
          error={undefined}
          onRetry={vi.fn()}
          onAssign={vi.fn()}
          onExport={vi.fn()}
          onProfileChanged={vi.fn().mockResolvedValue(undefined)}
        />,
      );
      await interact(() => button("配置").click());
      const form = view.container.querySelector<HTMLFormElement>(".employee-model-form");
      expect(Boolean(form)).toBe(computerProfile === "docker-linux");
      if (form) {
        await setInputValue(form.querySelector<HTMLInputElement>("input[list]")!, "docker-model");
        await interact(() =>
          form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
        );
        expect(updateEmployeeModel).toHaveBeenCalledWith("bot-one", {
          expectedRevision: 3,
          model: { connectionId: connection.id, modelId: "docker-model" },
        });
      }
    },
  );
});
