import {
  nodeCapabilityDescriptorSchema,
  nodeCapabilitySchema,
  nodePlatformSchema,
} from "@openbot/protocol";
import type { ComputerProvider } from "./provider.js";

export type ProviderConformanceIssueCode =
  | "provider-id-invalid"
  | "display-name-missing"
  | "platforms-empty"
  | "platform-duplicate"
  | "platform-unknown"
  | "platform-invalid"
  | "legacy-capability-invalid"
  | "capability-invalid"
  | "legacy-capability-duplicate"
  | "capability-manifest-empty"
  | "capability-provider-mismatch"
  | "capability-duplicate";

export interface ProviderConformanceIssue {
  code: ProviderConformanceIssueCode;
  message: string;
}

export interface ProviderDeclarationReport {
  providerId: string;
  conformant: boolean;
  executionStatus: "executable" | "declaration-only";
  issues: ProviderConformanceIssue[];
}

/**
 * Validate the static declaration every Worker Host publishes. This is intentionally independent
 * from runtime certification: a well-formed declaration does not prove that execution works.
 */
export function inspectProviderDeclaration(provider: ComputerProvider): ProviderDeclarationReport {
  const issues: ProviderConformanceIssue[] = [];
  // Reuse the Server's wire constraints before a declaration can pass local startup checks.
  if (!nodePlatformSchema.array().safeParse(provider.platforms).success)
    issues.push({
      code: "platform-invalid",
      message: "Platforms must match the shared wire schema.",
    });
  if (
    !nodeCapabilitySchema
      .array()
      .max(nodeCapabilitySchema.options.length)
      .safeParse(provider.capabilities).success
  )
    issues.push({
      code: "legacy-capability-invalid",
      message: "Legacy capabilities must match the shared wire schema.",
    });
  if (
    !nodeCapabilityDescriptorSchema.array().max(32).safeParse(provider.capabilityManifest).success
  )
    issues.push({
      code: "capability-invalid",
      message: "Capability descriptors must match the shared wire schema.",
    });

  if (issues.length)
    return {
      providerId: provider.id,
      conformant: false,
      executionStatus: provider.execute === undefined ? "declaration-only" : "executable",
      issues,
    };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(provider.id)) {
    issues.push({
      code: "provider-id-invalid",
      message: "Provider id must use lowercase ASCII letters, numbers, and hyphens.",
    });
  }
  if (provider.displayName.trim().length === 0) {
    issues.push({ code: "display-name-missing", message: "Provider display name is required." });
  }
  if (provider.platforms.length === 0) {
    issues.push({ code: "platforms-empty", message: "At least one platform must be declared." });
  }
  if (new Set(provider.platforms).size !== provider.platforms.length) {
    issues.push({ code: "platform-duplicate", message: "Platforms must not contain duplicates." });
  }
  if (provider.platforms.includes("unknown")) {
    issues.push({
      code: "platform-unknown",
      message: "A Provider cannot claim the unknown platform as supported.",
    });
  }
  if (new Set(provider.capabilities).size !== provider.capabilities.length) {
    issues.push({
      code: "legacy-capability-duplicate",
      message: "Legacy capability aliases must not contain duplicates.",
    });
  }
  if (provider.capabilities.length > 0 && provider.capabilityManifest.length === 0) {
    issues.push({
      code: "capability-manifest-empty",
      message: "Legacy capability aliases require versioned capability descriptors.",
    });
  }

  const descriptorKeys = new Set<string>();
  for (const descriptor of provider.capabilityManifest) {
    if (descriptor.providerId !== provider.id) {
      issues.push({
        code: "capability-provider-mismatch",
        message: `${descriptor.id}@${descriptor.version} names provider ${descriptor.providerId}, expected ${provider.id}.`,
      });
    }
    const key = `${descriptor.id}@${descriptor.version}`;
    if (descriptorKeys.has(key)) {
      issues.push({
        code: "capability-duplicate",
        message: `Capability ${key} is declared more than once.`,
      });
    }
    descriptorKeys.add(key);
  }

  return {
    providerId: provider.id,
    conformant: issues.length === 0,
    executionStatus: provider.execute === undefined ? "declaration-only" : "executable",
    issues,
  };
}

export function assertProviderDeclarations(providers: ComputerProvider[]): void {
  const reports = providers.map(inspectProviderDeclaration).filter((report) => !report.conformant);
  if (reports.length === 0) return;
  const details = reports
    .flatMap((report) => report.issues.map((issue) => `${report.providerId}:${issue.code}`))
    .join(", ");
  throw new Error(`Invalid Provider declaration(s): ${details}.`);
}
