// @vitest-environment jsdom
import type { EmployeeProfile, ModelConnection, ModelServicesSnapshot } from "@openbot/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createModelConnection,
  deleteModelConnection,
  discoverConnectionModels,
  getEmployeeProfile,
  getModelServices,
  updateEmployeeModel,
  updateModelConnection,
  verifyModelConnection,
} from "../api";
import {
  deferred,
  interact,
  type RenderedComponent,
  renderComponent,
  setInputValue,
} from "../test/render-component";
import { EmployeeModelEditor } from "./EmployeeModelEditor";
import { EmployeeProfileView } from "./EmployeeProfileView";
import { ModelConnectionDialog } from "./ModelConnectionsDialog";
import { ModelIdField, ModelSelector } from "./ModelSelector";

vi.mock("../api", async (load) => ({
  ...(await load<typeof import("../api")>()),
  createModelConnection: vi.fn(),
  deleteModelConnection: vi.fn(),
  discoverConnectionModels: vi.fn(),
  getEmployeeProfile: vi.fn(),
  getModelServices: vi.fn(),
  updateEmployeeModel: vi.fn(),
  updateModelConnection: vi.fn(),
  verifyModelConnection: vi.fn(),
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

function dialog(props: Partial<Parameters<typeof ModelConnectionDialog>[0]> = {}) {
  return renderComponent(
    <ModelConnectionDialog
      snapshot={snapshot}
      onClose={vi.fn()}
      onSaved={vi.fn()}
      onReload={vi.fn()}
      {...props}
    />,
  );
}
function saveButton(): HTMLButtonElement {
  return view!.container.ownerDocument.querySelector<HTMLButtonElement>('button[type="submit"]')!;
}

describe("model connection user flows", () => {
  it("verifies a new key, picks a listed default model, then saves it once", async () => {
    const saved = vi.fn();
    vi.mocked(verifyModelConnection).mockResolvedValue(["other-model", "fixture-model"]);
    vi.mocked(createModelConnection).mockResolvedValue(connection);
    view = await dialog({ onSaved: saved });
    const key = view.container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await setInputValue(key, "synthetic-key");
    // Unverified: a key never goes to the Server for saving before the free model-list check.
    expect(saveButton().disabled).toBe(true);
    await interact(() => button("测试").click());
    expect(verifyModelConnection).toHaveBeenCalledWith(
      { presetId: "deepseek", baseUrl: connection.baseUrl, apiKey: "synthetic-key" },
      expect.any(AbortSignal),
    );
    expect(view.container.textContent).toContain("已验证 · 读到 2 个模型");
    expect(view.container.querySelector<HTMLSelectElement>("select:not([required])")?.value).toBe(
      "fixture-model",
    );
    await submit();
    expect(createModelConnection).toHaveBeenCalledTimes(1);
    expect(createModelConnection).toHaveBeenCalledWith({
      name: "DeepSeek",
      presetId: "deepseek",
      baseUrl: connection.baseUrl,
      apiKey: "synthetic-key",
      defaultModel: "fixture-model",
    });
    expect(key.value).toBe("");
    expect(saved).toHaveBeenCalledWith(connection);
    expect(discoverConnectionModels).not.toHaveBeenCalled();
  });

  it("needs a fresh check after the key changes", async () => {
    vi.mocked(verifyModelConnection).mockResolvedValue(["fixture-model"]);
    view = await dialog();
    const key = view.container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await setInputValue(key, "first-key");
    await interact(() => button("测试").click());
    expect(saveButton().disabled).toBe(false);
    await setInputValue(key, "second-key");
    expect(saveButton().disabled).toBe(true);
    expect(view.container.textContent).toContain("保存前先测试这个 API Key");
  });

  it("explains a refused key with the fixed reason and keeps save disabled", async () => {
    vi.mocked(verifyModelConnection).mockRejectedValue(
      new ApiError("model_credentials_invalid", 422),
    );
    view = await dialog();
    await setInputValue(
      view.container.querySelector<HTMLInputElement>('input[type="password"]')!,
      "bad-key",
    );
    await interact(() => button("测试").click());
    expect(view.container.textContent).toContain("API Key 没有通过验证");
    expect(saveButton().disabled).toBe(true);
  });

  it("sets and clears a saved connection's default model with its revision", async () => {
    vi.mocked(updateModelConnection).mockResolvedValue({ ...connection, revision: 3 });
    view = await dialog({ connection: { ...connection, defaultModel: "fixture-model" } });
    const model = view.container.querySelector<HTMLInputElement>("input[list]")!;
    await setInputValue(model, "");
    await submit();
    expect(updateModelConnection).toHaveBeenCalledWith(connection.id, {
      expectedRevision: 2,
      name: connection.name,
      defaultModel: null,
    });
  });

  it("checks a saved key through the model list, never the metered test", async () => {
    vi.mocked(discoverConnectionModels).mockResolvedValue(["fixture-model"]);
    view = await dialog({ connection });
    await interact(() => button("测试").click());
    expect(discoverConnectionModels).toHaveBeenCalledWith(connection.id, expect.any(AbortSignal));
    expect(verifyModelConnection).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("已验证 · 读到 1 个模型");
  });

  it("keeps a conflict draft until reload", async () => {
    const reload = vi.fn();
    vi.mocked(updateModelConnection).mockRejectedValue(
      new ApiError("model_connection_revision_conflict", 409),
    );
    view = await dialog({ connection, onReload: reload });
    const name = view.container.querySelector<HTMLInputElement>("input:not([type])")!;
    await setInputValue(name, "新名字");
    await submit();
    expect(view.container.textContent).toContain("这个连接刚在别处改过");
    expect(name.value).toBe("新名字");
    expect(updateModelConnection).toHaveBeenCalledTimes(1);
    await interact(() => button("重新加载").click());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("disconnects only after confirming, and lists what still uses it", async () => {
    const deleted = vi.fn();
    vi.mocked(deleteModelConnection).mockRejectedValueOnce(
      new ApiError(
        "model_connection_in_use",
        409,
        {},
        {
          error: "model_connection_in_use",
          bots: [{ id: "bot-one", name: "Model Bot" }],
          runIds: ["run-1", "run-2"],
          ownerDefault: true,
        },
      ),
    );
    view = await dialog({ connection, onDeleted: deleted });
    await interact(() => button("断开这个服务").click());
    expect(deleteModelConnection).not.toHaveBeenCalled();
    await interact(() => button("断开").click());
    expect(deleteModelConnection).toHaveBeenCalledWith(connection.id, { expectedRevision: 2 });
    expect(view.container.textContent).toContain("Model Bot 用它作为模型");
    expect(view.container.textContent).toContain("2 个没结束的任务正在用它");
    expect(view.container.textContent).toContain("它是你的默认模型");
    expect(deleted).not.toHaveBeenCalled();

    vi.mocked(deleteModelConnection).mockResolvedValueOnce(undefined);
    await interact(() => button("返回").click());
    await interact(() => button("断开这个服务").click());
    await interact(() => button("断开").click());
    expect(deleted).toHaveBeenCalledWith(connection.id);
  });

  it("keeps environment connections read-only", async () => {
    view = await dialog({
      connection: { ...connection, id: "legacy-kimi", source: "environment" },
    });
    expect(view.container.querySelector('input[type="password"]')).toBeNull();
    expect(view.container.ownerDocument.querySelector('button[type="submit"]')).toBeNull();
    expect(view.container.textContent).not.toContain("断开这个服务");
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
      const change = [...view.container.querySelectorAll("button")].find(
        (item) => item.textContent === "更改",
      );
      expect(Boolean(change)).toBe(computerProfile === "docker-linux");
      await interact(() => change?.click());
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
