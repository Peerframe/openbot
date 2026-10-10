/** Runs the real container entry with disposable PostgreSQL, mTLS Temporal and HTTPS; no model calls. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { allowlistedEnvironment, OwnedDockerFixture, startControlPostgres } from "../../scripts/python-acceptance-fixture.ts";
import { startTemporalFixture } from "../../scripts/temporal-fixture.ts";
import { issueTlsFixture } from "../../scripts/tls-fixture.ts";
const [image] = process.argv.slice(2);
assert(image && process.argv.length === 3 && /^[a-zA-Z0-9./:_@-]+$/.test(image), "Supply one locally built product image.");
const root = fileURLToPath(new URL("../../", import.meta.url));
const docker = new OwnedDockerFixture(root, allowlistedEnvironment(["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]));
const directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-container-")));
const id = randomUUID(), label = { key: "openbot.fixture", value: id };
const configuration = `openbot-config-${id}`, data = `openbot-data-${id}`, volumes: string[] = [];
let productName: string | undefined;
let temporal: Awaited<ReturnType<typeof startTemporalFixture>> | undefined;
const create = (name: string, args: string[]) => {
  docker.run(["create", "--name", name, "--label", docker.reserveContainer(name, label, "single Server container", "daemon"), ...args]);
};
try {
  temporal = await startTemporalFixture();
  const engineId = temporal.profile.command(["ps", "-q", "temporal"]).trim();
  const networks = JSON.parse(docker.run(["inspect", "--format", "{{json .NetworkSettings.Networks}}", engineId]));
  const frontend = Object.keys(networks).filter((name) => name.endsWith("_frontend"));
  assert.equal(frontend.length, 1); const network = frontend[0]!;
  const pgName = "openbot-product-pg-" + id;
  const url = new URL(await startControlPostgres(docker, pgName, randomBytes(24).toString("hex")));
  docker.run(["network", "connect", "--alias", "product-db", network, pgName]);
  url.hostname = "product-db"; url.port = "5432";
  const tls = await issueTlsFixture(directory, "serverAuth", "entry.test");
  for (const [source, name] of [[temporal.settings.tls.ca, "temporal-ca.pem"], [temporal.settings.tls.certificate, "temporal-client.pem"], [temporal.settings.tls.key, "temporal-client.key"]])
    await copyFile(source!, join(directory, name!));
  await writeFile(join(directory, "temporal.json"), JSON.stringify({ temporal_address: "temporal:7233", namespace: "default", queue: "openbot-product-smoke-" + id,
    tls: { ca: "/run/openbot/temporal-ca.pem", certificate: "/run/openbot/temporal-client.pem", key: "/run/openbot/temporal-client.key", server_name: temporal.settings.tls.server_name } }), { mode: 0o600 });
  for (const name of [configuration, data]) { volumes.push(name); docker.run(["volume", "create", "--label", `${label.key}=${label.value}`, name]); }
  const init = "openbot-product-init-" + id;
  const initialize = `const fs=require('node:fs'); for(const d of ['/run/openbot','/var/lib/openbot','/var/lib/openbot/objects','/var/lib/openbot/artifacts']){fs.mkdirSync(d,{recursive:true});fs.chmodSync(d,0o700);fs.chownSync(d,1000,1000);} for(const n of ['server.pem','server.key','ca.pem','temporal-ca.pem','temporal-client.pem','temporal-client.key','temporal.json']){const p='/run/openbot/'+n;fs.copyFileSync('/source/'+n,p);fs.chmodSync(p,0o600);fs.chownSync(p,1000,1000);}`;
  create(init, ["--user", "0:0", "--mount", `type=bind,source=${directory},target=/source,readonly`, "--volume", `${configuration}:/run/openbot`, "--volume", `${data}:/var/lib/openbot`, "--entrypoint", "node", image, "-e", initialize]);
  docker.run(["start", "--attach", init]); assert.equal(docker.run(["inspect", "--format", "{{.State.ExitCode}}", init]), "0");
  const name = "openbot-product-" + id, password = randomBytes(24).toString("hex");
  productName = name;
  const env = {
    OPENBOT_TS_PUBLIC_ORIGIN: "https://entry.test:3001", OPENBOT_TS_DATABASE_URL: url.href, OPENBOT_TS_OWNER_PASSWORD: password,
    OPENBOT_TS_AUTH_ALLOWED_ORIGINS: "https://entry.test:3001", OPENBOT_TS_READ_ALLOWED_ORIGINS: "https://entry.test:3001", OPENBOT_TS_WRITE_ALLOWED_ORIGINS: "https://entry.test:3001",
    OPENBOT_TS_TLS_CERT_PATH: "/run/openbot/server.pem", OPENBOT_TS_TLS_KEY_PATH: "/run/openbot/server.key", OPENBOT_TS_HEALTH_CA_PATH: "/run/openbot/ca.pem", OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH: "/run/openbot/temporal.json",
  };
  create(name, ["--network", network, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777", "--volume", `${configuration}:/run/openbot:ro`, "--volume", `${data}:/var/lib/openbot`, "--publish", "127.0.0.1::3001", ...Object.entries(env).flatMap(([k,v]) => ["--env", `${k}=${v}`]), image]);
  docker.run(["start", name]);
  const binding = docker.run(["port", name, "3001/tcp"]); assert.match(binding, /^127\.0\.0\.1:\d+$/);
  const ca = await readFile(tls.caPath); let port = Number(binding.split(":")[1]);
  const api = (path: string, method = "GET", body?: unknown, cookie?: string) => new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, servername: "entry.test", ca, path, method, timeout: 10000,
      headers: { Host: "entry.test:3001", Origin: env.OPENBOT_TS_PUBLIC_ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) } }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("error", reject); response.on("data", (b: Buffer) => { bytes += b.length; if (bytes > 1024 * 1024) response.destroy(new Error("Smoke response limit")); else chunks.push(b); });
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
    }); req.on("error", reject); req.on("timeout", () => req.destroy(new Error("Smoke deadline"))); req.end(body ? JSON.stringify(body) : undefined);
  });
  const ready = async () => {
    for (let n = 0; n < 180; n++) {
      assert.equal(docker.run(["inspect", "--format", "{{.State.Running}}", name]), "true", "Container exited before ready");
      try { const r = await api("/health"); if (r.status === 200) { assert.equal(JSON.parse(r.text).execution.owner, "typescript-v1"); return; } } catch { /* Bounded startup only. */ }
      await delay(250);
    }
    throw new Error("Container health deadline");
  };
  await ready();
  assert.equal(docker.run(["exec", name, "node", "deploy/server/product-health.ts"]), "");
  const index = await api("/"); assert.equal(index.status, 200); assert.match(index.text, /<html/);
  const login = await api("/api/v1/auth/login", "POST", { password }); assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"]?.[0]?.split(";")[0]; assert(cookie?.startsWith("__Host-openbot_session="));
  assert(login.headers["set-cookie"]?.[0]?.includes("Secure"));
  const channel = await api("/api/v1/channels", "POST", { name: "Disposable container restart" }, cookie); assert.equal(channel.status, 201);
  const saved = JSON.parse(channel.text).channel.id;
  const parserClient = await readFile(new URL("./product-smoke-client.mjs", import.meta.url), "utf8");
  const parserReceipts = [JSON.parse(docker.run(["exec", name, "node", "--input-type=module", "-e", parserClient, "create"], 180000))];
  const before = docker.run(["inspect", "--format", "{{.State.StartedAt}}", name]);
  docker.run(["restart", "--time", "15", name]);
  const restartedBinding = docker.run(["port", name, "3001/tcp"]); assert.match(restartedBinding, /^127\.0\.0\.1:\d+$/);
  port = Number(restartedBinding.split(":")[1]); await ready();
  parserReceipts.push(JSON.parse(docker.run(["exec", name, "node", "--input-type=module", "-e", parserClient, "restart"], 90000)));
  assert.notEqual(docker.run(["inspect", "--format", "{{.State.StartedAt}}", name]), before);
  const channels = await api("/api/v1/channels", "GET", undefined, cookie); assert.equal(channels.status, 200); assert(channels.text.includes(saved));
  const inventory = docker.run(["exec", name, "node", "-e", `const fs=require('node:fs'); console.log(JSON.stringify({uid:process.getuid(),pid1:fs.readFileSync('/proc/1/cmdline','utf8').split('\\0').filter(Boolean),python:fs.existsSync('/workspace/apps/server-python'),migrations:fs.readdirSync('/workspace/packages/db/migrations').filter(n=>n.endsWith('.sql')).length}));`]);
  const details = JSON.parse(inventory); assert.equal(details.uid,1000); assert.equal(details.python,false); assert.deepEqual(details.pid1,["node","deploy/server/product-entry.ts"]); assert.equal(details.migrations,58);
  docker.run(["stop", "--time", "15", name]); assert.equal(docker.run(["inspect", "--format", "{{.State.ExitCode}}", name]), "0");
  await assert.rejects(api("/health"));
  console.log(JSON.stringify({ passed:true, syntheticOnly:true, modelCalls:0, parserReceipts, https:true, ownerSessionRestart:true, singleNode:true, sqlMigrations:58, nonroot:true }));
} catch (failure) {
  if (productName) console.error("Owned synthetic container diagnostics", docker.run(["logs", "--tail", "40", productName]));
  throw failure;
} finally {
  try { docker.cleanup(); } finally {
    for (const name of volumes) { const labels = JSON.parse(docker.run(["volume", "inspect", "--format", "{{json .Labels}}", name])); assert.equal(labels[label.key],label.value); docker.run(["volume","rm",name]); }
    await temporal?.close(); await rm(directory,{recursive:true,force:true});
  }
}
