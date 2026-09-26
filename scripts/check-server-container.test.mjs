import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkServerHealth } from "../deploy/server/healthcheck.mjs";
import { validateServerContainer } from "./check-server-container.mjs";

const repositoryRoot = new URL("../", import.meta.url);
const paths = [
  "deploy/server/Dockerfile",
  "deploy/server/compose.yaml",
  "deploy/server/compose.python.yaml",
  ".dockerignore",
  ".github/workflows/ci.yml",
  "scripts/smoke-server-container.sh",
  "package.json",
  "CONTRIBUTING.md",
  "CONTRIBUTING.zh-CN.md",
];
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
] = await Promise.all(paths.map((path) => readFile(new URL(path, repositoryRoot), "utf8")));
const valid = {
  dockerfile,
  compose,
  pythonCompose,
  dockerignore,
  workflow,
  smoke,
  packageJson,
  contributing,
  contributingChinese,
};

test("POSIX preflight log guard drains the stream and rejects missing or failed evidence", {
  skip: process.platform === "win32",
}, () => {
  const start = smoke.indexOf('  if ! docker logs "$invalid_python_container"');
  assert.notEqual(start, -1);
  const end = smoke.indexOf("\n  fi", start);
  assert.notEqual(end, -1);
  const guard = smoke.slice(start, end + "\n  fi".length);
  for (const mode of ["matched", "missing", "failed"]) {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
invalid_python_container=synthetic-log-stream
docker() {
  if [[ "$LOG_MODE" != "missing" ]]; then
    printf '%s\\n' 'Python Agent runtime preflight failed'
  fi
  for ((i=0; i<256; i++)); do printf '%2048s\\n' ''; done
  [[ "$LOG_MODE" != "failed" ]]
}
${guard}
`,
      ],
      {
        env: { ...process.env, LOG_MODE: mode },
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, mode === "matched" ? 0 : 1, `${mode}: ${result.stderr}`);
  }
});

test("accepts the exact non-root multi-stage Server container contract", () => {
  assert.doesNotThrow(() => validateServerContainer(valid));
});

test("rejects floating, experimental, or additional base images", () => {
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        dockerfile: dockerfile.replace(/@sha256:[a-f0-9]+/, ""),
      }),
    /exact digest/,
  );
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        dockerfile: dockerfile.replace("bookworm-slim", "alpine3.24"),
      }),
    /exact digest|experimental/,
  );
  assert.throws(
    () => validateServerContainer({ ...valid, dockerfile: `${dockerfile}\nFROM busybox:latest\n` }),
    /exact digest/,
  );
});

test("rejects a root or development-bearing runtime stage", () => {
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        dockerfile: dockerfile.replace("USER node", "USER root"),
      }),
    /missing required fragment|root/,
  );
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        dockerfile: dockerfile.replace(
          "COPY --chown=node:node deploy/server/healthcheck.mjs",
          "COPY . .\nCOPY --chown=node:node deploy/server/healthcheck.mjs",
        ),
      }),
    /complete context|source/,
  );
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        dockerfile: dockerfile.replace("npm ci --omit=dev", "npm ci"),
      }),
    /missing required fragment/,
  );
});

test("rejects omitting the nested Server production node_modules closure", () => {
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        dockerfile: dockerfile.replace(
          "COPY --from=production-dependencies --chown=node:node /workspace/apps/server/node_modules ./apps/server/node_modules\n",
          "",
        ),
      }),
    /missing required fragment/,
  );
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        dockerfile: dockerfile.replace("mkdir -p apps/server/node_modules", "true"),
      }),
    /missing required fragment/,
  );
});

test("rejects smoke that skips nested production or export filename coverage", () => {
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        smoke: smoke.replace("con-employee.openbot-employee.json", "missing-export-filename.json"),
      }),
    /missing required fragment/,
  );
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        smoke: smoke.replaceAll("filename-reserved-regex", "nested-prod-module"),
      }),
    /missing required fragment/,
  );
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        smoke: smoke.replaceAll("buildEmployeeTemplate", "buildTemplateOmitted"),
      }),
    /missing required fragment/,
  );
});

test("rejects missing runtime migrations or workspace output", () => {
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        dockerfile: dockerfile.replace(
          "COPY --from=build --chown=node:node /workspace/packages/db/migrations ./packages/db/migrations\n",
          "",
        ),
      }),
    /migrations/,
  );
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        dockerfile: dockerfile.replace(
          "COPY --from=build --chown=node:node /workspace/packages/policy/dist ./packages/policy/dist\n",
          "",
        ),
      }),
    /runtime workspace path/,
  );
});

test("rejects stale Compose authority and public host bindings", () => {
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        compose: compose.replace(
          "      OPENBOT_OWNER_NAME:",
          "      OPENBOT_NODE_TOKEN: shared-token\n      OPENBOT_OWNER_NAME:",
        ),
      }),
    /stale/,
  );
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        compose: compose.replace('"127.0.0.1:3001:3001"', '"0.0.0.0:3001:3001"'),
      }),
    /missing|required|over-broad/,
  );
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        compose: compose.replace("    stop_grace_period: 20s\n", ""),
      }),
    /stop_grace_period/,
  );
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        compose: compose.replace("    read_only: true\n", ""),
      }),
    /read_only/,
  );
});

test("rejects emulated-only, optional, or publishing container CI", () => {
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        workflow: workflow.replace("runner: ubuntu-24.04-arm", "runner: ubuntu-24.04"),
      }),
    /missing required fragment/,
  );
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        workflow: workflow.replace(
          "  server-container:\n",
          "  server-container:\n    continue-on-error: true\n",
        ),
      }),
    /required/,
  );
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        workflow: workflow.replace(
          "bash scripts/smoke-server-container.sh",
          "bash scripts/smoke-server-container.sh\n      - run: docker push example",
        ),
      }),
    /non-publishing/,
  );
});

test("rejects privileged or incomplete lifecycle smoke", () => {
  assert.throws(
    () => validateServerContainer({ ...valid, smoke: smoke.replace("  --read-only \\\n", "") }),
    /missing required fragment/,
  );
  assert.throws(
    () => validateServerContainer({ ...valid, smoke: `${smoke}\ndocker run --privileged image\n` }),
    /broadens privileges/,
  );
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        smoke: smoke.replace("server.shutdown_started", "server.shutdown_omitted"),
      }),
    /missing required fragment/,
  );
});

test("health probe uses a bounded loopback request", async () => {
  let requestedUrl;
  let requestedOptions;
  await checkServerHealth({
    port: "4567",
    timeoutMs: 100,
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestedOptions = options;
      return { status: 200, json: async () => ({ ok: true, service: "openbot-server" }) };
    },
  });
  assert.equal(requestedUrl, "http://127.0.0.1:4567/health");
  assert.equal(requestedOptions.redirect, "error");
  assert.equal(requestedOptions.signal.aborted, false);

  await assert.rejects(
    checkServerHealth({ fetchImpl: async () => ({ status: 503 }), timeoutMs: 100 }),
    /HTTP 503/,
  );
  await assert.rejects(
    checkServerHealth({
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({ ok: true, service: "different-service" }),
      }),
      timeoutMs: 100,
    }),
    /identity/,
  );
  await assert.rejects(
    checkServerHealth({ fetchImpl: async () => ({ status: 200 }), port: "0" }),
    /port/,
  );
  await assert.rejects(
    checkServerHealth({ fetchImpl: async () => ({ status: 200 }), timeoutMs: 10_001 }),
    /timeout/,
  );
});

test("health probe aborts a stalled request", async () => {
  await assert.rejects(
    checkServerHealth({
      timeoutMs: 5,
      fetchImpl: (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    }),
    /abort|timeout/i,
  );
});

test("isolates the container policy from a following peer job", () => {
  const peer = "\n  independent_job:\n    runs-on: ubuntu-latest\n    continue-on-error: true\n";
  assert.doesNotThrow(() => validateServerContainer({ ...valid, workflow: workflow + peer }));
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        workflow:
          workflow.replace("bash scripts/smoke-server-container.sh", "echo missing smoke") +
          peer +
          "    steps:\n      - run: bash scripts/smoke-server-container.sh\n",
      }),
    /Server container CI job is missing required fragment/,
  );
});

test("rejects Python dependency and overlay bypasses", () => {
  for (const fragment of [
    "--only-binary=:all:",
    "--profile runtime",
    "-r requirements-runtime.lock",
  ]) {
    assert.throws(
      () => validateServerContainer({ ...valid, dockerfile: dockerfile.replace(fragment, "") }),
      /Python dependency/,
    );
  }
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        pythonCompose: pythonCompose.replace("runtime-python", "runtime"),
      }),
    /Python Compose/,
  );
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        pythonCompose: `${pythonCompose}    privileged: true\n`,
      }),
    /Python Compose/,
  );
  assert.throws(
    () =>
      validateServerContainer({
        ...valid,
        dockerfile: dockerfile.replace(
          "FROM python-base AS runtime-python",
          "FROM python-base AS runtime-python\nRUN pip install pytest",
        ),
      }),
    /Python runtime/,
  );
});
