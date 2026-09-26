import assert from "node:assert/strict";
import { parseDocument } from "yaml";

export const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
export const SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
export const NODE_VERSION = "22.22.2";
export function workflowDocument(source) {
  assert(
    typeof source === "string" && source.length < 1024 * 1024,
    "Workflow source must be bounded.",
  );
  const document = parseDocument(source, { uniqueKeys: true, version: "1.2" });
  assert.equal(document.errors.length, 0, "Workflow YAML must be valid with unique keys.");
  const value = document.toJS({ maxAliasCount: 0 });
  assert(value?.jobs && typeof value.jobs === "object", "Workflow jobs are required.");
  return value;
}
export function requiredJob(workflow, id) {
  assert(workflow.jobs[id], `Missing required job: ${id}`);
  return workflow.jobs[id];
}
export function runs(job) {
  return (job.steps ?? [])
    .map((step) =>
      String(step.run ?? "")
        .replace(/\\\r?\n\s*/g, " ")
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .map((line) => line.trim().replace(/[ \t]+/g, " "))
        .join("\n"),
    )
    .join("\n");
}
export function hasCommands(job, commands, label, { conditional = false } = {}) {
  const source = runs(job);
  for (const command of commands) {
    const step = (job.steps ?? []).find((step) => runs({ steps: [step] }).includes(command));
    assert(step, `${label}: missing command ${command}`);
    assert(
      conditional || !("if" in step),
      `${label}: required command cannot be conditionally bypassed.`,
    );
  }
  return source;
}
export function expression(value) {
  return String(value ?? "")
    .trim()
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/\s+/g, " ");
}
export function selectedCondition(id) {
  return `contains(fromJSON(needs.scope.outputs.plan).required, '${id}')`;
}
export function prerequisites(job) {
  return typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
}
export function assertNoFailureBypass(job, label) {
  assert(!job["continue-on-error"], `${label}: failure cannot be ignored.`);
  for (const step of job.steps ?? [])
    assert(!step["continue-on-error"], `${label}: step failure cannot be ignored.`);
  assert(
    !/\|\|\s*(?:true|:|exit\s+0)\b/.test(runs(job)),
    `${label}: command failure cannot be ignored.`,
  );
}
export function assertPinnedSources(workflow) {
  for (const [id, job] of Object.entries(workflow.jobs)) {
    assertNoFailureBypass(job, id);
    if (job.uses)
      assert.equal(
        job.uses,
        "./.github/workflows/s7-migration.yml",
        "Reusable qualification must use this same commit.",
      );
    for (const step of job.steps ?? []) {
      if (step.uses)
        assert(
          /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(step.uses),
          `${id}: immutable action source required.`,
        );
      if (step.uses?.startsWith("actions/checkout@")) {
        assert.equal(step.uses, CHECKOUT, `${id}: reviewed checkout required.`);
        assert.equal(
          step.with?.["persist-credentials"],
          false,
          `${id}: checkout cannot retain credentials.`,
        );
      }
      if (step.uses?.startsWith("actions/setup-node@")) {
        assert.equal(step.uses, SETUP_NODE, `${id}: reviewed setup-node required.`);
        assert.equal(
          String(step.with?.["node-version"]),
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
