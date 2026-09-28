import {
  type ProviderConformanceCheck,
  type ProviderConformanceCheckSeverity,
  type ProviderConformanceCheckStatus,
  type ProviderConformanceReport,
  type ProviderConformanceStage,
  type ProviderExpectedFailure,
  nodeArchitectureSchema,
  nodePlatformSchema,
  providerConformanceCheckSchema,
  providerConformanceCheckSeveritySchema,
  providerConformanceCheckStatusSchema,
  providerConformanceStageSchema,
  providerConformanceEvidenceLevelSchema,
  providerExpectedFailureSchema,
} from "@openbot/protocol";
import {
  buildProviderConformanceReport,
  type ComputerProvider,
  inspectProviderDeclaration,
  isGeneratedConformanceCheckId,
  type ProviderConformanceTargetInput,
} from "@openbot/provider-sdk";

const conformanceIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
// Vocabulary belongs to the wire contract; this runner still validates before side effects.
const stages = new Set<string>(providerConformanceStageSchema.options);
const statuses = new Set<string>(providerConformanceCheckStatusSchema.options);
const severities = new Set<string>(providerConformanceCheckSeveritySchema.options);
const minimumTimeoutMs = 100;
const maximumTimeoutMs = 120_000;
const maximumScenarios = 256;
const defaultTimeoutMs = 30_000;
const maximumCleanupTimeoutMs = 5_000;

export interface ProviderConformanceScenarioContext {
  provider: ComputerProvider;
  target: ProviderConformanceTargetInput;
  signal: AbortSignal;
}

/** Runtime outcomes carry only a stable code; untrusted free text never enters public evidence. */
export interface ProviderConformanceScenarioOutcome {
  status: ProviderConformanceCheckStatus;
  code: string;
}

export interface ProviderConformanceScenario {
  id: string;
  name: string;
  description: string;
  severity: ProviderConformanceCheckSeverity;
  timeoutMs?: number;
  references?: ProviderConformanceCheck["references"];
  setup?(context: ProviderConformanceScenarioContext): Promise<void> | void;
  run(
    context: ProviderConformanceScenarioContext,
  ): Promise<ProviderConformanceScenarioOutcome> | ProviderConformanceScenarioOutcome;
  cleanup?(context: ProviderConformanceScenarioContext): Promise<void> | void;
}

export interface ProviderConformanceSuite {
  name: string;
  version: string;
  stage: ProviderConformanceStage;
  provider: ComputerProvider;
  providerVersion: string;
  target: ProviderConformanceTargetInput;
  defaultTimeoutMs?: number;
  generatedAt?: string;
  expectedFailures?: ProviderExpectedFailure[];
  scenarios: ProviderConformanceScenario[];
}

export interface ProviderConformanceRunResult {
  report: ProviderConformanceReport;
  exitCode: 0 | 1;
}

type BoundedResult<T> = { kind: "value"; value: T } | { kind: "timeout" } | { kind: "thrown" };

function assertBoundedString(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maximum) {
    throw new Error(`${label} must be a non-empty bounded string.`);
  }
}

function assertTimeout(value: unknown, label: string): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimumTimeoutMs ||
    value > maximumTimeoutMs
  ) {
    throw new Error(`${label} must be an integer from ${minimumTimeoutMs} to ${maximumTimeoutMs}.`);
  }
}

