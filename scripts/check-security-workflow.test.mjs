import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  validatePythonProductWorkflow,
  validateSecurityWorkflow,
} from "./check-security-workflow.mjs";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const migration = await readFile(
  new URL("../.github/workflows/s7-migration.yml", import.meta.url),
  "utf8",
);

test("qualifies Python product artifacts independently of legacy compatibility", () => {
  assert.doesNotThrow(() => validatePythonProductWorkflow(workflow, migration));
  for (const changed of [
    workflow.replace(
      "node apps/desktop/scripts/prepare-native-server.mjs --python-product",
      "npm run prepare:native --workspace @openbot/desktop",
    ),
    workflow.replace(
      "node apps/desktop/scripts/package.mjs --preview --python-product",
      "npm run package --workspace @openbot/desktop",
    ),
    workflow.replace(
      "OpenBot Preview.app/Contents/Resources/native-runtime",
      "OpenBot.app/Contents/Resources/native-runtime",
    ),
    workflow.replace(
      "deploy/server/smoke-product.py --image openbot-server:product-smoke",
      "scripts/smoke-server-container.sh",
    ),
    workflow.replace("  python-desktop-preview:\n", "  python-desktop-preview:\n    if: false\n"),
    workflow.replace("--engine postgres-mtls --upgrade-archive", "--engine postgres-mtls"),
    workflow.replace("  browser-product:\n", "  browser-product:\n    if: false\n"),
    workflow.replace("control node replacement response-loss browser-restart", "control node"),
    workflow.replace(
      "uses: ./.github/workflows/s7-migration.yml",
      "uses: someone/other/.github/workflows/migration.yml@main",
    ),
  ]) {
    assert.throws(() => validatePythonProductWorkflow(changed, migration), /Python/);
  }
  assert.throws(
    () => validatePythonProductWorkflow(workflow, migration.replace("  workflow_call:", "  push:")),
    /same-commit qualification/,
  );
});

test("accepts the pinned required portable matrix", () => {
  assert.doesNotThrow(() => validateSecurityWorkflow(workflow));
});

test("requires exact finding review without excluding history or printing candidates", () => {
  const review =
    'node scripts/check-credential-findings.mjs "${RUNNER_TEMP}/trufflehog-results.jsonl" "$status"';
  for (const changed of [
    workflow.replace(review, "echo ignored"),
    workflow.replace(review, `${review} || true`),
    workflow.replace("--json --fail", "--fail"),
    workflow.replace("git file:///repo", "git file:///repo --branch HEAD"),
    workflow.replace("git file:///repo", "git file:///repo --exclude-paths tests"),
    workflow.replace(review, `${review}\n          cat trufflehog-results.jsonl`),
  ]) {
    assert.throws(() => validateSecurityWorkflow(changed), /missing required|full history/);
  }
});

test("requires the exact npm CLI and a clean lock tree before auditing", () => {
  assert.throws(
    () => validateSecurityWorkflow(workflow.replace("npm@10.9.9", "npm@latest")),
    /missing required fragment/,
  );
  assert.throws(
    () =>
      validateSecurityWorkflow(
        workflow.replace("npm ci --ignore-scripts --audit=false", "npm install"),
      ),
    /missing required fragment/,
  );
  const auditFirst = workflow
    .replace("        run: npm ci --ignore-scripts --audit=false\n", "")
    .replace(
      "        run: npm audit --omit=dev --audit-level=high\n",
      "        run: npm audit --omit=dev --audit-level=high\n      - run: npm ci --ignore-scripts --audit=false\n",
    );
  assert.throws(() => validateSecurityWorkflow(auditFirst), /install the lock tree, then audit/);
});

test("rejects dependency audit bypasses and mutation", () => {
  assert.throws(
    () =>
      validateSecurityWorkflow(
        workflow.replace(
          "run: npm audit --omit=dev --audit-level=high",
          "run: npm audit --omit=dev --audit-level=high || true",
        ),
      ),
    /read-only and fail closed/,
  );
  assert.throws(
    () =>
      validateSecurityWorkflow(
        workflow.replace(
          "run: npm audit --omit=dev --audit-level=high",
          "run: npm audit fix --force",
        ),
      ),
    /missing required fragment|read-only and fail closed/,
  );
});

test("rejects a missing platform or moving runner label", () => {
  assert.throws(
    () =>
      validateSecurityWorkflow(workflow.replace("runner: windows-2025", "runner: windows-latest")),
    /missing required fragment|explicit runner labels/,
  );
});

test("rejects a matrix member that is allowed to fail", () => {
  const changed = workflow.replace(
    "    timeout-minutes: 50\n    strategy:\n      fail-fast: false",
    "    timeout-minutes: 50\n    continue-on-error: true\n    strategy:\n      fail-fast: false",
  );
  assert.throws(() => validateSecurityWorkflow(changed), /members must be required/);
});

