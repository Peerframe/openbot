import type { Run } from "@openbot/domain";
import { describe, expect, it } from "vitest";
import {
  indexActiveRunsByBot,
  isActiveRun,
  mergeArtifacts,
  mergeNodes,
  mergeProgress,
  mergeRuns,
  projectRunOnNodes,
  runStatusLabel,
  runTitle,
} from "./run-state";

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    channelId: "channel-1",
    botId: "bot-1",
    executionProfile: "docker-linux",
    instruction: "Test task",
    title: "Test task",
    status: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("run projections", () => {
  it("deduplicates realtime updates and keeps newest runs first", () => {
    const older = run();
    const updated = run({ status: "running", updatedAt: "2026-01-01T00:01:00.000Z" });
    const newer = run({
      id: "run-2",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    expect(mergeRuns([older], [updated, newer])).toEqual([newer, updated]);
  });

  it("does not let an older REST response overwrite a newer realtime state", () => {
    const assigned = run({
      status: "assigned",
      nodeId: "linux-node",
      updatedAt: "2026-01-01T00:01:00.000Z",
    });
    const staleQueued = run({ status: "queued", updatedAt: "2026-01-01T00:00:00.000Z" });

    expect(mergeRuns([assigned], [staleQueued])).toEqual([assigned]);
    expect(mergeRuns([assigned], [{ ...staleQueued, updatedAt: assigned.updatedAt }])).toEqual([
      assigned,
    ]);
  });

  it("indexes only the newest active run for each Bot", () => {
    const active = run({ id: "active", status: "waiting_approval" });
    const completed = run({ id: "done", status: "completed" });
    const index = indexActiveRunsByBot([active, completed]);

    expect(index.get("bot-1")).toEqual(active);
    expect(isActiveRun(completed)).toBe(false);
    expect(runStatusLabel(active.status)).toBe("待批准");
    expect(runStatusLabel("assigned")).toBe("已分配");
  });

  it("projects assignment and requeue events onto the connected Node", () => {
    const nodes = [
      {
        id: "linux-node",
        name: "Linux worker",
        platform: "linux" as const,
        osVersion: "6.8.0",
        architecture: "x64" as const,
        deviceClass: "server" as const,
        isolation: "unknown" as const,
        trustTier: "development" as const,
        capabilities: ["browser"],
        capabilityManifest: [],
        activeRunIds: [],
        maxConcurrentRuns: 1,
        connectedAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const queued = run();
    const assigned = run({ nodeId: "linux-node", status: "assigned" });
    const withAssignment = projectRunOnNodes(nodes, queued, assigned);
    const requeued = projectRunOnNodes(withAssignment, assigned, queued);

    expect(withAssignment[0]?.activeRunIds).toEqual([queued.id]);
    expect(requeued[0]?.activeRunIds).toEqual([]);
  });

  it("merges completed artifacts without duplicating realtime projections", () => {
    const artifact = {
      id: "artifact-1",
      runId: "run-1",
      name: "result.png",
      mediaType: "image/png",
      sha256: "a".repeat(64),
      sizeBytes: 128,
      createdAt: "2026-01-01T00:01:00.000Z",
    };

    expect(mergeArtifacts([artifact], [{ ...artifact, name: "renamed.png" }])).toEqual([
      { ...artifact, name: "renamed.png" },
    ]);
  });

  it("merges progress chronologically without duplicating events", () => {
    const first = {
      id: "progress-1",
      runId: "run-1",
      channelId: "channel-1",
      nodeId: "linux-node",
      stage: "navigate",
      message: "正在打开页面",
      createdAt: "2026-01-01T00:01:00.000Z",
    };
    const second = {
      ...first,
      id: "progress-2",
      stage: "screenshot",
      message: "正在截图",
      createdAt: "2026-01-01T00:02:00.000Z",
    };

    expect(mergeProgress([second], [first, first])).toEqual([first, second]);
  });

  it("keeps the latest projection for each connected Node", () => {
    const node = {
      id: "linux-node",
      name: "Linux worker",
      platform: "linux" as const,
      osVersion: "6.8.0",
      architecture: "x64" as const,
      deviceClass: "server" as const,
      isolation: "unknown" as const,
      trustTier: "development" as const,
      capabilities: ["browser"],
      capabilityManifest: [],
      activeRunIds: [],
      maxConcurrentRuns: 1,
      connectedAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    };
    const updated = {
      ...node,
      activeRunIds: ["run-1"],
      lastSeenAt: "2026-01-01T00:01:00.000Z",
    };

    expect(mergeNodes([node], [updated])).toEqual([updated]);
    expect(mergeNodes([updated], [node])).toEqual([updated]);
  });
});

describe("runTitle (P2 acceptance, 2026-10-07)", () => {
  it("shows only the Owner's words, not the appended attachment description", () => {
    expect(
      runTitle({
        title: "附件验收 User-provided attachment: p2.txt (text/plain, 24 bytes) [OpenBot att",
      }),
    ).toBe("附件验收");
    expect(runTitle({ title: "User-provided attachment: p2.txt (text/plain, 24 bytes)" })).toBe(
      "处理附件",
    );
    expect(runTitle({ title: "整理本周周报" })).toBe("整理本周周报");
  });
});
