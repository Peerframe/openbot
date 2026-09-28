import type { ExecutionNode } from "@openbot/domain";
import type { EmployeeTemplatePayload, NodeCapability } from "@openbot/protocol";

interface ExecutionRequirements {
  capabilities: NodeCapability[];
  platform?: ExecutionNode["platform"];
}

export function requirementsForExecutionProfile(
  executionProfile: EmployeeTemplatePayload["configuration"]["recommendedExecutionProfile"],
): ExecutionRequirements | undefined {
  switch (executionProfile) {
    case "docker-linux":
      return {
        capabilities: ["browser", "screenshot"],
      };
    case "macos-cua":
      return {
        capabilities: ["cua", "screenshot"],
        platform: "macos",
      };
    case "lume-vm":
      return {
        capabilities: ["lume", "screenshot"],
        platform: "macos",
      };
    case "coder":
      return {
        capabilities: ["coder"],
      };
    case "none":
    case "model":
      return undefined;
  }
}