test("rejects action, Node, or checkout-security drift in the portable job", () => {
  const portableStart = workflow.indexOf("\n  portable:\n");
  const windowsWorkerHostStart = workflow.indexOf("\n  windows-worker-host:\n");
  const beforePortable = workflow.slice(0, portableStart);
  const portableJob = workflow.slice(portableStart, windowsWorkerHostStart);
  const afterPortable = workflow.slice(windowsWorkerHostStart);

  assert.throws(
    () =>
      validateSecurityWorkflow(
        `${beforePortable}${portableJob.replace(
          "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n        with:\n          node-version: 22.22.2",
          "actions/setup-node@v7\n        with:\n          node-version: 22",
        )}${afterPortable}`,
      ),
    /missing required fragment/,
  );

  assert.throws(
    () =>
      validateSecurityWorkflow(
        `${beforePortable}${portableJob.replace(
          "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
          "actions/checkout@v7",
        )}${afterPortable}`,
      ),
    /missing required fragment/,
  );

  const portableWithoutCheckoutProtection = portableJob.replace(
    "          persist-credentials: false\n",
    "",
  );
  const changed = `${beforePortable}${portableWithoutCheckoutProtection}${afterPortable}`;
  assert.throws(() => validateSecurityWorkflow(changed), /missing required fragment/);
});

test("requires the reviewed setup-node pin in every CI job", () => {
  assert.throws(
    () =>
      validateSecurityWorkflow(
        workflow.replace(
          "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
          "actions/setup-node@v7",
        ),
      ),
    /exact reviewed setup-node pin/,
  );

  assert.throws(
    () =>
      validateSecurityWorkflow(
        workflow.replace(
          "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n",
          "",
        ),
      ),
    /exact reviewed setup-node pin/,
  );
});

test("rejects removal or broadening of the native macOS plist gate", () => {
  assert.throws(
    () =>
      validateSecurityWorkflow(
        workflow.replace(
          "name: Validate macOS LaunchAgent contract with native plist parser\n        if: runner.os == 'macOS'",
          "name: Validate macOS LaunchAgent contract with native plist parser\n        if: runner.os != 'Windows'",
        ),
      ),
    /missing required fragment|build the pinned macOS companion/,
  );
  assert.throws(
    () =>
      validateSecurityWorkflow(
        workflow.replace(
          "/usr/bin/plutil -lint apps/worker-host-macos/Resources/com.openbot.worker-host.node.plist",
          "echo skipped",
        ),
      ),
    /missing required fragment/,
  );
  assert.throws(
    () =>
      validateSecurityWorkflow(
        workflow.replace("          npm run worker-host:macos:native-check\n", ""),
      ),
    /missing required fragment/,
  );
});

test("rejects removal or network broadening of the macOS Desktop companion gate", () => {
  assert.throws(
    () =>
      validateSecurityWorkflow(
        workflow.replace("node scripts/build-macos-worker-host-candidate.mjs", "echo skipped"),
      ),
    /missing required fragment/,
  );
  assert.throws(
    () =>
      validateSecurityWorkflow(
        workflow.replace(
          "curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error",
          "curl --location",
        ),
      ),
    /build the pinned macOS companion/,
  );
  assert.throws(
    () =>
      validateSecurityWorkflow(
        workflow.replace(
          "name: Build the pinned macOS Worker companion",
          "name: Package the unsigned Desktop development artifact",
        ),
      ),
    /missing required fragment|build the pinned macOS companion/,
  );
});

test("requires every CI job in the final gate even after a skipped or failed dependency", () => {
  for (const changed of [
    workflow.replace("    if: always()\n    needs:", "    needs:"),
    workflow.replace("needs: [security, validate, portable,", "needs: [security, validate,"),
    `${workflow}\n  additional-platform:\n    runs-on: ubuntu-latest\n`,
    workflow.replace("  check:\n", "  check:\n    continue-on-error: true\n"),
    workflow.replace("needs.database.result", "needs.validate.result"),
  ]) {
    assert.throws(() => validateSecurityWorkflow(changed), /CI check must/);
  }
});

test("the actual merge gate accepts only success from every required job", () => {
  const gate = workflow.slice(workflow.indexOf("\n  check:\n"));
  const variables = [
    ...gate.matchAll(/^ {10}([A-Z_]+): \$\{\{ needs\.[a-z-]+\.result \}\}$/gm),
  ].map((match) => match[1]);
  assert.equal(variables.length, 13);
  const source = gate
    .split("        run: |\n")[1]
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
  const successful = Object.fromEntries(variables.map((name) => [name, "success"]));
  const execute = (results) =>
    spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", source], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...results },
    });
  assert.equal(execute(successful).status, 0);
  for (const variable of variables) {
    for (const result of ["failure", "cancelled", "skipped", "", "unknown"]) {
      assert.equal(
        execute({ ...successful, [variable]: result }).status,
        1,
        `${variable}=${result}`,
      );
    }
    const missing = { ...successful };
    delete missing[variable];
    assert.notEqual(execute(missing).status, 0, `${variable} missing`);
  }
});
