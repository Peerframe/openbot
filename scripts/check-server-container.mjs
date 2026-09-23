import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const NODE_IMAGE =
  "node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553";
const PYTHON_IMAGE =
  "python:3.12.13-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2";
const CHECKOUT_PIN = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";

export function validateServerContainer({
  dockerfile,
  compose,
  pythonCompose,
  dockerignore,
  workflow,
  smoke,
  packageJson,
  contributing,
  contributingChinese,
}) {
  const expectedFromLines = [
    `FROM ${NODE_IMAGE} AS base`,
    "FROM base AS toolchain",
    "FROM toolchain AS pruner",
    "FROM toolchain AS build",
    "FROM toolchain AS production-dependencies",
    "FROM base AS runtime-node",
    `FROM ${PYTHON_IMAGE} AS python-base`,
    "FROM python-base AS python-dependencies",
    "FROM python-base AS runtime-python",
    "FROM runtime-node AS runtime",
  ];
  const actualFromLines = dockerfile.match(/^FROM .+$/gm) ?? [];
  if (JSON.stringify(actualFromLines) !== JSON.stringify(expectedFromLines)) {
    throw new Error(
      "Server Dockerfile must use only the reviewed multi-stage base and exact digest.",
    );
  }

  const requiredDockerfileFragments = [
    "corepack enable npm",
    "corepack prepare npm@10.9.9 --activate",
    'test "$(npm --version)" = "10.9.9"',
    "ENV TURBO_TELEMETRY_DISABLED=1",
    "npm ci --ignore-scripts --audit=false",
    "npm exec -- turbo prune @openbot/server --docker --out-dir=/pruned",
    "COPY --from=pruner /pruned/json/ ./",
    "COPY --from=pruner /pruned/full/ ./",
    "COPY --from=pruner /workspace/tsconfig.base.json ./tsconfig.base.json",
    "npm exec -- turbo run build --filter=@openbot/server...",
    "npm ci --omit=dev --ignore-scripts --audit=false",
    "mkdir -p apps/server/node_modules",
    "install -d --owner=node --group=node --mode=0700 /var/lib/openbot/objects",
    "install -d --owner=node --group=node --mode=0700 /var/lib/openbot/model",
    "COPY --from=production-dependencies --chown=node:node /workspace/node_modules ./node_modules",
    "COPY --from=production-dependencies --chown=node:node /workspace/apps/server/node_modules ./apps/server/node_modules",
    "/workspace/apps/server/dist ./apps/server/dist",
    "/workspace/packages/db/migrations ./packages/db/migrations",
    "deploy/server/healthcheck.mjs ./deploy/server/healthcheck.mjs",
    "ENV NODE_ENV=production",
    "ENV OPENBOT_OBJECT_STORE_PATH=/var/lib/openbot/objects",
    "USER node",
    "STOPSIGNAL SIGTERM",
    'CMD ["node", "deploy/server/healthcheck.mjs"]',
    'CMD ["node", "apps/server/dist/index.js"]',
  ];
  for (const fragment of requiredDockerfileFragments) {
    if (!dockerfile.includes(fragment)) {
      throw new Error(`Server Dockerfile is missing required fragment: ${fragment}`);
    }
  }

  for (const workspace of ["config", "db", "domain", "logging", "policy", "protocol"]) {
    for (const path of ["package.json", "dist"]) {
      const fragment = `/workspace/packages/${workspace}/${path} ./packages/${workspace}/${path}`;
      if (!dockerfile.includes(fragment)) {
        throw new Error(`Server Dockerfile is missing runtime workspace path: ${fragment}`);
      }
    }
  }

  if ((dockerfile.match(/^COPY \. \.$/gm) ?? []).length !== 1) {
    throw new Error("Server Dockerfile must copy the complete context only into the pruner stage.");
  }
  const runtime = dockerfile.slice(
    dockerfile.indexOf("FROM base AS runtime-node"),
    dockerfile.indexOf(`FROM ${PYTHON_IMAGE}`),
  );
  if (
    /\b(?:ADD|USER root)\b|COPY \. \.|\/src(?:\s|$)|\/apps\/(?:desktop|node|web)|\/providers|npm (?:ci|install|exec|run)/.test(
      runtime,
    )
  ) {
    throw new Error(
      "Server runtime stage includes source, unrelated workspaces, root, or build tools.",
    );
  }
  if (
    /OPENBOT_(?:DATABASE_URL|NODE_TOKEN|OWNER_PASSWORD)/.test(dockerfile) ||
    /\b(?:alpine|latest)\b/i.test(dockerfile)
  ) {
    throw new Error("Server Dockerfile must not embed secrets or use floating/experimental bases.");
  }
  if (dockerfile.indexOf("USER node") > dockerfile.indexOf("HEALTHCHECK")) {
    throw new Error("Server Dockerfile must select the non-root user before runtime commands.");
  }

  const pythonRuntime =
    dockerfile
      .split("FROM python-base AS runtime-python")[1]
      ?.split("FROM runtime-node AS runtime")[0] ?? "";
  for (const fragment of [
    "ENV OPENBOT_AGENT_RUNTIME=python",
    "COPY --from=base /usr/local/bin/node /usr/local/bin/node",
    "COPY --from=runtime-node /workspace/ ./",
    "COPY --from=python-dependencies /workspace/apps/agent-runtime-python/ ./apps/agent-runtime-python/",
    "COPY apps/agent-runtime-python/src/ ./apps/agent-runtime-python/src/",
    "COPY apps/agent-runtime-python/scripts/run-worker.py ./apps/agent-runtime-python/scripts/run-worker.py",
    "USER node",
    "STOPSIGNAL SIGTERM",
  ]) {
    if (!pythonRuntime.includes(fragment))
      throw new Error(`Python runtime missing required fragment: ${fragment}`);
  }
  if (
    /\b(?:ADD|USER root)\b|COPY \. \.|pip .*install|npm |agent-runtime-python\/tests/.test(
      pythonRuntime,
    )
  ) {
    throw new Error("Python runtime includes installers, tests or unexpected privileges.");
  }
  for (const fragment of [
    "--only-binary=:all:",
    "-r requirements-runtime.lock",
    "--profile runtime",
    "python -m venv .venv",
  ]) {
    if (!dockerfile.includes(fragment))
      throw new Error(`Python dependency stage missing required fragment: ${fragment}`);
  }
  if (
    !pythonCompose.includes("target: runtime-python") ||
    !pythonCompose.includes("OPENBOT_AGENT_RUNTIME: python") ||
    /ports:|volumes:|privileged:|network_mode:/.test(pythonCompose)
  ) {
    throw new Error("Python Compose overlay must select only the target and fixed runtime.");
  }

  const requiredComposeFragments = [
    "dockerfile: deploy/server/Dockerfile",
    "condition: service_healthy",
    "stop_grace_period: 20s",
    "read_only: true",
    "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=0700",
    '"127.0.0.1:3001:3001"',
    "OPENBOT_OBJECT_STORE_PATH: /var/lib/openbot/objects",
    "openbot-objects:/var/lib/openbot/objects",
    "OPENBOT_MODEL_DIRECTORY: /var/lib/openbot/model",
    "openbot-model:/var/lib/openbot/model",
  ];
  for (const fragment of requiredComposeFragments) {
    if (!compose.includes(fragment)) {
      throw new Error(`Server Compose configuration is missing required fragment: ${fragment}`);
    }
  }
  if (
    /OPENBOT_NODE_TOKEN|0\.0\.0\.0:3001:3001|network_mode:\s*host|privileged:\s*true/.test(compose)
  ) {
    throw new Error(
      "Server Compose configuration restores a stale or over-broad authority boundary.",
    );
  }

  for (const fragment of [
    ".git",
    ".agents",
    ".codex",
    ".env*",
    "**/dist",
    "**/node_modules",
    "docs",
    "README*.md",
  ]) {
    if (!dockerignore.split("\n").includes(fragment)) {
      throw new Error(`Docker build context does not exclude: ${fragment}`);
    }
  }

  const jobStart = workflow.indexOf("\n  server-container:\n");
  if (jobStart === -1) throw new Error("CI is missing the native Server container job.");
  const jobSource = workflow.slice(jobStart + 1);
  const nextJob = jobSource.slice(1).search(/^ {2}[A-Za-z_][A-Za-z0-9_-]*:\s*$/m);
  const job = nextJob === -1 ? jobSource : jobSource.slice(0, nextJob + 1);
  const requiredWorkflowFragments = [
    "name: Server container ($" + "{{ matrix.name }})",
    "runs-on: $" + "{{ matrix.runner }}",
    "timeout-minutes: 25",
    "fail-fast: false",
    "- name: Linux amd64\n            runner: ubuntu-24.04\n            arch: amd64",
    "- name: Linux arm64\n            runner: ubuntu-24.04-arm\n            arch: arm64",
    CHECKOUT_PIN,
    "persist-credentials: false",
    "docker compose --file deploy/server/compose.yaml config --quiet",
    "OPENBOT_OWNER_PASSWORD: openbot-compose-ci-validation-only",
    "docker build --check --file deploy/server/Dockerfile .",
    'docker build --platform "linux/$' +
      '{{ matrix.arch }}" --tag openbot-server:smoke --file deploy/server/Dockerfile .',
    "OPENBOT_TEST_PLATFORM: $" + "{{ matrix.arch }}",
    "bash scripts/smoke-server-container.sh",
    "--target runtime-python --tag openbot-server:python-smoke",
    "OPENBOT_TEST_AGENT_RUNTIME: python",
    "--file deploy/server/compose.python.yaml config --quiet",
  ];
  for (const fragment of requiredWorkflowFragments) {
    if (!job.includes(fragment)) {
      throw new Error(`Server container CI job is missing required fragment: ${fragment}`);
    }
  }
  if (
    /continue-on-error:|docker (?:login|push)|push-to-registry|packages:\s*write|(?:ubuntu|windows|macos)-latest/.test(
      job,
    )
  ) {
    throw new Error(
      "Server container CI must remain required, native, read-only, and non-publishing.",
    );
  }

  if ((job.match(/^ +run: bash scripts\/smoke-server-container\.sh$/gm) ?? []).length !== 2) {
    throw new Error(
      "Server container CI job is missing required fragment: both runtime smoke lanes.",
    );
  }

  const requiredSmokeFragments = [
    'runtime_version" != "v24.21.0"',
    'runtime_uid" == "0"',
    '"electron", "tsx", "turbo", "typescript", "vite", "vitest"',
    "filename-reserved-regex",
    "apps/server/dist/employee-package.js",
    "buildEmployeeTemplate",
    "con-employee.openbot-employee.json",
    "@types/filename-reserved-regex",
    "expected_migration_count",
    "invalid_server_container",
    "  --read-only " + "\\" + "\n  --tmpfs",
    "postgres:17.11-bookworm",
    "select count(*) from drizzle.__drizzle_migrations",
    "Server container returned an unexpected health identity.",
    "docker restart --time 20",
    "docker stop --time 20",
    "server.shutdown_started",
    "server.shutdown_failed",
    "--profile runtime",
    "scripts/smoke-python-runtime.mjs",
    "Python preflight failure changed the fresh database.",
  ];
  for (const fragment of requiredSmokeFragments) {
    if (!smoke.includes(fragment)) {
      throw new Error(`Server container smoke is missing required fragment: ${fragment}`);
    }
  }
  if (/--privileged|docker\.sock|docker (?:login|push)|OPENBOT_NODE_TOKEN/.test(smoke)) {
    throw new Error("Server container smoke broadens privileges, publication, or stale identity.");
  }

  const parsedPackage = JSON.parse(packageJson);
  if (
    parsedPackage.scripts?.["server:container:check"] !==
    "node --test scripts/check-server-container.test.mjs && node scripts/check-server-container.mjs"
  ) {
    throw new Error("Package scripts must expose the complete Server container contract check.");
  }
  if (!parsedPackage.scripts?.check?.includes("npm run server:container:check")) {
    throw new Error("The root check must run the Server container contract check.");
  }

  if (/OPENBOT_NODE_TOKEN/.test(`${contributing}\n${contributingChinese}`)) {
    throw new Error("Contributor setup must not require the removed shared Node token.");
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repositoryRoot = new URL("../", import.meta.url);
  const [
    dockerfile,
    compose,
    pythonCompose,
    dockerignore,
    workflow,
    smoke,
    packageJson,
    contributing,
    contributingChinese,
  ] = await Promise.all(
    [
      "deploy/server/Dockerfile",
      "deploy/server/compose.yaml",
      "deploy/server/compose.python.yaml",
      ".dockerignore",
      ".github/workflows/ci.yml",
      "scripts/smoke-server-container.sh",
      "package.json",
      "CONTRIBUTING.md",
      "CONTRIBUTING.zh-CN.md",
    ].map((path) => readFile(new URL(path, repositoryRoot), "utf8")),
  );
  validateServerContainer({
    dockerfile,
    compose,
    pythonCompose,
    dockerignore,
    workflow,
    smoke,
    packageJson,
    contributing,
    contributingChinese,
  });
  console.info("Server container contract checks passed.");
}
