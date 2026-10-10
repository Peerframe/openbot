/** Owns the pinned native Temporal fixture; never uses an installed engine or profile. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Connection } from "@temporalio/client";
import proto from "@temporalio/proto";
import { extractNativeTemporal } from "../../../scripts/temporal-release.ts";
import { issueTlsFixture } from "../../../scripts/tls-fixture.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("Fixture port unavailable.")));
    });
  });
}
function owned(child: ChildProcess) {
  let ended = false, failed = false;
  child.once("error", () => { failed = true; });
  const closed = new Promise<number | null>((resolve) => child.once("close", (code) => { ended = true; resolve(code); }));
  return { child, closed, alive: () => !ended && !failed,
    async stop() {
      if (ended) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
      try { await closed; } finally { clearTimeout(timer); }
    },
  };
}

export async function runNativeWorkFixture(mode: "smoke" | "measure", runtime: string) {
  if (process.env.OPENBOT_NATIVE_TEMPORAL_FIXTURE) return false;
  const archive = process.env.OPENBOT_NATIVE_TEMPORAL_ARCHIVE;
  assert(archive, "Set OPENBOT_NATIVE_TEMPORAL_ARCHIVE to the reviewed 1.32.0 macOS arm64 archive.");
  assert(process.platform === "darwin" && process.arch === "arm64", "Only macOS arm64 has a reviewed native fixture.");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-native-engine-")));
  const signal = new AbortController();
  let interrupted: number | undefined;
  const onInt = () => { interrupted = 130; signal.abort(); };
  const onTerm = () => { interrupted = 143; signal.abort(); };
  process.once("SIGINT", onInt); process.once("SIGTERM", onTerm);
  let engine: ReturnType<typeof owned> | undefined, child: ReturnType<typeof owned> | undefined, connection: Connection | undefined;
  const environment = Object.fromEntries(["PATH", "HOME", "TMPDIR"].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));
  try {
    const binary = await extractNativeTemporal(archive, join(directory, "release"), signal.signal);
    for (const name of ["server", "client"]) await mkdir(join(directory, name), { mode: 0o700 });
    const serverName = "temporal.openbot.internal";
    const server = await issueTlsFixture(join(directory, "server"), "serverAuth,clientAuth", serverName);
    const client = await issueTlsFixture(join(directory, "client"), "clientAuth");
    const ports: Record<string, [number, number]> = {};
    const unique = new Set<number>();
    const allocate = async () => { let value: number; do { value = await freePort(); } while (unique.has(value)); unique.add(value); return value; };
    for (const name of ["frontend", "history", "matching", "worker"]) ports[name] = [await allocate(), await allocate()];
    const address = `127.0.0.1:${ports.frontend![0]}`;
    const leaf = { requireClientAuth: true, certFile: server.certificatePath, keyFile: server.privateKeyPath, clientCaFiles: [server.caPath] };
    const clientTls = { serverName, disableHostVerification: false, rootCaFiles: [server.caPath] };
    // SQLite qualifies platform/native loading only. Durable recovery gates still use PostgreSQL.
    const store = { sql: { pluginName: "sqlite", databaseName: join(directory, "engine.sqlite"), connectAddr: "127.0.0.1", connectProtocol: "tcp",
      connectAttributes: { setup: "true", cache: "private", journal_mode: "wal", synchronous: "2" }, maxConns: 1, maxIdleConns: 1, maxConnLifetime: "1h" } };
    const dynamic = join(directory, "dynamic.yaml"); await writeFile(dynamic, "{}", { mode: 0o600 });
    const configuration = {
      log: { stdout: true, level: "error" },
      persistence: { defaultStore: "default", visibilityStore: "visibility", numHistoryShards: 1, datastores: { default: store, visibility: store } },
      global: { membership: { maxJoinDuration: "30s", broadcastAddress: "127.0.0.1" }, tls: {
        internode: { server: leaf, client: clientTls }, frontend: { server: { ...leaf, clientCaFiles: [server.caPath, client.caPath] }, client: clientTls },
      } },
      services: Object.fromEntries(Object.entries(ports).map(([name, values]) => [name, { rpc: { grpcPort: values[0], membershipPort: values[1], bindOnLocalHost: true } }])),
      clusterMetadata: { enableGlobalNamespace: false, failoverVersionIncrement: 10, masterClusterName: "active", currentClusterName: "active",
        clusterInformation: { active: { enabled: true, initialFailoverVersion: 1, rpcName: "frontend", rpcAddress: address } } },
      publicClient: { hostPort: address }, dcRedirectionPolicy: { policy: "noop" }, dynamicConfigClient: { filepath: dynamic, pollInterval: "10s" },
    };
    const config = join(directory, "server.yaml"); await writeFile(config, JSON.stringify(configuration), { mode: 0o600 });
    const output = openSync(join(directory, "engine.log"), "wx", 0o600);
    try { engine = owned(spawn(binary, ["--config-file", config, "--allow-no-auth", "start"], { cwd: directory, env: environment, stdio: ["ignore", output, output] })); }
    finally { closeSync(output); }
    const tls = { serverNameOverride: serverName, serverRootCACertificate: await readFile(server.caPath),
      clientCertPair: { crt: await readFile(client.certificatePath), key: await readFile(client.privateKeyPath) } };
    const deadline = Date.now() + 60000;
    while (true) {
      signal.signal.throwIfAborted();
      if (!engine.alive()) throw new Error("Owned native engine exited before readiness.");
      try {
        connection = await Connection.connect({ address, tls, connectTimeout: 2000 });
        const info = await connection.withDeadline(Date.now() + 3000, () => connection!.workflowService.getSystemInfo({}));
        assert.equal(info.serverVersion, "1.32.0"); break;
      } catch {
        await connection?.close(); connection = undefined;
        if (Date.now() >= deadline) throw new Error("Owned native engine readiness timed out.");
        await delay(200, undefined, { signal: signal.signal });
      }
    }
    for (const deniedTls of [undefined, { serverNameOverride: serverName, serverRootCACertificate: tls.serverRootCACertificate }]) {
      let unauthorized: Connection | undefined;
      try { await assert.rejects(async () => {
        unauthorized = await Connection.connect({ address, ...(deniedTls ? { tls: deniedTls } : {}), connectTimeout: 1500 });
        await unauthorized.withDeadline(Date.now() + 1500, () => unauthorized!.workflowService.getSystemInfo({}));
      }); } finally { await unauthorized?.close(); }
    }
    await connection.withDeadline(Date.now() + 5000, () => connection!.workflowService.registerNamespace(proto.temporal.api.workflowservice.v1.RegisterNamespaceRequest.fromObject({ namespace: "default", workflowExecutionRetentionPeriod: { seconds: 86400 } })));
    const receipt = join(directory, "fixture.json");
    await writeFile(receipt, JSON.stringify({ address, tls: { ca: server.caPath, certificate: client.certificatePath, key: client.privateKeyPath, server_name: serverName } }), { mode: 0o600 });
    const script = mode === "smoke" ? "smoke-product.ts" : "measure-ts-product.ts";
    child = owned(spawn(process.execPath, [join(root, "apps/desktop/scripts", script), runtime], {
      cwd: root, env: { ...environment, OPENBOT_NATIVE_TEMPORAL_FIXTURE: receipt }, stdio: "inherit", signal: signal.signal,
    }));
    const limit = setTimeout(() => child?.child.kill("SIGTERM"), 900000);
    try { assert.equal(await child.closed, 0, "Native package qualification failed."); }
    finally { clearTimeout(limit); }
    return true;
  } finally {
    await child?.stop(); await connection?.close(); await engine?.stop();
    await rm(directory, { recursive: true, force: true });
    process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm);
    if (interrupted !== undefined) process.exitCode = interrupted;
  }
}

export async function configureNativeWorkFixture(dataRoot: string) {
  const receipt = process.env.OPENBOT_NATIVE_TEMPORAL_FIXTURE;
  assert(receipt, "The owned native engine must supply its private fixture receipt.");
  const fixture = JSON.parse(await readFile(receipt, "utf8"));
  assert.match(fixture.address, /^127\.0\.0\.1:\d+$/);
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(dataRoot, "temporal.json"), JSON.stringify({ temporal_address: fixture.address, namespace: "default",
    queue: `openbot-desktop-probe-${randomUUID()}`, tls: fixture.tls,
  }), { mode: 0o600, flag: "wx" });
}
