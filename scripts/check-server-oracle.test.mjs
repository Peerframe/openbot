import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkServerOracle } from "./check-server-oracle.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "openbot-oracle-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [
    "tests/oracles/legacy-server/src",
    "apps/product/src",
    "packages",
    "providers",
    "deploy",
    "scripts",
  ])
    await mkdir(join(root, path), { recursive: true });
  const base = join(root, "tests/oracles/legacy-server");
  const content = "export const original = true;\n";
  await writeFile(join(base, "src/example.ts"), content);
  const snapshot = {
    version: 1,
    license: "MIT",
    files: [
      {
        path: "src/example.ts",
        origin: "apps/server/src/example.ts",
        bytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
  };
  await writeFile(join(base, "snapshot.json"), JSON.stringify(snapshot));
  const pkg = {
    name: "@openbot/legacy-server-oracle",
    private: true,
    exports: {},
    scripts: { "build:oracle": "tsc -p tsconfig.json" },
    devDependencies: { zod: "4.6.2" },
  };
  await writeFile(join(base, "package.json"), JSON.stringify(pkg));
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      packages: {
        "tests/oracles/legacy-server": { devDependencies: pkg.devDependencies },
        "node_modules/@openbot/legacy-server-oracle": {
          resolved: "tests/oracles/legacy-server",
          link: true,
        },
      },
    }),
  );
  return { root, base, pkg, snapshot };
}

test("accepts a fixed test-only fixture without the old Server directory", async (t) => {
  const { root } = await fixture(t);
  assert.deepEqual(await checkServerOracle(root), { files: 1, productFilesChecked: 0 });
});
for (const mutation of [
  "changed",
  "added",
  "symlink",
  "traversal",
  "duplicate",
  "startup",
  "runtime-dependency",
  "lock-drift",
  "package-exports",
]) {
  test(`refuses ${mutation}`, async (t) => {
    const { root, base, pkg, snapshot } = await fixture(t);
    if (mutation === "changed")
      await writeFile(join(base, "src/example.ts"), "export const original = false;\n");
    if (mutation === "added") await writeFile(join(base, "src/other.ts"), "");
    if (mutation === "symlink") {
      await rm(join(base, "src/example.ts"));
      await symlink("../../../../package-lock.json", join(base, "src/example.ts"));
    }
    if (mutation === "traversal") {
      snapshot.files[0].path = "src/../../../../package-lock.json";
      await writeFile(join(base, "snapshot.json"), JSON.stringify(snapshot));
    }
    if (mutation === "duplicate") {
      snapshot.files.push(snapshot.files[0]);
      await writeFile(join(base, "snapshot.json"), JSON.stringify(snapshot));
    }
    if (mutation === "package-exports") {
      pkg.exports = null;
      await writeFile(join(base, "package.json"), JSON.stringify(pkg));
    }
    if (mutation === "startup") {
      pkg.scripts.start = "node dist/index.js";
      await writeFile(join(base, "package.json"), JSON.stringify(pkg));
    }
    if (mutation === "runtime-dependency")
      await writeFile(
        join(root, "apps/product/src/main.ts"),
        'import "@openbot/legacy-server-oracle";',
      );
    if (mutation === "lock-drift") {
      const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
      lock.packages["tests/oracles/legacy-server"].devDependencies.zod = "0.0.0";
      await writeFile(join(root, "package-lock.json"), JSON.stringify(lock));
    }
    await assert.rejects(() => checkServerOracle(root));
  });
}
