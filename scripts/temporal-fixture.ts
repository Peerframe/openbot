/** Owns a disposable PostgreSQL-backed mTLS Temporal instance using the existing pinned deployment profile. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Connection } from "@temporalio/client";
import proto from "@temporalio/proto";
import { maintain, Profile, TARGETS, type EngineDatabase } from "../deploy/temporal/maintain.ts";
import { issueTlsFixture } from "./tls-fixture.ts";

export interface TemporalFixtureSettings {
  address: string;
  tls: { ca: string; certificate: string; key: string; server_name: string };
}
export async function startTemporalFixture(
  options: {
    signal?: AbortSignal;
    createProfile?: (
      envFile: string,
      project: string,
      directory: string,
    ) => Promise<{ profile: Profile; close: () => void }>;
  } = {},
) {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "openbot-temporal-qualification-")),
  );
  const project = "openbot-temporal-qualification-" + randomBytes(6).toString("hex");
  let closeProfile: (() => void) | undefined;
  let profile: Profile | undefined,
    connection: Connection | undefined,
    closed = false;
  const close = async () => {
    if (closed) return;
    // Preserve the private fixture receipt on cleanup failure so its owned project can be recovered.
    await connection?.close();
    if (closeProfile) closeProfile();
    else profile?.command(["down", "--volumes", "--remove-orphans"]);
    await rm(directory, { recursive: true, force: true });
    closed = true;
  };
  try {
    signal.throwIfAborted();
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() =>
          typeof address === "object" && address
            ? resolve(address.port)
            : reject(new Error("Fixture port unavailable.")),
        );
      });
    });
    const engineDirectory = join(directory, "engine");
    for (const name of ["engine", "server", "client"])
      await mkdir(join(directory, name), { mode: 0o700 });
    const server = await issueTlsFixture(
      join(directory, "server"),
      "serverAuth,clientAuth",
      "temporal.openbot.internal",
    );
    const client = await issueTlsFixture(join(directory, "client"), "clientAuth");
    for (const [from, name] of [
      [server.certificatePath, "server.pem"],
      [server.privateKeyPath, "server.key"],
      [server.caPath, "server-ca.pem"],
      [client.caPath, "client-ca.pem"],
    ]) {
      const path = join(engineDirectory, name!);
      await copyFile(from!, path);
      await chmod(path, 0o444);
    }
    const environment = join(directory, "engine.env");
    await writeFile(
      environment,
      `OPENBOT_TEMPORAL_SCHEMA_PASSWORD=${randomBytes(24).toString("hex")}\nOPENBOT_TEMPORAL_RUNTIME_PASSWORD=${randomBytes(24).toString("hex")}\nOPENBOT_TEMPORAL_PORT=${port}\nOPENBOT_TEMPORAL_TLS_DIRECTORY=${engineDirectory}\n`,
      { mode: 0o600 },
    );
    signal.throwIfAborted();
    if (options.createProfile) {
      const owned = await options.createProfile(environment, project, directory);
      profile = owned.profile;
      closeProfile = owned.close;
    } else profile = new Profile(environment, project, true);
    assert.equal(
      profile.command(["ps", "--all", "-q"]).trim(),
      "",
      "Fixture project must start empty.",
    );
    profile.command(["config", "--quiet"]);
    profile.command(["up", "-d", "--wait", "--wait-timeout", "40", "postgresql"]);
    profile.command(["up", "-d", "temporal"]);
    const absentSchemaDeadline = Date.now() + 25000;
    while (
      profile.command(["ps", "--all", "--format", "{{.State}}", "temporal"]).trim() !== "exited"
    ) {
      if (Date.now() >= absentSchemaDeadline)
        throw new Error("Engine did not reject absent schemas.");
      await delay(100, undefined, { signal });
    }
    assert.match(
      profile.command(["logs", "--no-color", "temporal"]),
      /sql schema version compatibility check failed/i,
    );
    profile.command(["rm", "-f", "temporal"]);
    maintain("initialize", profile.command, profile.sql);
    assert.throws(() => maintain("initialize", profile!.command, profile!.sql), /empty/);
    maintain("upgrade", profile.command, profile.sql);
    for (const [database, target] of Object.entries(TARGETS))
      assert.equal(
        profile.sql(database as EngineDatabase, "SELECT curr_version FROM schema_version;").trim(),
        target,
      );
    const runtimeSql = (database: EngineDatabase, statement: string) =>
      profile!.command(
        [
          "exec",
          "-T",
          "postgresql",
          "sh",
          "-c",
          'PGPASSWORD="$OPENBOT_TEMPORAL_RUNTIME_PASSWORD" exec psql -h 127.0.0.1 -U temporal_runtime -v ON_ERROR_STOP=1 -At -d "$1"',
          "owned-runtime-query",
          database,
        ],
        statement,
      );
    assert.equal(
      runtimeSql(
        "temporal",
        "SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user; SELECT has_schema_privilege(current_user,'public','CREATE');",
      ).trim(),
      "f|f|f\nf",
    );
    assert.throws(() => runtimeSql("temporal", "CREATE TABLE forbidden_reference(id integer);"));
    for (const database of Object.keys(TARGETS) as EngineDatabase[])
      for (const table of ["schema_version", "schema_update_history"])
        assert.throws(() => runtimeSql(database, `DELETE FROM ${table} WHERE false;`));
    profile.command(["up", "-d", "temporal"]);
    const settings: TemporalFixtureSettings = {
      address: `127.0.0.1:${port}`,
      tls: {
        ca: server.caPath,
        certificate: client.certificatePath,
        key: client.privateKeyPath,
        server_name: "temporal.openbot.internal",
      },
    };
    const tls = {
      serverNameOverride: settings.tls.server_name,
      serverRootCACertificate: await readFile(settings.tls.ca),
      clientCertPair: {
        crt: await readFile(settings.tls.certificate),
        key: await readFile(settings.tls.key),
      },
    };
    const deadline = Date.now() + 45000;
    while (true) {
      signal.throwIfAborted();
      try {
        connection = await Connection.connect({
          address: settings.address,
          tls,
          connectTimeout: 2000,
        });
        try {
          await connection.withDeadline(Date.now() + 3000, () =>
            connection!.workflowService.describeNamespace({ namespace: "default" }),
          );
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === 5))
            throw error;
          await connection.withDeadline(Date.now() + 5000, () =>
            connection!.workflowService.registerNamespace(
              proto.temporal.api.workflowservice.v1.RegisterNamespaceRequest.fromObject({
                namespace: "default",
                workflowExecutionRetentionPeriod: { seconds: 604800 },
              }),
            ),
          );
        }
        // Namespace registration precedes visibility-cache propagation. The migration gate
        // queries visibility immediately, so readiness must prove that same service works.
        await connection.withDeadline(Date.now() + 3000, () =>
          connection!.workflowService.listWorkflowExecutions({
            namespace: "default",
            pageSize: 1,
            query: "ExecutionStatus = 'Running'",
          }),
        );
        break;
      } catch {
        await connection?.close();
        connection = undefined;
        if (Date.now() >= deadline) throw new Error("Owned mTLS Temporal did not become ready.");
        await delay(200, undefined, { signal });
      }
    }
    signal.throwIfAborted();
    const receipt = join(directory, "fixture.json");
    await writeFile(receipt, JSON.stringify(settings), { mode: 0o600 });
    return { settings, receipt, directory, profile, connection, close };
  } catch (error) {
    await close();
    throw error;
  }
}
