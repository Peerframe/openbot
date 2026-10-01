/**
 * ci-results.ts
 *
 * Final CI aggregate: every job must report, required jobs must succeed, and
 * non-required runs cannot conceal failure.
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { JOBS } from "./ci-selection.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkNeeds(needs: unknown): asserts needs is Record<string, unknown> {
  if (!isRecord(needs)) assert.fail("Every job must report a result.");
  assert.deepEqual(
    Object.keys(needs).sort(),
    ["scope", ...JOBS].sort(),
    "Every job must report a result.",
  );
  const failed: string[] = [];
  const cancelled: string[] = [];
  for (const job of ["scope", ...JOBS]) {
    const entry = needs[job];
    const result = isRecord(entry) ? entry.result : undefined;
    if (result === "failure") failed.push(job);
    if (result === "cancelled") cancelled.push(job);
  }
  // A cancelled selector may never publish its plan. Report dependency results first,
  // and preserve real failures even when cancellation interrupted other jobs.
  if (failed.length)
    assert.fail(
      `CI failed: failed jobs: ${failed.join(", ")}.${cancelled.length ? ` Also cancelled: ${cancelled.join(", ")}.` : ""}`,
    );
  if (cancelled.length)
    assert.fail(
      `CI cancelled: cancelled jobs: ${cancelled.join(", ")}. Qualification did not complete.`,
    );
  const scope = needs.scope;
  const scopeResult = isRecord(scope) ? scope.result : undefined;
  assert.equal(
    scopeResult,
    "success",
    `Scope selection must succeed: scope result is ${scopeResult ?? "missing"}.`,
  );
}

export function checkResults(plan: unknown, needs: unknown): string {
  checkNeeds(needs);
  if (!isRecord(plan)) assert.fail("Missing or unsupported CI scope.");
  assert.equal(plan.version, 1, "Missing or unsupported CI scope.");
  assert(
    Array.isArray(plan.required) && Array.isArray(plan.notApplicable),
    "Invalid CI selection.",
  );
  const required = plan.required as unknown[];
  const notApplicable = plan.notApplicable as unknown[];
  const classified = [...required, ...notApplicable];
  assert.deepEqual(
    [...classified].sort(),
    [...JOBS].sort(),
    "Every job must be classified exactly once.",
  );
  assert(
    required.includes("security") && required.includes("validate"),
    "Repository and security checks are always required.",
  );
  for (const job of JOBS) {
    const entry: unknown = needs[job];
    const result: unknown = isRecord(entry) ? entry.result : undefined;
    if (required.includes(job))
      assert.equal(result, "success", `${job}: required result is ${result ?? "missing"}.`);
    else
      assert(
        result === "skipped" || result === "success",
        `${job}: even a non-required run cannot conceal ${result ?? "missing"}.`,
      );
  }
  return `CI requirements satisfied: ${required.length} required jobs; ${notApplicable.length} explicitly not applicable.`;
}

function parseInput(name: "OPENBOT_CI_PLAN" | "OPENBOT_CI_NEEDS"): unknown {
  const source = process.env[name];
  if (!source?.trim())
    throw new Error(`${name} is missing or empty; CI qualification cannot complete.`);
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(`${name} contains invalid JSON; CI qualification cannot complete.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const needs = parseInput("OPENBOT_CI_NEEDS");
    checkNeeds(needs);
    console.log(checkResults(parseInput("OPENBOT_CI_PLAN"), needs));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "CI qualification could not be evaluated.",
    );
    process.exitCode = 1;
  }
}
