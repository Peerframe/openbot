import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const oraclePath = "tests/oracles/legacy-server";
const oracleName = "@openbot/legacy-server-oracle";
const excluded = new Set([
  "node_modules",
  "dist",
  ".git",
  ".turbo",
  ".venv",
  ".worker-venv",
  "__pycache__",
  "__fixtures__",
  "fixtures",
  "tests",
  "out",
  "native-runtime",
]);
const marker = /(?:tests[\\/]oracles[\\/]legacy-server|@openbot\/legacy-server-oracle)/;

async function files(directory, ignore = new Set()) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignore.has(entry.name)) continue;
    const path = join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Unexpected source symlink: ${path}`);
    if (entry.isDirectory()) found.push(...(await files(path, ignore)));
    else if (entry.isFile()) found.push(path);
  }
  return found.sort();
}

export async function checkServerOracle(root) {
  const base = join(root, oraclePath);
  const snapshot = JSON.parse(await readFile(join(base, "snapshot.json"), "utf8"));
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.license, "MIT");
  assert(snapshot.files.length > 0);
  const expected = new Set();
  for (const entry of snapshot.files) {
    assert(
      /^src\/(?:[a-z0-9_-]+\.ts|__fixtures__\/attachments\/[a-zA-Z0-9_.-]+)$/.test(entry.path),
      "Invalid oracle path",
    );
    assert.equal(entry.origin, `apps/server/${entry.path}`);
    assert(!expected.has(entry.path), "Duplicate oracle path");
    expected.add(entry.path);
    const path = join(base, entry.path);
    assert((await lstat(path)).isFile(), "Oracle must be a regular file");
    const data = await readFile(path);
    assert.equal(data.length, entry.bytes, `Oracle length changed: ${entry.path}`);
    assert.equal(
      createHash("sha256").update(data).digest("hex"),
      entry.sha256,
      `Oracle hash changed: ${entry.path}`,
    );
  }
  assert.deepEqual(
    (await files(join(base, "src")))
      .map((path) => relative(base, path).replaceAll("\\", "/"))
      .sort(),
    [...expected].sort(),
    "Unmanifested or missing oracle source",
  );
  assert(!expected.has("src/index.ts"), "No Server startup entry in oracle");
  const pkg = JSON.parse(await readFile(join(base, "package.json"), "utf8"));
  assert.equal(pkg.name, oracleName);
  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.exports, {});
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
  assert.equal(pkg.bin, undefined);
  assert.equal(pkg.main, undefined);
  assert.equal(pkg.module, undefined);
  assert.equal(pkg.peerDependencies, undefined);
  assert.deepEqual(pkg.scripts, { "build:oracle": "tsc -p tsconfig.json" });
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  assert.deepEqual(lock.packages[oraclePath].devDependencies, pkg.devDependencies);
  assert.deepEqual(lock.packages[`node_modules/${oracleName}`], {
    resolved: oraclePath,
    link: true,
  });

  // The fixture is immutable evidence. Product code and its package graph must not use it.
  let checked = 0;
  for (const directory of ["apps", "packages", "providers", "deploy", "scripts"]) {
    for (const path of await files(join(root, directory), excluded)) {
      const name = relative(root, path).replaceAll("\\", "/");
      if (
        (!/\.(?:[cm]?[jt]sx?|py|json|sh|ya?ml|toml)$/.test(name) &&
          !name.endsWith("/Dockerfile")) ||
        /(?:^|[/.])test(?:[/.]|$)/.test(name)
      )
        continue;
      // Comparators are consumers, not product entry points.
      if (
        name.startsWith("apps/server-python/scripts/compare-") ||
        [
          "scripts/check-server-oracle.mjs",
          "scripts/test-python-control.mjs",
          "scripts/verify-database.mjs",
        ].includes(name)
      )
        continue;
      const content = await readFile(path, "utf8");
      assert(!marker.test(content), `Product must not reference test-only oracle: ${name}`);
      checked++;
    }
  }
  return { files: expected.size, productFilesChecked: checked };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const result = await checkServerOracle(root);
  console.log(
    `Frozen Server oracle: ${result.files} exact files; ${result.productFilesChecked} product files have no oracle dependency.`,
  );
}
