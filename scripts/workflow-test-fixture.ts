/**
 * Mutable copies of this repository's own workflow YAML for checker tests.
 * Production checkers read workflows only through workflow-policy.ts.
 */
import assert from "node:assert/strict";
import { parse } from "yaml";

type Scalar = string | number | boolean;

export interface FixtureStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string | boolean;
  shell?: string;
  with?: Record<string, Scalar>;
  env?: Record<string, Scalar>;
  "continue-on-error"?: boolean;
}

export interface CommandStep extends FixtureStep {
  run: string;
}

export interface FixtureJob {
  name?: string;
  if?: string | boolean;
  needs?: string | string[];
  uses?: string;
  secrets?: string;
  "runs-on"?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; matrix?: { include?: Record<string, string>[] } };
  env?: Record<string, Scalar>;
  steps?: FixtureStep[];
  "continue-on-error"?: boolean;
}

export interface FixtureWorkflow {
  name?: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: Record<string, Scalar>;
  jobs: Record<string, FixtureJob>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFixtureWorkflow(value: unknown): value is FixtureWorkflow {
  if (
    !isRecord(value) ||
    !isRecord(value.on) ||
    !isRecord(value.permissions) ||
    !isRecord(value.concurrency) ||
    !isRecord(value.jobs)
  )
    return false;
  return Object.values(value.jobs).every((job) => {
    if (!isRecord(job)) return false;
    const steps: unknown = job.steps;
    return steps === undefined || (Array.isArray(steps) && steps.every(isRecord));
  });
}

/** Parses a repository workflow into a mutable fixture after checking its job and step shape. */
export function workflowFixture(source: string): FixtureWorkflow {
  const value: unknown = parse(source);
  assert(
    isFixtureWorkflow(value),
    "Fixture workflow must contain triggers, authority, concurrency and job mappings.",
  );
  return value;
}

export function fixtureJob(workflow: FixtureWorkflow, id: string): FixtureJob {
  const job = workflow.jobs[id];
  assert(job, `Fixture job is missing: ${id}`);
  return job;
}

export function fixtureSteps(job: FixtureJob): FixtureStep[] {
  assert(job.steps, "Fixture job has no steps.");
  return job.steps;
}

export function stepAt(job: FixtureJob, index: number): FixtureStep {
  const step = fixtureSteps(job).at(index);
  assert(step, `Fixture step is missing: ${index}`);
  return step;
}

export function settingsOf(step: FixtureStep): Record<string, Scalar> {
  assert(step.with, "Fixture step has no inputs.");
  return step.with;
}

export function environmentOf(step: FixtureStep): Record<string, Scalar> {
  assert(step.env, "Fixture step has no environment.");
  return step.env;
}

function isCommandStep(step: FixtureStep): step is CommandStep {
  return typeof step.run === "string";
}

/** The first step whose command text contains `fragment`, as the original `find` lookups did. */
export function commandStep(job: FixtureJob, fragment: string): CommandStep {
  const step = fixtureSteps(job)
    .filter(isCommandStep)
    .find((candidate) => candidate.run.includes(fragment));
  assert(step, `Fixture command is missing: ${fragment}`);
  return step;
}

export function matrixRows(job: FixtureJob): Record<string, string>[] {
  const rows = job.strategy?.matrix?.include;
  assert(rows, "Fixture job has no matrix rows.");
  return rows;
}
