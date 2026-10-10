/** Retains both-store/no-mutation and credential-file refusal gates after removing the Python operator. */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { maintain, readEnvironment, type EngineDatabase, type MaintenanceCommand } from "../deploy/temporal/maintain.ts";
function refusal(mode: "initialize" | "upgrade", rows: Partial<Record<EngineDatabase, string>>, state = "") {
  let mutations = 0;
  const command: MaintenanceCommand = (args) => { if (args[0] !== "ps") mutations++; return state; };
  assert.throws(() => maintain(mode, command, (database, statement) => { assert(statement.startsWith("SELECT ")); return rows[database]!; }));
  assert.equal(mutations, 0);
}
test("validates both schemas and stopped engine before the first write", () => {
  refusal("initialize", { temporal: "0", temporal_visibility: "1" });
  refusal("upgrade", { temporal: "1.18", temporal_visibility: "999.0" });
  for (const state of ["running", "paused", "restarting", "removing", "unknown"]) refusal("upgrade", {}, state);
  for (const value of ["", "1.19\n1.19", "NaN", "-1.0", "01.19", "1.19.1", "1.19;DROP TABLE t"])
    refusal("upgrade", { temporal: value });
});
test("verified schemas seal runtime metadata writes", () => {
  const mutations: string[] = [];
  maintain("upgrade", (args) => { if (args[0] !== "ps") mutations.push(args.join(" ")); return ""; }, (db, sql) => {
    if (!sql.startsWith("SELECT ")) mutations.push(sql);
    return db === "temporal" ? "1.19" : "1.14";
  });
  assert.equal(mutations.length, 3);
  assert.match(mutations[0]!, /schema upgrade$/);
  assert(mutations.slice(1).every((sql) => sql.startsWith("REVOKE ")));
});
test("private environment refuses shell/Compose expansion, duplicate keys and linked TLS material", () => {
  const directory = mkdtempSync(join(tmpdir(), "openbot-maintenance-")), path = join(directory, "engine.env");
  const good = `OPENBOT_TEMPORAL_SCHEMA_PASSWORD=${"a".repeat(48)}\nOPENBOT_TEMPORAL_RUNTIME_PASSWORD=${"b".repeat(48)}\n`;
  try {
    writeFileSync(path, good, { mode: 0o600 });
    assert.equal(readEnvironment(path).OPENBOT_TEMPORAL_PORT, "7233");
    for (const bad of [good + "COMPOSE_FILE=other.yaml", good + "OPENBOT_TEMPORAL_PORT=80", good + "OPENBOT_TEMPORAL_PORT=65536", good + "OPENBOT_TEMPORAL_PORT=${PORT}", good + "OPENBOT_TEMPORAL_RUNTIME_PASSWORD=" + "c".repeat(48), good.replace("b".repeat(48), "a".repeat(48)), good.replace("b".repeat(48), "$(ignored)")]) {
      writeFileSync(path, bad); assert.throws(() => readEnvironment(path));
    }
    writeFileSync(path, good); chmodSync(path, 0o644); assert.throws(() => readEnvironment(path)); chmodSync(path, 0o600);
    const linked = join(directory, "linked.env"); symlinkSync(path, linked); assert.throws(() => readEnvironment(linked));
    const link = join(directory, "linked-directory"); symlinkSync(directory, link);
    for (const target of [link, path, join(directory, "missing"), "relative"]) {
      writeFileSync(path, good + "OPENBOT_TEMPORAL_TLS_DIRECTORY=" + target); assert.throws(() => readEnvironment(path));
    }
    writeFileSync(path, good + "OPENBOT_TEMPORAL_TLS_DIRECTORY=" + directory);
    assert.equal(readEnvironment(path).OPENBOT_TEMPORAL_TLS_DIRECTORY, directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
