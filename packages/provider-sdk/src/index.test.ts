import { describe, expect, it } from "vitest";
import type { ComputerProvider } from "./index.js";
import {
  assertProviderDeclarations,
  buildProviderConformanceReport,
  inspectProviderDeclaration,
  serializeProviderConformanceReport,
} from "./index.js";

const provider = (overrides: Partial<ComputerProvider> = {}): ComputerProvider => ({
  id: "browser-driver",
  displayName: "Browser driver",
  platforms: ["linux", "windows", "macos"],
  capabilities: ["browser", "screenshot"],
  capabilityManifest: [
    { id: "browser.observe", version: 1, providerId: "browser-driver", constraints: {} },
    { id: "screen.capture", version: 1, providerId: "browser-driver", constraints: {} },
  ],
  ...overrides,
});

describe("Provider declaration conformance", () => {
  it("separates a conformant declaration from runtime execution support", () => {
    expect(inspectProviderDeclaration(provider())).toEqual({
      providerId: "browser-driver",
      conformant: true,
      executionStatus: "declaration-only",
      issues: [],
    });
    expect(
      inspectProviderDeclaration(
        provider({
          execute: async () => ({ ok: true, summary: "done", artifacts: [] }),
        }),
      ).executionStatus,
    ).toBe("executable");
  });

  it("reports invalid and internally inconsistent declarations", () => {
    const report = inspectProviderDeclaration(
      provider({
        id: "Browser Driver",
        displayName: " ",
        platforms: ["unknown", "unknown"],
        capabilities: ["browser", "browser"],
        capabilityManifest: [
          { id: "browser.observe", version: 1, providerId: "other", constraints: {} },
          { id: "browser.observe", version: 1, providerId: "other", constraints: {} },
        ],
      }),
    );

    expect(report.conformant).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual([
      "provider-id-invalid",
      "display-name-missing",
      "platform-duplicate",
      "platform-unknown",
      "legacy-capability-duplicate",
      "capability-provider-mismatch",
      "capability-provider-mismatch",
      "capability-duplicate",
    ]);
  });

  it("fails closed before a Worker Host can advertise an invalid declaration", () => {
    expect(() =>
      assertProviderDeclarations([
        provider({
          capabilityManifest: [],
          execute: async () => ({ ok: true, summary: "", artifacts: [] }),
        }),
      ]),
    ).toThrow("browser-driver:capability-manifest-empty");
  });
});

