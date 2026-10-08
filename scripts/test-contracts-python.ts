import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createDatabase } from "@openbot/db";
import {
  automationHttpOperations,
  browserHttpOperations,
  controlHttpOperations,
  employeeHttpOperations,
  lifecycleHttpOperations,
  nodeHttpOperations,
  pluginHttpOperations,
  portabilityHttpOperations,
  resourceHttpOperations,
  workHttpOperations,
} from "@openbot/protocol";
import { DevProcessOwner } from "./dev-processes.ts";
import {
  allowlistedEnvironment,
  OwnedDockerFixture,
  startControlPostgres,
} from "./python-acceptance-fixture.ts";
import { qualifyChannelReads } from "./ts-channel-read-acceptance.ts";
import { qualifyOwnerAuth } from "./ts-owner-auth-acceptance.ts";
import { qualifyPrimaryBotWrite } from "./ts-primary-bot-acceptance.ts";
import { qualifyTranscriptionRead } from "./ts-transcription-acceptance.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const suites = [
  "all",
  "work",
  "resources",
  "lifecycle",
  "employee",
  "automations",
  "browser",
  "portability",
  "publisher",
  "models",
  "nodes",
  "artifacts",
  "plugins",
  "control",
];
let selectedSuite = "all",
  inventory = false,
  selected = false,
  entry = "python",
  entrySelected = false,
  tls = false;
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === "--inventory" && !inventory) inventory = true;
  else if (argument === "--tls" && !tls) tls = true;
  else if (argument === "--suite" && !selected) {
    selectedSuite = args[++index] ?? "";
    assert(suites.includes(selectedSuite), "Unknown or missing contract suite.");
    selected = true;
  } else if (argument === "--entry" && !entrySelected) {
    entry = args[++index] ?? "";
    assert(entry === "python" || entry === "ts", "Unknown or missing contract entry.");
    entrySelected = true;
  } else
    throw new Error(
      "Use [--entry python|ts] [--suite NAME] [--inventory] [--tls]; options must not repeat.",
    );
}
assert(!inventory || selectedSuite === "all", "Inventory requires the complete all-suite run.");
assert(!inventory || entry === "python", "Inventory records the actual Python registrations.");
const tlsDirectory = tls ? process.env.OPENBOT_CONTRACT_TLS_DIRECTORY : undefined;
assert(
  !tls ||
    (entry === "ts" &&
      !inventory &&
      tlsDirectory &&
      process.env.NODE_EXTRA_CA_CERTS === join(tlsDirectory, "ca.pem")),
  "TLS requires the owned test-contracts-tls wrapper and TS entry.",
);
const environment = allowlistedEnvironment([
  "PATH",
  "HOME",
  "TMPDIR",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
]);
const docker = new OwnedDockerFixture(root, environment);
const processes = new DevProcessOwner({ cwd: root });
const directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-contract-")));
const abort = new AbortController();
const stop = () => {
  abort.abort();
  void processes.stop();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const dsn = await startControlPostgres(
    docker,
    `openbot-contract-${randomUUID()}`,
    randomBytes(24).toString("hex"),
  );
  const database = createDatabase(dsn);
  try {
    await database.migrate();
  } finally {
    await database.close();
  }
  const availablePort = async () => {
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    assert(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    return port;
  };
  const port = await availablePort();
  const baseUrl = `${tls ? "https" : "http"}://127.0.0.1:${port}`;
  const pythonPort = entry === "ts" ? await availablePort() : port;
  assert(entry === "python" || pythonPort !== port, "Private/public ports must differ.");
  const pluginPort = await availablePort();
  const plugins = {
    endpoint: `http://127.0.0.1:${pluginPort}/mcp`,
    token: randomBytes(32).toString("hex"),
    controllerToken: randomBytes(32).toString("hex"),
  };
  const pluginConfig = join(directory, "mcp-fixture.json");
  await writeFile(
    pluginConfig,
    JSON.stringify({
      port: pluginPort,
      token: plugins.token,
      controllerToken: plugins.controllerToken,
    }),
    { mode: 0o600 },
  );
  const pluginChild = processes.start(
    join(root, "apps/server-python/.worker-venv/bin/python"),
    ["-I", "-B", "apps/server-python/scripts/contract-plugin-fixture.py", pluginConfig],
    allowlistedEnvironment(["PATH", "HOME", "TMPDIR"]),
  );
  let pluginReady = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    abort.signal.throwIfAborted();
    assert(
      pluginChild.exitCode === null && pluginChild.signalCode === null,
      "Owned MCP fixture exited before readiness.",
    );
    try {
      pluginReady = (
        await fetch(`http://127.0.0.1:${pluginPort}/fixture-control`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(1000),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${plugins.controllerToken}`,
          },
          body: "{}",
        })
      ).ok;
    } catch {
      /* Await only the owned loopback fixture. */
    }
    if (pluginReady) break;
    await delay(250, undefined, { signal: abort.signal });
  }
  assert(pluginReady, "Owned MCP fixture did not become ready.");
  const password = randomBytes(24).toString("hex");
  let publisher: { keyid: string; publicKey: string } | undefined;
  const publisherDirectory = join(directory, "publisher"),
    publisherPassphrase = join(directory, "publisher-secret", "passphrase");
  if (selectedSuite === "publisher") {
    // Call the retained offline CLI directly with an allowlist; never load the user's .env.
    const keyChild = processes.start(
      process.execPath,
      [
        "scripts/employee-publisher-key.ts",
        "init",
        "--keyring",
        publisherDirectory,
        "--passphrase-file",
        publisherPassphrase,
      ],
      allowlistedEnvironment(["PATH", "HOME", "TMPDIR"]),
    );
    const deadline = setTimeout(() => keyChild.kill("SIGTERM"), 15000);
    try {
      await processes.waitSuccess(keyChild);
    } finally {
      clearTimeout(deadline);
    }
    const manifest = JSON.parse(await readFile(join(publisherDirectory, "trust.json"), "utf8"));
    const active = manifest.keys.find(
      (entry: { keyid: string }) => entry.keyid === manifest.activeKeyId,
    );
    assert(active && typeof active.publicKey === "string");
    publisher = { keyid: active.keyid, publicKey: active.publicKey };
  }
  for (const name of ["objects", "artifacts"]) await mkdir(join(directory, name), { mode: 0o700 });
  const modelReceipt = join(directory, "model-receipt.json");
  if (selectedSuite === "models") await writeFile(modelReceipt, "{}", { mode: 0o600 });
  const startPython = (proxy: boolean, readGroup = proxy) =>
    processes.start(
      join(root, "apps/server-python/.worker-venv/bin/python"),
      selectedSuite === "models"
        ? ["-I", "-B", "apps/server-python/scripts/contract-model-fixture.py", modelReceipt]
        : ["-I", "-B", "apps/server-python/scripts/serve.py"],
      {
        ...allowlistedEnvironment(["PATH", "HOME", "TMPDIR"]),
        OPENBOT_CONTROL_AUTHORITY: "product",
        OPENBOT_CONTROL_DATABASE_URL: dsn,
        OPENBOT_CONTROL_OWNER_PASSWORD: password,
        OPENBOT_CONTROL_HOST: "127.0.0.1",
        OPENBOT_CONTROL_PORT: String(proxy ? pythonPort : port),
        OPENBOT_CONTROL_COOKIE_MODE: tls ? "secure" : "loopback",
        OPENBOT_CONTROL_ALLOWED_ORIGINS: `${baseUrl},https://secondary.example.test`,
        ...(proxy
          ? {
              OPENBOT_CONTROL_PROXY_ADDRESS: "127.0.0.1",
              OPENBOT_CONTROL_TS_READ_GROUP: readGroup ? "transcription" : "none",
              OPENBOT_CONTROL_TS_WRITE_GROUP: readGroup ? "primary-bot" : "none",
              OPENBOT_CONTROL_TS_AUTH_GROUP: readGroup ? "owner" : "none",
              OPENBOT_CONTROL_TS_CHANNEL_READ_GROUP: readGroup ? "channels" : "none",
              OPENBOT_CONTROL_PUBLIC_ORIGIN: baseUrl,
            }
          : {}),
        OPENBOT_CONTROL_OBJECT_ROOT: join(directory, "objects"),
        OPENBOT_CONTROL_ARTIFACT_ROOT: join(directory, "artifacts"),
        OPENBOT_CONTROL_NODE_EXECUTABLE: process.execPath,
        OPENBOT_CONTROL_NODE_MODULE_ROOT: join(root, "node_modules"),
        OPENBOT_CONTROL_PLUGIN_LOCAL_ENDPOINTS: JSON.stringify([plugins.endpoint]),
        ...(publisher
          ? {
              OPENBOT_CONTROL_PUBLISHER_DIRECTORY: publisherDirectory,
              OPENBOT_CONTROL_PUBLISHER_PASSPHRASE_FILE: publisherPassphrase,
            }
          : {}),
      },
    );
  const startEntry = (readGroup = true) =>
    processes.start(process.execPath, ["apps/server-ts/dist/serve.js"], {
      ...allowlistedEnvironment(["PATH", "HOME", "TMPDIR"]),
      OPENBOT_TS_PYTHON_ORIGIN: `http://127.0.0.1:${pythonPort}`,
      OPENBOT_TS_PUBLIC_ORIGIN: baseUrl,
      OPENBOT_TS_HOST: "127.0.0.1",
      OPENBOT_TS_PORT: String(port),
      OPENBOT_TS_READ_GROUP: readGroup ? "transcription" : "none",
      OPENBOT_TS_WRITE_GROUP: readGroup ? "primary-bot" : "none",
      OPENBOT_TS_AUTH_GROUP: readGroup ? "owner" : "none",
      OPENBOT_TS_CHANNEL_READ_GROUP: readGroup ? "channels" : "none",
      OPENBOT_TS_OWNER_PASSWORD: password,
      OPENBOT_TS_AUTH_ALLOWED_ORIGINS: `${baseUrl},https://secondary.example.test`,
      OPENBOT_TS_WRITE_ALLOWED_ORIGINS: `${baseUrl},https://secondary.example.test`,
      OPENBOT_TS_READ_ALLOWED_ORIGINS: `${baseUrl},https://secondary.example.test`,
      OPENBOT_TS_DATABASE_URL: dsn,
      ...(tlsDirectory
        ? {
            OPENBOT_TS_TLS_CERT_PATH: join(tlsDirectory, "server.pem"),
            OPENBOT_TS_TLS_KEY_PATH: join(tlsDirectory, "server.key"),
          }
        : {}),
    });
  let child = startPython(entry === "ts");
  let entryChild = entry === "ts" ? startEntry() : undefined;
  const waitReady = async () => {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      abort.signal.throwIfAborted();
      assert(
        child.exitCode === null && child.signalCode === null,
        "Disposable product exited before health.",
      );
      if (entryChild)
        assert(
          entryChild.exitCode === null && entryChild.signalCode === null,
          "Disposable TS entry exited before health.",
        );
      try {
        ready = (
          await fetch(`${baseUrl}/health`, {
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
      } catch {
        /* Await only this owned process, never another configured server. */
      }
      if (ready) break;
      await delay(250, undefined, { signal: abort.signal });
    }
    assert(ready, "Disposable Python product did not become healthy.");
  };
  const stopOwned = async (target: ChildProcess) => {
    assert(target.exitCode === null && target.signalCode === null, "Switch target must be alive.");
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        target.kill("SIGKILL");
        reject(new Error("Owned product did not stop within the switch deadline."));
      }, 12000);
      target.once("exit", (code, signal) => {
        clearTimeout(deadline);
        if (code === 0 || signal === "SIGTERM") resolve();
        else reject(new Error("Owned product failed during the switch."));
      });
      target.kill("SIGTERM");
    });
  };
  await waitReady();
  const headers = { Origin: baseUrl, "Content-Type": "application/json" };
  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assert(setCookie);
  assert(setCookie?.includes("HttpOnly") && setCookie.includes("SameSite=strict"));
  if (tls)
    assert(
      setCookie.startsWith("__Host-openbot_session=") &&
        setCookie.includes("Secure") &&
        setCookie.includes("Path=/") &&
        !/;\s*Domain=/iu.test(setCookie),
    );
  if (tls && selectedSuite === "all") {
    const redirect = await fetch(`${baseUrl}/api/v1/bots/`, {
      headers: { Cookie: setCookie.split(";")[0]! },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(redirect.status, 307);
    assert.equal(redirect.headers.get("location"), `${baseUrl}/api/v1/bots`);
    await redirect.arrayBuffer();
    const privateResponse = await fetch(`http://127.0.0.1:${pythonPort}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(privateResponse.status, 400);
    await privateResponse.arrayBuffer();
    const snapshot = async () => {
      const result = await fetch(`${baseUrl}/api/v1/auth/session`, {
        headers: { Cookie: setCookie.split(";")[0]! },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(result.status, 200);
      return result.json();
    };
    const before = await snapshot();
    assert(entryChild);
    const oldEntry = entryChild;
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("TLS entry did not close within its deadline.")),
        10000,
      );
      oldEntry.once("exit", (code, signal) => {
        clearTimeout(deadline);
        code === 0 || signal === "SIGTERM"
          ? resolve()
          : reject(new Error("TLS entry failed on stop."));
      });
      oldEntry.kill("SIGTERM");
    });
    await assert.rejects(fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) }));
    entryChild = startEntry();
    await waitReady();
    assert.deepEqual(await snapshot(), before);
    console.log(
      "TLS entry restart retained the same HTTPS URL and secure Owner session; private Python retained the forwarded operations. Canonical HTTPS redirect and private direct refusal passed.",
    );
  }
  let cookie = setCookie.split(";")[0]!;
  assert(cookie);
  const created = await fetch(`${baseUrl}/api/v1/bots`, {
    method: "POST",
    headers: { ...headers, Cookie: cookie },
    body: JSON.stringify({
      name: "Contract fixture",
      role: "Synthetic validation",
      computerProfile: "none",
    }),
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  assert.equal(created.status, 201);
  const bot: unknown = await created.json();
  assert(bot && typeof bot === "object" && "bot" in bot);
  const value = bot.bot;
  assert(value && typeof value === "object" && "id" in value && typeof value.id === "string");
  if (entry === "ts" && !tls && selectedSuite === "all") {
    const snapshot = async () => {
      const response = await fetch(`${baseUrl}/api/v1/bots`, {
        headers: { Cookie: cookie },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const before = await snapshot();
    assert(entryChild);
    await stopOwned(entryChild);
    await stopOwned(child);
    entryChild = undefined;
    child = startPython(false);
    await waitReady();
    assert.deepEqual(
      await snapshot(),
      before,
      "Direct reverse switch must retain the issued session and Bot data.",
    );
    await stopOwned(child);
    child = startPython(true);
    entryChild = startEntry();
    await waitReady();
    assert.deepEqual(
      await snapshot(),
      before,
      "Mixed entry restoration must retain the same session and data.",
    );
    console.log(
      "Mixed → direct Python → mixed switch retained the public URL, SQL Bot and issued Owner session; one writer at each step.",
    );
  }
  if (entry === "ts" && ["all", "control", "resources"].includes(selectedSuite)) {
    const ownershipAcceptance = {
      databaseUrl: dsn,
      origin: baseUrl,
      privateOrigin: `http://127.0.0.1:${pythonPort}`,
      cookie,
      async stopPython() {
        await stopOwned(child);
      },
      async restorePython() {
        child = startPython(true);
        await waitReady();
      },
      async reverseToPython() {
        assert(entryChild);
        await stopOwned(entryChild);
        await stopOwned(child);
        child = startPython(true, false);
        entryChild = startEntry(false);
        await waitReady();
      },
      async restoreTs() {
        assert(entryChild);
        await stopOwned(entryChild);
        await stopOwned(child);
        child = startPython(true);
        entryChild = startEntry();
        await waitReady();
      },
    };
    await qualifyTranscriptionRead(ownershipAcceptance);
    await qualifyPrimaryBotWrite(ownershipAcceptance);
    cookie = await qualifyOwnerAuth({ ...ownershipAcceptance, password });
    await qualifyChannelReads({ ...ownershipAcceptance, cookie });
  }
  // This owned database has no Worker. Seed publication states so HTTP decision/unread
  // contracts exercise real transactions without claiming execution by a production Host.
  const lifecycle = {
    channelId: randomUUID(),
    unreadMessageId: randomUUID(),
    approvals: {
      approve: randomUUID(),
      reject: randomUUID(),
      expired: randomUUID(),
    },
  };
  const employee = {
    botId: randomUUID(),
    sourceRunId: randomUUID(),
    sourceTaskId: randomUUID(),
    sourceWorkRunId: randomUUID(),
    proposals: {
      accept: randomUUID(),
      reject: randomUUID(),
      native: randomUUID(),
      incomplete: randomUUID(),
    },
  };
  const nodes = {
    expiredNodeId: `expired-${randomUUID()}`,
    expiredToken: `obenr_${randomBytes(32).toString("base64url")}`,
  };
  const workIntent = JSON.stringify({ operation: "synthetic.no-effect" });
  const work = {
    taskId: randomUUID(),
    intentDigest: createHash("sha256").update(workIntent).digest("hex"),
    actions: {
      approve: randomUUID(),
      reject: randomUUID(),
      expired: randomUUID(),
      stale: randomUUID(),
      unknown: randomUUID(),
    },
  };
  // Author a one-pixel RGBA PNG using the standard chunk/CRC format; no copied image asset.
  const pngChunk = (type: string, data: Buffer) => {
    const framed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    let crc = 0xffffffff;
    for (const byte of framed) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, framed, checksum]);
  };
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", Buffer.from("00000001000000010806000000", "hex")),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  const artifacts = {
    valid: [
      {
        id: randomUUID(),
        name: "Fixture 报告.md",
        mediaType: "text/markdown",
        base64: Buffer.from(
          "\ufeff# Synthetic report\r\nExact 文档 🧪 bytes.\r\n",
          "utf8",
        ).toString("base64"),
      },
      {
        id: randomUUID(),
        name: "Fixture 图像.png",
        mediaType: "image/png",
        base64: png.toString("base64"),
      },
    ],
    integrity: randomUUID(),
    refusedKey: randomUUID(),
    symlink: randomUUID(),
    oversized: randomUUID(),
  };
  const native = {
    taskId: employee.sourceTaskId,
    valid: [
      ...artifacts.valid.map((file) => ({ ...file, id: randomUUID() })),
      {
        id: randomUUID(),
        name: "Fixture empty 'opaque'.bin",
        mediaType: "application/octet-stream",
        base64: "",
      },
    ],
    integrity: randomUUID(),
    sizeMismatch: randomUUID(),
    missing: randomUUID(),
    symlink: randomUUID(),
    oversized: randomUUID(),
  };
  const nativeRecords = native.valid.map((file) => {
    const bytes = Buffer.from(file.base64, "base64");
    return {
      ...file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    };
  });
  for (const file of nativeRecords)
    await writeFile(join(directory, "artifacts", file.sha256), Buffer.from(file.base64, "base64"), {
      mode: 0o600,
    });
  const publishedDirectory = join(directory, "objects", "runs", employee.sourceRunId);
  await mkdir(publishedDirectory, { recursive: true, mode: 0o700 });
  for (const file of artifacts.valid)
    await writeFile(
      join(publishedDirectory, `${file.id}.${file.mediaType === "image/png" ? "png" : "md"}`),
      Buffer.from(file.base64, "base64"),
      { mode: 0o600 },
    );
  const sentinel = Buffer.from("Synthetic private artifact sentinel", "utf8");
  await writeFile(join(publishedDirectory, `${artifacts.integrity}.md`), sentinel, { mode: 0o600 });
  await writeFile(
    join(publishedDirectory, `${artifacts.oversized}.md`),
    Buffer.alloc(5 * 1024 * 1024 + 1),
    { mode: 0o600 },
  );
  const privateArtifact = join(directory, "private-artifact-sentinel");
  await writeFile(privateArtifact, sentinel, { mode: 0o600 });
  await symlink(privateArtifact, join(publishedDirectory, `${artifacts.symlink}.md`));
  const nativeRefusals = [
    {
      id: native.integrity,
      kind: "integrity",
      sha256: createHash("sha256").update("Synthetic expected native bytes").digest("hex"),
      sizeBytes: sentinel.length,
    },
    {
      id: native.sizeMismatch,
      kind: "sizeMismatch",
      sha256: createHash("sha256").update("Synthetic native size mismatch").digest("hex"),
      sizeBytes: Buffer.byteLength("Synthetic native size mismatch") + 1,
    },
    {
      id: native.missing,
      kind: "missing",
      sha256: createHash("sha256").update("Synthetic missing native file").digest("hex"),
      sizeBytes: 0,
    },
    {
      id: native.symlink,
      kind: "symlink",
      sha256: createHash("sha256").update(sentinel).digest("hex"),
      sizeBytes: sentinel.length,
    },
    {
      id: native.oversized,
      kind: "oversized",
      sha256: createHash("sha256").update("Synthetic native oversized descriptor").digest("hex"),
      sizeBytes: 8 * 1024 * 1024,
    },
  ];
  for (const file of nativeRefusals) {
    const path = join(directory, "artifacts", file.sha256);
    if (file.kind === "missing") continue;
    if (file.kind === "symlink") await symlink(privateArtifact, path);
    else
      await writeFile(
        path,
        file.kind === "oversized"
          ? Buffer.alloc(8 * 1024 * 1024 + 1)
          : file.kind === "sizeMismatch"
            ? Buffer.from("Synthetic native size mismatch")
            : sentinel,
        { mode: 0o600 },
      );
  }
  const seed = createDatabase(dsn);
  try {
    await seed.client.begin(async (sql) => {
      const digest = createHash("sha256")
        .update(`openbot:enrollment:${nodes.expiredToken}`)
        .digest("hex");
      await sql`INSERT INTO node_enrollment_tokens(id,node_id,token_digest,expires_at,created_at) VALUES (${randomUUID()},${nodes.expiredNodeId},${digest},clock_timestamp()-interval '1 second',clock_timestamp()-interval '10 minutes')`;
      const seedBot = randomUUID(),
        node = randomUUID();
      await sql`INSERT INTO bots(id,name,role,computer_profile) VALUES (${seedBot},'Synthetic published states','Synthetic fixture','none')`;
      const workRun = randomUUID();
      await sql`INSERT INTO work_tasks(id,owner_id,bot_id,request_key,request_digest,objective,token_limit,status) VALUES (${work.taskId},'owner',${seedBot},${randomUUID()},${work.intentDigest},'Synthetic action publication',0,'open')`;
      await sql`INSERT INTO work_runs(id,task_id,ordinal,status) VALUES (${workRun},${work.taskId},1,'running')`;
      for (const [kind, id] of Object.entries(work.actions))
        await sql`INSERT INTO work_actions(id,task_id,run_id,action_key,intent,intent_digest,authority_generation,requires_approval,baseline_requires_approval,decision,status,expires_at,reserved_tokens) VALUES (${id},${work.taskId},${workRun},${kind},${workIntent}::jsonb,${work.intentDigest},${kind === "stale" ? 2 : 1},true,true,${kind === "unknown" ? "approved" : "pending"},${kind === "unknown" ? "unknown" : "proposed"},clock_timestamp()+${kind === "expired" ? "-10 minutes" : "10 minutes"}::interval,0)`;
      await sql`INSERT INTO channels(id,name,description) VALUES (${lifecycle.channelId},'Synthetic published channel','Fixture only')`;
      await sql`INSERT INTO channel_bots(channel_id,bot_id) VALUES (${lifecycle.channelId},${seedBot})`;
      await sql`INSERT INTO messages(id,channel_id,author_type,content,created_at) VALUES (${lifecycle.unreadMessageId},${lifecycle.channelId},'bot','Synthetic published unread message',clock_timestamp())`;
      await sql`INSERT INTO nodes(id,name,platform,status) VALUES (${node},'Synthetic offline Host','linux','offline')`;
      for (const [kind, approval] of Object.entries(lifecycle.approvals)) {
        const run = randomUUID();
        await sql`INSERT INTO runs(id,channel_id,bot_id,execution_profile,instruction,title,status) VALUES (${run},${lifecycle.channelId},${seedBot},'none','Synthetic private Run instruction','Synthetic publication','waiting_approval')`;
        await sql`INSERT INTO approvals(id,run_id,node_id,action,target,summary,risk,target_fingerprint,expires_at) VALUES (${approval},${run},${node},'fixture.write','synthetic fixture','Synthetic confirmation','write',${"a".repeat(64)},clock_timestamp()+ ${kind === "expired" ? "-10 minutes" : "10 minutes"}::interval)`;
      }
      await sql`INSERT INTO run_events(id,channel_id,bot_id,type,payload) VALUES (${randomUUID()},${lifecycle.channelId},${seedBot},'SETTINGS_PRIMARY_BOT_UPDATED',${JSON.stringify({ previousBotId: null, primaryBotId: seedBot, revision: 1, fileName: "😀".repeat(160), name: "😀".repeat(120), privatePayload: "Synthetic audit private sentinel" })}::jsonb)`;
      await sql`INSERT INTO bots(id,name,role,computer_profile) VALUES (${employee.botId},'Synthetic knowledge recipient','Synthetic fixture','none')`;
      await sql`INSERT INTO channel_bots(channel_id,bot_id) VALUES (${lifecycle.channelId},${employee.botId})`;
      for (const kind of ["accept", "reject"] as const) {
        const run = kind === "accept" ? employee.sourceRunId : randomUUID();
        await sql`INSERT INTO runs(id,channel_id,bot_id,execution_profile,instruction,title,status) VALUES (${run},${lifecycle.channelId},${employee.botId},'none','Synthetic publication','Synthetic completed source','completed')`;
        await sql`INSERT INTO knowledge_proposals(id,bot_id,source_run_id,kind,title,content) VALUES (${employee.proposals[kind]},${employee.botId},${run},'semantic','Candidate fact','Synthetic candidate content')`;
      }
      for (const kind of ["native", "incomplete"] as const) {
        const task = kind === "native" ? employee.sourceTaskId : randomUUID();
        const run = kind === "native" ? employee.sourceWorkRunId : randomUUID();
        const complete = kind === "native";
        await sql`INSERT INTO work_tasks(id,owner_id,bot_id,request_key,request_digest,objective,token_limit,status,authority_active,completion_digest) VALUES (${task},'owner',${employee.botId},${randomUUID()},${"b".repeat(64)},'Synthetic native source',0,${complete ? "completed" : "queued"},${!complete},${complete ? "c".repeat(64) : null})`;
        await sql`INSERT INTO work_runs(id,task_id,ordinal,status) VALUES (${run},${task},1,${complete ? "completed" : "queued"})`;
        await sql`INSERT INTO knowledge_proposals(id,bot_id,source_kind,source_work_run_id,kind,title,content) VALUES (${employee.proposals[kind]},${employee.botId},'task',${run},'procedural','Candidate procedure','Synthetic native candidate')`;
      }
      for (const file of artifacts.valid) {
        const bytes = Buffer.from(file.base64, "base64");
        await sql`INSERT INTO artifacts(id,run_id,name,media_type,storage_key,sha256,metadata) VALUES (${file.id},${employee.sourceRunId},${file.name},${file.mediaType},${`runs/${employee.sourceRunId}/${file.id}.${file.mediaType === "image/png" ? "png" : "md"}`},${createHash("sha256").update(bytes).digest("hex")},${JSON.stringify({ sizeBytes: bytes.length })}::jsonb)`;
      }
      for (const kind of ["integrity", "refusedKey", "symlink", "oversized"] as const)
        await sql`INSERT INTO artifacts(id,run_id,name,media_type,storage_key,sha256,metadata) VALUES (${artifacts[kind]},${employee.sourceRunId},'Synthetic refused artifact','text/markdown',${kind === "refusedKey" ? "../private-artifact-sentinel" : `runs/${employee.sourceRunId}/${artifacts[kind]}.md`},${"0".repeat(64)},${JSON.stringify({ sizeBytes: sentinel.length })}::jsonb)`;
      for (const file of [
        ...nativeRecords,
        ...nativeRefusals.map((file) => ({
          ...file,
          name: `Synthetic native ${file.kind}`,
          mediaType: "application/octet-stream",
        })),
      ])
        await sql`INSERT INTO work_artifacts(id,task_id,run_id,artifact_key,name,media_type,sha256,size_bytes) VALUES (${file.id},${employee.sourceTaskId},${employee.sourceWorkRunId},${`native.${file.id}`},${file.name},${file.mediaType},${file.sha256},${file.sizeBytes})`;
    });
  } finally {
    await seed.close();
  }
  const runCli = async (path: string, suite: string) => {
    const contractChild = processes.start(
      process.execPath,
      ["packages/contract-tests/src/cli.ts", "--fixture", path, "--suite", suite],
      allowlistedEnvironment(["PATH", "HOME", "TMPDIR", ...(tls ? ["NODE_EXTRA_CA_CERTS"] : [])]),
    );
    // Parser deadlines, a cancelled browser command and SSE cadence all retain finite budgets.
    const deadline = setTimeout(
      () => contractChild.kill("SIGTERM"),
      suite === "all" ? 180000 : 120000,
    );
    try {
      await processes.waitSuccess(contractChild);
    } finally {
      clearTimeout(deadline);
    }
  };
  const artifactFixture = join(directory, "artifact-fixture.json");
  await writeFile(
    artifactFixture,
    JSON.stringify({
      baseUrl,
      origin: baseUrl,
      cookie,
      botId: value.id,
      artifacts: { ...artifacts, native },
    }),
    { mode: 0o600 },
  );
  if (selectedSuite === "all" || selectedSuite === "artifacts")
    await runCli(artifactFixture, "artifacts");
  // Storage measurement rejects every symlink in its root. Remove only the owned negative
  // fixture after its real no-follow check, preserving the integrated positive storage gate.
  await rm(join(publishedDirectory, `${artifacts.symlink}.md`));
  const nativeSymlink = nativeRefusals.find((file) => file.kind === "symlink");
  assert(nativeSymlink);
  await rm(join(directory, "artifacts", nativeSymlink.sha256));
  const { symlink: qualifiedLink, ...regularArtifacts } = artifacts;
  assert(qualifiedLink);
  const { symlink: nativeQualifiedLink, ...regularNative } = native;
  assert(nativeQualifiedLink);
  const fixture = join(directory, "contract-fixture.json");
  const fullFixture = {
    baseUrl,
    origin: baseUrl,
    cookie,
    botId: value.id,
    password,
    work,
    lifecycle,
    employee,
    nodes,
    artifacts: { ...regularArtifacts, native: regularNative },
    plugins,
    browser: { frameBase64: png.toString("base64") },
    publisher,
  };
  const fields: Record<string, readonly (keyof typeof fullFixture)[]> = {
    all: [],
    work: ["work"],
    resources: [],
    automations: [],
    portability: [],
    publisher: ["publisher"],
    models: [],
    lifecycle: ["lifecycle"],
    employee: ["employee"],
    browser: ["browser"],
    nodes: ["nodes"],
    artifacts: ["artifacts"],
    plugins: ["plugins"],
    control: ["password"],
  };
  const keys: readonly (keyof typeof fullFixture)[] = [
    "baseUrl",
    "origin",
    "cookie",
    "botId",
    ...(fields[selectedSuite] ?? []),
  ];
  await writeFile(
    fixture,
    JSON.stringify(
      selectedSuite === "all"
        ? fullFixture
        : Object.fromEntries(keys.map((key) => [key, fullFixture[key]])),
    ),
    { mode: 0o600 },
  );
  if (selectedSuite === "all" || selectedSuite === "resources") {
    const desktopChild = processes.start(
      process.execPath,
      ["--import", "tsx", "scripts/contract-desktop-fixture.ts", fixture],
      allowlistedEnvironment(["PATH", "HOME", "TMPDIR", ...(tls ? ["NODE_EXTRA_CA_CERTS"] : [])]),
    );
    const deadline = setTimeout(() => desktopChild.kill("SIGTERM"), 30000);
    try {
      await processes.waitSuccess(desktopChild);
    } finally {
      clearTimeout(deadline);
    }
  }
  await runCli(fixture, selectedSuite);
  if (selectedSuite === "all" || selectedSuite === "nodes" || selectedSuite === "browser") {
    const evidence = createDatabase(dsn);
    try {
      const rows =
        await evidence.client`SELECT details FROM node_identity_events WHERE type='enrolled'`;
      assert(rows.length > 0, "The real HTTP/SQL suite must enroll a synthetic Node.");
      const expectedDigest = createHash("sha256")
        .update("openbot:client-network:v1\0" + "127.0.0.1")
        .digest("hex");
      for (const row of rows) {
        assert.equal(row.details.clientIdentityDigest, expectedDigest);
        assert.equal(row.details.clientIdentitySource, entry === "ts" ? "forwarded" : "direct");
      }
      console.log(`Private Node identity source/digest verified through the ${entry} entry.`);
    } finally {
      await evidence.close();
    }
  }
  if (selectedSuite === "models") {
    const receipt = JSON.parse(await readFile(modelReceipt, "utf8"));
    assert.deepEqual(
      receipt,
      {
        discovery: 10,
        probes: 4,
        refused: 0,
        modes: {
          success: 6,
          credentials: 4,
          redirect: 1,
          "invalid-json": 1,
          oversize: 1,
          failure: 1,
        },
      },
      "Unexpected synthetic provider dispatch, retry or fallback.",
    );
    console.log(
      "Owned synthetic provider receipt: 10 discoveries, 4 explicit probes, zero unauthorized dispatch/retry/fallback.",
    );
  }
  console.log(
    `Real Python product + disposable PostgreSQL CLI contracts passed: ${selectedSuite} (no Temporal/live-provider calls).`,
  );
  if (inventory) {
    const consumerInventory = await Promise.all(
      [
        {
          surface: "Web HTTP, SSE, upload and media",
          sources: [
            "apps/web/src/api.ts",
            "apps/web/src/work-api.ts",
            "apps/web/src/native-task-api.ts",
            "apps/web/src/destination-api.ts",
            "apps/web/src/plugin-api.ts",
            "apps/web/src/event-stream.ts",
            "apps/web/src/composer-context.ts",
            "apps/web/src/channel-attachment-client.ts",
            "apps/web/src/components/PluginManagerPanel.tsx",
            "apps/web/src/components/PluginInstallForm.tsx",
            "apps/web/src/components/PluginPlatformPanels.tsx",
            "apps/web/src/components/PluginCallApprovals.tsx",
            "apps/web/src/components/AttachmentsManager.tsx",
            "apps/web/src/components/ShareConversationDialog.tsx",
            "apps/web/src/components/ArtifactCard.tsx",
            "apps/web/src/components/TaskCard.tsx",
            "apps/web/src/components/TaskSheet.tsx",
            "apps/web/src/components/WorkTasksScreen.tsx",
          ],
          scope:
            "Direct and composed product requests, two polling EventSources, channel/Owner raw uploads and img/href downloads; native Work artifacts/actions remain display-only in bundled Web; preview/demo interceptors are synthetic and excluded.",
        },
        {
          surface: "Desktop HTTP and local Worker bridge",
          sources: [
            "apps/desktop/src/server-proxy.ts",
            "apps/desktop/src/desktop-server-actions.ts",
            "apps/desktop/src/report-save.ts",
            "apps/desktop/src/main.ts",
            "apps/desktop/src/python-server.ts",
            "apps/desktop/src/native-server.ts",
            "apps/desktop/src/local-worker-controller.ts",
          ],
          scope:
            "Web renderer reuses the public API through one dedicated Session; narrow method/header/body/Origin/redirect rules, private cookies, saves/health/login/enrollment and Node socket URL derivation. Node Fetch qualifies settings/Owner attachment composition; installed Electron/platform qualification is separate.",
        },
        {
          surface: "Node Worker HTTP and WebSocket",
          sources: [
            "apps/node/src/node-identity.ts",
            "apps/node/src/client.ts",
            "apps/node/src/run-session.ts",
            "apps/node/src/command-relay.ts",
            "apps/node/src/browser-host.ts",
          ],
          scope:
            "POST enrollment and /ws/nodes use retained shared identity/Run/browser/command wire schemas; synthetic peers prove identity/observation only. Runtime lifecycle/replay comparisons remain separate from real executor/Temporal execution.",
        },
        {
          surface: "Native Worker Host enrollment and supervision",
          sources: [
            "apps/worker-host-macos/Sources/OpenBotWorkerHostCore/Enrollment.swift",
            "apps/worker-host-macos/Sources/OpenBotWorkerHostCore/Models.swift",
            "apps/worker-host-macos/Sources/OpenBotWorkerHostCore/ChildSupervisor.swift",
            "apps/worker-host-windows/OpenBot.WorkerHost.Windows/NodeLaunchPlan.cs",
          ],
          scope:
            "macOS URLSession directly consumes POST enrollment with strict201/JSON/8KiB/identity bounds; native supervisors forward existing Node configuration. Windows delegates Server transport to the Node client; no extra native HTTP implementation was found. Source review is not target-platform execution.",
        },
      ].map(async (entry) => ({
        ...entry,
        sources: await Promise.all(
          entry.sources.map(async (path) => ({
            path,
            sha256: createHash("sha256")
              .update(await readFile(join(root, path)))
              .digest("hex"),
          })),
        ),
      })),
    );
    const response = await fetch(`${baseUrl}/openapi.json`, {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    const schema: unknown = await response.json();
    assert(
      schema &&
        typeof schema === "object" &&
        "paths" in schema &&
        schema.paths &&
        typeof schema.paths === "object",
    );
    const routes = Object.entries(schema.paths)
      .flatMap(([path, methods]) => {
        assert(methods && typeof methods === "object");
        return Object.entries(methods).map(([method, operation]) => {
          assert(operation && typeof operation === "object");
          return {
            method: method.toUpperCase(),
            path,
            operationId: Reflect.get(operation, "operationId"),
            responseSchema: Reflect.get(operation, "responses"),
            contractOwner: workHttpOperations.some(
              (item) => item.path === path && item.method === method,
            )
              ? "TS Work"
              : controlHttpOperations.some((item) => item.path === path && item.method === method)
                ? "TS Control core"
                : resourceHttpOperations.some(
                      (item) => item.path === path && item.method === method,
                    )
                  ? "TS Models/storage"
                  : lifecycleHttpOperations.some(
                        (item) => item.path === path && item.method === method,
                      )
                    ? "TS Lifecycle/control"
                    : employeeHttpOperations.some(
                          (item) => item.path === path && item.method === method,
                        )
                      ? "TS Employee"
                      : automationHttpOperations.some(
                            (item) => item.path === path && item.method === method,
                          )
                        ? "TS Automation"
                        : nodeHttpOperations.some(
                              (item) => item.path === path && item.method === method,
                            )
                          ? "TS Node identity"
                          : pluginHttpOperations.some(
                                (item) => item.path === path && item.method === method,
                              )
                            ? "TS Plugins"
                            : browserHttpOperations.some(
                                  (item) => item.path === path && item.method === method,
                                )
                              ? "TS Browser"
                              : portabilityHttpOperations.some(
                                    (item) => item.path === path && item.method === method,
                                  )
                                ? "TS Employee portability"
                                : "pending",
          };
        });
      })
      .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    assert(
      routes.every((route) => route.contractOwner !== "pending"),
      "Every actual default registration must have a shared TS contract before refreshing inventory.",
    );
    for (const operation of [
      ...workHttpOperations,
      ...controlHttpOperations,
      ...resourceHttpOperations,
      ...lifecycleHttpOperations,
      ...employeeHttpOperations,
      ...automationHttpOperations,
      ...nodeHttpOperations,
      ...pluginHttpOperations,
      ...browserHttpOperations,
      ...portabilityHttpOperations,
    ]) {
      const actual = routes.find(
        (item) => item.path === operation.path && item.method === operation.method.toUpperCase(),
      );
      assert(actual, `Missing real Python registration: ${operation.operationId}`);
      assert.equal(actual.operationId, operation.operationId);
      assert(
        actual.responseSchema &&
          typeof actual.responseSchema === "object" &&
          [
            operation.status,
            ...("additionalSuccessStatuses" in operation
              ? (operation.additionalSuccessStatuses ?? [])
              : []),
          ].some((status) => String(status) in (actual.responseSchema as object)),
        `Missing registered success response: ${operation.operationId}`,
      );
    }
    await writeFile(
      join(root, "docs/research/typescript-control-plane-route-inventory.json"),
      `${JSON.stringify(
        {
          source:
            "Real serve.py product mode OpenAPI on disposable PostgreSQL, without optional Temporal/browser/command installation",
          scope:
            "Default product HTTP registrations; Work/core, resource bytes/DOCX, lifecycle/approval/audit, Employee/automation, Node identity/socket, Run/native Work artifact bytes, real MCP install/content, synthetic-peer browser observation/maintenance, unsigned Employee export/import and SSE change/coalescing/tombstone/session revocation verified; separate publisher suite qualifies configured signed v1/v2 HTTP and activation; actual Web/Desktop settings and Owner attachment composition verified with Node Fetch; activation registers200 but returns201 on creation and200 on replay; synthetic publication/peers do not qualify Worker/browser execution; successful legacy/native plugin decisions, trusted browser/conditional installations, provider success, saturation backpressure and complete consumer parity remain pending",
          consumerInventory,
          serviceComposition: [
            {
              source: "apps/server-python/src/openbot_server/app.py",
              scope:
                "auth/identity/conversation/profile/task/run-command/Work/product registrars are present in product mode; read-only and staged authority modes intentionally omit groups.",
            },
            {
              source: "apps/server-python/scripts/serve.py",
              scope:
                "Publisher changes bytes/trust on existing portability routes. Temporal/browser/command configurations alter trusted Work services and /ws/nodes messages; they are not additional default HTTP paths. Their successful execution/composition remains separately qualified.",
            },
            {
              source: "apps/server-python/src/openbot_server/product_control.py",
              scope: `Attachment/extension/knowledge/plugin/browser registrations plus workspace/channel SSE and optional Worker registry WebSocket; current product composition already supplies the registry and all${routes.length} default HTTP operations.`,
            },
          ],
          additionalSurfaces: [
            {
              transport: "SSE",
              path: "/api/v1/workspace/events",
              source: "apps/server-python/src/openbot_server/product_control.py",
              status:
                "real ready/heartbeat/reconnect/abort/change invalidation/session revocation verified; saturation backpressure/mixed-entry pending",
            },
            {
              transport: "SSE",
              path: "/api/v1/channels/{channel_id}/events",
              source: "apps/server-python/src/openbot_server/product_control.py",
              status:
                "real ready/heartbeat/reconnect/abort/change/coalescing/tombstone/session revocation verified; saturation backpressure/mixed-entry pending",
            },
            {
              transport: "WebSocket",
              path: "/ws/nodes",
              source: "apps/server-python/src/openbot_server/worker_host_routes.py",
              status:
                "real bootstrap/identity/heartbeat/credential rotation/revocation verified with synthetic peers; Worker execution and mixed-entry parity pending",
            },
          ],
          routes,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Recorded ${routes.length} actual default product HTTP registrations.`);
  }
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await processes.stop();
  try {
    docker.cleanup();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
