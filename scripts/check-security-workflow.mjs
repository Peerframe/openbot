import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SETUP_NODE_PIN = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";

export function validateSecurityWorkflow(workflow) {
  const requiredFragments = [
    "permissions:\n  contents: read",
    "fetch-depth: 0",
    "persist-credentials: false",
    "ghcr.io/trufflesecurity/trufflehog@sha256:deb2af10659a488a14d262a323addcde099d99827a1cf1dc4e93c17915c39f08",
    "--no-verification",
    "--no-update",
    "--fail-on-scan-errors",
    "$" + "{{ github.workspace }}:/repo:ro",
  ];

  for (const fragment of requiredFragments) {
    if (!workflow.includes(fragment)) {
      throw new Error(`CI security workflow is missing required fragment: ${fragment}`);
    }
  }

  if (/trufflehog-action@|upload-sarif|--verifier/.test(workflow)) {
    throw new Error("CI secret scanning must stay digest-pinned, local, and non-uploading.");
  }

  const securityJobStart = workflow.indexOf("\n  security:\n");
  const checkJobStart = workflow.indexOf("\n  validate:\n");
  if (securityJobStart === -1 || checkJobStart <= securityJobStart) {
    throw new Error("CI must define the security job before the validate job.");
  }
  const securityJob = workflow.slice(securityJobStart, checkJobStart);
  const requiredSecurityFragments = [
    "npm install --global npm@10.9.9 --ignore-scripts --no-audit --no-fund",
    'test "$(npm --version)" = "10.9.9"',
    "npm ci --ignore-scripts --audit=false",
    "npm audit --omit=dev --audit-level=high",
    "umask 077",
    "--json --fail --fail-on-scan-errors git file:///repo",
    '>"${RUNNER_TEMP}/trufflehog-results.jsonl" 2>"${RUNNER_TEMP}/trufflehog-diagnostics.log"',
    'node scripts/check-credential-findings.mjs "${RUNNER_TEMP}/trufflehog-results.jsonl" "$status"',
  ];
  for (const fragment of requiredSecurityFragments) {
    if (!securityJob.includes(fragment)) {
      throw new Error(`CI security job is missing required fragment: ${fragment}`);
    }
  }
  const selectedNpm = securityJob.indexOf(requiredSecurityFragments[0]);
  const verifiedNpm = securityJob.indexOf(requiredSecurityFragments[1]);
  const cleanInstall = securityJob.indexOf(requiredSecurityFragments[2]);
  const audit = securityJob.indexOf(requiredSecurityFragments[3]);
  if (
    selectedNpm === -1 ||
    verifiedNpm <= selectedNpm ||
    cleanInstall <= verifiedNpm ||
    audit <= cleanInstall
  ) {
    throw new Error(
      "CI security job must select and verify npm, install the lock tree, then audit.",
    );
  }
  if (
    /continue-on-error:|npm audit fix|(?:npm ci|npm audit)[^\n]*(?:\|\||;)\s*true/.test(securityJob)
  ) {
    throw new Error("CI dependency auditing must remain read-only and fail closed.");
  }
  if (
    /--exclude-|--branch|--since-commit|check-credential-findings[^\n]*\|\||cat[^\n]*trufflehog-/.test(
      securityJob,
    )
  ) {
    throw new Error(
      "Credential scanning must retain full history and fail closed without raw output.",
    );
  }

  const portableJobStart = workflow.indexOf("\n  portable:\n");
  const windowsWorkerHostJobStart = workflow.indexOf("\n  windows-worker-host:\n");
  const databaseJobStart = workflow.indexOf("\n  database:\n");
  if (
    portableJobStart === -1 ||
    windowsWorkerHostJobStart <= portableJobStart ||
    databaseJobStart <= windowsWorkerHostJobStart
  ) {
    throw new Error(
      "CI must define the portable matrix before the Windows Worker Host and database jobs.",
    );
  }

  const portableJob = workflow.slice(portableJobStart, windowsWorkerHostJobStart);
  const requiredPortableFragments = [
    "name: Retained clients and legacy Desktop ($" + "{{ matrix.name }})",
    "runs-on: $" + "{{ matrix.runner }}",
    "timeout-minutes: 50",
    "fail-fast: false",
    "- name: Linux x64\n            runner: ubuntu-24.04",
    "- name: Windows x64\n            runner: windows-2025",
    "- name: macOS arm64\n            runner: macos-15",
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "persist-credentials: false",
    SETUP_NODE_PIN,
    "node-version: 22.22.2",
    "cache: npm",
    "- run: npm ci",
    "- run: npm run typecheck",
    "- run: npm run test",
    "- run: npm run build",
    "name: Build the pinned macOS Worker companion",
    "https://nodejs.org/dist/v22.22.2/node-v22.22.2-darwin-arm64.tar.gz",
    "node scripts/build-macos-worker-host-candidate.mjs",
    "OPENBOT_DESKTOP_MACOS_WORKER_COMPANION=$companion_root/OpenBot Worker Host.app",
    "name: Package the unsigned Desktop development artifact",
    "npm run package --workspace @openbot/desktop",
    "npm run make:installers --workspace @openbot/desktop",
    "name: Retain versioned installers and checksums",
    "name: Validate macOS LaunchAgent contract with native plist parser",
    "if: runner.os == 'macOS'",
    "npm run worker-host:macos:check",
    "npm run worker-host:macos:native-check",
    "/usr/bin/plutil -lint apps/worker-host-macos/Resources/com.openbot.worker-host.node.plist",
    "/usr/bin/plutil -lint apps/worker-host-macos/Resources/Info.plist.template",
    "/usr/bin/plutil -lint apps/worker-host-macos/Resources/OpenBotWorkerHost.entitlements.template.plist",
  ];

  for (const fragment of requiredPortableFragments) {
    if (!portableJob.includes(fragment)) {
      throw new Error(`CI portable matrix is missing required fragment: ${fragment}`);
    }
  }

  const setupNodeReferences = workflow.match(/actions\/setup-node@[^\s]+/g) ?? [];
  if (
    setupNodeReferences.length !== 8 ||
    setupNodeReferences.some((reference) => reference !== SETUP_NODE_PIN)
  ) {
    throw new Error("CI must use the exact reviewed setup-node pin in all eight jobs.");
  }

  const companionBuild = portableJob.indexOf("name: Build the pinned macOS Worker companion");
  const desktopPackage = portableJob.indexOf(
    "name: Package the unsigned Desktop development artifact",
  );
  const nativeValidation = portableJob.indexOf(
    "name: Validate macOS LaunchAgent contract with native plist parser",
  );
  if (
    companionBuild === -1 ||
    desktopPackage <= companionBuild ||
    nativeValidation <= desktopPackage ||
    !portableJob.slice(companionBuild, desktopPackage).includes("if: runner.os == 'macOS'") ||
    !portableJob.slice(nativeValidation).includes("if: runner.os == 'macOS'") ||
    !portableJob
      .slice(companionBuild, desktopPackage)
      .includes("curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error")
  ) {
    throw new Error(
      "CI must build the pinned macOS companion before Desktop packaging and native validation.",
    );
  }

  if (/continue-on-error:|(?:ubuntu|windows|macos)-latest/.test(portableJob)) {
    throw new Error("CI portable matrix members must be required and use explicit runner labels.");
  }
  const gate = workflow.match(
    /^ {2}check:\n([\s\S]*?)(?=^ {2}[A-Za-z_][A-Za-z0-9_-]*:\n|$(?![\s\S]))/m,
  )?.[1];
  const jobIds = [
    ...workflow
      .slice(workflow.indexOf("\njobs:\n"))
      .matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*$/gm),
  ]
    .map((match) => match[1])
    .filter((id) => id !== "check");
  const requiredJobs = gate
    ?.match(/^ {4}needs: \[([^\]]+)\]$/m)?.[1]
    .split(",")
    .map((id) => id.trim());
  if (
    !gate ||
    !gate.includes("    if: always()\n") ||
    !requiredJobs ||
    new Set(requiredJobs).size !== jobIds.length ||
    jobIds.some((id) => !requiredJobs.includes(id)) ||
    /continue-on-error:/.test(workflow)
  ) {
    throw new Error("CI check must always require every job without failure exemptions.");
  }
  const resultJobs = [...gate.matchAll(/needs\.([a-z][a-z0-9-]*)\.result/g)].map(
    (match) => match[1],
  );
  if (
    resultJobs.length !== requiredJobs.length ||
    requiredJobs.some((id) => !resultJobs.includes(id)) ||
    !gate.includes('if [[ "$result" != "success" ]]; then') ||
    !gate.includes("              exit 1\n")
  ) {
    throw new Error("CI check must inspect every prerequisite and accept only success.");
  }
}

