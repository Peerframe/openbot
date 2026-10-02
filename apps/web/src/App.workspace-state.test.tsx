// @vitest-environment jsdom

import type {
  Approval,
  Bot,
  Channel,
  EmployeeProfile,
  ExecutionNode,
  Run,
  WorkspaceSnapshot,
} from "@openbot/domain";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedWorkspace } from "./App";
import {
  deferred,
  interact,
  type RenderedComponent,
  renderComponent,
} from "./test/render-component";
import { defaultPreferences, updatePreferences } from "./workspace-preferences";

const createdAt = "2026-09-14T00:00:00Z";
const bots: Bot[] = ["alpha", "beta"].map((id) => ({
  id,
  name: id === "alpha" ? "Alpha" : "Beta",
  role: "Assistant",
  status: "idle",
  computerProfile: "none",
  createdAt,
}));
const channel: Channel = {
  id: "channel-a",
  name: "产品讨论",
  description: "产品频道",
  botIds: ["alpha"],
  createdAt,
};
function snapshot(members = ["alpha"]): WorkspaceSnapshot {
  return {
    channels: [{ ...channel, botIds: members }],
    bots,
    nodes: [],
    runs: [],
    approvals: [],
    artifacts: [],
    progress: [],
    counts: { channels: 1, bots: 2, connectedNodes: 0, activeRuns: 0 },
  };
}
const worker: ExecutionNode = {
  id: "worker",
  name: "Fixture Worker",
  platform: "linux",
  osVersion: "test",
  architecture: "x64",
  deviceClass: "container",
  isolation: "container",
  trustTier: "development",
  capabilities: [],
  capabilityManifest: [],
  activeRunIds: [],
  maxConcurrentRuns: 2,
  connectedAt: createdAt,
  lastSeenAt: createdAt,
};
const queuedRun: Run = {
  id: "run",
  channelId: channel.id,
  botId: "alpha",
  executionProfile: "none",
  instruction: "Check workspace recovery",
  title: "恢复验证",
  status: "queued",
  createdAt,
  updatedAt: createdAt,
};
const pendingApproval: Approval = {
  id: "approval",
  runId: queuedRun.id,
  channelId: channel.id,
  botId: "alpha",
  nodeId: worker.id,
  action: "write",
  target: "fixture",
  summary: "确认写入 fixture",
  risk: "write",
  targetFingerprint: "fixture",
  beforeState: {},
  status: "pending",
  expiresAt: "2999-01-01T00:00:00Z",
  createdAt,
};
class TestEventSource extends EventTarget {
  static instances: TestEventSource[] = [];
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    super();
    TestEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, payload: unknown) {
    if (this.closed) throw new Error("Cannot deliver a network event to a closed stream.");
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(payload) }));
  }
}
type PendingRead = ReturnType<typeof deferred<Response>> & { signal: AbortSignal | undefined };
let reads: PendingRead[];
let profiles: (PendingRead & { botId: string })[];
let mutations: ReturnType<typeof deferred<Response>>[];
let rendered: RenderedComponent | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  reads = [];
  profiles = [];
  mutations = [];
  TestEventSource.instances = [];
  updatePreferences(defaultPreferences);
  vi.stubGlobal("EventSource", TestEventSource);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  // Deliberately ignore abort: the component must also reject a stale completion.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/workspace") {
        const request = { ...deferred<Response>(), signal: init?.signal ?? undefined };
        reads.push(request);
        return request.promise;
      }
      const profilePath = /^\/api\/v1\/bots\/([^/]+)\/profile$/.exec(url);
      if (profilePath?.[1]) {
        const request = {
          ...deferred<Response>(),
          botId: profilePath[1],
          signal: init?.signal ?? undefined,
        };
        profiles.push(request);
        return request.promise;
      }
      if (url.startsWith("/api/v1/channels/") && url.includes("/bots")) {
        const request = deferred<Response>();
        mutations.push(request);
        return request.promise;
      }
      if (url.endsWith("/messages")) return Response.json({ messages: [] });
      if (url.endsWith("/runs")) return Response.json({ runs: [] });
      if (url.endsWith("/reactions")) return Response.json({ reactions: [] });
      if (url.includes("plugins")) return Response.json({ plugins: [], pendingCalls: [] });
      throw new Error(`Unexpected workspace fixture request: ${url}`);
    }),
  );
});
afterEach(async () => {
  await rendered?.unmount();
  rendered = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function mount(initial = snapshot(), strict = false) {
  const component = <AuthenticatedWorkspace ownerName="Owner" onLogout={async () => {}} />;
  rendered = await renderComponent(strict ? <StrictMode>{component}</StrictMode> : component);
  await interact(() => reads.at(-1)?.resolve(Response.json(initial)));
  return rendered.container;
}
function stream(url = "/api/v1/workspace/events") {
  const result = TestEventSource.instances.findLast((item) => item.url === url && !item.closed);
  if (!result) throw new Error(`Missing stream: ${url}`);
  return result;
}
async function railTab(label: string) {
  const tab = Array.from(
    rendered?.container.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
  ).find((item) => item.textContent?.startsWith(label));
  if (tab && tab.ariaSelected !== "true") await interact(() => tab.click());
}
async function memberCount() {
  // The 频道信息 rail's 成员 tab (ChannelInfo artboard) replaced the members popover.
  await railTab("成员");
  const rows = rendered?.container.querySelectorAll(".ci-members .ci-member");
  return rows === undefined ? undefined : `频道成员 ${rows.length}`;
}
async function ready() {
  await interact(() => stream().emit("workspace.ready", { type: "workspace.ready", nodes: [] }));
}
async function identityChanged() {
  await interact(() =>
    stream().emit("employee.profile.changed", {
      type: "employee.profile.changed",
      botId: "alpha",
      sections: ["identity"],
      occurredAt: createdAt,
    }),
  );
}
describe("Authenticated workspace snapshot and realtime ordering", () => {
  it("does not replace the newer refresh with an older successful response", async () => {
    await mount();
    await ready();
    await identityChanged();
    expect(reads).toHaveLength(3);
    await interact(() => reads[2]?.resolve(Response.json(snapshot(["alpha", "beta"]))));
    expect(await memberCount()).toBe("频道成员 2");
    await interact(() => reads[1]?.resolve(Response.json(snapshot())));
    expect(await memberCount()).toBe("频道成员 2");
    expect(reads[1]?.signal?.aborted).toBe(true);
  });
  it("replays channel events over a pending snapshot while recovering unrelated missed channels", async () => {
    await mount();
    await ready();
    await interact(() =>
      stream("/api/v1/channels/channel-a/events").emit("channel.updated", {
        type: "channel.updated",
        channelId: channel.id,
        channel: { ...channel, botIds: ["alpha", "beta"] },
      }),
    );
    expect(await memberCount()).toBe("频道成员 2");
    const recovery = snapshot();
    recovery.channels.push({ ...channel, id: "missed-channel", name: "断线期间的新频道" });
    recovery.counts.channels = 2;
    await interact(() => reads[1]?.resolve(Response.json(recovery)));
    expect(await memberCount()).toBe("频道成员 2");
    expect(rendered?.container.textContent).toContain("断线期间的新频道");
    expect(reads).toHaveLength(2);
  });
  it.each(["join", "remove"] as const)(
    "projects the %s response before a failed reconciliation",
    async (operation) => {
      const container = await mount(snapshot(operation === "join" ? ["alpha"] : ["alpha", "beta"]));
      await ready();
      await interact(() => {
        if (operation === "join") {
          Array.from(container.querySelectorAll("button"))
            .find((button) => button.textContent === "添加成员")
            ?.click();
        }
      });
      await interact(() => {
        if (operation === "join") {
          container.querySelector<HTMLButtonElement>('.ci-add-popover [role="option"]')?.click();
        } else {
          container.querySelector<HTMLButtonElement>('[aria-label="将 Beta 移出频道"]')?.click();
        }
      });
      expect(mutations).toHaveLength(1);
      const result = { ...channel, botIds: operation === "join" ? ["alpha", "beta"] : ["alpha"] };
      await interact(() =>
        mutations[0]?.resolve(
          Response.json(
            operation === "join" ? { channel: result } : { channel: result, cancelledRuns: [] },
          ),
        ),
      );
      expect(await memberCount()).toBe(operation === "join" ? "频道成员 2" : "频道成员 1");
      expect(reads).toHaveLength(3);
      await interact(() => reads[2]?.reject(new Error("reconciliation unavailable")));
      expect(await memberCount()).toBe(operation === "join" ? "频道成员 2" : "频道成员 1");
      await interact(() => reads[1]?.resolve(Response.json(snapshot())));
      expect(await memberCount()).toBe(operation === "join" ? "频道成员 2" : "频道成员 1");
      expect(container.textContent).toContain("reconciliation unavailable");
    },
  );
  it("retains node removals and newer node events while recovering another missed worker", async () => {
    await mount();
    await ready();
    await interact(() => {
      stream().emit("node.upserted", { type: "node.upserted", node: worker });
      stream().emit("node.removed", { type: "node.removed", nodeId: worker.id });
      stream().emit("node.upserted", {
        type: "node.upserted",
        node: {
          ...worker,
          id: "updated",
          name: "Latest Worker",
          lastSeenAt: "2026-09-14T00:00:02Z",
        },
      });
      stream().emit("node.upserted", {
        type: "node.upserted",
        node: { ...worker, id: "updated", name: "Stale Worker" },
      });
    });
    const recovery = snapshot();
    recovery.nodes = [worker, { ...worker, id: "missed", name: "Missed Worker" }];
    recovery.counts.connectedNodes = 2;
    await interact(() => reads[1]?.resolve(Response.json(recovery)));
    await railTab("详情");
    const workers = rendered?.container.querySelectorAll(".ci-computer");
    expect(workers?.length).toBe(2);
    expect(rendered?.container.textContent).toContain("Latest Worker");
    expect(rendered?.container.textContent).toContain("Missed Worker");
    expect(rendered?.container.textContent).not.toContain("Fixture Worker");
    expect(rendered?.container.textContent).not.toContain("Stale Worker");
  });
  it("does not revive an approval or worker occupancy when replaying a completed run", async () => {
    const initial = snapshot();
    initial.nodes = [worker];
    initial.runs = [queuedRun];
    initial.approvals = [pendingApproval];
    initial.counts = { ...initial.counts, connectedNodes: 1, activeRuns: 1 };
    await mount(initial);
    await interact(() =>
      stream().emit("workspace.ready", { type: "workspace.ready", nodes: [worker] }),
    );
    const running: Run = {
      ...queuedRun,
      nodeId: worker.id,
      status: "running",
      updatedAt: "2026-09-14T00:00:01Z",
    };
    const completed: Run = {
      ...running,
      status: "completed",
      updatedAt: "2026-09-14T00:00:03Z",
      resultSummary: "验证完成",
    };
    await interact(() => {
      stream().emit("run.updated", { type: "run.updated", run: running });
      stream().emit("node.upserted", {
        type: "node.upserted",
        node: { ...worker, activeRunIds: [running.id], lastSeenAt: "2026-09-14T00:00:02Z" },
      });
      stream().emit("approval.updated", {
        type: "approval.updated",
        approval: { ...pendingApproval, status: "approved" },
        run: completed,
      });
      stream().emit("run.updated", { type: "run.updated", run: running });
    });
    await railTab("详情");
    expect(rendered?.container.querySelector(".ci-computer")?.textContent).toContain("0/2 任务");
    await interact(() => reads[1]?.resolve(Response.json(initial)));
    expect(rendered?.container.querySelector(".ci-computer")?.textContent).toContain("0/2 任务");
    expect(rendered?.container.querySelector(".ci-run-status.completed")).not.toBeNull();
    expect(rendered?.container.textContent).not.toContain(pendingApproval.summary);
    expect(reads).toHaveLength(2);
  });
  it("ignores an old request failure after the current refresh succeeded", async () => {
    await mount();
    await ready();
    await identityChanged();
    await interact(() => reads[2]?.resolve(Response.json(snapshot(["alpha", "beta"]))));
    await interact(() => reads[1]?.reject(new Error("stale failure")));
    expect(await memberCount()).toBe("频道成员 2");
    expect(rendered?.container.textContent).not.toContain("stale failure");
  });
  it("reconciles missed membership through the real EventSource reconnect handler", async () => {
    await mount();
    const disconnected = stream();
    await interact(() => disconnected.onerror?.());
    expect(disconnected.closed).toBe(true);
    await interact(() => vi.advanceTimersByTime(2000));
    expect(stream()).not.toBe(disconnected);
    await ready();
    await interact(() => reads[1]?.resolve(Response.json(snapshot(["alpha", "beta"]))));
    expect(await memberCount()).toBe("频道成员 2");
    expect(reads).toHaveLength(2);
  });
  it("invalidates StrictMode's first request and releases pending reads and streams on unmount", async () => {
    await mount(snapshot(["alpha", "beta"]), true);
    expect(reads).toHaveLength(2);
    expect(reads[0]?.signal?.aborted).toBe(true);
    await interact(() => reads[0]?.resolve(Response.json(snapshot())));
    expect(await memberCount()).toBe("频道成员 2");
    await ready();
    const pending = reads.at(-1);
    await rendered?.unmount();
    rendered = undefined;
    expect(pending?.signal?.aborted).toBe(true);
    expect(TestEventSource.instances.every((item) => item.closed)).toBe(true);
    await interact(() => pending?.reject(new Error("completion after unmount")));
    expect(document.body.textContent).toBe("");
  });
});

function employeeProfile(botId: string, name: string): EmployeeProfile {
  const employee = bots.find((bot) => bot.id === botId);
  if (!employee) throw new Error(`Unknown employee: ${botId}`);
  return {
    employee: { ...employee, name },
    details: { description: "Profile fixture", revision: 1, updatedAt: createdAt },
    evolution: [],
    skills: [],
    memories: [],
    memoryEvents: [],
    records: { runs: [], approvals: [], artifacts: [], decisions: [] },
    statistics: { totalRuns: 0, completedRuns: 0, failedRuns: 0, verifiedSkills: 0 },
    configuration: { executionProfile: "none", portabilityFormat: "openbot.employee/v1" },
  };
}
async function openProfile(name = "Alpha") {
  const button = rendered?.container.querySelector(
    `[title="${name} · 点击对话，右键查看更多操作"]`,
  );
  if (!button) throw new Error(`Missing profile entry: ${name}`);
  await interact(() =>
    button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
  const item = Array.from(
    rendered?.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
  ).find((candidate) => candidate.textContent?.trim() === "编辑资料");
  if (!item) throw new Error(`Missing profile menu item: ${name}`);
  await interact(() => item.click());
}
async function completeProfile(index: number, name: string) {
  const request = profiles[index];
  if (!request) throw new Error(`Missing profile request: ${index}`);
  await interact(() =>
    request.resolve(Response.json({ profile: employeeProfile(request.botId, name) })),
  );
}
function displayedProfile() {
  return rendered?.container.querySelector(".employee-profile .ep-name h1")?.textContent;
}
describe("Employee profile read ownership in the real workspace", () => {
  it.each(["success", "failure"])(
    "ignores stale %s after an event refresh completed",
    async (outcome) => {
      await mount();
      await openProfile();
      await identityChanged();
      expect(profiles).toHaveLength(2);
      await completeProfile(1, "Latest Alpha");
      expect(displayedProfile()).toBe("Latest Alpha");
      if (outcome === "success") await completeProfile(0, "Stale Alpha");
      else await interact(() => profiles[0]?.reject(new Error("stale profile error")));
      expect(displayedProfile()).toBe("Latest Alpha");
      expect(rendered?.container.textContent).not.toContain("stale profile error");
      expect(profiles[0]?.signal?.aborted).toBe(true);
    },
  );
  it("does not let a stale completion stop the current loading state", async () => {
    await mount();
    await openProfile();
    await identityChanged();
    await completeProfile(0, "Stale Alpha");
    expect(displayedProfile()).toBeUndefined();
    expect(rendered?.container.textContent).toContain("正在读取员工档案");
    await completeProfile(1, "Latest Alpha");
    expect(displayedProfile()).toBe("Latest Alpha");
  });
  it("aborts a reconnect read when leaving and does not revive it on return", async () => {
    await mount();
    await openProfile();
    await completeProfile(0, "Initial Alpha");
    await ready();
    await openProfile("Beta");
    expect(profiles[1]?.signal?.aborted).toBe(true);
    await openProfile();
    await completeProfile(3, "Returned Alpha");
    await completeProfile(1, "Old Alpha from reconnect");
    await completeProfile(2, "Old Beta");
    expect(displayedProfile()).toBe("Returned Alpha");
  });
  it("aborts event reads on unmount and does not refetch unrelated profiles", async () => {
    await mount(snapshot(), true);
    await openProfile("Beta");
    await identityChanged();
    expect(profiles).toHaveLength(1);
    await ready();
    expect(profiles).toHaveLength(2);
    await rendered?.unmount();
    rendered = undefined;
    expect(profiles.every((request) => request.signal?.aborted)).toBe(true);
    await completeProfile(1, "Late Beta");
    expect(document.body.textContent).toBe("");
  });
  it("shows a failed refresh and retries instead of silently presenting retained data as fresh", async () => {
    await mount();
    await openProfile();
    await completeProfile(0, "Initial Alpha");
    await ready();
    await interact(() => profiles[1]?.reject(new Error("profile refresh failed")));
    expect(rendered?.container.querySelector(".employee-profile-loading")?.textContent).toContain(
      "profile refresh failed",
    );
    expect(displayedProfile()).toBeUndefined();
    const retry = rendered?.container.querySelector<HTMLButtonElement>(
      ".employee-profile-loading button.primary-button",
    );
    if (!retry) throw new Error("Missing refresh retry button");
    await interact(() => retry.click());
    await completeProfile(2, "Refreshed Alpha");
    expect(displayedProfile()).toBe("Refreshed Alpha");
  });
  it("keeps the retry consumer connected after a current failure", async () => {
    await mount();
    await openProfile();
    await interact(() => profiles[0]?.reject(new Error("current profile failure")));
    expect(rendered?.container.textContent).toContain("current profile failure");
    const retry = rendered?.container.querySelector<HTMLButtonElement>(
      ".employee-profile-loading button.primary-button",
    );
    if (!retry) throw new Error("Missing retry button");
    await interact(() => retry.click());
    await completeProfile(1, "Recovered Alpha");
    expect(displayedProfile()).toBe("Recovered Alpha");
    expect(rendered?.container.textContent).not.toContain("current profile failure");
  });
});
