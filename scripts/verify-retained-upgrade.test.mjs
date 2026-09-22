import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import {
  fixtureFolder,
  loadUpgradeFixture,
  validateFixture,
  validateUpgradeTarget,
} from "./verify-retained-upgrade.mjs";

test("requires a dedicated loopback database and never silently skips", () => {
  assert.match(
    validateUpgradeTarget("postgres://fixture@127.0.0.1/openbot_upgrade_test_ci"),
    /openbot_upgrade_test_ci/,
  );
  for (const value of [
    undefined,
    "",
    "postgres://private:secret@db.example.com/openbot_upgrade_test_ci",
    "postgres://x@127.0.0.1/openbot",
    "postgres://x@127.0.0.1/openbot_upgrade_test_ci?host=remote",
    "postgres://x@127.0.0.1/openbot_upgrade_test_ci#fragment",
  ]) {
    assert.throws(
      () => validateUpgradeTarget(value),
      (error) => /No suite is skipped/.test(error.message) && !error.message.includes("secret"),
    );
  }
});

test("repository fixture pins historical SQL, timestamp, and seed identity", async () => {
  const fixture = await loadUpgradeFixture();
  assert.equal(fixture.manifest.through, "0018_automations");
  assert.equal(fixture.manifest.migrations.length, 19);
  const check = (
    manifest = fixture.manifest,
    journal = fixture.journal,
    sources = fixture.sources,
    seed = fixture.seed,
  ) => validateFixture(manifest, journal, sources, seed);
  check();
  const alteredJournal = structuredClone(fixture.journal);
  alteredJournal.entries[2].when++;
  assert.throws(() => check(fixture.manifest, alteredJournal), /timestamp drift/);
  const alteredSources = [...fixture.sources];
  alteredSources[3] += "\n-- historical rewrite";
  assert.throws(
    () => check(fixture.manifest, fixture.journal, alteredSources),
    /Historical SQL changed/,
  );
  assert.throws(
    () => check(fixture.manifest, fixture.journal, fixture.sources, `${fixture.seed}\n`),
    /seed digest changed/,
  );
  const alteredEndpoint = structuredClone(fixture.manifest);
  alteredEndpoint.through = "missing";
  assert.throws(() => check(alteredEndpoint), /endpoint differs/);
  const complete = structuredClone(fixture.manifest);
  complete.migrations = fixture.journal.entries.map((entry) => ({
    ...entry,
    sha256: createHash("sha256").update("").digest("hex"),
  }));
  assert.throws(() => check(complete), /historical prefix with pending migrations/);
});

test("a missing requested fixture is an explicit failure before connection", async () => {
  await assert.rejects(
    loadUpgradeFixture(join(fixtureFolder, "missing")),
    /No database was opened/,
  );
});
