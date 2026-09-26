import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { argumentsFor, makePlan } from "./ci-scope.mjs";

const plan = await makePlan(process.cwd(), argumentsFor(process.argv.slice(2)));
console.log(JSON.stringify(plan, null, 2));
if (
  process.env.OPENBOT_CI_PLAN &&
  JSON.stringify(JSON.parse(process.env.OPENBOT_CI_PLAN)) !== JSON.stringify(plan)
)
  throw new Error("Validation must use the same immutable input and selection as the scope job.");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(args) {
  const result = spawnSync(npm, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.error || result.status !== 0)
    throw new Error(`Affected validation failed: npm ${args.join(" ")}`);
}
if (plan.mode === "full") run(["run", "check"]);
else {
  for (const command of plan.rootChecks) run(["run", command]);
  if (plan.mode === "workspace") {
    run(["run", "lint"]);
    const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
    const entries = Object.entries(lock.packages);
    for (const name of plan.workspaces) {
      const [path] = entries.find(
        ([path, value]) => !path.includes("node_modules") && value.name === name,
      );
      const pkg = JSON.parse(await readFile(`${path}/package.json`, "utf8"));
      if (!pkg.scripts?.test)
        console.log(
          `${name}: no package-local tests; consumer coverage only, not a zero-test pass.`,
        );
    }
    // Existing Turbo graph builds dependencies. Sequential phases prevent duplicate writers.
    for (const task of ["typecheck", "test", "build"])
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
