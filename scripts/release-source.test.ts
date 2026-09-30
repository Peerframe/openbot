import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { sha256BoundedRegularFile } from "./node-linux-release.ts";
import {
  assertReleaseVersion,
  assertSourceCommit,
  assertSourceDateEpoch,
  assertSourceTreeState,
  sha256File,
} from "./release-source.ts";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

async function temporaryDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "openbot-release-source-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function patternedBytes(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + 7) & 0xff;
  return bytes;
}

test("preserves bounded release version inputs", () => {
  for (const version of ["1.2.3", "1.2.3-rc.1+build.5", "0.0.0+sha.abc"]) {
    assert.equal(assertReleaseVersion(version), version);
  }
  const longest = `1.2.3-${"a".repeat(58)}`;
  assert.equal(longest.length, 64);
  assert.equal(assertReleaseVersion(longest), longest);
  for (const version of [
    `1.2.3-${"a".repeat(59)}`,
    "latest",
    "1.2",
    "v1.2.3",
    "1.2.3 ",
    1,
    undefined,
    null,
  ]) {
    assert.throws(() => assertReleaseVersion(version), /bounded SemVer/);
  }
});

test("accepts only full lowercase source commits", () => {
  assert.equal(assertSourceCommit(COMMIT), COMMIT);
  for (const commit of [
    COMMIT.toUpperCase(),
    COMMIT.slice(1),
    `${COMMIT}0`,
    ` ${COMMIT}`,
    "g".repeat(40),
    40,
    undefined,
  ]) {
    assert.throws(() => assertSourceCommit(commit), /full lowercase Git SHA-1/);
  }
});

test("accepts bounded integer source date epochs", () => {
  assert.equal(assertSourceDateEpoch(0), 0);
  assert.equal(assertSourceDateEpoch("1"), 1);
  assert.equal(assertSourceDateEpoch(1_700_000_000), 1_700_000_000);
  assert.equal(assertSourceDateEpoch("4102444800"), 4_102_444_800);
  for (const epoch of [
    -1,
    4_102_444_801,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "tomorrow",
    "1e400",
  ]) {
    assert.throws(() => assertSourceDateEpoch(epoch), /integer between 1970 and 2100/);
  }
});

test("requires the reviewed commit at a clean HEAD", () => {
  assert.doesNotThrow(() => assertSourceTreeState(COMMIT, `${COMMIT}\n`, ""));
  assert.doesNotThrow(() => assertSourceTreeState(COMMIT, ` ${COMMIT} `, "\n"));
  assert.throws(() => assertSourceTreeState(COMMIT, `${"b".repeat(40)}\n`, ""), /does not match/);
  assert.throws(
    () => assertSourceTreeState(COMMIT, `${COMMIT}\n`, " M package.json\n"),
    /clean source tree/,
  );
  assert.throws(() => assertSourceTreeState(COMMIT, COMMIT, "?? new.txt\n"), /clean source tree/);
  const upper = COMMIT.toUpperCase();
  assert.throws(() => assertSourceTreeState(upper, upper, ""), /full lowercase/);
});

test("hashes trusted release files exactly", async (context) => {
  const directory = await temporaryDirectory(context);
  const empty = path.join(directory, "empty");
  const abc = path.join(directory, "abc");
  const large = path.join(directory, "large");
  const largeBytes = patternedBytes(3 * 65_536 + 17);
  await writeFile(empty, "");
  await writeFile(abc, "abc");
  await writeFile(large, largeBytes);
  assert.equal(await sha256File(empty), EMPTY_SHA256);
  assert.equal(await sha256File(abc), ABC_SHA256);
  assert.equal(await sha256File(large), createHash("sha256").update(largeBytes).digest("hex"));
  await assert.rejects(sha256File(path.join(directory, "missing")), { code: "ENOENT" });
});

test("trusted and bounded digests agree on reviewed regular files", async (context) => {
  const directory = await temporaryDirectory(context);
  const file = path.join(directory, "archive");
  const bytes = patternedBytes(1024 * 1024 + 3);
  await writeFile(file, bytes);
  const bounds = { minimumBytes: 0, maximumBytes: 2 * 1024 * 1024 };
  const expected = createHash("sha256").update(bytes).digest("hex");
  assert.equal(await sha256BoundedRegularFile(file, bounds), expected);
  assert.equal(await sha256File(file), expected);
  const empty = path.join(directory, "empty");
  await writeFile(empty, "");
  assert.equal(await sha256BoundedRegularFile(empty, bounds), EMPTY_SHA256);
});

test("bounded digest rejects out-of-bound sizes and malformed bounds", async (context) => {
  const directory = await temporaryDirectory(context);
  const file = path.join(directory, "abc");
  await writeFile(file, "abc");
  await assert.rejects(
    sha256BoundedRegularFile(file, { minimumBytes: 4, maximumBytes: 10 }),
    /outside the reviewed bound/,
  );
  await assert.rejects(
    sha256BoundedRegularFile(file, { minimumBytes: 0, maximumBytes: 2 }),
    /outside the reviewed bound/,
  );
  await assert.rejects(sha256BoundedRegularFile(file), /outside the reviewed bound/);
  for (const bounds of [
    { minimumBytes: 5, maximumBytes: 4 },
    { minimumBytes: -1, maximumBytes: 4 },
    { minimumBytes: 0, maximumBytes: 1.5 },
    { minimumBytes: Number.NaN, maximumBytes: 4 },
  ]) {
    await assert.rejects(sha256BoundedRegularFile(file, bounds), /bounds are malformed/);
  }
});
