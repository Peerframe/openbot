import assert from "node:assert/strict";
import { parseDocument } from "yaml";

export const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
export const SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
export const NODE_VERSION = "22.22.2";

/** A parsed YAML mapping whose values no policy has checked yet. */
export type Mapping = { readonly [key: string]: unknown };

/**
 * A step after the shared workflow shape was checked. What a step means for
 * security, release or platform policy stays with each checker.
 */
export interface WorkflowStep {
  readonly uses: string | undefined;
  readonly run: string | undefined;
  readonly conditional: boolean;
  readonly condition: unknown;
  readonly with: Mapping;
  readonly env: Mapping;
  readonly continueOnError: unknown;
}

/** A job after the shared workflow shape was checked; `source` is the complete parsed job. */
export interface WorkflowJob {
  readonly id: string;
  readonly source: Mapping;
  readonly steps: readonly WorkflowStep[];
  readonly conditional: boolean;
  readonly condition: unknown;
  readonly needs: readonly string[];
  readonly uses: string | undefined;
  readonly env: Mapping;
  readonly continueOnError: unknown;
}

/** Triggers, permissions and concurrency in `source` stay unverified input for each checker. */
export interface Workflow {
  readonly source: Mapping;
  readonly jobs: ReadonlyMap<string, WorkflowJob>;
}

