import type { ExecutionNode, Run } from "@openbot/domain";
import {
  firstCapabilityRequirementMismatch,
  hasBrowserClickIntent,
  type NodeCapability,
  type NodeCapabilityRequirement,
} from "@openbot/protocol";

export interface ExecutionRequirements {
  capabilities: NodeCapability[];
  capabilityManifest: NodeCapabilityRequirement[];
  executionProfile: Exclude<Run["executionProfile"], "none" | "model">;
  platform?: ExecutionNode["platform"];
}

export type NodeCompatibilityResult =
  | { compatible: true }
  | {
      compatible: false;
      reason:
        | "capacity-exhausted"
        | "platform-mismatch"
        | "legacy-capability-missing"
        | "capability-missing"
        | "capability-version-unsupported";
      capability?: string;
      expectedVersion?: number;
      advertisedVersions?: number[];
    };

export function requirementsForRun(run: Run): ExecutionRequirements | undefined {
  const requirements = requirementsForExecutionProfile(run.executionProfile);
  if (
    requirements &&
    run.executionProfile === "docker-linux" &&
    hasBrowserClickIntent(run.instruction)
  )
    requirements.capabilityManifest.push({ id: "browser.input", version: 1 });
  return requirements;
}

export function requirementsForExecutionProfile(
  executionProfile: Run["executionProfile"],
): ExecutionRequirements | undefined {
  switch (executionProfile) {
    case "docker-linux":
      return {
        capabilities: ["browser", "screenshot"],
        capabilityManifest: [
          { id: "browser.observe", version: 1 },
          { id: "screen.capture", version: 1 },
        ],
        executionProfile: "docker-linux",
      };
    case "macos-cua":
      return {
        capabilities: ["cua", "screenshot"],
        capabilityManifest: [
          { id: "desktop.observe", version: 1 },
          { id: "screen.capture", version: 1 },
        ],
        executionProfile: "macos-cua",
        platform: "macos",
      };
    case "lume-vm":
      return {
        capabilities: ["lume", "screenshot"],
        capabilityManifest: [
          { id: "vm.manage", version: 1 },
          { id: "desktop.observe", version: 1 },
          { id: "screen.capture", version: 1 },
        ],
        executionProfile: "lume-vm",
        platform: "macos",
      };
    case "coder":
      return {
        capabilities: ["coder"],
        capabilityManifest: [{ id: "code.execute", version: 1 }],
        executionProfile: "coder",
      };
    case "none":
    case "model":
      return undefined;
  }
}

export function selectExecutionNode(
  run: Run,
  nodes: ExecutionNode[],
): { node: ExecutionNode; requirements: ExecutionRequirements } | undefined {
  const requirements = requirementsForRun(run);
  if (requirements === undefined) return undefined;

  const candidates = nodes.filter(
    (node) => evaluateNodeCompatibility(requirements, node).compatible,
  );
  candidates.sort(
    (left, right) =>
      left.activeRunIds.length - right.activeRunIds.length || left.id.localeCompare(right.id),
  );
  const node = candidates[0];
  return node === undefined ? undefined : { node, requirements };
}

/**
 * Evaluate a Node declaration without attempting execution. Versioned capabilities are
 * authoritative: legacy names cannot silently satisfy a missing or incompatible major version.
 */
export function evaluateNodeCompatibility(
  requirements: ExecutionRequirements,
  node: ExecutionNode,
): NodeCompatibilityResult {
  if (node.activeRunIds.length >= node.maxConcurrentRuns) {
    return { compatible: false, reason: "capacity-exhausted" };
  }
  if (requirements.platform !== undefined && node.platform !== requirements.platform) {
    return { compatible: false, reason: "platform-mismatch" };
  }

  const legacyCapabilities = new Set(node.capabilities);
  const missingLegacy = requirements.capabilities.find(
    (capability) => !legacyCapabilities.has(capability),
  );
  if (missingLegacy !== undefined) {
    return {
      compatible: false,
      reason: "legacy-capability-missing",
      capability: missingLegacy,
    };
  }

  const mismatch = firstCapabilityRequirementMismatch(
    requirements.capabilityManifest,
    node.capabilityManifest,
  );
  if (mismatch !== undefined) {
    return { compatible: false, ...mismatch };
  }
  return { compatible: true };
}
