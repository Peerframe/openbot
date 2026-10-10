/** Runs the existing public contract consumers against the sole Server process and owned services. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createDatabase } from "@openbot/db";
import { allowlistedEnvironment } from "./acceptance-fixture.ts";
import { serverContractFixture } from "./server-contract-fixture.ts";

export async function runHttpContracts(selectedSuite: string, tlsDirectory?: string) {
  const owned = await serverContractFixture({ publisher: selectedSuite === "publisher", ...(tlsDirectory ? { tlsDirectory } : {}) });
  const { directory, dsn, baseUrl, password, cookie, plugins, publisher, modelReceipt, processes } = owned;
  const tls = !!tlsDirectory;
  const headers = { Origin: baseUrl, "Content-Type": "application/json" };
  try {
    const created = await fetch(baseUrl + "/api/v1/bots", { method: "POST", headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ name: "Contract fixture", role: "Synthetic validation", computerProfile: "none" }), signal: AbortSignal.timeout(10000) });
    assert.equal(created.status, 201);
    const { bot: value } = await created.json() as { bot: { id: string } };
    const snapshot = async () => {
      const response = await fetch(baseUrl + "/api/v1/bots", { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200); return response.json();
    };
    const before = await snapshot();
    await owned.restart();
    assert.deepEqual(await snapshot(), before, "Real Server restart retains the issued session and Bot data.");
  // Seed legacy publication states for HTTP contracts. The live Worker only handles TS admissions;
  // these synthetic legacy rows do not claim native execution.
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
        assert.equal(row.details.clientIdentitySource, "direct");
      }
      console.log(`Private Node identity source/digest verified through the direct Server entry.`);
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
    `Direct Server + PostgreSQL/mTLS Temporal CLI contracts passed: ${selectedSuite} (synthetic providers and peers).`,
  );

  } finally { await owned.close(); }
}
