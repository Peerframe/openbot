import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  captureFixtureFiles,
  restoreFixtureFiles,
  verifyFixtureFiles,
} from "./paired-restore-files.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "openbot-paired-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(join(source, "model"), { recursive: true, mode: 0o700 });
  await writeFile(join(source, "model", "settings.json"), "synthetic ciphertext", { mode: 0o600 });
  return { root, source, backup: join(root, "backup"), target: join(root, "target") };
}

test("copies paired bytes into new private paths and refuses an existing destination", async (t) => {
  const { source, backup, target } = await fixture(t);
  const files = await captureFixtureFiles(source, backup);
  await restoreFixtureFiles(backup, target, files);
  assert.equal(
    await readFile(join(target, "model", "settings.json"), "utf8"),
    "synthetic ciphertext",
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(target)).mode & 0o077, 0);
    assert.equal((await stat(join(target, "model", "settings.json"))).mode & 0o077, 0);
  }
  await assert.rejects(restoreFixtureFiles(backup, target, files), { code: "EEXIST" });
});

test("missing, extra and same-size modified files fail before any destination is created", async (t) => {
  const { source, backup, target } = await fixture(t);
  const files = await captureFixtureFiles(source, backup);
  const path = join(backup, "model", "settings.json");
  await writeFile(path, "Synthetic ciphertext");
  await assert.rejects(restoreFixtureFiles(backup, target, files));
  await assert.rejects(stat(target), { code: "ENOENT" });
  await writeFile(path, "synthetic ciphertext");
  await writeFile(join(backup, "extra"), "extra");
  await assert.rejects(verifyFixtureFiles(backup, files));
  await rm(join(backup, "extra"));
  await rm(path);
  await assert.rejects(verifyFixtureFiles(backup, files));
});

test("symbolic and hard links cannot enter the fixture copy", async (t) => {
  const { root, source, backup } = await fixture(t);
  const outside = join(root, "outside");
  await writeFile(outside, "outside fixture");
  await symlink(outside, join(source, "linked"));
  await assert.rejects(captureFixtureFiles(source, backup), /regular and unlinked/);
  await rm(backup, { recursive: true });
  await rm(join(source, "linked"));
  await link(outside, join(source, "hardlinked"));
  await assert.rejects(captureFixtureFiles(source, backup), /regular and unlinked/);
  assert.equal(await readFile(outside, "utf8"), "outside fixture");
});

test("oversized files and excessive directory depth are refused", async (t) => {
  const { source, backup } = await fixture(t);
  await writeFile(join(source, "large"), Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(captureFixtureFiles(source, backup), /exceed bounds/);
  await rm(backup, { recursive: true });
  await rm(join(source, "large"));
  await mkdir(join(source, ...Array(9).fill("deep")), { recursive: true });
  await assert.rejects(captureFixtureFiles(source, backup), /depth bound/);
});

test("empty directories also consume the total inventory bound", async (t) => {
  const { source, backup } = await fixture(t);
  for (const parent of ["first", "second", "third"]) {
    for (let index = 0; index < 100; index++) {
      await mkdir(join(source, parent, `empty-${index}`), { recursive: true });
    }
  }
  await assert.rejects(captureFixtureFiles(source, backup), /entry bound/);
});
