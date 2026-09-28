import { describe, expect, it } from "vitest";
import type { ComputerProvider } from "@openbot/provider-sdk";
import {
  runProviderConformanceSuite,
  type ProviderConformanceScenario,
  type ProviderConformanceSuite,
} from "./runner.js";

const generatedAt = "2026-09-04T00:00:00.000Z";

function executableProvider(overrides: Partial<ComputerProvider> = {}): ComputerProvider {
  return {
    id: "fixture-provider",
    displayName: "Fixture Provider",
    platforms: ["linux"],
    capabilities: ["browser"],
    capabilityManifest: [
      {
        id: "browser.observe",
        version: 1,
        providerId: "fixture-provider",
        constraints: {},
      },
    ],
    execute: async () => ({ ok: true, summary: "done", artifacts: [] }),
    ...overrides,
  };
}

function successfulScenario(
  overrides: Partial<ProviderConformanceScenario> = {},
): ProviderConformanceScenario {
  return {
    id: "scenario.navigate",
    name: "Navigate",
    description: "Navigate using a bounded hermetic fixture.",
    severity: "required",
    run: () => ({ status: "success", code: "navigation-complete" }),
    ...overrides,
  };
}

function suite(overrides: Partial<ProviderConformanceSuite> = {}): ProviderConformanceSuite {
  return {
    name: "openbot-provider",
    version: "1.0.0",
    stage: "integration",
    provider: executableProvider(),
    providerVersion: "0.1.0",
    target: {
      platform: "linux",
      architecture: "x64",
      osVersion: "6.8.0",
      evidenceLevel: "hermetic",
    },
    defaultTimeoutMs: 100,
    generatedAt,
    scenarios: [successfulScenario()],
    ...overrides,
  };
}

function scenarioCheck(
  result: Awaited<ReturnType<typeof runProviderConformanceSuite>>,
  id: string,
) {
  const check = result.report.checks.find((candidate) => candidate.id === id);
  expect(check).toBeDefined();
  return check;
}

