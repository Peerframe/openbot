/** Owns a complete disposable Server process, PostgreSQL, MCP peer and mTLS Temporal lifetime. */
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createDatabase } from "@openbot/db";
import { DevProcessOwner } from "./dev-processes.ts";
import { allowlistedEnvironment, OwnedDockerFixture, startControlPostgres } from "./acceptance-fixture.ts";
import { contractPluginFixture } from "./contract-plugin-fixture.ts";
import { prepareProduct } from "../deploy/server/prepare-product.ts";
import { startTemporalFixture } from "./temporal-fixture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
export async function serverContractFixture(options: { publisher?: boolean; tlsDirectory?: string; signal?: AbortSignal; temporal?: Awaited<ReturnType<typeof startTemporalFixture>> } = {}) {
  const signal = options.signal ?? new AbortController().signal;
  const environment = allowlistedEnvironment(["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", ...(options.tlsDirectory ? ["NODE_EXTRA_CA_CERTS"] : [])]);
  const docker = new OwnedDockerFixture(root, environment), processes = new DevProcessOwner({ cwd: root });
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-contract-")));
  let temporal = options.temporal, plugins: Awaited<ReturnType<typeof contractPluginFixture>> | undefined;
  let child: ChildProcess | undefined;
  const close = async () => {
    const results = await Promise.allSettled([processes.stop(), plugins?.close()]);
    try { if (!options.temporal) await temporal?.close(); } finally { docker.cleanup(); }
    for (const result of results) if (result.status === "rejected") throw result.reason;
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const dsn = await startControlPostgres(docker, `openbot-contract-${randomUUID()}`, randomBytes(24).toString("hex"));
    const db = createDatabase(dsn); try { await db.migrate(); } finally { await db.close(); }
    temporal ??= await startTemporalFixture({ signal });
    plugins = await contractPluginFixture();
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer(); server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("Fixture port unavailable."))); });
    });
    const baseUrl = `${options.tlsDirectory ? "https" : "http"}://127.0.0.1:${port}`, password = randomBytes(24).toString("hex");
    for (const name of ["objects", "artifacts"]) await mkdir(join(directory, name), { mode: 0o700 });
    const temporalPath = join(directory, "temporal.json"), modelReceipt = join(directory, "model-receipt.json");
    await writeFile(temporalPath, JSON.stringify({ temporal_address: temporal.settings.address, namespace: "default", queue: "openbot-contract-" + randomUUID(), tls: temporal.settings.tls }), { mode: 0o600 });
    await writeFile(modelReceipt, "{}", { mode: 0o600 });
    const publisherDirectory = join(directory, "publisher"), publisherPassphrase = join(directory, "publisher-secret", "passphrase");
    let publisher: { keyid: string; publicKey: string } | undefined;
    if (options.publisher) {
      const keyChild = processes.start(process.execPath, ["scripts/employee-publisher-key.ts", "init", "--keyring", publisherDirectory, "--passphrase-file", publisherPassphrase], environment);
      const timer = setTimeout(() => keyChild.kill("SIGTERM"), 15000);
      try { await processes.waitSuccess(keyChild); } finally { clearTimeout(timer); }
      const manifest = JSON.parse(await readFile(join(publisherDirectory, "trust.json"), "utf8"));
      const active = manifest.keys.find((entry: { keyid: string }) => entry.keyid === manifest.activeKeyId);
      assert(active && typeof active.publicKey === "string"); publisher = { keyid: active.keyid, publicKey: active.publicKey };
    }
    const env = { ...environment,
      OPENBOT_TS_HOST: "127.0.0.1", OPENBOT_TS_PORT: String(port), OPENBOT_TS_PUBLIC_ORIGIN: baseUrl,
      OPENBOT_TS_DATABASE_URL: dsn, OPENBOT_TS_OWNER_PASSWORD: password,
      OPENBOT_TS_AUTH_ALLOWED_ORIGINS: `${baseUrl},https://secondary.example.test`,
      OPENBOT_TS_WRITE_ALLOWED_ORIGINS: `${baseUrl},https://secondary.example.test`,
      OPENBOT_TS_READ_ALLOWED_ORIGINS: `${baseUrl},https://secondary.example.test`,
      OPENBOT_TS_OBJECT_ROOT: join(directory, "objects"), OPENBOT_TS_ARTIFACT_ROOT: join(directory, "artifacts"),
      OPENBOT_TS_WORK_FILE_ROOT: join(directory, "artifacts"), OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH: temporalPath,
      OPENBOT_TS_MODEL_CONNECTION_KEY_PATH: join(directory, "objects", "model-connections.key"),
      OPENBOT_TS_PLUGIN_LOCAL_ENDPOINTS: JSON.stringify([plugins.endpoint]),
      ...(publisher ? { OPENBOT_CONTROL_PUBLISHER_DIRECTORY: publisherDirectory, OPENBOT_CONTROL_PUBLISHER_PASSPHRASE_FILE: publisherPassphrase } : {}),
      ...(options.tlsDirectory ? { OPENBOT_TS_TLS_CERT_PATH: join(options.tlsDirectory, "server.pem"), OPENBOT_TS_TLS_KEY_PATH: join(options.tlsDirectory, "server.key") } : {}),
    };
    const start = async () => {
      signal.throwIfAborted();
      child = processes.start(process.execPath, ["scripts/ts-model-fixture.ts", modelReceipt], env);
      for (let attempt = 0; attempt < 160; attempt++) {
        signal.throwIfAborted(); assert(child.exitCode === null && child.signalCode === null, "Owned Server exited before health.");
        try { const response = await fetch(baseUrl + "/health", { signal: AbortSignal.timeout(1000) }); if (response.ok) { await response.arrayBuffer(); return; } await response.arrayBuffer(); } catch { /* Only await the process started above. */ }
        await delay(250, undefined, { signal });
      }
      throw new Error("Owned Server did not become healthy.");
    };
    const stopCurrent = async () => {
      assert(child && child.exitCode === null && child.signalCode === null);
      const old = child;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { old.kill("SIGKILL"); reject(new Error("Server restart stop deadline.")); }, 12000);
        old.once("exit", (code, exitSignal) => { clearTimeout(timer); code === 0 || exitSignal === "SIGTERM" ? resolve() : reject(new Error("Server failed during restart.")); });
        old.kill("SIGTERM");
      });
      await assert.rejects(fetch(baseUrl + "/health", { signal: AbortSignal.timeout(1000) }));
      return old.pid;
    };
    const restart = async () => { const prior = await stopCurrent(); await start(); assert(child?.pid !== prior, "Restart must replace the actual process."); };
    const whileStopped = async (operation: () => Promise<void>) => { await stopCurrent(); try { await operation(); } finally { await start(); } };
    await prepareProduct(env);
    await start();
    const login = await fetch(baseUrl + "/api/v1/auth/login", { method: "POST", headers: { Origin: baseUrl, "Content-Type": "application/json" }, body: JSON.stringify({ password }), signal: AbortSignal.timeout(10000), redirect: "error" });
    assert.equal(login.status, 200); await login.arrayBuffer();
    const setCookie = login.headers.get("set-cookie"); assert(setCookie && setCookie.includes("HttpOnly") && setCookie.includes("SameSite=strict"));
    if (options.tlsDirectory) assert(setCookie.startsWith("__Host-openbot_session=") && setCookie.includes("Secure") && setCookie.includes("Path=/") && !/;\s*Domain=/iu.test(setCookie));
    const cookie = setCookie.split(";")[0]!;
    return { root, directory, dsn, databaseUrl: dsn, origin: baseUrl, baseUrl, password, cookie, setCookie, plugins, publisher, modelReceipt, processes, restart, whileStopped, close, objectRoot: join(directory, "objects"), modelKeyPath: env.OPENBOT_TS_MODEL_CONNECTION_KEY_PATH };
  } catch (error) { await close(); throw error; }
}
