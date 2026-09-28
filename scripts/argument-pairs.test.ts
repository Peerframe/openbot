import assert from "node:assert/strict";
import test from "node:test";
import { parseArgumentPairs } from "./argument-pairs.ts";

const RELEASE_MSG = "Release arguments must be unique --name value pairs.";
const ARCHIVE_MSG = "Archive arguments must be unique --name value pairs.";
const SMOKE_MSG = "Smoke arguments must be unique --name value pairs.";
const MACOS_CANDIDATE_MSG = "macOS candidate arguments must be unique --name value pairs.";
const MACOS_DISTRIBUTION_MSG = "macOS distribution arguments must be unique --name value pairs.";

test("empty arguments yield an empty map", () => {
  const values = parseArgumentPairs([], RELEASE_MSG);
  assert.equal(values.size, 0);
});

test("multiple pairs preserve insertion order", () => {
  const values = parseArgumentPairs(
    ["--arch", "x64", "--out-dir", "/tmp/out", "--version", "1.0.0"],
    RELEASE_MSG,
  );
  assert.deepEqual(
    [...values.entries()],
    [
      ["--arch", "x64"],
      ["--out-dir", "/tmp/out"],
      ["--version", "1.0.0"],
    ],
  );
});

test("empty string values are preserved", () => {
  const values = parseArgumentPairs(["--tag", ""], ARCHIVE_MSG);
  assert.equal(values.get("--tag"), "");
  assert.equal(values.size, 1);
});

test("Unicode, path, single-dash, and equals tokens stay literal", () => {
  const values = parseArgumentPairs(
    [
      "--label",
      "名前-café",
      "--path",
      "/tmp/spaced dir/file",
      "--odd",
      "-single",
      "--kv",
      "name=value",
      "--name=value",
      "kept",
    ],
    SMOKE_MSG,
  );
  assert.equal(values.get("--label"), "名前-café");
  assert.equal(values.get("--path"), "/tmp/spaced dir/file");
  assert.equal(values.get("--odd"), "-single");
  assert.equal(values.get("--kv"), "name=value");
  assert.equal(values.get("--name=value"), "kept");
});

test("missing value throws caller message", () => {
  assert.throws(
    () => parseArgumentPairs(["--arch"], RELEASE_MSG),
    (error: unknown) => error instanceof Error && error.message === RELEASE_MSG,
  );
});

test("key that does not start with -- throws caller message", () => {
  assert.throws(
    () => parseArgumentPairs(["arch", "x64"], ARCHIVE_MSG),
    (error: unknown) => error instanceof Error && error.message === ARCHIVE_MSG,
  );
});

test("value that looks like the next option throws caller message", () => {
  assert.throws(
    () => parseArgumentPairs(["--arch", "--x64"], SMOKE_MSG),
    (error: unknown) => error instanceof Error && error.message === SMOKE_MSG,
  );
});

test("duplicate keys throw caller message", () => {
  assert.throws(
    () => parseArgumentPairs(["--arch", "x64", "--arch", "arm64"], MACOS_CANDIDATE_MSG),
    (error: unknown) => error instanceof Error && error.message === MACOS_CANDIDATE_MSG,
  );
});

test("input array is not mutated and calls are independent", () => {
  const input = Object.freeze(["--a", "1", "--b", "2"]) as readonly string[];
  const first = parseArgumentPairs(input, RELEASE_MSG);
  const second = parseArgumentPairs(input, RELEASE_MSG);
  assert.deepEqual([...input], ["--a", "1", "--b", "2"]);
  assert.notEqual(first, second);
  first.set("--a", "changed");
  assert.equal(second.get("--a"), "1");
  assert.equal(parseArgumentPairs(input, RELEASE_MSG).get("--a"), "1");
});

test("five caller malformed messages are returned verbatim", () => {
  const cases = [
    RELEASE_MSG,
    ARCHIVE_MSG,
    SMOKE_MSG,
    MACOS_CANDIDATE_MSG,
    MACOS_DISTRIBUTION_MSG,
  ] as const;
  for (const message of cases) {
    assert.throws(
      () => parseArgumentPairs(["--only"], message),
      (error: unknown) => error instanceof Error && error.message === message,
    );
  }
});