export function validatePythonProductWorkflow(workflow, migrationWorkflow) {
  const job = (id) => {
    const section = workflow.match(
      new RegExp(
        `^ {2}${id}:\\n([\\s\\S]*?)(?=^ {2}[A-Za-z_][A-Za-z0-9_-]*:\\n|$(?![\\s\\S]))`,
        "m",
      ),
    )?.[1];
    if (!section) throw new Error(`Python product CI is missing job: ${id}`);
    if (/^ {4}if:|continue-on-error:|\|\|\s*true/m.test(section))
      throw new Error(`Python product CI must not bypass ${id}.`);
    return section;
  };
  const temporal = job("temporal-qualification");
  if (
    !temporal.includes("--engine postgres-mtls --upgrade-archive") ||
    !temporal.includes("--only-case product-owner-corrections")
  )
    throw new Error(
      "Python Temporal CI must retain the original recovery and upgrade qualification.",
    );
  const browser = job("browser-product");
  for (const fragment of [
    "--filter=@openbot/node^... --filter=@openbot/db",
    "experiments/work-journey/product_browser_probe.py",
    "for recovery in control node replacement response-loss browser-restart; do",
  ]) {
    if (!browser.includes(fragment))
      throw new Error(`Python browser CI must retain its real product recovery cases: ${fragment}`);
  }
  const egress = job("browser-egress");
  for (const fragment of [
    "experiments/browser-execution/egress-fixture.Dockerfile",
    "experiments/browser-execution/qualify_egress.py",
    "--fixture-image",
  ]) {
    if (!egress.includes(fragment))
      throw new Error(`Browser egress CI must exercise the actual proxy: ${fragment}`);
  }
  const container = job("python-product-container");
  for (const fragment of [
    "runner: ubuntu-24.04\n            arch: amd64",
    "runner: ubuntu-24.04-arm\n            arch: arm64",
    "--target runtime-product",
    "--file deploy/server/Dockerfile.product",
    "deploy/server/smoke-product.py --image openbot-server:product-smoke",
  ]) {
    if (!container.includes(fragment))
      throw new Error(`Python product container must qualify its own entry: ${fragment}`);
  }
  const preview = job("python-desktop-preview");
  const orderedStages = [
    "npm exec -- turbo run build --filter=@openbot/desktop --filter=@openbot/python-node-runtime",
    "node apps/desktop/scripts/prepare-native-server.mjs --python-product",
    "node apps/desktop/scripts/smoke-python-product.mjs apps/desktop/out/python-product-runtime",
    "node apps/desktop/scripts/package.mjs --preview --python-product",
    "apps/desktop/out/python-product/OpenBot Preview-darwin-arm64/OpenBot Preview.app/Contents/Resources/native-runtime",
  ];
  let previous = -1;
  for (const stage of orderedStages) {
    const at = preview.indexOf(stage);
    if (at <= previous)
      throw new Error(`Python Preview must execute its staged and packaged lifecycle: ${stage}`);
    previous = at;
  }
  if (
    !preview.includes("runs-on: macos-15") ||
    /prepare:native|npm run package|--filter=@openbot\/server|apps\/server\//.test(preview)
  )
    throw new Error("Python Preview must not substitute legacy Desktop packaging.");
  if (
    !job("synthetic-migration").includes("uses: ./.github/workflows/s7-migration.yml") ||
    !/^  workflow_call:\s*$/m.test(migrationWorkflow) ||
    !migrationWorkflow.includes("node experiments/s7-migration/qualify.mjs --report")
  )
    throw new Error("Python migration must invoke the existing same-commit qualification.");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  validateSecurityWorkflow(workflow);
  const migration = await readFile(
    new URL("../.github/workflows/s7-migration.yml", import.meta.url),
    "utf8",
  );
  validatePythonProductWorkflow(workflow, migration);
  console.info("CI security workflow checks passed.");
}