export function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asMapping(value: unknown): Mapping | undefined {
  return isMapping(value) ? value : undefined;
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Reads an own nested mapping value; every other shape reads as absent. */
export function field(value: unknown, ...path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isMapping(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function optionalText(source: Mapping, key: string, label: string): string | undefined {
  const value = field(source, key);
  if (value === undefined || value === null) return undefined;
  assert(typeof value === "string", `${label}: ${key} must be text.`);
  return value;
}

function optionalMapping(source: Mapping, key: string, label: string): Mapping {
  const value = field(source, key);
  if (value === undefined || value === null) return {};
  assert(isMapping(value), `${label}: ${key} must be a mapping.`);
  return value;
}

function jobNeeds(source: Mapping, id: string): readonly string[] {
  const needs = field(source, "needs");
  if (needs === undefined || needs === null) return [];
  if (typeof needs === "string") return [needs];
  assert(
    isList(needs) && needs.every((need): need is string => typeof need === "string"),
    `${id}: needs must list job ids.`,
  );
  return needs;
}

function workflowStep(value: unknown, label: string): WorkflowStep {
  assert(isMapping(value), `${label}: workflow steps must be mappings.`);
  return {
    uses: optionalText(value, "uses", label),
    run: optionalText(value, "run", label),
    conditional: Object.hasOwn(value, "if"),
    condition: field(value, "if"),
    with: optionalMapping(value, "with", label),
    env: optionalMapping(value, "env", label),
    continueOnError: field(value, "continue-on-error"),
  };
}

function workflowJob(id: string, value: unknown): WorkflowJob {
  assert(isMapping(value), `${id}: workflow jobs must be mappings.`);
  const steps = field(value, "steps") ?? [];
  assert(isList(steps), `${id}: workflow steps must be a list.`);
  return {
    id,
    source: value,
    steps: steps.map((step) => workflowStep(step, id)),
    conditional: Object.hasOwn(value, "if"),
    condition: field(value, "if"),
    needs: jobNeeds(value, id),
    uses: optionalText(value, "uses", id),
    env: optionalMapping(value, "env", id),
    continueOnError: field(value, "continue-on-error"),
  };
}

/** Parses untrusted workflow text once and checks the job and step shape every checker shares. */
export function workflowDocument(source: string): Workflow {
  assert(
    typeof source === "string" && source.length < 1024 * 1024,
    "Workflow source must be bounded.",
  );
  const document = parseDocument(source, { uniqueKeys: true, version: "1.2" });
  assert.equal(document.errors.length, 0, "Workflow YAML must be valid with unique keys.");
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  const jobs = field(value, "jobs");
  assert(isMapping(value) && isMapping(jobs), "Workflow jobs are required.");
  return {
    source: value,
    jobs: new Map(
      Object.entries(jobs).map(([id, job]): [string, WorkflowJob] => [id, workflowJob(id, job)]),
    ),
  };
}

export function requiredJob(workflow: Workflow, id: string): WorkflowJob {
  const job = workflow.jobs.get(id);
  assert(job, `Missing required job: ${id}`);
  return job;
}

/** One step's executable text with continuations joined and comment lines removed. */
export function stepScript(step: WorkflowStep): string {
  return (step.run ?? "")
    .replace(/\\\r?\n\s*/g, " ")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.trim().replace(/[ \t]+/g, " "))
    .join("\n");
}

export function runs(job: WorkflowJob): string {
  return job.steps.map(stepScript).join("\n");
}

export function hasCommands(
  job: WorkflowJob,
  commands: readonly string[],
  label: string,
  { conditional = false }: { readonly conditional?: boolean } = {},
): string {
  const source = runs(job);
  for (const command of commands) {
    const step = job.steps.find((candidate) => stepScript(candidate).includes(command));
    assert(step, `${label}: missing command ${command}`);
    assert(
      conditional || !step.conditional,
      `${label}: required command cannot be conditionally bypassed.`,
    );
  }
  return source;
}

export function expression(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/\s+/g, " ");
}

export function selectedCondition(id: string): string {
  return `contains(fromJSON(needs.scope.outputs.plan).required, '${id}')`;
}

export function assertNoFailureBypass(job: WorkflowJob, label: string): void {
  assert(!job.continueOnError, `${label}: failure cannot be ignored.`);
  for (const step of job.steps)
    assert(!step.continueOnError, `${label}: step failure cannot be ignored.`);
  assert(
    !/\|\|\s*(?:true|:|exit\s+0)\b/.test(runs(job)),
    `${label}: command failure cannot be ignored.`,
  );
}

export function assertPinnedSources(workflow: Workflow): void {
  for (const [id, job] of workflow.jobs) {
    assertNoFailureBypass(job, id);
    if (job.uses)
      assert.equal(
        job.uses,
        "./.github/workflows/s7-migration.yml",
        "Reusable qualification must use this same commit.",
      );
    for (const step of job.steps) {
      if (step.uses)
        assert(
          /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(step.uses),
          `${id}: immutable action source required.`,
        );
      if (step.uses?.startsWith("actions/checkout@")) {
        assert.equal(step.uses, CHECKOUT, `${id}: reviewed checkout required.`);
        assert.equal(
          step.with["persist-credentials"],
          false,
          `${id}: checkout cannot retain credentials.`,
        );
      }
      if (step.uses?.startsWith("actions/setup-node@")) {
        assert.equal(step.uses, SETUP_NODE, `${id}: reviewed setup-node required.`);
        assert.equal(
          String(step.with["node-version"]),
          NODE_VERSION,
          `${id}: reviewed Node required.`,
        );
      }
    }
    if (/\b(?:npm|node)\s/.test(runs(job)))
      assert(
        job.steps.some((step) => step.uses === SETUP_NODE),
        `${id}: Node commands need the reviewed setup-node.`,
      );
  }
}

/** True when a checkout step fetches the complete commit history. */
export function fetchesFullHistory(job: WorkflowJob): boolean {
  return job.steps.some(
    (step) => step.uses?.startsWith("actions/checkout@") === true && step.with["fetch-depth"] === 0,
  );
}

/** The explicit `strategy.matrix.include` rows; any other matrix shape is rejected. */
export function matrixRows(job: WorkflowJob): readonly Mapping[] {
  const rows = field(job.source, "strategy", "matrix", "include");
  assert(isList(rows) && rows.every(isMapping), `${job.id}: explicit matrix rows are required.`);
  return rows;
}
