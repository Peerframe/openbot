import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  assertClampMtimePrecondition,
  assertOutputAbsent,
  ExclusiveOutputs,
  type PackagedNodeHelloSchema,
  parseCandidateArchiveArguments,
  parseCandidateBuildArguments,
  parseCandidateSmokeArguments,
  runPackagedNodeSmoke,
  validateArchiveMembers,
  withExclusiveOutputDirectory,
  withOwnedScratch,
} from "./node-linux-candidate.ts";

const acceptingSchema: PackagedNodeHelloSchema = {
  safeParse: (value) => ({ success: true, data: value }),
};
const rejectingSchema: PackagedNodeHelloSchema = { safeParse: () => ({ success: false }) };

async function temporaryRoot(context: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openbot-node-linux-candidate-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("keeps the build, archive, and smoke argument contracts and messages", () => {
  assert.throws(
    () => parseCandidateBuildArguments(["--arch"]),
    /^Error: Release arguments must be unique --name value pairs\.$/,
  );
  assert.throws(
    () => parseCandidateBuildArguments(["--arch", "x64", "--sign", "yes"]),
    /^Error: Unknown release argument: --sign\.$/,
  );
  assert.throws(
    () => parseCandidateBuildArguments(["--version", "1.2.3"]),
    /^Error: Missing release argument: --arch\.$/,
  );
  const build = parseCandidateBuildArguments([
    "--arch",
    "riscv64",
    "--node-archive",
    "runtime.tar.xz",
    "--npm-cli",
    "npm-cli.js",
    "--out-dir",
    "out",
    "--source-commit",
    "unchecked",
    "--source-date-epoch",
    "unchecked",
    "--version",
    "unchecked",
  ]);
  assert.equal(build.architecture, "riscv64", "architecture is validated later, in order");
  assert.equal(build.nodeArchive, path.resolve("runtime.tar.xz"));
  assert.equal(build.outputDirectory, path.resolve("out"));

  const archive = [
    "--candidate",
    "/tmp/candidate",
    "--dpkg-query",
    "/usr/bin/dpkg-query",
    "--gnu-tar",
    "/usr/bin/tar",
    "--out-dir",
    "/tmp/out",
    "--xz",
    "/usr/bin/xz",
  ];
  assert.deepEqual(parseCandidateArchiveArguments(archive), {
    candidate: "/tmp/candidate",
    dpkgQuery: "/usr/bin/dpkg-query",
    gnuTar: "/usr/bin/tar",
    outputDirectory: "/tmp/out",
    xz: "/usr/bin/xz",
  });
  assert.throws(
    () => parseCandidateArchiveArguments([...archive, "--level", "9"]),
    /^Error: Unknown archive argument: --level\.$/,
  );
  assert.throws(
    () => parseCandidateArchiveArguments(archive.with(3, "dpkg-query")),
    /^Error: Archive argument must be absolute: --dpkg-query\.$/,
  );
  assert.throws(
    () => parseCandidateArchiveArguments(archive.with(5, "/usr/local/bin/tar")),
    /^Error: Linux archive tool must use the reviewed path: \/usr\/bin\/tar\.$/,
  );
  assert.throws(
    () => parseCandidateArchiveArguments(archive.slice(2)),
    /^Error: Missing archive argument: --candidate\.$/,
    "tool paths are checked before the candidate",
  );

  assert.deepEqual(parseCandidateSmokeArguments(["--arch", "arm64", "--candidate", "/c"]), {
    architecture: "arm64",
    candidate: "/c",
  });
  assert.throws(
    () => parseCandidateSmokeArguments(["--arch", "x64", "--timeout", "1"]),
    /^Error: Unknown smoke argument: --timeout\.$/,
  );
  assert.throws(
    () => parseCandidateSmokeArguments(["--arch", "ia32", "--candidate", "/c"]),
    /^Error: Smoke architecture must be x64 or arm64\.$/,
  );
  assert.throws(
    () => parseCandidateSmokeArguments(["--arch", "x64", "--candidate", "relative"]),
    /^Error: Smoke candidate path must be absolute\.$/,
  );
});

test("removes owned scratch on early failure and on success", async (context) => {
  const root = await temporaryRoot(context);
  let observed = "";
  await assert.rejects(
    withOwnedScratch(
      "scratch-",
      async (scratch) => {
        observed = scratch;
        throw new Error("fails before any payload");
      },
      root,
    ),
    /^Error: fails before any payload$/,
  );
  assert.ok(observed.startsWith(path.join(root, "scratch-")));
  assert.deepEqual(await readdir(root), []);

  const result = await withOwnedScratch(
    "scratch-",
    async (scratch) => {
      await writeFile(path.join(scratch, "payload"), "x");
      return "done";
    },
    root,
  );
  assert.equal(result, "done");
  assert.deepEqual(await readdir(root), []);
});

test("rolls back only a candidate directory this build created", async (context) => {
  const root = await temporaryRoot(context);
  const existing = path.join(root, "existing");
  await mkdir(existing);
  await writeFile(path.join(existing, "sentinel"), "keep");
  let entered = false;
  await assert.rejects(
    withExclusiveOutputDirectory(existing, async () => {
      entered = true;
    }),
    { code: "EEXIST" },
  );
  assert.equal(entered, false);
  assert.equal(await readFile(path.join(existing, "sentinel"), "utf8"), "keep");

  const partial = path.join(root, "partial");
  await assert.rejects(
    withExclusiveOutputDirectory(partial, async () => {
      await mkdir(path.join(partial, "bin"));
      await writeFile(path.join(partial, "bin", "node"), "partial");
      throw new Error("staging failed");
    }),
    /^Error: staging failed$/,
  );
  assert.deepEqual((await readdir(root)).sort(), ["existing"]);

  const complete = path.join(root, "complete");
  await withExclusiveOutputDirectory(complete, () => writeFile(path.join(complete, "ok"), "1"));
  assert.deepEqual(await readdir(complete), ["ok"]);
});

test("never deletes another writer's output while rolling back its own", async (context) => {
  const root = await temporaryRoot(context);
  const foreign = path.join(root, "archive.tar.xz.build.json");
  await writeFile(foreign, "foreign");
  await assert.rejects(assertOutputAbsent(foreign), {
    message: "Release output already exists: archive.tar.xz.build.json.",
  });
  const dangling = path.join(root, "dangling.SHA256SUMS");
  await symlink(path.join(root, "missing-target"), dangling);
  await assert.rejects(assertOutputAbsent(dangling), {
    message: "Release output already exists: dangling.SHA256SUMS.",
  });
  await assertOutputAbsent(path.join(root, "absent"));

  const outputs = new ExclusiveOutputs();
  const archive = path.join(root, "archive.tar.xz");
  const handle = await outputs.claim(archive, () => open(archive, "wx", 0o644));
  await handle.close();
  await assert.rejects(
    outputs.claim(foreign, () => writeFile(foreign, "mine", { flag: "wx" })),
    { code: "EEXIST" },
  );
  await outputs.rollback();
  assert.deepEqual((await readdir(root)).sort(), [
    "archive.tar.xz.build.json",
    "dangling.SHA256SUMS",
  ]);
  assert.equal(await readFile(foreign, "utf8"), "foreign");
});

test("rejects clamp-mtime drift, oversized trees, and escaping archive members", async (context) => {
  const root = await temporaryRoot(context);
  const candidate = path.join(root, "openbot-node-1.2.3-linux-x64-unsigned");
  await mkdir(path.join(candidate, "app"), { recursive: true });
  await writeFile(path.join(candidate, "app", "index.js"), "");
  const sourceDate = Date.parse("2026-01-01T00:00:00.000Z");
  await assertClampMtimePrecondition(candidate, sourceDate);

  const old = new Date(sourceDate - 1000);
  await utimes(path.join(candidate, "app", "index.js"), old, old);
  await assert.rejects(assertClampMtimePrecondition(candidate, sourceDate), {
    message: "Release candidate contains an mtime older than its source date.",
  });
  await utimes(candidate, old, old);
  await assert.rejects(assertClampMtimePrecondition(candidate, sourceDate), {
    message: "Release candidate directory mtime is older than its source date.",
  });

  const wide = path.join(root, "wide");
  await mkdir(wide);
  for (let index = 0; index < 301; index += 1) await writeFile(path.join(wide, `f${index}`), "");
  await assert.rejects(assertClampMtimePrecondition(wide, 0), {
    message: "Release candidate exceeds the archive entry bound.",
  });

  const name = "openbot-node-1.2.3-linux-x64-unsigned";
  validateArchiveMembers(`${name}/\n${name}/app/\n${name}/app/index.js\n`, name);
  for (const listing of [
    "",
    "x".repeat(128 * 1024 + 1),
    `${name}/../escape\n`,
    `${name}/./app\n`,
    `${name}//app\n`,
    `${name}/app\\index.js\n`,
    `${name}-sibling/app\n`,
    "/etc/passwd\n",
  ]) {
    assert.throws(
      () => validateArchiveMembers(listing, name),
      /Archive member listing is missing or too large|member outside the candidate root/,
    );
  }
  assert.throws(
    () => validateArchiveMembers(`${Array.from({ length: 301 }, () => name).join("\n")}\n`, name),
    /^Error: Linux archive exceeds the member-count bound\.$/,
  );
});

type FixtureMode =
  | "exit-early"
  | "invalid-json"
  | "oversized-hello"
  | "wrong-credential"
  | "flood-output"
  | "valid-hello"
  | "unclean-shutdown";

async function writeFixture(root: string, mode: FixtureMode): Promise<string> {
  const fixture = path.join(root, `${mode}.mjs`);
  await writeFile(
    fixture,
    `import { writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
writeFileSync(new URL("./" + mode + ".pid", import.meta.url), String(process.pid));
process.on("SIGTERM", () => process.exit(mode === "unclean-shutdown" ? 1 : 0));
if (mode === "exit-early") process.exit(3);
if (mode === "flood-output") {
  process.stdout.write("x".repeat(70 * 1024));
  setInterval(() => undefined, 1000);
} else {
  const socket = new WebSocket(process.env.OPENBOT_NODE_SERVER_URL);
  socket.addEventListener("open", () => {
    if (mode === "invalid-json" || mode === "oversized-hello") {
      socket.send(mode === "invalid-json" ? "{" : "x".repeat(64 * 1024 + 1));
      return;
    }
    socket.send(JSON.stringify({
      type: "node.hello",
      protocolVersion: "fixture-protocol",
      nodeId: process.env.OPENBOT_NODE_ID,
      credential: mode === "wrong-credential" ? "obn_wrong" : process.env.OPENBOT_NODE_CREDENTIAL,
      platform: "linux",
      architecture: "x64",
      deviceClass: "server",
      isolation: "unknown",
      trustTier: "development",
      maxConcurrentRuns: 1,
      capabilities: [],
      capabilityManifest: [],
    }));
  });
}
`,
  );
  return fixture;
}

async function assertReaped(root: string, mode: FixtureMode): Promise<void> {
  const pid = Number(await readFile(path.join(root, `${mode}.pid`), "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

async function smoke(
  context: TestContext,
  mode: FixtureMode,
  helloSchema: PackagedNodeHelloSchema = acceptingSchema,
): Promise<{
  readonly fixtures: string;
  readonly scratchRoot: string;
  readonly run: Promise<void>;
}> {
  const fixtures = await temporaryRoot(context);
  const scratchRoot = await temporaryRoot(context);
  const entryPoint = await writeFixture(fixtures, mode);
  const run = runPackagedNodeSmoke({
    architecture: "x64",
    executable: process.execPath,
    entryPoint,
    helloSchema,
    protocolVersion: "fixture-protocol",
    temporaryRoot: scratchRoot,
  });
  return { fixtures, scratchRoot, run };
}

test("smoke releases scratch and gateway when the runtime cannot start", async (context) => {
  const scratchRoot = await temporaryRoot(context);
  await assert.rejects(
    runPackagedNodeSmoke({
      architecture: "x64",
      executable: path.join(scratchRoot, "missing-node"),
      entryPoint: path.join(scratchRoot, "missing-index.js"),
      helloSchema: acceptingSchema,
      protocolVersion: "fixture-protocol",
      temporaryRoot: scratchRoot,
    }),
    { message: "Packaged Node could not start." },
  );
  assert.deepEqual(await readdir(scratchRoot), []);
});

test("smoke fails closed and reaps the runtime on every rejected hello", async (context) => {
  const cases: readonly [FixtureMode, PackagedNodeHelloSchema, string][] = [
    ["exit-early", acceptingSchema, "Packaged Node exited before a valid hello."],
    ["invalid-json", acceptingSchema, "Packaged Node hello was not valid JSON."],
    ["oversized-hello", acceptingSchema, "Packaged Node hello exceeded the 64 KiB bound."],
    ["valid-hello", rejectingSchema, "Packaged Node hello did not match the protocol schema."],
    [
      "wrong-credential",
      acceptingSchema,
      "Packaged Node hello identity does not match the smoke fixture.",
    ],
    ["flood-output", acceptingSchema, "Packaged Node smoke output exceeded the 64 KiB bound."],
    ["unclean-shutdown", acceptingSchema, "Packaged Node did not terminate cleanly after SIGTERM."],
  ];
  for (const [mode, schema, message] of cases) {
    const { fixtures, scratchRoot, run } = await smoke(context, mode, schema);
    await assert.rejects(run, { message }, mode);
    await assertReaped(fixtures, mode);
    assert.deepEqual(await readdir(scratchRoot), [], mode);
  }
});

test("smoke accepts a least-authority hello and a clean SIGTERM shutdown", async (context) => {
  const { fixtures, scratchRoot, run } = await smoke(context, "valid-hello");
  await run;
  await assertReaped(fixtures, "valid-hello");
  assert.deepEqual(await readdir(scratchRoot), []);
});
