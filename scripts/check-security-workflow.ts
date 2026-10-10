import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { JOBS } from "./ci-selection.ts";
import {
  asMapping,
  assertPinnedSources,
  expression,
  fetchesFullHistory,
  field,
  hasCommands,
  matrixRows,
  requiredJob,
  selectedCondition,
  workflowDocument,
} from "./workflow-policy.ts";

function ordered(script: string, stages: readonly string[]): boolean {
  return stages.every((stage, index) => {
    const previous = stages[index - 1];
    return previous === undefined || script.indexOf(stage) > script.indexOf(previous);
  });
}

export function validateSecurityWorkflow(source: string): void {
  const workflow = workflowDocument(source);
  assert.deepEqual(
    workflow.source.permissions,
    { contents: "read" },
    "CI permissions must remain read-only.",
  );
  const on = asMapping(workflow.source.on);
  assert(
    on === undefined || !Object.hasOwn(on, "pull_request_target"),
    "Untrusted PRs cannot use a privileged trigger.",
  );
  assert(
    on !== undefined && Object.hasOwn(on, "pull_request") && Object.hasOwn(on, "push"),
    "PR and main qualification triggers are required.",
  );
  assert.deepEqual(
    field(on, "push", "branches"),
    ["main"],
    "Push qualification remains main-only.",
  );
  assert.equal(
    expression(field(workflow.source, "concurrency", "cancel-in-progress")),
    "github.event_name == 'pull_request'",
    "Cancel obsolete PRs, not main qualification.",
  );
  assert(
    expression(field(workflow.source, "concurrency", "group")).includes(
      "github.event.pull_request.number || github.ref",
    ),
    "Concurrency must distinguish PRs and refs.",
  );
  assertPinnedSources(workflow);
  for (const [id, job] of workflow.jobs) {
    assert(!job.source.secrets, `${id}: do not expose secrets to PR qualification.`);
    const permissions = job.source.permissions;
    if (permissions) {
      const grants = asMapping(permissions);
      assert(grants !== undefined, `${id}: permission escalation.`);
      for (const [name, permission] of Object.entries(grants))
        assert(
          permission === "none" || (name === "contents" && permission === "read"),
          `${id}: permission escalation.`,
        );
    }
  }
  const security = requiredJob(workflow, "security");
  assert(!security.conditional, "Security must always be required.");
  assert(fetchesFullHistory(security), "Security must scan complete history.");
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
      'node scripts/check-credential-findings.ts "${RUNNER_TEMP}/trufflehog-results.jsonl" "$status"',
    ],
    "Security",
  );
  const stages = ["npm@10.9.9", 'test "$(npm --version)"', "npm ci ", "npm audit "];
  assert(ordered(script, stages), "Select and verify npm, install the lock tree, then audit.");
  assert(
    !/npm audit fix|--exclude-|--branch|--since-commit|--verifier|\bcat\s+[^\n]*trufflehog-/.test(
      script,
    ),
    "Security scans must be complete, read-only, local and non-printing.",
  );
  assert(
    !/trufflehog-action@|upload-sarif/.test(JSON.stringify(security.source)),
    "Do not upload credential candidates.",
  );
  for (const step of security.steps)
    if (step.run) assert(!step.conditional, "Security commands cannot be conditionally bypassed.");

  hasCommands(
    requiredJob(workflow, "server-container"),
    [
      "--test /workspace/qualification/kernel-facts.test.ts",
      "OPENBOT_READONLY_KERNEL_TEST=1",
      "--network none --read-only",
      "--cap-drop ALL --cap-add SETUID --cap-add SETGID --user 0",
    ],
    "Linux kernel qualification",
  );
  const scope = requiredJob(workflow, "scope");
  assert(!scope.conditional && !scope.source.needs, "Scope must run independently.");
  assert.equal(
    field(scope.source, "outputs", "plan"),
    "${{ steps.scope.outputs.plan }}",
    "Scope output must come from the selector.",
  );
  hasCommands(
    scope,
    ['node scripts/ci-scope.ts --event "$GITHUB_EVENT_PATH" --github-output "$GITHUB_OUTPUT"'],
    "Scope",
  );
  assert(fetchesFullHistory(scope), "Scope needs actual commit ancestry.");
  for (const id of JOBS.filter((id) => !["security", "validate"].includes(id))) {
    const job = requiredJob(workflow, id);
    assert(job.needs.includes("scope"), `${id}: scope prerequisite missing.`);
    assert.equal(
      expression(job.condition),
      selectedCondition(id),
      `${id}: only the tested scope may declare non-applicability.`,
    );
  }
  const validate = requiredJob(workflow, "validate");
  assert(
    validate.needs.includes("scope") && !validate.conditional,
    "Validation cannot be omitted.",
  );
  hasCommands(validate, ['npm run check:affected -- --event "$GITHUB_EVENT_PATH"'], "Validation");
  assert(
    validate.steps.some((step) => step.env.OPENBOT_CI_PLAN === "${{ needs.scope.outputs.plan }}"),
    "Validation must verify the same selected plan.",
  );

  const portable = requiredJob(workflow, "portable");
  assert.equal(
    field(portable.source, "strategy", "fail-fast"),
    false,
    "Platform failures must remain independent.",
  );
  assert.deepEqual(
    matrixRows(portable)
      .map((row) => row.runner)
      .sort(),
    ["macos-15", "ubuntu-24.04", "windows-2025"],
    "Retain all explicitly supported runners.",
  );
  assert.equal(
    portable.source["runs-on"],
    "${{ matrix.runner }}",
    "Execute on the selected native runner.",
  );
  hasCommands(
    portable,
    [
      "turbo run test --concurrency=2 --filter=@openbot/desktop --filter=@openbot/node --filter=@openbot/windows-secret-acl",
      "turbo run build --filter=@openbot/desktop --filter=@openbot/node --filter=@openbot/server --filter=@openbot/web",
      "node apps/desktop/scripts/prepare-native-server.ts",
      "node apps/desktop/scripts/package.ts",
      "npm run make:installers --workspace @openbot/desktop",
    ],
    "Required portable commands",
  );
  const portableRuns = hasCommands(
    portable,
    [
      "--filter=@openbot/desktop",
      "--filter=@openbot/node",
      "--filter=@openbot/server --filter=@openbot/web",
      "node scripts/build-macos-worker-host-candidate.ts",
      "https://nodejs.org/dist/v22.22.2/node-v22.22.2-darwin-arm64.tar.gz",
      "OPENBOT_DESKTOP_MACOS_WORKER_COMPANION=$companion_root/OpenBot Worker Host.app",
      "node apps/desktop/scripts/prepare-native-server.ts",
      "node apps/desktop/scripts/package.ts",
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
    portableRuns.indexOf("node scripts/build-macos-worker-host-candidate.ts") <
      portableRuns.indexOf("node apps/desktop/scripts/package.ts"),
    "Build the companion before packaging.",
  );
  for (const fragment of [
    "node scripts/build-macos-worker-host-candidate.ts",
    "/usr/bin/plutil -lint",
  ]) {
    const step = portable.steps.find((candidate) => candidate.run?.includes(fragment));
    assert.equal(
      expression(step?.condition),
      "runner.os == 'macOS'",
      "Native macOS checks need their actual platform.",
    );
    if (fragment.startsWith("node"))
      assert(
        (step?.run ?? "").includes("curl --proto '=https' --tlsv1.2 --fail"),
        "Companion download must verify HTTPS and errors.",
      );
  }

  const harness = requiredJob(workflow, "harness");
  const harnessCommands = hasCommands(
    harness,
    [
      "npm run harness:check",
      "npm run harness:wheel",
      "npm run harness:quality",
      "derive-product-lock.py --check",
      "npm run contracts:check",
      "npm run contracts:test",
      "node apps/web/src/test/work-http-probe.mjs",
      "node --test experiments/work-journey/desktop-temporal/observe-pollers.test.ts experiments/work-journey/desktop-temporal/probe-support.test.ts",
      "npm run contracts:http:ts",
      "npm run contracts:http:ts -- --suite publisher",
      "npm run contracts:http:ts -- --suite models",
      "npm run contracts:http:tls",
      "npm run contracts:http:tls -- --suite publisher",
      "npm run contracts:http:tls -- --suite models",
    ],
    "Harness and contract",
  );
  for (const command of [
    "npm run contracts:http:ts",
    "npm run contracts:http:ts -- --suite publisher",
    "npm run contracts:http:ts -- --suite models",
    "npm run contracts:http:tls",
    "npm run contracts:http:tls -- --suite publisher",
    "npm run contracts:http:tls -- --suite models",
  ])
    assert(
      harnessCommands.split("\n").some((line) => line.trim() === command),
      `Harness requires the complete contract command: ${command}`,
    );
  const gate = requiredJob(workflow, "check");
  assert.equal(
    expression(gate.condition),
    "always()",
    "CI check must run after failed or skipped prerequisites.",
  );
  const expected = [...workflow.jobs.keys()].filter((id) => id !== "check").sort();
  assert.deepEqual(
    gate.needs.toSorted(),
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
    aggregate && !aggregate.conditional,
    "CI check must execute the tested success-only result validator.",
  );
  assert.equal(aggregate.env.OPENBOT_CI_PLAN, "${{ needs.scope.outputs.plan }}");
  assert.equal(aggregate.env.OPENBOT_CI_NEEDS, "${{ toJSON(needs) }}");
}

