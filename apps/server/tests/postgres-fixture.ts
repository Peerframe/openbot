/** Starts a labeled disposable PostgreSQL and preserves cleanup ownership even on setup failure. */
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDatabase } from "@openbot/db";
import {
  OwnedDockerFixture, allowlistedEnvironment, startControlPostgres,
} from "../../../scripts/acceptance-fixture.ts";

export async function disposableDatabase() {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const fixture = new OwnedDockerFixture(root, allowlistedEnvironment([
    "PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG",
  ]));
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const url = await startControlPostgres(fixture, `openbot-p5-${randomUUID()}`, randomBytes(24).toString("hex"));
    database = createDatabase(url);
    await database.migrate();
    return {
      url, sql: database.client,
      async close() {
        try { await database!.close(); } finally { fixture.cleanup(); }
      },
    };
  } catch (error) {
    try { await database?.close(); } finally { fixture.cleanup(); }
    throw error;
  }
}
