import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { project, writeProjection } from "./product-node-project.mjs";
import { collectProductionPackageGraph } from "../../scripts/node-linux-release.mjs";
const root = resolve(
  process.env.OPENBOT_CONTAINER_SOURCE ?? fileURLToPath(new URL("../..", import.meta.url)),
);
const lock = JSON.parse(await readFile(join(root, "package-lock.json")));

test("runtime is the exact retained parser/DB closure, with no business Server or oracle", () => {
  const result = project(lock, "runtime");
  assert.deepEqual(
    result.graph,
    collectProductionPackageGraph(lock, "packages/python-node-runtime"),
  );
  assert.equal(result.graph.packageKeys.length, 43);
  assert.deepEqual(result.graph.workspaceKeys, ["packages/db", "packages/python-node-runtime"]);
  for (const key of result.graph.packageKeys)
    assert.deepEqual(result.lock.packages[key], lock.packages[key]);
});

test("build adds only fixed Web workspaces and reviewed tools at original integrity/version", () => {
  const result = project(lock, "build");
  assert.deepEqual(result.graph.workspaceKeys, [
    "apps/web",
    "packages/db",
    "packages/domain",
    "packages/protocol",
    "packages/python-node-runtime",
  ]);
  for (const key of result.graph.packageKeys) {
    assert.equal(result.lock.packages[key].version, lock.packages[key].version);
    assert.equal(result.lock.packages[key].integrity, lock.packages[key].integrity);
  }
  assert.ok(result.graph.packageKeys.includes("node_modules/typescript"));
  assert.ok(result.graph.packageKeys.includes("node_modules/vite"));
  assert.ok(!result.graph.packageKeys.some((key) => /vitest|jsdom|turbo/.test(key)));
});

test("removed Server/oracle workspaces and links cannot affect either projection", () => {
  const copy = structuredClone(lock);
  for (const [key, value] of Object.entries(copy.packages)) {
    if (
      key.includes("apps/server") ||
      key.includes("tests/oracles") ||
      value.name?.includes("legacy-server") ||
      value.resolved?.includes("tests/oracles")
    )
      delete copy.packages[key];
  }
  for (const profile of ["runtime", "build"])
    assert.deepEqual(project(copy, profile), project(lock, profile));
});

test("missing graph and build-tool pin drift fail closed", () => {
  assert.throws(() => project(lock, "auto"));
  for (const key of [
    "node_modules/officeparser",
    "node_modules/typescript",
    "node_modules/@types/node",
  ]) {
    const copy = structuredClone(lock);
    delete copy.packages[key];
    assert.throws(() => project(copy, "build"));
  }
  const copy = structuredClone(lock);
  copy.packages["node_modules/vite"].version = "0.0.0";
  assert.throws(() => project(copy, "build"));
});

test("projection retains DB exports and writes independent npm manifests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbot-product-lock-"));
  try {
    await writeProjection(root, dir, "runtime");
    const db = JSON.parse(await readFile(join(dir, "packages/db/package.json")));
    assert.equal(db.exports["."].default, "./dist/index.js");
    assert.equal(db.devDependencies, undefined);
    const value = JSON.parse(await readFile(join(dir, "package-lock.json")));
    assert.deepEqual(value, project(lock, "runtime").lock);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit Docker target uses immutable bases and selective public context", async () => {
  const file = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
  assert.match(
    file,
    /python:3\.12\.13-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2/,
  );
  assert.match(
    file,
    /node:24\.21\.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553/,
  );
  assert.doesNotMatch(
    file,
    /COPY \. \.|apps\/server\/|tests\/oracles|\.worker-venv|OPENBOT_CONTROL_OWNER_PASSWORD|OPENBOT_DATABASE_URL/,
  );
  assert.match(file, /--only-binary=:all: --no-deps/);
  assert.match(file, /verify_environment.py --worker/);
  assert.match(file, /COPY --from=product-build \/workspace\/apps\/web\/dist/);
  assert.match(file, /COPY apps\/desktop\/resources\/openbot-icon\.png/);
  assert.match(file, /USER 1000:1000/);
  assert.match(file, /STOPSIGNAL SIGTERM/);
  const ignore = await readFile(
    new URL("./Dockerfile.dockerignore", import.meta.url),
    "utf8",
  );
  assert.ok(ignore.startsWith("**\n"));
  assert.doesNotMatch(ignore, /!apps\/server\/|!tests\/|!.*\.venv/);
  assert.ok(ignore.includes("!apps/desktop/resources/openbot-icon.png\n"));
});

test("standalone Compose uses distinct volumes, no published PG or automatic engine", async () => {
  const file = await readFile(new URL("./compose.yaml", import.meta.url), "utf8");
  assert.match(file, /127\.0\.0\.1:3001:3001/);
  assert.doesNotMatch(file, /5432:5432|privileged:|docker.sock|TEMPORAL|COMMAND_CONFIG|restart:/);
  assert.match(file, /product-postgres:/);
  assert.match(file, /product-state:/);
  assert.match(file, /read_only: true/);
});
