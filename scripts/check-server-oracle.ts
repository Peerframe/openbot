import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = { readonly [key: string]: unknown };

export interface ServerOracleResult {
  readonly files: number;
  readonly productFilesChecked: number;
}

const oraclePath = "tests/oracles/legacy-server";
const oracleName = "@openbot/legacy-server-oracle";
const excluded = new Set([
  "node_modules",
  "dist",
  ".git",
  ".turbo",
  ".venv",
  ".worker-venv",
  ".build-venv",
  ".quality-venv",
  "__pycache__",
  "__fixtures__",
  "fixtures",
  "tests",
  "out",
  "native-runtime",
]);
const marker = /(?:tests[\\/]oracles[\\/]legacy-server|@openbot\/legacy-server-oracle)/;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

async function readJsonObject(path: string, message: string): Promise<JsonObject> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  assert(isJsonObject(value), message);
  return value;
}

async function files(
  directory: string,
  ignore: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignore.has(entry.name)) continue;
    const path = join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Unexpected source symlink: ${path}`);
    if (entry.isDirectory()) found.push(...(await files(path, ignore)));
    else if (entry.isFile()) found.push(path);
  }
  return found.sort();
}

export async function checkServerOracle(root: string): Promise<ServerOracleResult> {
  const base = join(root, oraclePath);
  const snapshot = await readJsonObject(join(base, "snapshot.json"), "Invalid oracle snapshot");
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.license, "MIT");
  const entries = snapshot.files;
  assert(isList(entries) && entries.length > 0);
  const expected = new Set<string>();
  for (const entry of entries) {
    assert(isJsonObject(entry), "Invalid oracle path");
    const name = entry.path;
    assert(
      typeof name === "string" &&
        /^src\/(?:[a-z0-9_-]+\.ts|__fixtures__\/attachments\/[a-zA-Z0-9_.-]+)$/.test(name),
      "Invalid oracle path",
    );
    assert.equal(entry.origin, `apps/server/${name}`);
    assert(!expected.has(name), "Duplicate oracle path");
    expected.add(name);
    const path = join(base, name);
    assert((await lstat(path)).isFile(), "Oracle must be a regular file");
    const data = await readFile(path);
    assert.equal(data.length, entry.bytes, `Oracle length changed: ${name}`);
    assert.equal(
      createHash("sha256").update(data).digest("hex"),
      entry.sha256,
      `Oracle hash changed: ${name}`,
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
  const pkg = await readJsonObject(join(base, "package.json"), "Invalid oracle package");
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
  const lock = await readJsonObject(join(root, "package-lock.json"), "Invalid package lock");
  const packages = lock.packages;
  assert(isJsonObject(packages), "Invalid package lock");
  const oracleLock = packages[oraclePath];
  assert(isJsonObject(oracleLock), "Invalid package lock");
  assert.deepEqual(oracleLock.devDependencies, pkg.devDependencies);
  assert.deepEqual(packages[`node_modules/${oracleName}`], {
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
          "scripts/check-server-oracle.ts",
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