describe("Provider conformance runner", () => {
  it("runs scenarios sequentially in stable id order and always cleans them up", async () => {
    const lifecycle: string[] = [];
    const scenario = (id: string): ProviderConformanceScenario =>
      successfulScenario({
        id,
        name: id,
        setup: () => lifecycle.push(`setup:${id}`),
        run: () => {
          lifecycle.push(`run:${id}`);
          return { status: "success", code: "fixture-complete" };
        },
        cleanup: () => lifecycle.push(`cleanup:${id}`),
      });

    const result = await runProviderConformanceSuite(
      suite({ scenarios: [scenario("scenario.zulu"), scenario("scenario.alpha")] }),
    );

    expect(lifecycle).toEqual([
      "setup:scenario.alpha",
      "run:scenario.alpha",
      "cleanup:scenario.alpha",
      "setup:scenario.zulu",
      "run:scenario.zulu",
      "cleanup:scenario.zulu",
    ]);
    expect(result.report.checks.map((check) => check.id)).toEqual([
      "provider.declaration",
      "provider.executable",
      "provider.target-platform",
      "scenario.alpha",
      "scenario.zulu",
      "target.evidence-level",
    ]);
    expect(result.report.summary).toMatchObject({ conformant: true, baselineCurrent: true });
    expect(result.exitCode).toBe(0);
  });

  it("suppresses thrown values and stack traces from public evidence", async () => {
    const secret = "obn_secret-that-must-not-enter-evidence";
    const result = await runProviderConformanceSuite(
      suite({
        scenarios: [
          successfulScenario({
            run: () => Promise.reject(secret),
          }),
        ],
      }),
    );

    expect(scenarioCheck(result, "scenario.navigate")).toMatchObject({
      status: "failure",
      evidence: ["runner=execution-failed"],
    });
    expect(JSON.stringify(result.report)).not.toContain(secret);
    expect(JSON.stringify(result.report)).not.toContain("Error:");
    expect(result.exitCode).toBe(1);
  });

  it("attempts cleanup when setup fails before execution", async () => {
    let executed = false;
    let cleaned = false;
    const result = await runProviderConformanceSuite(
      suite({
        scenarios: [
          successfulScenario({
            setup: () => {
              throw new Error("setup-secret");
            },
            run: () => {
              executed = true;
              return { status: "success", code: "must-not-run" };
            },
            cleanup: () => {
              cleaned = true;
            },
          }),
        ],
      }),
    );

    expect(executed).toBe(false);
    expect(cleaned).toBe(true);
    expect(scenarioCheck(result, "scenario.navigate")).toMatchObject({
      status: "failure",
      evidence: ["runner=execution-failed"],
    });
    expect(JSON.stringify(result.report)).not.toContain("setup-secret");
  });

  it("aborts timed-out execution and still attempts cleanup", async () => {
    let cleanupCalled = false;
    const result = await runProviderConformanceSuite(
      suite({
        scenarios: [
          successfulScenario({
            timeoutMs: 100,
            run: ({ signal }) =>
              new Promise((resolve) => {
                signal.addEventListener(
                  "abort",
                  () => resolve({ status: "failure", code: "fixture-aborted" }),
                  { once: true },
                );
              }),
            cleanup: () => {
              cleanupCalled = true;
            },
          }),
        ],
      }),
    );

    expect(cleanupCalled).toBe(true);
    expect(scenarioCheck(result, "scenario.navigate")).toMatchObject({
      status: "failure",
      evidence: ["runner=timeout"],
    });
  });

  it("turns cleanup throws and timeouts into stable failure codes", async () => {
    const cleanupThrow = await runProviderConformanceSuite(
      suite({
        scenarios: [
          successfulScenario({
            cleanup: () => {
              throw new Error("cleanup-secret");
            },
          }),
        ],
      }),
    );
    expect(scenarioCheck(cleanupThrow, "scenario.navigate")).toMatchObject({
      status: "failure",
      evidence: ["runner=cleanup-failed"],
    });
    expect(JSON.stringify(cleanupThrow.report)).not.toContain("cleanup-secret");

    const cleanupTimeout = await runProviderConformanceSuite(
      suite({
        scenarios: [
          successfulScenario({
            cleanup: ({ signal }) =>
              new Promise((resolve) => {
                signal.addEventListener("abort", () => resolve(), { once: true });
              }),
          }),
        ],
      }),
    );
    expect(scenarioCheck(cleanupTimeout, "scenario.navigate")).toMatchObject({
      status: "failure",
      evidence: ["runner=cleanup-timeout"],
    });
  });

  it("rejects unbounded scenario outcomes without copying their fields", async () => {
    const result = await runProviderConformanceSuite(
      suite({
        scenarios: [
          successfulScenario({
            run: () =>
              ({
                status: "success",
                code: "fixture-complete",
                secret: "untrusted-text",
              }) as never,
          }),
        ],
      }),
    );

    expect(scenarioCheck(result, "scenario.navigate")).toMatchObject({
      status: "failure",
      evidence: ["runner=invalid-result"],
    });
    expect(JSON.stringify(result.report)).not.toContain("untrusted-text");
  });

  it("does not let a required scenario hide a missing prerequisite as skipped", async () => {
    const result = await runProviderConformanceSuite(
      suite({
        scenarios: [
          successfulScenario({
            run: () => ({ status: "skipped", code: "browser-missing" }),
          }),
        ],
      }),
    );

    expect(scenarioCheck(result, "scenario.navigate")).toMatchObject({
      status: "failure",
      evidence: ["runner=invalid-result"],
    });
    expect(result.exitCode).toBe(1);
  });

  it("fails closed before scenarios execute when Provider preflight fails", async () => {
    let executed = false;
    const result = await runProviderConformanceSuite(
      suite({
        provider: executableProvider({ execute: undefined }),
        scenarios: [
          successfulScenario({
            run: () => {
              executed = true;
              return { status: "success", code: "must-not-run" };
            },
          }),
        ],
      }),
    );

    expect(executed).toBe(false);
    expect(scenarioCheck(result, "scenario.navigate")).toMatchObject({
      status: "failure",
      evidence: ["runner=provider-not-executable"],
    });
    expect(result.report.summary.baselineCurrent).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("keeps expected failures visible while using their baseline for the exit code", async () => {
    const failingScenario = successfulScenario({
      run: () => ({ status: "failure", code: "known-driver-gap" }),
    });
    const expectedFailures = [
      {
        checkId: "scenario.navigate",
        reason: "The maintained Provider issue remains visible until its bounded expiry.",
        issueUrl: "https://github.com/example/openbot/issues/456",
        expiresAt: "2026-10-01T00:00:00.000Z",
      },
    ];
    const accepted = await runProviderConformanceSuite(
      suite({ scenarios: [failingScenario], expectedFailures }),
    );

    expect(accepted.report.summary).toMatchObject({
      conformant: false,
      baselineCurrent: true,
    });
    expect(accepted.exitCode).toBe(0);

    const stale = await runProviderConformanceSuite(
      suite({
        scenarios: [failingScenario],
        expectedFailures: [
          { ...expectedFailures[0], expiresAt: "2026-09-03T00:00:00.000Z" },
        ] as ProviderConformanceSuite["expectedFailures"],
      }),
    );
    expect(stale.report.summary.baselineCurrent).toBe(false);
    expect(stale.exitCode).toBe(1);
  });

  it("rejects duplicate, reserved, and excessive scenario ids before execution", async () => {
    const duplicate = successfulScenario();
    await expect(
      runProviderConformanceSuite(suite({ scenarios: [duplicate, duplicate] })),
    ).rejects.toThrow("Scenario ids must be unique");
    await expect(
      runProviderConformanceSuite(
        suite({ scenarios: [successfulScenario({ id: "provider.declaration" })] }),
      ),
    ).rejects.toThrow("invalid or reserved");
    await expect(
      runProviderConformanceSuite(
        suite({
          scenarios: Array.from({ length: 257 }, (_, index) =>
            successfulScenario({ id: `scenario.case-${index}` }),
          ),
        }),
      ),
    ).rejects.toThrow("more than 256 scenarios");
  });

  it.each([
    "provider.declaration",
    "provider.target-platform",
    "provider.executable",
    "target.evidence-level",
    "target.real-device-metadata",
  ])("refuses reserved check %s before any scenario lifecycle action", async (id) => {
    const lifecycle: string[] = [];
    await expect(
      runProviderConformanceSuite(
        suite({
          scenarios: [
            successfulScenario({
              id,
              setup: () => {
                lifecycle.push("setup");
              },
              run: () => {
                lifecycle.push("run");
                return { status: "success", code: "done" };
              },
              cleanup: () => {
                lifecycle.push("cleanup");
              },
            }),
          ],
        }),
      ),
    ).rejects.toThrow("invalid or reserved");
    expect(lifecycle).toEqual([]);
  });

  it("requires complete opaque metadata for real-device evidence", async () => {
    await expect(
      runProviderConformanceSuite(
        suite({
          stage: "real-device",
          target: {
            platform: "linux",
            architecture: "x64",
            osVersion: "6.8.0",
            evidenceLevel: "real-device",
          },
        }),
      ),
    ).rejects.toThrow("Real-device suite target metadata is incomplete");

    const result = await runProviderConformanceSuite(
      suite({
        stage: "real-device",
        target: {
          platform: "linux",
          architecture: "x64",
          osVersion: "6.8.0",
          evidenceLevel: "real-device",
          workerHostVersion: "0.1.0",
          hardwareModel: "Dedicated test workstation",
          hardwareEvidenceId: "inventory.linux-lab-01",
        },
      }),
    );
    expect(
      result.report.checks.find((check) => check.id === "target.real-device-metadata"),
    ).toMatchObject({ status: "success" });
    expect(result.exitCode).toBe(0);
  });
});
