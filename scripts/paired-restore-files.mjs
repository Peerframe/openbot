import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const maxBytes = 16 * 1024 * 1024;
const maxFiles = 128;
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Test-only bounded copies of quiescent, synthetic files; never an arbitrary archive extractor. */
async function inventory(root, visit = async () => {}) {
  const files = [];
  let total = 0;
  let entries = 0;
  async function walk(relative = "") {
    const directory = join(root, relative);
    const info = await lstat(directory);
    assert(info.isDirectory() && !info.isSymbolicLink(), "Fixture directory must not be a link.");
    assert(relative.split("/").length <= 8, "Fixture tree exceeds the depth bound.");
    const names = (await readdir(directory)).sort();
    entries += names.length;
    assert(entries <= 256, "Fixture tree exceeds the entry bound.");
    for (const name of names) {
      assert(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name), "Unexpected fixture filename.");
      const path = relative ? `${relative}/${name}` : name;
      const entry = await lstat(join(root, path));
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      assert(entry.isFile() && entry.nlink === 1, "Fixture files must be regular and unlinked.");
      assert(
        files.length < maxFiles && entry.size <= maxBytes - total,
        "Fixture files exceed bounds.",
      );
      const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes;
      try {
        const opened = await handle.stat();
        assert(
          opened.ino === entry.ino && opened.dev === entry.dev && opened.size === entry.size,
          "Fixture file changed during inspection.",
        );
        const buffer = Buffer.alloc(entry.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        assert.equal(offset, entry.size, "Fixture file changed during reading.");
        bytes = buffer.subarray(0, offset);
      } finally {
        await handle.close();
      }
      total += bytes.length;
      files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
      await visit(path, bytes);
    }
  }
  await walk();
  return files;
}

export async function captureFixtureFiles(source, destination) {
  await mkdir(destination, { mode: 0o700 });
  const files = await inventory(source, async (path, bytes) => {
    await mkdir(dirname(join(destination, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(destination, path), bytes, { flag: "wx", mode: 0o600 });
  });
  await verifyFixtureFiles(destination, files);
  return files;
}

export async function verifyFixtureFiles(directory, expected) {
  assert(
    Array.isArray(expected) && expected.length > 0 && expected.length <= maxFiles,
    "Invalid fixture inventory.",
  );
  assert.deepEqual(
    await inventory(directory),
    expected,
    "Paired fixture files are missing, unexpected or changed.",
  );
}

export async function restoreFixtureFiles(source, destination, expected) {
  await verifyFixtureFiles(source, expected);
  const files = await captureFixtureFiles(source, destination);
  assert.deepEqual(files, expected, "Fixture files changed while restoring.");
}