describe("machine-readable Provider conformance", () => {
  const generatedAt = "2026-09-04T00:00:00.000Z";
  const executableProvider = (): ComputerProvider =>
    provider({
      execute: async () => ({ ok: true, summary: "done", artifacts: [] }),
    });
  const target = {
    platform: "linux",
    architecture: "x64",
    osVersion: "6.8.0",
    evidenceLevel: "hermetic",
  } as const;

  it.each([
    "provider.declaration",
    "provider.target-platform",
    "provider.executable",
    "target.evidence-level",
    "target.real-device-metadata",
  ])("independently refuses a caller-supplied generated check %s", (id) => {
    expect(() =>
      buildProviderConformanceReport({
        provider: executableProvider(),
        providerVersion: "0.1.0",
        target,
        stage: "integration",
        suiteVersion: "1.0.0",
        generatedAt,
        checks: [
          {
            id,
            name: "Override",
            description: "Cannot override generated evidence.",
            status: "success",
            severity: "required",
          },
        ],
      }),
    ).toThrow(`Conformance check id ${id} is reserved`);
  });

  it("emits a bounded, deterministic report without turning evidence into a support claim", () => {
    const report = buildProviderConformanceReport({
      provider: executableProvider(),
      providerVersion: "0.1.0",
      target,
      stage: "integration",
      suiteVersion: "1.0.0",
      generatedAt,
      checks: [
        {
          id: "scenario.navigate-and-capture",
          name: "Navigate and capture",
          description: "The Provider returns a bounded screenshot from a hermetic target.",
          status: "success",
          severity: "required",
          evidence: ["fixture=example.test", "artifact=result.png"],
        },
      ],
    });

    expect(report.checks.map((check) => check.id)).toEqual([
      "provider.declaration",
      "provider.executable",
      "provider.target-platform",
      "scenario.navigate-and-capture",
      "target.evidence-level",
    ]);
    expect(report.summary).toMatchObject({
      success: 5,
      failure: 0,
      total: 5,
      conformant: true,
      baselineCurrent: true,
    });
    expect(report).not.toHaveProperty("supported");
    expect(report).not.toHaveProperty("certified");
    expect(serializeProviderConformanceReport(report)).toBe(`${JSON.stringify(report, null, 2)}\n`);
  });

  it("keeps an expected failure visible and non-conformant while accepting the CI baseline", () => {
    const report = buildProviderConformanceReport({
      provider: provider({ id: "Browser Driver" }),
      providerVersion: "0.1.0",
      target,
      stage: "declaration",
      suiteVersion: "1.0.0",
      generatedAt,
      expectedFailures: [
        {
          checkId: "provider.declaration",
          reason: "The provider id migration is tracked and must not be hidden.",
          issueUrl: "https://github.com/example/openbot/issues/123",
          expiresAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });

    expect(report.baseline.unexpectedFailures).toEqual([]);
    expect(report.baseline.staleEntries).toEqual([]);
    expect(report.summary).toMatchObject({
      failure: 1,
      expectedFailureEntries: 1,
      conformant: false,
      baselineCurrent: true,
    });
  });

  it("fails the baseline on an unexpected failure or a stale expected failure", () => {
    const unexpected = buildProviderConformanceReport({
      provider: executableProvider(),
      providerVersion: "0.1.0",
      target: { ...target, platform: "freebsd" },
      stage: "routing",
      suiteVersion: "1.0.0",
      generatedAt,
    });
    expect(unexpected.baseline.unexpectedFailures).toEqual(["provider.target-platform"]);
    expect(unexpected.summary.baselineCurrent).toBe(false);

    const stale = buildProviderConformanceReport({
      provider: executableProvider(),
      providerVersion: "0.1.0",
      target,
      stage: "declaration",
      suiteVersion: "1.0.0",
      generatedAt,
      expectedFailures: [
        {
          checkId: "provider.declaration",
          reason: "This baseline should be removed after the check passes.",
          issueUrl: "https://github.com/example/openbot/issues/124",
          expiresAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
    expect(stale.baseline.staleEntries).toEqual(["provider.declaration"]);
    expect(stale.summary.baselineCurrent).toBe(false);

    const expired = buildProviderConformanceReport({
      provider: provider({ id: "Browser Driver" }),
      providerVersion: "0.1.0",
      target,
      stage: "declaration",
      suiteVersion: "1.0.0",
      generatedAt,
      expectedFailures: [
        {
          checkId: "provider.declaration",
          reason: "Expired debt must return to the unexpected-failure queue.",
          issueUrl: "https://github.com/example/openbot/issues/125",
          expiresAt: "2026-09-03T00:00:00.000Z",
        },
      ],
    });
    expect(expired.baseline.staleEntries).toEqual(["provider.declaration"]);
    expect(expired.baseline.unexpectedFailures).toEqual(["provider.declaration"]);
    expect(expired.summary.baselineCurrent).toBe(false);
  });

  it("rejects skipped required checks, duplicate ids, and incomplete real-device evidence", () => {
    expect(() =>
      buildProviderConformanceReport({
        provider: executableProvider(),
        providerVersion: "0.1.0",
        target,
        stage: "integration",
        suiteVersion: "1.0.0",
        generatedAt,
        checks: [
          {
            id: "scenario.missing-browser",
            name: "Browser prerequisite",
            description: "A required browser executable must be present.",
            status: "skipped",
            severity: "required",
          },
        ],
      }),
    ).toThrow("missing prerequisites are failures");

    expect(() =>
      buildProviderConformanceReport({
        provider: executableProvider(),
        providerVersion: "0.1.0",
        target,
        stage: "routing",
        suiteVersion: "1.0.0",
        generatedAt,
        checks: [
          {
            id: "scenario.duplicate",
            name: "First",
            description: "First duplicate.",
            status: "success",
            severity: "recommended",
          },
          {
            id: "scenario.duplicate",
            name: "Second",
            description: "Second duplicate.",
            status: "success",
            severity: "recommended",
          },
        ],
      }),
    ).toThrow("Conformance check ids must be unique");

    expect(() =>
      buildProviderConformanceReport({
        provider: executableProvider(),
        providerVersion: "0.1.0",
        target: {
          platform: "linux",
          architecture: "unknown",
          osVersion: "unknown",
          evidenceLevel: "hermetic",
        },
        stage: "real-device",
        suiteVersion: "1.0.0",
        generatedAt,
      }),
    ).toThrow("Real-device reports require real-device evidence");

    const realDevice = buildProviderConformanceReport({
      provider: executableProvider(),
      providerVersion: "0.1.0",
      target: {
        platform: "linux",
        architecture: "x64",
        osVersion: "6.8.0",
        evidenceLevel: "real-device",
        workerHostVersion: "0.1.0",
        hardwareModel: "Dedicated test workstation",
        hardwareEvidenceId: "inventory.linux-lab-01",
      },
      stage: "real-device",
      suiteVersion: "1.0.0",
      generatedAt,
    });
    expect(realDevice.summary.conformant).toBe(true);
    expect(
      realDevice.checks.find((check) => check.id === "target.real-device-metadata"),
    ).toMatchObject({ status: "success" });
  });
});
