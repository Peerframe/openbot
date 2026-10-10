/** The fixture CLI refuses mutable image selection before touching Docker or any output. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { egressArguments } from "./qualify-egress.ts";
const digest = "sha256:" + "a".repeat(64);
test("only a fixed local image ID and fresh output argument are accepted", () => {
  assert.deepEqual(egressArguments(["--fixture-image", digest, "--output", "/tmp/owned"]), {
    image: digest,
    output: "/tmp/owned",
  });
  for (const argv of [
    [],
    ["--fixture-image", "latest", "--output", "/tmp/owned"],
    ["--fixture-image", digest, "--output", ""],
    ["--fixture-image", digest, "--output", "/tmp/owned", "--privileged"],
    ["--output", "/tmp/owned", "--fixture-image", digest],
  ])
    assert.throws(() => egressArguments(argv));
});
