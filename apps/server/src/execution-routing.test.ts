import type { ExecutionNode, Run } from "@openbot/domain";
import { describe, expect, it } from "vitest";
import {
  evaluateNodeCompatibility,
  requirementsForRun,
  selectExecutionNode,
} from "./execution-routing.js";

const run: Run = {
  id: "00000000-0000-4000-8000-000000000001",
  channelId: "00000000-0000-4000-8000-000000000002",
  botId: "00000000-0000-4000-8000-000000000003",
  executionProfile: "docker-linux",
  instruction: "打开 https://example.test 并截图",
  title: "打开测试页并截图",
  status: "queued",
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
};

const node = (overrides: Partial<ExecutionNode> = {}): ExecutionNode => ({
  id: "node-b",
  name: "Linux worker",
  platform: "linux",
  osVersion: "6.8.0",
  architecture: "x64",
  deviceClass: "server",
  isolation: "dedicated-host",
  trustTier: "development",
  capabilities: ["browser", "shell", "screenshot"],
  capabilityManifest: [
    { id: "browser.observe", version: 1, providerId: "docker", constraints: {} },
    { id: "screen.capture", version: 1, providerId: "docker", constraints: {} },
  ],
  activeRunIds: [],
  maxConcurrentRuns: 1,
  connectedAt: "2026-09-03T00:00:00.000Z",
  lastSeenAt: "2026-09-03T00:00:00.000Z",
  ...overrides,
});

describe("execution routing", () => {
  it("requires browser.input for explicit clicks and does not route them to observation-only Workers", () => {
    const clicking = {
      ...run,
      instruction: 'Open https://example.com/ and click button "Preview"',
    };
    expect(selectExecutionNode(clicking, [node()])).toBeUndefined();
    const capable = node();
    capable.capabilityManifest.push({
      id: "browser.input",
      version: 1,
      providerId: "docker",
      constraints: { operation: "click" },
    });
    expect(
      selectExecutionNode(clicking, [capable])?.requirements.capabilityManifest,
    ).toContainEqual({ id: "browser.input", version: 1 });
  });

  it("maps fixed profiles to legacy aliases and exact capability majors", () => {
    expect(requirementsForRun(run)).toEqual({
      capabilities: ["browser", "screenshot"],
      capabilityManifest: [
        { id: "browser.observe", version: 1 },
        { id: "screen.capture", version: 1 },
      ],
      executionProfile: "docker-linux",
    });
    expect(requirementsForRun({ ...run, executionProfile: "macos-cua" })).toEqual({
      capabilities: ["cua", "screenshot"],
      capabilityManifest: [
        { id: "desktop.observe", version: 1 },
        { id: "screen.capture", version: 1 },
      ],
      executionProfile: "macos-cua",
      platform: "macos",
    });
    expect(requirementsForRun({ ...run, executionProfile: "none" })).toBeUndefined();
    expect(requirementsForRun({ ...run, executionProfile: "model" })).toBeUndefined();
  });

  it("selects the least-loaded compatible node with a stable ID tie-break", () => {
    const selected = selectExecutionNode(run, [
      node({ id: "node-b" }),
      node({ id: "node-a" }),
      node({ id: "node-full", activeRunIds: [run.id] }),
      node({ id: "node-shell", capabilities: ["shell"] }),
    ]);

    expect(selected?.node.id).toBe("node-a");
  });

  const platformScenarios: Array<{
    name: string;
    executionProfile: Run["executionProfile"];
    worker: ExecutionNode;
    compatible: boolean;
    reason?: string;
  }> = [
    {
      name: "Linux x64 browser Worker",
      executionProfile: "docker-linux",
      worker: node({ platform: "linux", architecture: "x64", deviceClass: "server" }),
      compatible: true,
    },
    {
      name: "Windows x64 browser Worker",
      executionProfile: "docker-linux",
      worker: node({ platform: "windows", architecture: "x64", deviceClass: "desktop" }),
      compatible: true,
    },
    {
      name: "macOS arm64 browser Worker",
      executionProfile: "docker-linux",
      worker: node({ platform: "macos", architecture: "arm64", deviceClass: "desktop" }),
      compatible: true,
    },
    {
      name: "macOS arm64 Cua declaration",
      executionProfile: "macos-cua",
      worker: node({
        platform: "macos",
        architecture: "arm64",
        deviceClass: "desktop",
        capabilities: ["cua", "screenshot"],
        capabilityManifest: [
          { id: "desktop.observe", version: 1, providerId: "cua", constraints: {} },
          { id: "screen.capture", version: 1, providerId: "cua", constraints: {} },
        ],
      }),
      compatible: true,
    },
    {
      name: "Linux cannot claim a macOS-only profile",
      executionProfile: "macos-cua",
      worker: node({
        platform: "linux",
        capabilities: ["cua", "screenshot"],
        capabilityManifest: [
          { id: "desktop.observe", version: 1, providerId: "cua", constraints: {} },
          { id: "screen.capture", version: 1, providerId: "cua", constraints: {} },
        ],
      }),
      compatible: false,
      reason: "platform-mismatch",
    },
    {
      name: "legacy aliases cannot replace an empty manifest",
      executionProfile: "docker-linux",
      worker: node({ capabilityManifest: [] }),
      compatible: false,
      reason: "capability-missing",
    },
    {
      name: "a newer unrecognized capability major cannot silently satisfy v1",
      executionProfile: "docker-linux",
      worker: node({
        capabilityManifest: [
          { id: "browser.observe", version: 2, providerId: "docker", constraints: {} },
          { id: "screen.capture", version: 1, providerId: "docker", constraints: {} },
        ],
      }),
      compatible: false,
      reason: "capability-version-unsupported",
    },
    {
      name: "Linux arm64 coding Worker",
      executionProfile: "coder",
      worker: node({
        platform: "linux",
        architecture: "arm64",
        capabilities: ["coder", "shell"],
        capabilityManifest: [
          { id: "code.execute", version: 1, providerId: "coder", constraints: {} },
        ],
      }),
      compatible: true,
    },
  ];

  it.each(platformScenarios)("conformance: $name", (scenario) => {
    const requirements = requirementsForRun({
      ...run,
      executionProfile: scenario.executionProfile,
    });
    if (requirements === undefined) throw new Error("Scenario requires an execution profile.");
    const result = evaluateNodeCompatibility(requirements, scenario.worker);

    expect(result.compatible).toBe(scenario.compatible);
    if (!scenario.compatible && !result.compatible) expect(result.reason).toBe(scenario.reason);
  });
});
