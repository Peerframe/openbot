/** Performs explicit stopped-engine schema maintenance with the pinned upstream tools and two-store preflight. */
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const TARGETS = { temporal: "1.19", temporal_visibility: "1.14" } as const;
export type EngineDatabase = keyof typeof TARGETS;
const passwordKeys = ["OPENBOT_TEMPORAL_SCHEMA_PASSWORD", "OPENBOT_TEMPORAL_RUNTIME_PASSWORD"] as const;
const directory = dirname(fileURLToPath(import.meta.url));
export function readEnvironment(path: string): Record<string, string> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let source: string;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid?.() || info.size > 4096)
      throw new Error("Environment must be an owned private regular file of at most 4096 bytes.");
    source = readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
  const values: Record<string, string> = Object.create(null);
  const keys: readonly string[] = [...passwordKeys, "OPENBOT_TEMPORAL_PORT", "OPENBOT_TEMPORAL_TLS_DIRECTORY"];
  for (const line of source.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("="), key = line.slice(0, at), value = line.slice(at + 1);
    if (at < 0 || key in values || !keys.includes(key))
      throw new Error("Unknown, duplicate or malformed profile environment setting.");
    values[key] = value;
  }
  if (passwordKeys.some((key) => !/^[0-9a-fA-F]{48,128}$/.test(values[key] ?? "")) || values[passwordKeys[0]] === values[passwordKeys[1]])
    throw new Error("Use distinct random hexadecimal passwords of 48–128 characters.");
  values.OPENBOT_TEMPORAL_PORT ??= "7233";
  const port = values.OPENBOT_TEMPORAL_PORT;
  if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535)
    throw new Error("Use an unprivileged loopback port.");
  const tls = values.OPENBOT_TEMPORAL_TLS_DIRECTORY;
  if (tls !== undefined && (!isAbsolute(tls) || !lstatSync(tls).isDirectory()))
    throw new Error("Use an explicit existing TLS material directory.");
  return values;
}
export type MaintenanceCommand = (args: readonly string[], input?: string | Buffer) => string;
export type MaintenanceSql = (database: EngineDatabase, statement: string) => string;
function version(value: string) {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value))
    throw new Error("Missing, multiple or malformed schema version.");
  const [major, minor] = value.split(".").map(Number);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) throw new Error("Invalid schema version.");
  return [major!, minor!] as const;
}
export function sealMetadata(sql: MaintenanceSql) {
  for (const database of Object.keys(TARGETS) as EngineDatabase[])
    sql(database, "REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON schema_version, schema_update_history FROM temporal_runtime;");
}
export function maintain(mode: "initialize" | "upgrade", command: MaintenanceCommand, sql: MaintenanceSql) {
  if (mode !== "initialize" && mode !== "upgrade") throw new Error("Expected initialize or upgrade.");
  const states = command(["ps", "--all", "--format", "{{.State}}", "temporal"]).trim().split("\n").filter(Boolean);
  if (states.some((state) => !["exited", "created"].includes(state)))
    throw new Error("Stop the engine and workers before exclusive schema maintenance; paused is not stopped.");
  // Validate both stores before the first schema mutation; mixed/foreign targets stay untouched.
  for (const [database, target] of Object.entries(TARGETS) as [EngineDatabase, string][]) {
    if (mode === "initialize") {
      if (sql(database, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%';").trim() !== "0")
        throw new Error("Initialization requires both engine databases to be empty.");
    } else {
      const current = version(sql(database, "SELECT curr_version FROM schema_version;").trim()), expected = version(target);
      if (current[0] > expected[0] || current[0] === expected[0] && current[1] > expected[1])
        throw new Error("Schema is newer than the pinned tools; downgrade is unsupported.");
    }
  }
  command(["run", "--rm", "--no-deps", "-e", "OPENBOT_TEMPORAL_SCHEMA_PREFLIGHT=passed", "schema", mode]);
  for (const [database, target] of Object.entries(TARGETS) as [EngineDatabase, string][])
    if (sql(database, "SELECT curr_version FROM schema_version;").trim() !== target)
      throw new Error("Schema tool did not produce the pinned target version.");
  sealMetadata(sql);
}
export class Profile {
  readonly environment: Record<string, string>;
  readonly values: Record<string, string>;
  readonly envFile: string;
  readonly project: string;
  readonly mtls: boolean;
  constructor(envFile: string, project: string, mtls = false) {
    this.project = project;
    this.mtls = mtls;
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw new Error("Invalid Compose project name.");
    this.values = readEnvironment(envFile);
    this.envFile = realpathSync(envFile);
    this.environment = Object.fromEntries(["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]
      .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    Object.assign(this.environment, this.values);
  }
  command: MaintenanceCommand = (args, input) => {
    const files = ["--file", join(directory, "compose.yaml")];
    if (this.mtls) files.push("--file", join(directory, "compose.mtls.yaml"));
    const result = spawnSync("docker", ["compose", "--env-file", this.envFile, "--project-name", this.project, ...files, ...args], {
      env: this.environment, input, encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024,
    });
    // CLI diagnostics may include substituted credentials; keep them out of errors and logs.
    if (result.error || result.status !== 0) throw new Error("Temporal profile operation failed: " + args[0]);
    return result.stdout;
  };
  sql: MaintenanceSql = (database, statement) => {
    if (!(database in TARGETS)) throw new Error("Unexpected engine database.");
    return this.command(["exec", "-T", "postgresql", "psql", "-U", "temporal_schema", "-v", "ON_ERROR_STOP=1", "-At", "-d", database], statement);
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      "env-file": { type: "string" }, project: { type: "string" }, mtls: { type: "boolean", default: false },
    } });
    const mode = positionals[0];
    if (positionals.length !== 1 || !["initialize", "upgrade"].includes(mode ?? "") || !values["env-file"] || !values.project)
      throw new Error("Usage: maintain.ts initialize|upgrade --env-file PATH --project NAME [--mtls]");
    const profile = new Profile(values["env-file"], values.project, values.mtls);
    maintain(mode as "initialize" | "upgrade", profile.command, profile.sql);
    console.log("Pinned engine schemas verified; runtime metadata writes revoked. Engine remains stopped.");
  } catch (error) { console.error(error instanceof Error ? error.message : "Temporal maintenance failed."); process.exitCode = 1; }
}
