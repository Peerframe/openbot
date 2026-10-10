/**
 * check-affected.ts
 *
 * Real check invocation for the selected validation lane. Does not own selection
 * policy; imports makePlan / argumentsFor from ci-scope.ts.
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { argumentsFor, makePlan } from "./ci-scope.ts";
import { workspaceGraph } from "./ci-selection.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const plan = await makePlan(process.cwd(), argumentsFor(process.argv.slice(2)));
console.log(JSON.stringify(plan, null, 2));
if (process.env.OPENBOT_CI_PLAN) {
  const expected: unknown = JSON.parse(process.env.OPENBOT_CI_PLAN);
  if (JSON.stringify(expected) !== JSON.stringify(plan))
    throw new Error("Validation must use the same immutable input and selection as the scope job.");
}
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(args: readonly string[]): void {
  const result = spawnSync(npm, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.error || result.status !== 0)
    throw new Error(`Affected validation failed: npm ${args.join(" ")}`);
}
if (plan.mode === "full") run(["run", "check"]);
else {
  for (const command of plan.rootChecks) run(["run", command]);
  if (plan.mode === "workspace") {
    run(["run", "lint"]);
    const lock: unknown = JSON.parse(await readFile("package-lock.json", "utf8"));
    const graph = workspaceGraph(lock);
    for (const name of plan.workspaces) {
      const node = graph.find((entry) => entry.name === name);
      if (!node) throw new Error(`Missing workspace package entry for ${name}`);
      const { path } = node;
      const pkg: unknown = JSON.parse(await readFile(`${path}/package.json`, "utf8"));
      const scripts = isRecord(pkg) && isRecord(pkg.scripts) ? pkg.scripts : undefined;
      if (!scripts || typeof scripts.test !== "string")
        console.log(
          `${name}: no package-local tests; consumer coverage only, not a zero-test pass.`,
        );
    }
    // Tests import their own compiled entry too; ^build alone only prepares dependencies.
    // Sequential phases prevent duplicate writers and make cold checkouts reproducible.
    for (const task of ["build", "typecheck", "test"])
      run([
        "exec",
        "--",
        "turbo",
        "run",
        task,
        "--concurrency=2",
        ...plan.workspaces.map((name) => `--filter=${name}`),
      ]);
  }
}
console.log(
  `Validation lane passed (${plan.mode}). Separate CI qualifications: ${plan.required.filter((job) => job !== "validate").join(", ")}. This is not the final CI aggregate.`,
);
