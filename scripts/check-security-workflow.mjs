import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { JOBS } from "./ci-selection.ts";
import {
  assertPinnedSources,
  expression,
  hasCommands,
  prerequisites,
  requiredJob,
  runs,
  selectedCondition,
  workflowDocument,
} from "./workflow-policy.mjs";

export function validateSecurityWorkflow(source) {
  const workflow = workflowDocument(source);
  assert.deepEqual(
    workflow.permissions,
    { contents: "read" },
    "CI permissions must remain read-only.",
  );
  assert(
    !("pull_request_target" in (workflow.on ?? {})),
    "Untrusted PRs cannot use a privileged trigger.",
  );
  assert(
    workflow.on && "pull_request" in workflow.on && "push" in workflow.on,
    "PR and main qualification triggers are required.",
  );
  assert.deepEqual(workflow.on.push.branches, ["main"], "Push qualification remains main-only.");
  assert.equal(
    expression(workflow.concurrency?.["cancel-in-progress"]),
    "github.event_name == 'pull_request'",
    "Cancel obsolete PRs, not main qualification.",
  );
  assert(
    expression(workflow.concurrency?.group).includes(
      "github.event.pull_request.number || github.ref",
    ),
    "Concurrency must distinguish PRs and refs.",
  );
  assertPinnedSources(workflow);
  for (const [id, job] of Object.entries(workflow.jobs)) {
    assert(!job.secrets, `${id}: do not expose secrets to PR qualification.`);
    if (job.permissions)
      for (const [name, permission] of Object.entries(job.permissions))
        assert(
          permission === "none" || (name === "contents" && permission === "read"),
          `${id}: permission escalation.`,
        );
  }
  const security = requiredJob(workflow, "security");
  assert(!("if" in security), "Security must always be required.");
  assert(
    security.steps.some(
      (step) => step.uses?.startsWith("actions/checkout@") && step.with?.["fetch-depth"] === 0,
    ),
    "Security must scan complete history.",
  );
  const script = hasCommands(
    security,
    [
      "npm@10.9.9",
      'test "$(npm --version)" = "10.9.9"',
      "npm ci --ignore-scripts --audit=false",
      "npm audit --omit=dev --audit-level=high",
      "scripts/audit-python.sh",
      "umask 077",
      "ghcr.io/trufflesecurity/trufflehog@sha256:deb2af10659a488a14d262a323addcde099d99827a1cf1dc4e93c17915c39f08",
      "${{ github.workspace }}:/repo:ro",
      "--no-verification",
      "--no-update",
      "--json --fail --fail-on-scan-errors git file:///repo",
      '>"${RUNNER_TEMP}/trufflehog-results.jsonl" 2>"${RUNNER_TEMP}/trufflehog-diagnostics.log"',
      'node scripts/check-credential-findings.mjs "${RUNNER_TEMP}/trufflehog-results.jsonl" "$status"',
    ],
    "Security",
  );
  const stages = ["npm@10.9.9", 'test "$(npm --version)"', "npm ci ", "npm audit "];
  assert(
    stages.every(
      (stage, index) => index === 0 || script.indexOf(stage) > script.indexOf(stages[index - 1]),
    ),
    "Select and verify npm, install the lock tree, then audit.",
  );
  assert(
    !/npm audit fix|--exclude-|--branch|--since-commit|--verifier|\bcat\s+[^\n]*trufflehog-/.test(
      script,
    ),
    "Security scans must be complete, read-only, local and non-printing.",
  );
  assert(
    !/trufflehog-action@|upload-sarif/.test(JSON.stringify(security)),
    "Do not upload credential candidates.",
  );
  for (const step of security.steps)
    if (step.run) assert(!("if" in step), "Security commands cannot be conditionally bypassed.");

  const scope = requiredJob(workflow, "scope");
  assert(!("if" in scope) && !scope.needs, "Scope must run independently.");
  assert.equal(
    scope.outputs?.plan,
    "${{ steps.scope.outputs.plan }}",
    "Scope output must come from the selector.",
  );
  hasCommands(
    scope,
    ['node scripts/ci-scope.ts --event "$GITHUB_EVENT_PATH" --github-output "$GITHUB_OUTPUT"'],
    "Scope",
  );
  assert(
    scope.steps.some(
      (step) => step.uses?.startsWith("actions/checkout@") && step.with?.["fetch-depth"] === 0,
    ),
    "Scope needs actual commit ancestry.",
  );
  for (const id of JOBS.filter((id) => !["security", "validate"].includes(id))) {
    const job = requiredJob(workflow, id);
    assert(prerequisites(job).includes("scope"), `${id}: scope prerequisite missing.`);
    assert.equal(
      expression(job.if),
      selectedCondition(id),
      `${id}: only the tested scope may declare non-applicability.`,
    );
  }
  const validate = requiredJob(workflow, "validate");
  assert(
    prerequisites(validate).includes("scope") && !("if" in validate),
    "Validation cannot be omitted.",
  );
  hasCommands(validate, ['npm run check:affected -- --event "$GITHUB_EVENT_PATH"'], "Validation");
  assert(
    validate.steps.some((step) => step.env?.OPENBOT_CI_PLAN === "${{ needs.scope.outputs.plan }}"),
    "Validation must verify the same selected plan.",
  );

  const portable = requiredJob(workflow, "portable");
  assert.equal(
    portable.strategy?.["fail-fast"],
    false,
    "Platform failures must remain independent.",
  );
  assert.deepEqual(
    portable.strategy.matrix.include.map((row) => row.runner).sort(),
    ["macos-15", "ubuntu-24.04", "windows-2025"],
    "Retain all explicitly supported runners.",
  );
  assert.equal(
    portable["runs-on"],
    "${{ matrix.runner }}",
    "Execute on the selected native runner.",
  );
  hasCommands(
    portable,
    [
      "turbo run test --concurrency=2 --filter=@openbot/desktop --filter=@openbot/node --filter=@openbot/windows-secret-acl",
      "turbo run build --filter=@openbot/desktop --filter=@openbot/node --filter=@openbot/python-node-runtime",
      "node apps/desktop/scripts/prepare-native-server.ts",
      "node apps/desktop/scripts/package.mjs",
      "npm run make:installers --workspace @openbot/desktop",
    ],
    "Required portable commands",
  );
  const portableRuns = hasCommands(
    portable,
    [
      "--filter=@openbot/desktop",
      "--filter=@openbot/node",
      "--filter=@openbot/python-node-runtime",
      "node scripts/build-macos-worker-host-candidate.mjs",
      "https://nodejs.org/dist/v22.22.2/node-v22.22.2-darwin-arm64.tar.gz",
      "OPENBOT_DESKTOP_MACOS_WORKER_COMPANION=$companion_root/OpenBot Worker Host.app",
      "node apps/desktop/scripts/prepare-native-server.ts",
      "node apps/desktop/scripts/package.mjs",
      "npm run make:installers --workspace @openbot/desktop",
      "npm run worker-host:macos:native-check",
      "/usr/bin/plutil -lint apps/worker-host-macos/Resources/com.openbot.worker-host.node.plist",
      "/usr/bin/plutil -lint apps/worker-host-macos/Resources/Info.plist.template",
      "/usr/bin/plutil -lint apps/worker-host-macos/Resources/OpenBotWorkerHost.entitlements.template.plist",
    ],
    "Portable qualification",
    { conditional: true },
  );
  assert(
    portableRuns.indexOf("node scripts/build-macos-worker-host-candidate.mjs") <
      portableRuns.indexOf("node apps/desktop/scripts/package.mjs"),
    "Build the companion before packaging.",
  );
  for (const fragment of [
    "node scripts/build-macos-worker-host-candidate.mjs",
    "/usr/bin/plutil -lint",
  ]) {
    const step = portable.steps.find((step) => step.run?.includes(fragment));
    assert.equal(
      expression(step.if),
      "runner.os == 'macOS'",
      "Native macOS checks need their actual platform.",
    );
    if (fragment.startsWith("node"))
      assert(
        step.run.includes("curl --proto '=https' --tlsv1.2 --fail"),
        "Companion download must verify HTTPS and errors.",
      );
  }

  const harness = requiredJob(workflow, "harness");
  hasCommands(
    harness,
    [
      "npm run harness:check",
      "npm run harness:wheel",
      "npm run harness:quality",
      "derive-product-lock.py --check",
      "npm run contracts:check",
      "npm run contracts:test",
    ],
    "Harness and contract",
  );
  const gate = requiredJob(workflow, "check");
  assert.equal(
    expression(gate.if),
    "always()",
    "CI check must run after failed or skipped prerequisites.",
  );
  const expected = Object.keys(workflow.jobs)
    .filter((id) => id !== "check")
    .sort();
  assert.deepEqual(
    prerequisites(gate).toSorted(),
    expected,
    "CI check must depend on every job exactly once.",
  );
  assert.deepEqual(
    expected,
    ["scope", ...JOBS].sort(),
    "New jobs must join the explicit selection and result contract.",
  );
  const aggregate = gate.steps.find((step) => step.run?.trim() === "node scripts/ci-results.ts");
  assert(
    aggregate && !("if" in aggregate),
    "CI check must execute the tested success-only result validator.",
  );
  assert.equal(aggregate.env?.OPENBOT_CI_PLAN, "${{ needs.scope.outputs.plan }}");
  assert.equal(aggregate.env?.OPENBOT_CI_NEEDS, "${{ toJSON(needs) }}");
}

