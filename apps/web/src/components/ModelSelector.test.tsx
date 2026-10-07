import type { ModelConnection, ModelServicesSnapshot, Run } from "@openbot/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelConnectionDialog } from "./ModelConnectionsDialog";
import { ModelSelectionFields } from "./ModelSelector";
import { TaskSheet } from "./TaskSheet";

const connection: ModelConnection = {
  id: "connection-1",
  name: "工作账户",
  presetId: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  protocol: "openai-chat",
  enabled: true,
  hasApiKey: true,
  revision: 2,
  source: "saved",
  createdAt: "2026-09-08T00:00:00Z",
  updatedAt: "2026-09-08T00:00:00Z",
};
const snapshot: ModelServicesSnapshot = {
  connections: [connection],
  customBaseUrls: [],
  presets: [
    {
      id: "openrouter",
      name: "OpenRouter",
      protocol: "openai-chat",
      endpoints: [{ name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" }],
      suggestedModels: [],
      discovery: true,
      description: "选择完整模型 ID。",
      docsUrl: "https://openrouter.ai/docs/quickstart",
    },
  ],
};

describe("model service selection", () => {
  it("preserves a manually entered provider-prefixed model ID without needing discovery", () => {
    const html = renderToStaticMarkup(
      <ModelSelectionFields
        snapshot={snapshot}
        value={{ connectionId: connection.id, modelId: "vendor/model:version" }}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain('value="vendor/model:version"');
    expect(html).toContain("获取模型列表");
    expect(html).toContain("获取列表只查询模型");
    expect(html).not.toContain("测试模型");
  });

  it("keeps an unavailable binding visible instead of selecting another enabled connection", () => {
    const html = renderToStaticMarkup(
      <ModelSelectionFields
        snapshot={{
          ...snapshot,
          connections: [
            { ...connection, enabled: false },
            { ...connection, id: "replacement", name: "备用账户" },
          ],
        }}
        value={{ connectionId: connection.id, modelId: "vendor/model" }}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("工作账户（不可用）");
    expect(html).toContain("任务不会自动切换服务");
    expect(html).toContain('value="connection-1" disabled="" selected=""');
    expect(html).toContain('value="replacement"');
    expect(html).not.toContain('value="replacement" selected=""');
  });

  it("offers C7 inheritance without treating an environment connection as the default", () => {
    const html = renderToStaticMarkup(
      <ModelSelectionFields
        snapshot={{
          ...snapshot,
          connections: [{ ...connection, source: "environment", defaultModel: "kimi-k3" }],
        }}
        value={null}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("使用默认模型");
    expect(html).not.toContain("服务电脑默认 · kimi-k3");
    const empty = renderToStaticMarkup(
      <ModelSelectionFields
        snapshot={{ ...snapshot, connections: [] }}
        value={null}
        onChange={() => undefined}
      />,
    );
    expect(empty).toContain("还没有可用的模型服务");
    expect(empty).not.toContain("服务电脑默认");
    expect(empty).toContain("未配置时，Bot 暂时无法调用模型");
  });

  it("explains an invalid manual model ID before a call can be submitted", () => {
    const html = renderToStaticMarkup(
      <ModelSelectionFields
        snapshot={snapshot}
        value={{ connectionId: connection.id, modelId: "错误 model" }}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("模型 ID 需以英文字母或数字开头");
  });

  it("does not offer arbitrary custom endpoints or a usable save button without Server authorization", () => {
    const preset = snapshot.presets[0];
    if (!preset) throw new Error("Missing test preset");
    const html = renderToStaticMarkup(
      <ModelConnectionDialog
        snapshot={{
          ...snapshot,
          connections: [],
          presets: [
            { ...preset, id: "custom", name: "自定义 API", endpoints: [], discovery: true },
          ],
        }}
        onClose={() => undefined}
        onSaved={() => undefined}
        onReload={() => undefined}
      />,
    );
    expect(html).toContain("服务电脑还没有允许任何自定义地址");
    expect(html).toMatch(/type="submit"[^>]*disabled=""/);
    expect(html).toContain('type="password" autoComplete="new-password"');
    expect(html).toContain('maxLength="2048"');
    expect(html).not.toContain('type="url"');
  });
});

it("shows a queued model Run's immutable selection rather than its Bot's current model", () => {
  const run = {
    id: "run-one",
    workTaskId: "mapped-task",
    channelId: "channel-one",
    botId: "bot-one",
    executionProfile: "model",
    model: { connectionId: "queued-connection", modelId: "queued-model" },
    instruction: "Fixture",
    title: "Fixture",
    status: "queued",
    createdAt: "2026-09-25T00:00:00Z",
    updatedAt: "2026-09-25T00:00:00Z",
  } satisfies Run;
  const html = renderToStaticMarkup(
    <TaskSheet
      artifacts={[]}
      botsById={new Map()}
      bot={{
        id: "bot-one",
        name: "Model Bot",
        role: "Fixture",
        status: "idle",
        computerProfile: "model",
        model: { connectionId: "new-connection", modelId: "new-model" },
        createdAt: run.createdAt,
      }}
      run={run}
      liveFrame={undefined}
      node={undefined}
      progress={[]}
      onClose={() => {}}
      onRun={() => {}}
    />,
  );
  expect(html).toContain("queued-model");
  expect(html).toContain('href="#/tasks?task=mapped-task"');
  expect(html).toContain("查看任务");
  expect(html).not.toContain("new-model");
  expect(html).toContain("由服务电脑执行");
  expect(html).not.toContain("等待分配");
});
