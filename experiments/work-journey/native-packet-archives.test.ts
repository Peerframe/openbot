/** Real archive bytes qualify the root packet reader without extraction or a privileged runner. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { Header } from "tar";
import { ociIdentity, pinnedNativeMembers } from "./native-packet-archives.ts";

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
type Entry = { name: string; bytes: Buffer; type?: "File" | "SymbolicLink"; size?: number };
function archive(entries: Entry[]) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = new Header({
      path: entry.name,
      type: entry.type ?? "File",
      size: entry.size ?? entry.bytes.length,
      mode: 0o600,
      uid: 0,
      gid: 0,
      ...(entry.type === "SymbolicLink" ? { linkpath: "/outside" } : {}),
    });
    header.encode();
    assert(header.block);
    chunks.push(header.block, entry.bytes, Buffer.alloc((512 - (entry.bytes.length % 512)) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
async function fixture(t: TestContext, bytes: Buffer) {
  const root = await mkdtemp(join(tmpdir(), "openbot-packet-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "input");
  await writeFile(path, bytes, { mode: 0o600 });
  return { path, pin: { size: bytes.length, sha256: hash(bytes) } };
}
const binary = Buffer.from("synthetic reviewed native binary\n"),
  expected = { runsc: hash(binary) };
const binaryTar = () => archive([{ name: "bin/runsc", bytes: binary }]);
for (const compression of ["gzip", "bzip2"] as const) {
  function compress(input: Buffer) {
    if (compression === "gzip") return gzipSync(input);
    const result = spawnSync("/usr/bin/bzip2", ["--compress", "--stdout"], {
      input,
      env: { LANG: "C", LC_ALL: "C" },
      timeout: 5000,
    });
    assert.equal(result.status, 0);
    return result.stdout;
  }
  test(`${compression}: exact download and member hashes return bytes without extraction`, async (t) => {
    if (compression === "bzip2" && process.platform === "win32") {
      t.skip("Reviewed bzip2 CI tool is Unix-only");
      return;
    }
    const { path, pin } = await fixture(t, compress(binaryTar()));
    const result = await pinnedNativeMembers(path, pin, expected, "bin/", compression);
    assert.deepEqual([...result], [["runsc", binary]]);
  });
  test(`${compression}: a valid selected member cannot hide a corrupt compression trailer`, async (t) => {
    if (compression === "bzip2" && process.platform === "win32") {
      t.skip("Reviewed bzip2 CI tool is Unix-only");
      return;
    }
    const bytes = compress(binaryTar());
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
    const { path, pin } = await fixture(t, bytes);
    await assert.rejects(pinnedNativeMembers(path, pin, expected, "bin/", compression));
  });
  test(`${compression}: nested compressed input fails before parser decompression`, async (t) => {
    if (compression === "bzip2" && process.platform === "win32") {
      t.skip("Reviewed bzip2 CI tool is Unix-only");
      return;
    }
    const { path, pin } = await fixture(t, compress(gzipSync(binaryTar())));
    await assert.rejects(
      pinnedNativeMembers(path, pin, expected, "bin/", compression),
      /Nested native archive compression refused/,
    );
  });
}

test("download size, download hash and selected binary hash fail independently", async (t) => {
  const { path, pin } = await fixture(t, gzipSync(binaryTar()));
  await assert.rejects(
    pinnedNativeMembers(path, { ...pin, size: pin.size + 1 }, expected, "bin/", "gzip"),
    /download size/,
  );
  await assert.rejects(
    pinnedNativeMembers(path, { ...pin, sha256: "0".repeat(64) }, expected, "bin/", "gzip"),
    /download pin/,
  );
  await assert.rejects(
    pinnedNativeMembers(path, pin, { runsc: "0".repeat(64) }, "bin/", "gzip"),
    /binary pin/,
  );
});
for (const [name, entries, pattern] of [
  [
    "duplicate",
    [
      { name: "bin/runsc", bytes: binary },
      { name: "bin/runsc", bytes: binary },
    ],
    /Duplicate/,
  ],
  ["link", [{ name: "bin/runsc", bytes: Buffer.alloc(0), type: "SymbolicLink" }], /member type/],
  ["missing", [{ name: "other", bytes: binary }], /Required native binary missing/],
  [
    "oversized",
    [{ name: "bin/runsc", bytes: binary, size: 120 * 1024 * 1024 + 1 }],
    /member type\/size/,
  ],
  [
    "member count",
    Array.from({ length: 2049 }, (_, i) => ({ name: `other-${i}`, bytes: binary })),
    /member count/,
  ],
] satisfies [string, Entry[], RegExp][]) {
  test(`selected native member rejects ${name}`, async (t) => {
    const { path, pin } = await fixture(t, gzipSync(archive(entries)));
    await assert.rejects(pinnedNativeMembers(path, pin, expected, "bin/", "gzip"), pattern);
  });
}
test("symlinks and cancellation are refused before decoding", async (t) => {
  const { path, pin } = await fixture(t, gzipSync(binaryTar()));
  await symlink(path, path + "-link");
  await assert.rejects(pinnedNativeMembers(path + "-link", pin, expected, "bin/", "gzip"), /ELOOP/);
  await assert.rejects(
    pinnedNativeMembers(path, pin, expected, "bin/", "bzip2", AbortSignal.abort()),
    /abort/i,
  );
});
function image(architecture = "amd64", os = "linux") {
  const config = Buffer.from(
    JSON.stringify({ architecture, os, rootfs: { diff_ids: ["sha256:" + "d".repeat(64)] } }),
  );
  const cp = { digest: "sha256:" + hash(config), size: config.length };
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config: cp, layers: [] }));
  const mp = { digest: "sha256:" + hash(manifest), size: manifest.length };
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [mp] }));
  const entries: Entry[] = [
    { name: "index.json", bytes: index },
    { name: "blobs/sha256/" + hash(manifest), bytes: manifest },
    { name: "blobs/sha256/" + hash(config), bytes: config },
  ];
  return { entries, cp, mp };
}
test("OCI identity verifies referenced metadata and skips large layers", async (t) => {
  const { entries, cp, mp } = image();
  entries.push({ name: "blobs/sha256/" + "e".repeat(64), bytes: Buffer.alloc(1024 * 1024) });
  const { path } = await fixture(t, archive(entries));
  assert.deepEqual(await ociIdentity(path, cp.digest, mp.digest), {
    manifest: mp.digest,
    config: cp.digest,
    diffIds: ["sha256:" + "d".repeat(64)],
  });
  await assert.rejects(
    ociIdentity(path, cp.digest, "sha256:" + "0".repeat(64)),
    /manifest changed/,
  );
  await assert.rejects(ociIdentity(path, "sha256:" + "0".repeat(64), mp.digest), /content changed/);
});
for (const [name, change] of [
  [
    "config bytes",
    (v) => {
      v.entries[2]!.bytes = Buffer.from("changed");
    },
  ],
  [
    "manifest bytes",
    (v) => {
      v.entries[1]!.bytes = Buffer.from("changed");
    },
  ],
  [
    "missing config",
    (v) => {
      v.entries.pop();
    },
  ],
  [
    "multiple manifests",
    (v) => {
      v.entries[0]!.bytes = Buffer.from(JSON.stringify({ manifests: [v.mp, v.mp] }));
    },
  ],
  [
    "duplicate index",
    (v) => {
      v.entries.push(v.entries[0]!);
    },
  ],
  [
    "linked metadata",
    (v) => {
      v.entries[2]!.type = "SymbolicLink";
      v.entries[2]!.bytes = Buffer.alloc(0);
    },
  ],
  [
    "oversized referenced metadata",
    (v) => {
      v.entries[0]!.bytes = Buffer.from(
        JSON.stringify({ manifests: [{ ...v.mp, size: 256 * 1024 + 1 }] }),
      );
    },
  ],
  [
    "wrong architecture",
    (v) => {
      Object.assign(v, image("arm64"));
    },
  ],
  [
    "wrong OS",
    (v) => {
      Object.assign(v, image("amd64", "windows"));
    },
  ],
] satisfies [string, (v: ReturnType<typeof image>) => void][]) {
  test(`OCI refuses ${name}`, async (t) => {
    const value = image();
    change(value);
    const { path } = await fixture(t, archive(value.entries));
    await assert.rejects(ociIdentity(path, value.cp.digest, value.mp.digest));
  });
}