export function validatePythonProductWorkflow(source, migrationSource) {
  const workflow = workflowDocument(source);
  const job = (id) => requiredJob(workflow, id);
  hasCommands(
    job("temporal-qualification"),
    ["--engine postgres-mtls --upgrade-archive", "--only-case product-owner-corrections"],
    "Python Temporal",
  );
  hasCommands(
    job("browser-product"),
    [
      "experiments/work-journey/product_browser_probe.py",
      "for recovery in control node replacement response-loss browser-restart; do",
    ],
    "Python browser",
  );
  hasCommands(
    job("browser-egress"),
    [
      "experiments/browser-execution/egress-fixture.Dockerfile",
      "experiments/browser-execution/qualify_egress.py",
      "--fixture-image",
      'sudo python3 -B "$root/run_probe.py" --docker /usr/bin/docker',
    ],
    "Browser egress",
  );
  const container = job("python-product-container");
  assert.deepEqual(
    container.strategy.matrix.include.map((row) => `${row.runner}:${row.arch}`).sort(),
    ["ubuntu-24.04-arm:arm64", "ubuntu-24.04:amd64"],
    "Python container keeps both actual architectures.",
  );
  hasCommands(
    container,
    [
      "--target runtime-product",
      "--file deploy/server/Dockerfile",
      "deploy/server/smoke-product.py --image openbot-server:product-smoke",
    ],
    "Python product container",
  );
  const preview = job("python-desktop-preview");
  assert.equal(preview["runs-on"], "macos-15");
  const stages = [
    "--filter=@openbot/desktop --filter=@openbot/python-node-runtime",
    "node apps/desktop/scripts/prepare-native-server.ts --python-product",
    "node apps/desktop/scripts/smoke-python-product.ts apps/desktop/out/python-product-runtime",
    "node apps/desktop/scripts/package.mjs --preview --python-product",
    "OpenBot Python Preview.app/Contents/Resources/native-runtime",
  ];
  const script = hasCommands(preview, stages, "Python Preview");
  assert(
    stages.every(
      (stage, index) => index === 0 || script.indexOf(stage) > script.indexOf(stages[index - 1]),
    ),
    "Python Preview must stage, smoke, package, then smoke the installed payload.",
  );
  assert(
    !/prepare:native|npm run package|--filter=@openbot\/server|apps\/server\//.test(script),
    "Python Preview cannot substitute retired packaging.",
  );
  assert.equal(
    job("synthetic-migration").uses,
    "./.github/workflows/s7-migration.yml",
    "Python migration uses same-commit qualification.",
  );
  const migration = workflowDocument(migrationSource);
  assert("workflow_call" in migration.on, "Python migration needs same-commit qualification.");
  hasCommands(
    requiredJob(migration, "synthetic-migration"),
    ["node experiments/s7-migration/qualify.mjs --report"],
    "Python migration",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  validateSecurityWorkflow(workflow);
  validatePythonProductWorkflow(
    workflow,
    await readFile(new URL("../.github/workflows/s7-migration.yml", import.meta.url), "utf8"),
  );
  console.log("CI security, selection and product qualification properties passed.");
}
