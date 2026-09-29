// Apply the existing migrator only to the parent-owned disposable reference database.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDatabase } from "../../packages/db/dist/index.js";

/** Private 0600 fixture written by the parent probe; it carries only the reference DSN. */
interface MigrationFixture {
  readonly dsn: string;
}

function parseFixture(value: unknown): MigrationFixture {
  assert(value !== null && typeof value === "object", "Migration fixture must be a JSON object");
  const dsn: unknown = Reflect.get(value, "dsn");
  assert(typeof dsn === "string", "Migration fixture must provide a DSN string");
  return { dsn };
}

/** Refuse anything but the parent's loopback probe database before opening a connection. */
function assertReferenceDatabase(dsn: string): void {
  const url = new URL(dsn);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/openbot_probe");
}

const fixturePath = process.argv[2];
assert(fixturePath, "Usage: migrate.ts <fixture.json>");
const { dsn } = parseFixture(JSON.parse(await readFile(fixturePath, "utf8")));
assertReferenceDatabase(dsn);
const db = createDatabase(dsn);
try {
  await db.migrate();
} finally {
  await db.close();
}