export function validatePythonProductWorkflow(source: string, migrationSource: string): void {
  const workflow = workflowDocument(source);
  const job = (id: string) => requiredJob(workflow, id);
  hasCommands(
    job("temporal-qualification"),
    ["--engine postgres-mtls --upgrade-archive", "--only-case product-owner-corrections"],
    "Python Temporal",
  );
  hasCommands(
    job("browser-product"),
    [
      "node --import tsx experiments/work-journey/product-browser-probe.ts",
      "node --import tsx experiments/work-journey/product-browser-native.ts",
      "for recovery in pages response-loss; do",
      "for recovery in control node replacement response-loss browser-restart; do",
    ],
    "TS browser",
  );
  hasCommands(
    job("browser-product"),
    [
      "experiments/work-journey/native-packet-prepare.ts",
      "bzip2=1.0.8-5.1ubuntu0.1",
      "experiments/linux-execution/qualify-native.ts",
      "experiments/linux-execution/native-helper.ts",
      '"$(command -v node)" "$RUNNER_TEMP/openbot-native-qualify.cjs"',
    ],
    "Actual migrated TS native adapter",
  );
  hasCommands(
    job("browser-egress"),
    [
      "experiments/browser-execution/egress-fixture.Dockerfile",
      "experiments/browser-execution/qualify-egress.ts",
      "--fixture-image",
      'sudo python3 -B "$root/run_probe.py" --docker /usr/bin/docker',
    ],
    "Browser egress",
  );
  hasCommands(
    job("temporal-qualification"),
    [
      'OPENBOT_TEMPORAL_PREVIOUS_ARCHIVE="$RUNNER_TEMP/temporal_1.31.3_linux_amd64.tar.gz" npm run test:temporal:upgrade',
    ],
    "Actual TS adjacent upgrade",
  );
  hasCommands(
    job("harness"),
    ["npm run contracts:legacy", "npm run test:linux:contracts"],
    "Retained adapter compatibility and protected Host",
  );
  const container = job("server-container");
  assert.deepEqual(
    matrixRows(container)
      .map((row) => `${String(row.runner)}:${String(row.arch)}`)
      .sort(),
    ["ubuntu-24.04-arm:arm64", "ubuntu-24.04:amd64"],
    "Python container keeps both actual architectures.",
  );
  hasCommands(
    container,
    [
      "scripts/product-entry.integration.test.ts",
      "--target runtime-product",
      "--file deploy/server/Dockerfile",
      "deploy/server/smoke-product.ts openbot-server:product-smoke",
    ],
    "Python product container",
  );
  const preview = job("desktop-product");
  assert.equal(preview.source["runs-on"], "macos-15");
  const stages = [
    "--filter=@openbot/desktop --filter=@openbot/server --filter=@openbot/web",
    "node apps/desktop/scripts/prepare-native-server.ts",
    "node apps/desktop/scripts/smoke-product.ts apps/desktop/native-runtime",
    "node apps/desktop/scripts/package.ts --preview",
    "node apps/desktop/scripts/verify-product.ts",
    'node apps/desktop/scripts/smoke-product.ts "apps/desktop/out/preview/OpenBot Preview-darwin-arm64/OpenBot Preview.app/Contents/Resources/native-runtime"',
    "apps/desktop/native-runtime/node/bin/node apps/desktop/scripts/measure-ts-product.ts apps/desktop/native-runtime",
  ];
  const script = hasCommands(preview, stages, "TS Desktop product");
  assert(
    ordered(script, stages),
    "TS Desktop must build, default-stage, smoke, package, verify and smoke actual payload before measurement.",
  );
  assert(
    !/--python-product|--ts-product|tests\/oracles\/legacy-server\//.test(script),
    "Desktop gate must qualify the default product, never an opt-in or oracle entry.",
  );
  assert.equal(
    job("synthetic-migration").uses,
    "./.github/workflows/s7-migration.yml",
    "Python migration uses same-commit qualification.",
  );
  const migration = workflowDocument(migrationSource);
  const migrationOn = asMapping(migration.source.on);
  assert(
    migrationOn !== undefined && Object.hasOwn(migrationOn, "workflow_call"),
    "Python migration needs same-commit qualification.",
  );
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
