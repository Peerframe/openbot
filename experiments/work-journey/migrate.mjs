// Apply the existing migrator only to the parent-owned disposable reference database.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDatabase } from "../../packages/db/dist/index.js";
const cfg = JSON.parse(await readFile(process.argv[2], "utf8"));
const url = new URL(cfg.dsn);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.pathname, "/openbot_probe");
const db = createDatabase(cfg.dsn);
try {
  await db.migrate();
} finally {
  await db.close();
}
