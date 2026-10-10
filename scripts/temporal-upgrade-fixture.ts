/** Qualifies adjacent engine binaries and cold restore only on owned disposable volumes. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  maintain,
  Profile,
  sealMetadata,
  TARGETS,
  type MaintenanceCommand,
  type EngineDatabase,
} from "../deploy/temporal/maintain.ts";
import { extractPreviousTemporal } from "./temporal-release.ts";
import { startTemporalFixture } from "./temporal-fixture.ts";
const databases = Object.keys(TARGETS) as EngineDatabase[];
const digest = (data: string) => createHash("sha256").update(data).digest("hex");
export type UpgradePort = {
  command: MaintenanceCommand;
  versions: () => Record<string, string>;
  records: () => Record<string, string>;
  shards: () => string[];
  selectTarget: () => void;
  migrate: () => void;
  verifyPrivileges: () => void;
  ready: () => Promise<void>;
};
/** Failure before restart deliberately leaves the engine stopped; a failed attempt is not retried. */
export class AdjacentUpgrade {
  attempted = false;
  completed = false;
  async run(port: UpgradePort) {
    if (this.attempted) throw new Error("Adjacent release fixture upgrades once only.");
    this.attempted = true;
    port.command(["stop", "temporal"]);
    const versions = port.versions(),
      records = port.records(),
      shards = port.shards();
    assert.deepEqual(shards, ["1", "2", "3", "4"]);
    port.selectTarget();
    port.migrate();
    assert.deepEqual(port.versions(), versions);
    assert.deepEqual(port.records(), records);
    port.verifyPrivileges();
    port.command(["up", "-d", "temporal"]);
    await port.ready();
    assert.deepEqual(port.shards(), shards);
    this.completed = true;
    return {
      from: "1.31.3",
      to: "1.32.0",
      schemaHistoryUnchanged: true,
      shardIds: shards,
      schemaHistoryDigests: Object.fromEntries(
        Object.entries(records).map(([db, value]) => [db, digest(value)]),
      ),
    };
  }
}
export async function startUpgradeTemporalFixture(archive: string, signal: AbortSignal) {
  let controller: Awaited<ReturnType<typeof ownedUpgradeProfile>> | undefined;
  const fixture = await startTemporalFixture({
    signal,
    createProfile: async (env, project, directory) => {
      controller = await ownedUpgradeProfile(archive, env, project, directory, signal);
      return controller;
    },
  });
  assert(controller);
  const owned = controller,
    connection = fixture.connection;
  const version = async (expected: string) => {
    const deadline = Date.now() + 45000;
    while (true) {
      signal.throwIfAborted();
      try {
        const info = await connection.withDeadline(Date.now() + 3000, () =>
          connection.workflowService.getSystemInfo({}),
        );
        assert.equal(info.serverVersion, expected);
        await connection.withDeadline(Date.now() + 3000, () =>
          connection.workflowService.describeNamespace({ namespace: "default" }),
        );
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await delay(300, undefined, { signal });
      }
    }
  };
  return {
    ...fixture,
    async warmup() {
      await version("1.31.3");
      assert.match(
        owned.profile
          .command([
            "run",
            "--rm",
            "--no-deps",
            "--entrypoint",
            "temporal-sql-tool",
            "schema",
            "--version",
          ])
          .trim(),
        /1\.31\.3$/,
      );
      const started = performance.now();
      let reportAt = 0;
      // Preserve the previous gate's upstream-recommended ten-minute shard warm-up.
      while (performance.now() - started < 600000) {
        signal.throwIfAborted();
        await connection.withDeadline(Date.now() + 5000, () => connection.healthService.check({}));
        const elapsed = performance.now() - started;
        if (elapsed >= reportAt) {
          console.log(
            JSON.stringify({
              stage: "previous-release-warmup",
              healthySeconds: Math.round(elapsed / 1000),
              requiredSeconds: 600,
            }),
          );
          reportAt += 60000;
        }
        await delay(Math.min(10000, Math.max(1, 600000 - elapsed)), undefined, { signal });
      }
      assert.deepEqual(owned.shards(), ["1", "2", "3", "4"]);
    },
    async upgrade() {
      const receipt = await owned.upgrade.run({ ...owned, ready: () => version("1.32.0") });
      console.log(JSON.stringify(receipt));
      return receipt;
    },
    backup: owned.backup,
    async restore() {
      owned.restore();
      await version("1.32.0");
    },
  };
}
async function ownedUpgradeProfile(
  archive: string,
  env: string,
  project: string,
  directory: string,
  signal: AbortSignal,
) {
  const profile = new Profile(env, project, true);
  const result = spawnSync("docker", ["info", "--format", "{{.Architecture}}"], {
    env: profile.environment,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 0, "Owned Docker engine is unavailable.");
  const architecture = (
    { aarch64: "arm64", arm64: "arm64", x86_64: "amd64", amd64: "amd64" } as Record<string, string>
  )[result.stdout.trim()];
  assert(architecture, "Only reviewed Linux amd64/arm64 binaries are accepted.");
  const paths = await extractPreviousTemporal(
    archive,
    architecture,
    join(directory, "release-1.31.3"),
    signal,
  );
  const overlay = join(directory, "previous-release.json");
  await writeFile(
    overlay,
    JSON.stringify({
      services: Object.fromEntries(
        [
          ["temporal", "temporal-server"],
          ["schema", "temporal-sql-tool"],
        ].map(([service, name]) => [
          service,
          {
            volumes: [
              {
                type: "bind",
                source: paths[name!],
                target: "/usr/local/bin/" + name,
                read_only: true,
                bind: { create_host_path: false },
              },
            ],
          },
        ]),
      ),
    }),
    { mode: 0o600 },
  );
  const original = profile.command,
    commands = [original];
  let current = original,
    previous = true,
    restored = false;
  profile.command = (args, input) =>
    current([...(previous ? ["--file", overlay] : []), ...args], input);
  const versions = () =>
    Object.fromEntries(
      databases.map((db) => [
        db,
        profile.sql(db, "SELECT curr_version FROM schema_version;").trim(),
      ]),
    );
  const records = () =>
    Object.fromEntries(
      databases.map((db) => [
        db,
        profile.sql(
          db,
          "SELECT row_to_json(s)::text FROM schema_update_history s ORDER BY year,month,update_time;",
        ),
      ]),
    );
  const shards = () =>
    profile.sql("temporal", "SELECT shard_id FROM shards ORDER BY shard_id;").trim().split("\n");
  const runtime = (db: EngineDatabase, statement: string) =>
    profile.command(
      [
        "exec",
        "-T",
        "postgresql",
        "sh",
        "-c",
        'PGPASSWORD="$OPENBOT_TEMPORAL_RUNTIME_PASSWORD" exec psql -h 127.0.0.1 -U temporal_runtime -v ON_ERROR_STOP=1 -At -d "$1"',
        "owned-runtime-query",
        db,
      ],
      statement,
    );
  const verifyPrivileges = () => {
    for (const db of databases)
      for (const table of ["schema_version", "schema_update_history"])
        assert.throws(() => runtime(db, `DELETE FROM ${table} WHERE false;`));
  };
  const upgrade = new AdjacentUpgrade();
  let snapshot:
    | {
        versions: Record<string, string>;
        namespace: string;
        dumps: Record<string, { data: string; sha256: string }>;
      }
    | undefined;
  return {
    profile,
    command: profile.command,
    versions,
    records,
    shards,
    upgrade,
    selectTarget: () => {
      previous = false;
    },
    migrate: () => maintain("upgrade", profile.command, profile.sql),
    verifyPrivileges,
    backup: () => {
      assert(!snapshot, "Fixture takes one cold snapshot only.");
      profile.command(["stop", "temporal"]);
      snapshot = {
        versions: versions(),
        namespace: profile.sql("temporal", "SELECT id FROM namespaces WHERE name='default';"),
        dumps: Object.fromEntries(
          databases.map((db) => {
            const data = profile.command([
              "exec",
              "-T",
              "postgresql",
              "pg_dump",
              "-U",
              "temporal_schema",
              "--format=plain",
              "--no-owner",
              "--no-privileges",
              db,
            ]);
            assert(data.startsWith("--"));
            assert(Buffer.byteLength(data) <= 64 * 1024 * 1024);
            return [db, { data, sha256: digest(data) }];
          }),
        ),
      };
      profile.command(["up", "-d", "temporal"]);
      console.log(
        JSON.stringify({
          case: "cold-engine-backup",
          schema: snapshot.versions,
          bytes: Object.fromEntries(
            databases.map((db) => [db, Buffer.byteLength(snapshot!.dumps[db]!.data)]),
          ),
        }),
      );
    },
    restore: () => {
      assert(
        snapshot && upgrade.completed && !restored,
        "Restore requires one verified snapshot and the completed upgrade.",
      );
      profile.command(["stop", "temporal"]);
      const next = new Profile(env, project + "-restore", true);
      commands.push(next.command);
      current = next.command;
      assert.equal(profile.command(["ps", "--all", "-q"]).trim(), "");
      profile.command(["up", "-d", "--wait", "--wait-timeout", "40", "postgresql"]);
      for (const db of databases) {
        assert.equal(
          profile.sql(db, "SELECT count(*) FROM pg_tables WHERE schemaname='public';").trim(),
          "0",
        );
        const dump: { data: string; sha256: string } = snapshot.dumps[db]!;
        assert.equal(digest(dump.data), dump.sha256);
        profile.command(
          [
            "exec",
            "-T",
            "postgresql",
            "psql",
            "-U",
            "temporal_schema",
            "--single-transaction",
            "-v",
            "ON_ERROR_STOP=1",
            "-d",
            db,
          ],
          dump.data,
        );
      }
      assert.deepEqual(versions(), snapshot.versions);
      assert.equal(
        profile.sql("temporal", "SELECT id FROM namespaces WHERE name='default';"),
        snapshot.namespace,
      );
      sealMetadata(profile.sql);
      verifyPrivileges();
      maintain("upgrade", profile.command, profile.sql);
      profile.command(["up", "-d", "temporal"]);
      restored = true;
      console.log(
        JSON.stringify({
          case: "restore-new-engine-volume",
          namespacePreserved: true,
          schema: snapshot.versions,
        }),
      );
    },
    close: () => {
      const errors: unknown[] = [];
      for (const command of commands.reverse()) {
        try {
          command(["down", "--volumes", "--remove-orphans"]);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "Owned upgrade fixture cleanup failed.");
    },
  };
}