function assertCanonicalTimestamp(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC timestamp.`);
  }
}

function validateSuite(input: ProviderConformanceSuite): void {
  assertBoundedString(input.name, "Suite name", 160);
  if (!conformanceIdPattern.test(input.name)) {
    throw new Error("Suite name must be a stable lowercase conformance id.");
  }
  assertBoundedString(input.version, "Suite version", 160);
  assertBoundedString(input.providerVersion, "Provider version", 160);
  if (!stages.has(input.stage)) throw new Error("Suite stage is invalid.");
  if (input.generatedAt !== undefined) assertCanonicalTimestamp(input.generatedAt, "generatedAt");
  if (input.defaultTimeoutMs !== undefined) {
    assertTimeout(input.defaultTimeoutMs, "Suite default timeout");
  }

  if (typeof input.provider !== "object" || input.provider === null) {
    throw new Error("Suite Provider is invalid.");
  }
  if (
    typeof input.provider.id !== "string" ||
    typeof input.provider.displayName !== "string" ||
    !Array.isArray(input.provider.platforms) ||
    !Array.isArray(input.provider.capabilities) ||
    !Array.isArray(input.provider.capabilityManifest)
  ) {
    throw new Error("Suite Provider declaration is malformed.");
  }

  if (typeof input.target !== "object" || input.target === null) {
    throw new Error("Suite target is invalid.");
  }
  if (
    !nodePlatformSchema.safeParse(input.target.platform).success ||
    input.target.platform === "unknown"
  ) {
    throw new Error("Suite target platform is invalid.");
  }
  if (!nodeArchitectureSchema.safeParse(input.target.architecture).success) {
    throw new Error("Suite target architecture is invalid.");
  }
  if (!providerConformanceEvidenceLevelSchema.safeParse(input.target.evidenceLevel).success) {
    throw new Error("Suite target evidence level is invalid.");
  }
  assertBoundedString(input.target.osVersion, "Suite target OS version", 160);
  for (const [label, value] of [
    ["Worker Host version", input.target.workerHostVersion],
    ["Hardware model", input.target.hardwareModel],
  ] as const) {
    if (value !== undefined) assertBoundedString(value, label, 160);
  }
  if (
    input.target.hardwareEvidenceId !== undefined &&
    (!conformanceIdPattern.test(input.target.hardwareEvidenceId) ||
      input.target.hardwareEvidenceId.length > 160)
  ) {
    throw new Error("Hardware evidence id must be a bounded lowercase conformance id.");
  }
  if (
    input.stage === "real-device" &&
    (input.target.evidenceLevel !== "real-device" ||
      input.target.architecture === "unknown" ||
      input.target.osVersion.trim().toLowerCase() === "unknown" ||
      input.target.workerHostVersion === undefined ||
      input.target.hardwareModel === undefined ||
      input.target.hardwareEvidenceId === undefined)
  ) {
    throw new Error("Real-device suite target metadata is incomplete.");
  }

  if (!Array.isArray(input.scenarios) || input.scenarios.length < 1) {
    throw new Error("Suite must contain at least one scenario.");
  }
  if (input.scenarios.length > maximumScenarios) {
    throw new Error(`Suite cannot contain more than ${maximumScenarios} scenarios.`);
  }
  const ids = new Set<string>();
  for (const scenario of input.scenarios) {
    if (typeof scenario !== "object" || scenario === null) {
      throw new Error("Suite scenario is invalid.");
    }
    assertBoundedString(scenario.id, "Scenario id", 160);
    if (!conformanceIdPattern.test(scenario.id) || isGeneratedConformanceCheckId(scenario.id)) {
      throw new Error("Scenario id is invalid or reserved.");
    }
    if (ids.has(scenario.id)) throw new Error("Scenario ids must be unique.");
    ids.add(scenario.id);
    assertBoundedString(scenario.name, "Scenario name", 160);
    assertBoundedString(scenario.description, "Scenario description", 1000);
    if (!severities.has(scenario.severity)) throw new Error("Scenario severity is invalid.");
    if (scenario.timeoutMs !== undefined) assertTimeout(scenario.timeoutMs, "Scenario timeout");
    if (typeof scenario.run !== "function") throw new Error("Scenario run function is required.");
    if (scenario.setup !== undefined && typeof scenario.setup !== "function") {
      throw new Error("Scenario setup must be a function.");
    }
    if (scenario.cleanup !== undefined && typeof scenario.cleanup !== "function") {
      throw new Error("Scenario cleanup must be a function.");
    }
    if (scenario.references !== undefined) {
      const referenceProbe = providerConformanceCheckSchema.safeParse({
        id: scenario.id,
        name: scenario.name,
        description: scenario.description,
        status: "success",
        severity: scenario.severity,
        timestamp: "2000-01-01T00:00:00.000Z",
        references: scenario.references,
        evidence: [],
      });
      if (!referenceProbe.success) throw new Error("Scenario references are invalid.");
    }
  }

  const expectedFailures = input.expectedFailures ?? [];
  if (!providerExpectedFailureSchema.array().max(256).safeParse(expectedFailures).success) {
    throw new Error("Suite expected-failure baseline is invalid.");
  }
}

async function bounded<T>(
  operation: () => Promise<T>,
  signal: AbortController,
  timeoutMs: number,
): Promise<BoundedResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operationResult = operation().then<BoundedResult<T>, BoundedResult<T>>(
    (value) => ({ kind: "value", value }),
    () => ({ kind: "thrown" }),
  );
  const timeoutResult = new Promise<BoundedResult<T>>((resolve) => {
    timer = setTimeout(() => {
      signal.abort();
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  const result = await Promise.race([operationResult, timeoutResult]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

function failedCheck(
  scenario: ProviderConformanceScenario,
  generatedAt: string,
  code: string,
): ProviderConformanceCheck {
  return providerConformanceCheckSchema.parse({
    id: scenario.id,
    name: scenario.name,
    description: scenario.description,
    status: "failure",
    severity: scenario.severity,
    timestamp: generatedAt,
    references: scenario.references ?? [],
    evidence: [`runner=${code}`],
  });
}

function outcomeCheck(
  scenario: ProviderConformanceScenario,
  generatedAt: string,
  outcome: unknown,
): ProviderConformanceCheck {
  if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) {
    return failedCheck(scenario, generatedAt, "invalid-result");
  }
  const keys = Object.keys(outcome);
  const status = Reflect.get(outcome, "status");
  const code = Reflect.get(outcome, "code");
  if (
    keys.length !== 2 ||
    !keys.includes("status") ||
    !keys.includes("code") ||
    typeof status !== "string" ||
    !statuses.has(status) ||
    (scenario.severity === "required" && (status === "skipped" || status === "info")) ||
    typeof code !== "string" ||
    code.length < 1 ||
    code.length > 160 ||
    !conformanceIdPattern.test(code)
  ) {
    return failedCheck(scenario, generatedAt, "invalid-result");
  }

  const parsed = providerConformanceCheckSchema.safeParse({
    id: scenario.id,
    name: scenario.name,
    description: scenario.description,
    status,
    severity: scenario.severity,
    timestamp: generatedAt,
    references: scenario.references ?? [],
    evidence: [`result=${code}`],
  });
  return parsed.success ? parsed.data : failedCheck(scenario, generatedAt, "invalid-result");
}

function preflightFailure(input: ProviderConformanceSuite): string | undefined {
  if (!inspectProviderDeclaration(input.provider).conformant) return "provider-declaration-failed";
  if (!input.provider.platforms.includes(input.target.platform)) return "target-platform-failed";
  if (
    (input.stage === "integration" || input.stage === "real-device") &&
    input.provider.execute === undefined
  ) {
    return "provider-not-executable";
  }
  if (input.stage === "integration" && input.target.evidenceLevel === "simulated") {
    return "evidence-level-failed";
  }
  return undefined;
}

async function runScenario(
  suite: ProviderConformanceSuite,
  scenario: ProviderConformanceScenario,
  generatedAt: string,
): Promise<ProviderConformanceCheck> {
  const timeoutMs = scenario.timeoutMs ?? suite.defaultTimeoutMs ?? defaultTimeoutMs;
  const controller = new AbortController();
  const context = { provider: suite.provider, target: suite.target, signal: controller.signal };
  const result = await bounded(
    async () => {
      await scenario.setup?.(context);
      return await scenario.run(context);
    },
    controller,
    timeoutMs,
  );

  let check: ProviderConformanceCheck;
  if (result.kind === "timeout") check = failedCheck(scenario, generatedAt, "timeout");
  else if (result.kind === "thrown") check = failedCheck(scenario, generatedAt, "execution-failed");
  else check = outcomeCheck(scenario, generatedAt, result.value);

  if (scenario.cleanup !== undefined) {
    const cleanupController = new AbortController();
    const cleanup = await bounded(
      async () => {
        await scenario.cleanup?.({
          provider: suite.provider,
          target: suite.target,
          signal: cleanupController.signal,
        });
      },
      cleanupController,
      Math.min(timeoutMs, maximumCleanupTimeoutMs),
    );
    if (cleanup.kind !== "value") {
      check = failedCheck(
        scenario,
        generatedAt,
        cleanup.kind === "timeout" ? "cleanup-timeout" : "cleanup-failed",
      );
    }
  }

  return check;
}

export async function runProviderConformanceSuite(
  suite: ProviderConformanceSuite,
): Promise<ProviderConformanceRunResult> {
  validateSuite(suite);
  const generatedAt = suite.generatedAt ?? new Date().toISOString();
  const blocked = preflightFailure(suite);
  const scenarios = [...suite.scenarios].sort((left, right) => left.id.localeCompare(right.id));
  const checks: ProviderConformanceCheck[] = [];

  for (const scenario of scenarios) {
    checks.push(
      blocked === undefined
        ? await runScenario(suite, scenario, generatedAt)
        : failedCheck(scenario, generatedAt, blocked),
    );
  }

  const report = buildProviderConformanceReport({
    provider: suite.provider,
    providerVersion: suite.providerVersion,
    target: suite.target,
    stage: suite.stage,
    suiteName: suite.name,
    suiteVersion: suite.version,
    generatedAt,
    checks,
    expectedFailures: [...(suite.expectedFailures ?? [])],
  });
  return { report, exitCode: report.summary.baselineCurrent ? 0 : 1 };
}
