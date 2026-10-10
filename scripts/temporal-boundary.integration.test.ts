/** Preserves actual mTLS rotation, engine/database crash and incompatible-schema qualification. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, Connection, type ConnectionOptions } from "@temporalio/client";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { installWorkRuntime } from "@openbot/work";
import { it } from "vitest";
import { maintain, TARGETS } from "../deploy/temporal/maintain.ts";
import {
  allowlistedEnvironment,
  OwnedDockerFixture,
  startControlPostgres,
} from "./acceptance-fixture.ts";
import { startTemporalFixture } from "./temporal-fixture.ts";
import { issueTlsFixture } from "./tls-fixture.ts";
import { heldWork } from "./integration/work-upgrade.ts";

it("rejects unauthorized mTLS, rotates trust and preserves original Work through SIGKILL and schema refusal", {
  timeout: 480000,
}, async () => {
  await installWorkRuntime();
  const engine = await startTemporalFixture(),
    connections: Connection[] = [];
  const docker = new OwnedDockerFixture(
    fileURLToPath(new URL("../", import.meta.url)),
    allowlistedEnvironment([
      "PATH",
      "HOME",
      "TMPDIR",
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
      "DOCKER_CONFIG",
    ]),
  );
  const held: Awaited<ReturnType<typeof heldWork>>[] = [];
  let current = engine.connection;
  const tls = async () => ({
    serverNameOverride: engine.settings.tls.server_name,
    serverRootCACertificate: await readFile(engine.settings.tls.ca),
    clientCertPair: {
      crt: await readFile(engine.settings.tls.certificate),
      key: await readFile(engine.settings.tls.key),
    },
  });
  const namespace = async (connection: Connection) => {
    await connection.withDeadline(Date.now() + 3000, () =>
      connection.workflowService.getSystemInfo({}),
    );
    const description = await connection.withDeadline(Date.now() + 3000, () =>
      connection.workflowService.describeNamespace({ namespace: "default" }),
    );
    assert(description.namespaceInfo?.id);
    return description.namespaceInfo.id;
  };
  let originalNamespace = "";
  const rejected = async (name: string, transport: ConnectionOptions["tls"]) => {
    assert.equal(await namespace(current), originalNamespace);
    // Construct separately so malformed client options cannot be mistaken for a handshake refusal.
    const bad = Connection.lazy({
      address: engine.settings.address,
      tls: transport ?? false,
      connectTimeout: 5000,
    });
    try {
      await assert.rejects(bad.ensureConnected());
    } finally {
      await bad.close();
    }
    assert.equal(await namespace(current), originalNamespace);
    console.log(
      JSON.stringify({ case: "mtls-reject-" + name, validClientHealthyBeforeAndAfter: true }),
    );
  };
  const reconnect = async () => {
    const deadline = Date.now() + 45000;
    while (true) {
      const candidate = Connection.lazy({
        address: engine.settings.address,
        tls: await tls(),
        connectTimeout: 2000,
      });
      try {
        await candidate.ensureConnected();
        assert.equal(await namespace(candidate), originalNamespace);
        current = candidate;
        connections.push(candidate);
        return;
      } catch (error) {
        await candidate.close();
        if (Date.now() >= deadline) throw error;
        await delay(200);
      }
    }
  };
  const until = async (read: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 90000;
    while (!(await read())) {
      assert(Date.now() < deadline, "Temporal boundary wait: " + label);
      await delay(200);
    }
  };
  try {
    const bundle = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL("../packages/work/dist/workflows.js", import.meta.url)),
    });
    const replay = async (item: (typeof held)[number]) => {
      const before = await item.facts();
      const handle = new Client({ connection: current, namespace: "default" }).workflow.getHandle(
        item.workflowId,
      );
      assert.equal((await handle.describe()).runId, item.admission.engine_first_run_id);
      await Worker.runReplayHistory({ workflowBundle: bundle }, await handle.fetchHistory());
      assert.equal(await item.facts(), before);
      await item.verifyAdmission();
      return handle;
    };
    originalNamespace = await namespace(current);
    const originalTls = await tls();
    const unknownDirectory = join(engine.directory, "unknown-client");
    await mkdir(unknownDirectory, { mode: 0o700 });
    const unknown = await issueTlsFixture(unknownDirectory, "clientAuth");
    await rejected("plaintext", false);
    await rejected("missing-certificate", {
      serverNameOverride: originalTls.serverNameOverride,
      serverRootCACertificate: originalTls.serverRootCACertificate,
    });
    await rejected("unknown-client-ca", {
      ...originalTls,
      clientCertPair: {
        crt: await readFile(unknown.certificatePath),
        key: await readFile(unknown.privateKeyPath),
      },
    });
    await rejected("wrong-server-name", { ...originalTls, serverNameOverride: "wrong.invalid" });
    const dsn = await startControlPostgres(
      docker,
      "openbot-boundary-control-" + randomUUID(),
      randomBytes(24).toString("hex"),
    );
    const rotating = await heldWork(dsn, engine, "approval");
    held.push(rotating);
    const beforeRotation = await rotating.facts();
    await replay(rotating);
    engine.profile.command(["stop", "temporal"]);
    const replacementDirectory = join(engine.directory, "replacement-client");
    await mkdir(replacementDirectory, { mode: 0o700 });
    const replacement = await issueTlsFixture(replacementDirectory, "clientAuth");
    // This whole directory belongs to the disposable fixture. Stop the engine before replacing trust.
    const ca = join(engine.directory, "engine", "client-ca.pem");
    await chmod(ca, 0o600);
    await copyFile(replacement.caPath, ca);
    await chmod(ca, 0o444);
    await copyFile(replacement.certificatePath, engine.settings.tls.certificate);
    await copyFile(replacement.privateKeyPath, engine.settings.tls.key);
    await chmod(engine.settings.tls.certificate, 0o600);
    await chmod(engine.settings.tls.key, 0o600);
    engine.profile.command(["up", "-d", "temporal"]);
    await reconnect();
    await rejected("retired-client-ca", originalTls);
    assert.equal(await rotating.facts(), beforeRotation);
    await replay(rotating);
    await rotating.start("resume");
    const pending = await rotating.snapshot(),
      action = pending.actions.find((v) => v.decision === "pending");
    assert(action);
    assert.deepEqual(pending.actions, rotating.before.actions);
    assert.equal(
      (
        await rotating.request(`/api/v1/actions/${action.id}/decision`, "POST", {
          intentDigest: action.intentDigest,
          approved: true,
        })
      ).status,
      200,
    );
    await until(
      async () => (await rotating.snapshot()).status === "completed",
      "rotated approval completion",
    );
    const completed = await rotating.snapshot();
    assert.equal(completed.artifacts.length, 1);
    assert.deepEqual(rotating.models, ["read", "report", "answer", "review"]);
    const downloaded = await rotating.request(completed.artifacts[0]!.downloadUrl);
    assert.equal(downloaded.status, 200);
    assert.match(await downloaded.text(), /Original durable recovery report/);
    const handle = new Client({ connection: current }).workflow.getHandle(rotating.workflowId);
    await current.withDeadline(Date.now() + 20000, () => handle.result());
    await rotating.stop();
    await replay(rotating);
    console.log(
      JSON.stringify({
        case: "mtls-stop-rotate-reconnect",
        namespacePreserved: true,
        originalWorkRunPreserved: true,
        originalApprovalOnly: true,
        providerCalls: rotating.models.length,
        artifactsDownloaded: 1,
        offlineReplay: true,
      }),
    );

    const crashing = await heldWork(dsn, engine, "approval");
    held.push(crashing);
    const beforeCrash = await crashing.facts(),
      beforeCalls = [...crashing.models];
    engine.profile.command(["kill", "-s", "SIGKILL", "temporal", "postgresql"]);
    engine.profile.command(["up", "-d", "--wait", "--wait-timeout", "40", "postgresql"]);
    engine.profile.command(["up", "-d", "temporal"]);
    await reconnect();
    assert.equal(await crashing.facts(), beforeCrash);
    await replay(crashing);
    await crashing.start("resume");
    const cancelledResponse = await crashing.request(
      `/api/v1/tasks/${crashing.initial.id}/cancel`,
      "POST",
      {},
    );
    assert.equal(cancelledResponse.status, 200);
    const cancelled = await crashing.snapshot();
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.authorityActive, false);
    assert.equal(cancelled.artifacts.length, 0);
    assert.deepEqual(cancelled.usage, crashing.before.usage);
    await until(
      async () =>
        (
          await new Client({ connection: current }).workflow
            .getHandle(crashing.workflowId)
            .describe()
        ).status.name !== "RUNNING",
      "crash cancellation closure",
    );
    assert.deepEqual(crashing.models, beforeCalls);
    assert.deepEqual(
      (await crashing.snapshot()).actions.filter((v) => v.status === "applied").map((v) => v.id),
      crashing.before.actions.filter((v) => v.status === "applied").map((v) => v.id),
    );
    await crashing.stop();
    await replay(crashing);
    console.log(
      JSON.stringify({
        case: "server-and-database-sigkill",
        namespacePreserved: true,
        originalWorkRunPreserved: true,
        pendingApprovalCancelled: true,
        noFurtherModelCalls: true,
        noArtifacts: true,
        offlineReplay: true,
      }),
    );

    engine.profile.command(["stop", "temporal"]);
    maintain("upgrade", engine.profile.command, engine.profile.sql);
    engine.profile.sql("temporal", "UPDATE schema_version SET curr_version='999.0';");
    assert.throws(() => maintain("upgrade", engine.profile.command, engine.profile.sql), /newer/);
    assert.equal(
      engine.profile.sql("temporal", "SELECT curr_version FROM schema_version;").trim(),
      "999.0",
    );
    engine.profile.sql("temporal", "UPDATE schema_version SET curr_version='0.0';");
    engine.profile.command(["rm", "-f", "temporal"]);
    engine.profile.command(["up", "-d", "temporal"]);
    await until(
      async () =>
        engine.profile.command(["ps", "--all", "--format", "{{.State}}", "temporal"]).trim() ===
        "exited",
      "incompatible schema refusal",
    );
    assert.match(
      engine.profile.command(["logs", "--no-color", "temporal"]),
      /sql schema version compatibility check failed/i,
    );
    assert.equal(
      engine.profile.sql("temporal", "SELECT curr_version FROM schema_version;").trim(),
      "0.0",
    );
    const version = TARGETS.temporal;
    assert(/^\d+\.\d+$/.test(version));
    engine.profile.sql("temporal", `UPDATE schema_version SET curr_version='${version}';`);
    engine.profile.command(["up", "-d", "temporal"]);
    await reconnect();
    await replay(rotating);
    await replay(crashing);
    console.log(
      JSON.stringify({
        case: "incompatible-schema-rejected",
        newerRejectedByOperator: true,
        tooOldRejectedByServer: true,
        restoredVersion: version,
        namespaceAndOriginalWorkRetained: true,
      }),
    );
  } finally {
    const outcomes = await Promise.allSettled([
      ...held.map((item) => item.close()),
      ...connections.map((connection) => connection.close()),
    ]);
    try {
      docker.cleanup();
    } finally {
      await engine.close();
    }
    assert(
      outcomes.every((outcome) => outcome.status === "fulfilled"),
      "Owned Temporal boundary cleanup failed.",
    );
  }
});
