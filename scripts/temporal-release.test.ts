/** Preserves the retired archive probe's real gzip/tar bounds, type safety and cleanup cases. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  stat,
  rm,
  mkdir,
  writeFile,
  symlink,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  extractPinnedTemporal,
  extractPreviousTemporal,
  type TemporalReleasePin,
} from "./temporal-release.ts";
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const contents = {
  "temporal-server": Buffer.from("fixture-server"),
  "temporal-sql-tool": Buffer.from("fixture-sql-tool"),
};
type Member = { name: string; data?: Buffer; type?: string; link?: string };
const regular = (): Member[] => Object.entries(contents).map(([name, data]) => ({ name, data }));
function archiveBytes(entries: Member[]) {
  const blocks: Buffer[] = [];
  for (const item of entries) {
    const data = item.data ?? Buffer.alloc(0),
      header = Buffer.alloc(512);
    header.write(item.name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write(item.type ?? "0", 156);
    header.write(item.link ?? "", 157, 100);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write(
      header
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
      148,
    );
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
async function fixture(t: { after: (f: () => Promise<void>) => void }, entries = regular()) {
  const root = await mkdtemp(join(tmpdir(), "openbot-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = join(root, "release.tar.gz"),
    destination = join(root, "binaries");
  const bytes = archiveBytes(entries);
  await writeFile(archive, bytes);
  const pin: TemporalReleasePin = {
    size: bytes.length,
    sha256: sha(bytes),
    members: Object.fromEntries(
      Object.entries(contents).map(([name, data]) => [
        name,
        { size: data.length, sha256: sha(data) },
      ]),
    ),
  };
  const extract = (bounds?: { expandedBytes: number; members: number }) =>
    extractPinnedTemporal(archive, destination, pin, AbortSignal.timeout(5000), bounds);
  const rejected = async (pattern: RegExp, bounds?: { expandedBytes: number; members: number }) => {
    await assert.rejects(extract(bounds), pattern);
    await assert.rejects(stat(destination), { code: "ENOENT" });
  };
  return { root, archive, destination, bytes, pin, extract, rejected };
}
test("only exact binaries are written with private/executable modes; ignored paths have no effects", async (t) => {
  const f = await fixture(t, [
    ...regular(),
    { name: "../outside", data: Buffer.from("ignored") },
    { name: "config/development.yaml", type: "2", link: "../../outside" },
  ]);
  const paths = await f.extract();
  assert.deepEqual((await readdir(f.destination)).sort(), Object.keys(contents).sort());
  await assert.rejects(stat(join(f.root, "outside")), { code: "ENOENT" });
  assert.equal((await stat(f.destination)).mode & 0o777, 0o700);
  for (const [name, data] of Object.entries(contents)) {
    assert.equal(paths[name], join(f.destination, name));
    assert.deepEqual(await readFile(paths[name]!), data);
    assert.equal((await stat(paths[name]!)).mode & 0o777, 0o555);
  }
});
for (const kind of ["archive hash", "archive size", "member hash", "member size"])
  test("rejects " + kind + " and removes partial output", async (t) => {
    const f = await fixture(t);
    if (kind === "archive hash") f.pin.sha256 = "0".repeat(64);
    if (kind === "archive size") f.pin.size++;
    if (kind === "member hash") f.pin.members["temporal-sql-tool"]!.sha256 = "0".repeat(64);
    if (kind === "member size") f.pin.members["temporal-sql-tool"]!.size++;
    await f.rejected(/differs from its pin/);
  });
for (const type of ["1", "2", "5"])
  test("rejects binary member type " + type, async (t) => {
    const f = await fixture(t, [
      regular()[0]!,
      { name: "temporal-sql-tool", type, link: type === "5" ? "" : "temporal-server" },
    ]);
    await f.rejected(/regular Temporal/);
  });
for (const name of ["temporal-server", "config/extra"])
  test("rejects duplicate member " + name, async (t) => {
    const extra =
      name === "temporal-server" ? regular()[0]! : { name, data: Buffer.from("ignored") };
    const f = await fixture(
      t,
      name === "temporal-server" ? [...regular(), extra] : [...regular(), extra, extra],
    );
    await f.rejected(/Duplicate/);
  });
test("an alias cannot supply an exact missing member", async (t) => {
  const entries = regular();
  entries[1]!.name = "./temporal-sql-tool";
  await (await fixture(t, entries)).rejected(/missing/);
});
test("an existing destination is preserved", async (t) => {
  const f = await fixture(t);
  await mkdir(f.destination);
  await writeFile(join(f.destination, "keep"), "existing");
  await assert.rejects(f.extract(), { code: "EEXIST" });
  assert.equal(await readFile(join(f.destination, "keep"), "utf8"), "existing");
});
test("symlink destination and input are refused", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "untouched");
  await symlink(target, f.destination);
  await assert.rejects(f.extract(), { code: "EEXIST" });
  await assert.rejects(stat(target), { code: "ENOENT" });
  await rm(f.destination);
  await rename(f.archive, f.archive + ".original");
  await symlink(f.archive + ".original", f.archive);
  await assert.rejects(f.extract(), { code: "ELOOP" });
  await assert.rejects(stat(f.destination), { code: "ENOENT" });
});
test("expanded limit includes ignored content", async (t) => {
  const f = await fixture(t, [
    ...regular(),
    ...[1, 2, 3].map((n) => ({ name: "ignored-" + n, data: Buffer.alloc(12000) })),
  ]);
  await f.rejected(/expanded byte bound/, { expandedBytes: 16384, members: 128 });
});
test("member count limit removes partial output", async (t) => {
  const f = await fixture(t, [...regular(), { name: "extra", data: Buffer.from("x") }]);
  await f.rejected(/member bound/, { expandedBytes: 65536, members: 2 });
});
test("gzip trailer is verified after tar end", async (t) => {
  const f = await fixture(t);
  const bytes = f.bytes.subarray(0, -5);
  await writeFile(f.archive, bytes);
  f.pin.size = bytes.length;
  f.pin.sha256 = sha(bytes);
  await f.rejected(/unexpected end/);
});
test("unreviewed architecture is rejected before any output", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    extractPreviousTemporal(f.archive, "other", f.destination, AbortSignal.timeout(5000)),
    /architecture/,
  );
  await assert.rejects(stat(f.destination), { code: "ENOENT" });
});
