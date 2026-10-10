/** Negative fixtures prevent retired authority paths and independent SQL pools from returning. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { architectureViolations, checkServerArchitecture } from "./check-server-architecture.ts";
test("rejects static and dynamic retired imports, including aliases", () => {
  for (const source of ['import adapter from "@fastify/reply-from";', 'const old = await import("./runtime-port.js");', 'const old = require("../../server-python/run.js");'])
    assert.deepEqual(architectureViolations("app.ts", source), ["Retired runtime import"]);
  assert.deepEqual(architectureViolations("config.ts", 'const old = "OPENBOT_TS_PYTHON_ORIGIN";'), []);
});
test("permits SQL types but confines actual client creation to the shared pool", () => {
  const source = 'import client from "postgres"; const db = client(url);';
  assert.deepEqual(architectureViolations("product-http.ts", source), ["SQL connections must use the shared pool"]);
  assert.deepEqual(architectureViolations("database-pool.ts", source), []);
  assert.deepEqual(architectureViolations("owner-session.ts", 'import type client from "postgres";'), []);
});
test("keeps stable lock namespaces centralized without interpreting comments as SQL", () => {
  assert.deepEqual(architectureViolations("work-tree.ts", 'await db`SELECT pg_advisory_xact_lock(hashtextextended(${id},731))`;'), ["Advisory gates must use a named namespace"]);
  assert.deepEqual(architectureViolations("work-tree.ts", 'await db`SELECT pg_advisory_xact_lock(hashtextextended(${id},${LOCK_NAMESPACE.taskSource}))`;'), []);
  assert.deepEqual(architectureViolations("notes.ts", '// pg_advisory_lock is documented here'), []);
});
test("current production modules obey the sole Server boundary", async () => {
  assert.deepEqual(await checkServerArchitecture(fileURLToPath(new URL("../", import.meta.url))), []);
});
