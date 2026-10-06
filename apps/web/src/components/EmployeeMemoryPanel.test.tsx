// @vitest-environment jsdom
import type { EmployeeProfile } from "@openbot/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { interact, type RenderedComponent, renderComponent } from "../test/render-component";

const api = vi.hoisted(() => ({
  updateEmployeeMemory: vi.fn(async () => ({})),
  getKnowledgeProposals: vi.fn(async () => []),
}));
vi.mock("../api", async (original) => ({ ...(await original<typeof import("../api")>()), ...api }));

import { EmployeeMemoryPanel } from "./EmployeeMemoryPanel";

const profile: EmployeeProfile = {
  employee: {
    id: "employee-1",
    name: "Coder",
    role: "代码开发与验证",
    status: "idle",
    computerProfile: "coder",
    createdAt: "2026-09-03T00:00:00.000Z",
  },
  details: {
    description: "Build and verify changes within the assigned repository.",
    revision: 1,
    updatedAt: "2026-09-03T00:00:00.000Z",
  },
  evolution: [],
  skills: [],
  memories: [],
  memoryEvents: [],
  records: { runs: [], approvals: [], artifacts: [], decisions: [] },
  statistics: { totalRuns: 0, completedRuns: 0, failedRuns: 0, verifiedSkills: 0 },
  configuration: { executionProfile: "coder", portabilityFormat: "openbot.employee/v1" },
};

const interactiveViews: RenderedComponent[] = [];

afterEach(async () => {
  for (const view of interactiveViews.splice(0)) await view.unmount();
});

describe("EmployeeMemoryPanel", () => {
  it("makes Owner memory controls and the no-transfer boundary explicit", () => {
    const html = renderToStaticMarkup(
      <EmployeeMemoryPanel profile={profile} onProfileChanged={async () => undefined} />,
    );

    expect(html).toContain("添加记忆");
    expect(html).toContain("审阅前不会成为记忆");
    expect(html).toContain("记忆不会进入 Bot 模板");
  });
});

describe("reviewed knowledge memory provenance", () => {
  function memoryProfile(provenance: Record<string, unknown>): EmployeeProfile {
    return {
      ...profile,
      memories: [
        {
          id: "memory",
          botId: "employee-1",
          kind: "procedural",
          title: "Reviewed evidence",
          content: "Synthetic reviewed content",
          sensitivity: "internal",
          portability: "never",
          provenance,
          modelUseEnabled: false,
          revision: 1,
          createdAt: "2026-09-25T00:00:00Z",
          updatedAt: "2026-09-25T00:00:00Z",
        },
      ],
    };
  }
  it("shows the actual reviewed native Task and Work Run without inventing a channel source", () => {
    const html = renderToStaticMarkup(
      <EmployeeMemoryPanel
        profile={memoryProfile({
          source: "reviewed-work-proposal",
          actor: "owner",
          proposalId: "proposal",
          sourceTaskId: "native-task",
          sourceWorkRunId: "native-work-run",
        })}
        onProfileChanged={async () => {}}
      />,
    );
    expect(html).toContain('href="#/tasks?task=native-task"');
    expect(html).toContain("native-work-run");
    expect(html).toContain("Work Run");
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain("来源频道 Run");
  });
  it("retains legacy channel Run provenance without granting a native Task identity", () => {
    const html = renderToStaticMarkup(
      <EmployeeMemoryPanel
        profile={memoryProfile({ source: "reviewed-agent-proposal", sourceRunId: "channel-run" })}
        onProfileChanged={async () => {}}
      />,
    );
    expect(html).toContain("来源频道 Run：channel-run");
    expect(html).not.toContain("#/tasks?task=");
  });
  it("does not fall back to a misleading legacy identity when native provenance is incomplete", () => {
    const html = renderToStaticMarkup(
      <EmployeeMemoryPanel
        profile={memoryProfile({
          source: "reviewed-work-proposal",
          sourceTaskId: "native-task",
          sourceRunId: "not-the-source",
        })}
        onProfileChanged={async () => {}}
      />,
    );
    expect(html).toContain("原生任务来源信息不完整");
    expect(html).not.toContain("not-the-source");
    expect(html).not.toContain("#/tasks?task=");
  });
  it("does not invent a source link for manually authored Owner memory", () => {
    const html = renderToStaticMarkup(
      <EmployeeMemoryPanel
        profile={memoryProfile({ source: "owner", actor: "owner" })}
        onProfileChanged={async () => {}}
      />,
    );
    expect(html).not.toContain("#/tasks?task=");
    expect(html).not.toContain("来源频道 Run");
  });
});

describe("记忆 · 模型可用", () => {
  const memory = (
    id: string,
    sensitivity: EmployeeProfile["memories"][number]["sensitivity"],
  ): EmployeeProfile["memories"][number] => ({
    id,
    botId: "employee-1",
    kind: "semantic",
    title: id,
    content: "Synthetic fact",
    sensitivity,
    portability: "never",
    provenance: { source: "owner" },
    modelUseEnabled: false,
    revision: 3,
    createdAt: "2026-09-25T00:00:00Z",
    updatedAt: "2026-09-25T00:00:00Z",
  });

  it("sends only the switch with the revision and keeps confidential memory off", async () => {
    api.updateEmployeeMemory.mockClear();
    const changed = vi.fn(async () => undefined);
    const view = await renderComponent(
      <EmployeeMemoryPanel
        profile={{
          ...profile,
          memories: [memory("open", "internal"), memory("secret", "confidential")],
        }}
        onProfileChanged={changed}
      />,
    );
    interactiveViews.push(view);
    const switches = [...view.container.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
    expect(switches.map((item) => item.disabled)).toEqual([false, true]);
    await interact(() => switches[0]?.click());
    expect(api.updateEmployeeMemory).toHaveBeenCalledWith("employee-1", "open", {
      expectedRevision: 3,
      modelUseEnabled: true,
    });
    expect(changed).toHaveBeenCalledOnce();
  });
});
