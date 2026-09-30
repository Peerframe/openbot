import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  FIXTURE_DATABASE,
  FIXTURE_PASSWORD,
  FIXTURE_TOKEN,
  redactFixtureOutput,
} from "./output-redaction.ts";

test("every occurrence of each owned secret is replaced by its exact label", () => {
  const password = randomBytes(24).toString("hex");
  const token = randomBytes(32).toString("base64url");
  const output = `dsn uses ${password}\ncookie=${token}; again ${token}\n${password}`;
  const redacted = redactFixtureOutput(output, [
    [password, FIXTURE_PASSWORD],
    [token, FIXTURE_TOKEN],
  ]);
  assert.equal(
    redacted,
    "dsn uses [fixture password]\ncookie=[fixture token]; again [fixture token]\n[fixture password]",
  );
  assert(!redacted.includes(password) && !redacted.includes(token));
  assert.deepEqual(
    [FIXTURE_PASSWORD, FIXTURE_TOKEN, FIXTURE_DATABASE],
    ["[fixture password]", "[fixture token]", "[fixture database]"],
  );
});

test("replacement follows the caller's order", () => {
  const password = randomBytes(12).toString("hex");
  const databaseUrl = `postgres://127.0.0.1:5545/${password}_dev_smoke`;
  const output = `failed ${databaseUrl}`;
  assert.equal(
    redactFixtureOutput(output, [
      [databaseUrl, FIXTURE_DATABASE],
      [password, FIXTURE_PASSWORD],
    ]),
    "failed [fixture database]",
  );
  assert.equal(
    redactFixtureOutput(output, [
      [password, FIXTURE_PASSWORD],
      [databaseUrl, FIXTURE_DATABASE],
    ]),
    "failed postgres://127.0.0.1:5545/[fixture password]_dev_smoke",
  );
});

test("an empty or missing secret is refused instead of corrupting or masking output", () => {
  assert.throws(() => redactFixtureOutput("abc", [["", FIXTURE_TOKEN]]), {
    message: "Refusing to redact an empty fixture secret.",
  });
  // An untyped JavaScript caller could pass an unset token; `replaceAll(undefined)` would
  // silently replace the text "undefined" and leave the real value unchecked.
  assert.throws(
    () =>
      Reflect.apply(redactFixtureOutput, undefined, ["undefined", [[undefined, FIXTURE_TOKEN]]]),
    { message: "Refusing to redact an empty fixture secret." },
  );
  assert.equal(redactFixtureOutput("unchanged", []), "unchanged");
});
