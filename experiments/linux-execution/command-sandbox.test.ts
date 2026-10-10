/** Lifecycle fault injection plus real ledger locks; fake Docker does not qualify native isolation. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import compatibility from "../../scripts/integration/fixtures/command-compatibility.json" with {
  type: "json",
};
import type { WorkCommand } from "../../apps/server/dist/work-command-contract.js";
import { CommandSandbox, prepareAction, inputManifest } from "./command-sandbox.ts";
import { DockerCli, absent } from "./docker-cli.ts";
import { EventLedger } from "./event-ledger.ts";
import { assertCreatedShape, createArguments, type Shape } from "./container-shape.ts";
import type { CommandResult } from "./subprocess.ts";
const result = (stdout: string, overrides: Partial<CommandResult> = {}): CommandResult => ({
  argv: [],
  stdout,
  stderr: "",
  status: 0,
  ok: true,
  uncertain: false,
  timedOut: false,
  outputTruncated: false,
  capturedBytes: Buffer.byteLength(stdout),
  ...overrides,
});
const id = "d".repeat(64);
function inspected(shape: Shape) {
  const l = shape.command.limits;
  return {
    Id: id,
    Name: "/" + shape.name,
    RestartCount: 0,
    Config: { User: "10001:10001", Env: ["PATH=/usr/bin:/bin"] },
    State: { Status: "created", ExitCode: 0 },
    HostConfig: {
      PidsLimit: l.pids,
      Memory: l.memoryMiB * 1024 ** 2,
      MemorySwap: l.memoryMiB * 1024 ** 2,
      NanoCpus: l.nanoCPUs,
      Ulimits: [
        { Name: "nofile", Soft: l.nofile, Hard: l.nofile },
        { Name: "nproc", Soft: l.pids, Hard: l.pids },
      ],
      Tmpfs: { "/tmp": `rw,nosuid,nodev,noexec,size=${l.tmpMiB}m` },
      Runtime: "runsc",
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ["ALL"],
      CapAdd: [],
      SecurityOpt: ["no-new-privileges"],
      RestartPolicy: { Name: "no" },
      LogConfig: {
        Type: "local",
        Config: {
          "max-size": Math.max(8, Math.ceil(l.capturedOutputKiB / 2)) + "k",
          "max-file": "2",
          compress: "false",
        },
      },
    },
    Mounts: [
      {
        Destination: "/input",
        Source: shape.input,
        RW: false,
        Type: "bind",
        Propagation: "rprivate",
      },
      {
        Destination: "/output",
        Source: shape.output,
        RW: true,
        Type: "bind",
        Propagation: "rprivate",
      },
    ],
  };
}
async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ob-box-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, "input"),
    output = join(root, "output");
  mkdirSync(input);
  mkdirSync(output);
  const command = structuredClone(
    compatibility.fingerprints.positive[0]!.operation.command,
  ) as WorkCommand;
  command.inputManifest = [];
  command.inputDigest = "sha256:" + createHash("sha256").update("[]").digest("hex");
  const ledger = new EventLedger(join(root, "events.jsonl")),
    prepared = await prepareAction({
      root,
      input,
      output,
      command,
      action: "action",
      epoch: 1,
      controlPaths: [ledger.path, ledger.path + ".lock"],
    }),
    calls: string[][] = [],
    value = inspected(prepared.shape),
    capacity = {
      version: 1,
      path: output,
      mount_id: 42,
      device: "1:2",
      inode: 3,
      filesystem: "ext4",
      device_bytes: command.limits.outputMiB * 1024 ** 2,
      filesystem_bytes: command.limits.outputMiB * 512 * 1024,
      limit_bytes: command.limits.outputMiB * 1024 ** 2,
    };
  let createResult = result(id),
    startResult = result(id),
    inspectValue: unknown = value;
  const info = {
      ID: "owned-daemon",
      DockerRootDir: root + "/docker-data",
      OSType: "linux",
      Architecture: "x86_64",
      CgroupVersion: "2",
      Runtimes: { runsc: {} },
    },
    image = { Id: "sha256:" + "e".repeat(64), RepoDigests: [command.image] };
  const cli = new DockerCli({
    async run(args) {
      calls.push([...args]);
      switch (args[0]) {
        case "version":
          return result("29.8.1");
        case "info":
          return result(JSON.stringify(info));
        case "image":
          return result(JSON.stringify(image));
        case "create":
          return createResult;
        case "start":
          return startResult;
        case "inspect":
          return inspectValue === null
            ? result("", { ok: false, status: 1, stderr: "No such object" })
            : result(JSON.stringify(inspectValue));
        default:
          throw new Error("unexpected mutating Docker verb");
      }
    },
  });
  const box = new CommandSandbox({
    cli,
    root,
    ledger,
    admittedImages: [command.image],
    expectedDaemonId: info.ID,
    expectedDaemonRoot: info.DockerRootDir,
    capacity: () => ({ ...capacity }),
    platform: "linux",
    architecture: "x64",
  });
  return {
    root,
    input,
    output,
    command,
    ledger,
    prepared,
    calls,
    value,
    capacity,
    box,
    info,
    image,
    setCreate(value: CommandResult) {
      createResult = value;
    },
    setStart(value: CommandResult) {
      startResult = value;
    },
    setInspect(value: unknown) {
      inspectValue = value;
    },
  };
}
test("complete create/start/recover uses exact ID and one durable attempt", async (t) => {
  const f = await fixture(t);
  await f.box.preflight(f.command.image);
  const created = await f.box.create(f.prepared);
  assert.equal(created.container_id, id);
  assert.equal(f.ledger.counters("action", 1).startAttempts, 0);
  await f.box.startOnce(created);
  assert.equal(f.ledger.counters("action", 1).startAttempts, 1);
  assert.equal(f.ledger.counters("action", 1).launches, 1);
  f.value.State.Status = "exited";
  assert.deepEqual(await f.box.recover("action", 1), {
    outcome: "exited",
    container_id: id,
    exit_code: 0,
  });
  await assert.rejects(f.box.startOnce(created), /start_already_reserved/);
  await assert.rejects(f.box.create(f.prepared), /create_already_reserved/);
  assert.equal(f.calls.filter((c) => c[0] === "create").length, 1);
  assert.deepEqual(
    f.calls.find((c) => c[0] === "start"),
    ["start", id],
  );
  assert(f.calls.filter((c) => c[0] === "inspect").every((c) => c[1] === id));
});
for (const mode of ["truncated", "timeout", "failure", "receipt", "missing", "replaced"] as const)
  test(`uncertain create ${mode} never starts or repeats`, async (t) => {
    const f = await fixture(t);
    if (mode === "truncated" || mode === "timeout")
      f.setCreate(
        result("No such object", {
          ok: false,
          status: null,
          uncertain: true,
          outputTruncated: mode === "truncated",
          timedOut: mode === "timeout",
        }),
      );
    if (mode === "failure") f.setCreate(result("", { ok: false, status: 1 }));
    if (mode === "receipt") f.setCreate(result("not-an-id"));
    if (mode === "missing") f.setInspect(null);
    if (mode === "replaced") f.setInspect({ ...f.value, Id: "e".repeat(64) });
    await assert.rejects(f.box.create(f.prepared));
    await assert.rejects(f.box.create(f.prepared), /create_already_reserved/);
    assert.equal(f.calls.filter((c) => c[0] === "create").length, 1);
    assert(!f.calls.some((c) => ["start", "rm", "kill"].includes(c[0]!)));
    assert.equal((await f.box.recover("action", 1)).outcome, "unknown");
  });
for (const mode of ["truncated", "timeout", "failure"])
  test(`uncertain start ${mode} stays consumed after new ledger instance`, async (t) => {
    const f = await fixture(t),
      created = await f.box.create(f.prepared);
    f.setStart(
      result("", {
        ok: false,
        status: mode === "failure" ? 1 : null,
        uncertain: mode !== "failure",
        outputTruncated: mode === "truncated",
        timedOut: mode === "timeout",
      }),
    );
    await assert.rejects(f.box.startOnce(created));
    await assert.rejects(
      new EventLedger(f.ledger.path).reserveStart(created),
      /start_already_reserved/,
    );
    assert.equal(f.calls.filter((c) => c[0] === "start").length, 1);
    assert.equal((await f.box.recover("action", 1)).outcome, "unknown");
  });
test("storage identity recheck consumes attempt but cannot start", async (t) => {
  const f = await fixture(t),
    created = await f.box.create(f.prepared);
  f.capacity.mount_id++;
  await assert.rejects(f.box.startOnce(created), /output_capacity_changed/);
  f.capacity.mount_id--;
  await assert.rejects(f.box.startOnce(created), /start_already_reserved/);
  assert(!f.calls.some((c) => c[0] === "start"));
});
for (const change of ["id", "name", "intent", "ambiguous"])
  test(`unproven ${change} association cannot reserve or call Docker`, async (t) => {
    const f = await fixture(t),
      created = await f.box.create(f.prepared);
    if (change === "id") created.container_id = "e".repeat(64);
    if (change === "name") created.container_name = "another";
    if (change === "intent") created.intent_digest = "changed";
    if (change === "ambiguous") await f.ledger.append("action", 1, "container_created", created);
    f.calls.length = 0;
    await assert.rejects(f.box.startOnce(created));
    assert.equal(f.calls.length, 0);
    assert.equal(f.ledger.counters("action", 1).startAttempts, 0);
  });
for (const change of ["directory", "input", "stale_output"])
  test(`prepare/create rejects changed ${change} before any daemon verb`, async (t) => {
    const f = await fixture(t);
    if (change === "directory") {
      renameSync(f.input, f.input + "-old");
      mkdirSync(f.input);
    }
    if (change === "input") writeFileSync(join(f.input, "new"), "bytes");
    if (change === "stale_output") writeFileSync(join(f.output, "old"), "bytes");
    await assert.rejects(f.box.create(f.prepared));
    assert.equal(f.calls.length, 0);
  });
test("cross-process create reservations serialize at durable ledger", async (t) => {
  const f = await fixture(t),
    module = new URL("./event-ledger.ts", import.meta.url).href,
    script = `import {EventLedger} from ${JSON.stringify(module)};const ledger=new EventLedger(process.argv[1]);try{await ledger.reserveCreate('action',1,'name','intent');process.stdout.write('won');}catch(error){if(error.message!=='create_already_reserved')throw error;process.stdout.write('refused');}`;
  const values = await Promise.all(
    Array.from({ length: 4 }, () =>
      promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, f.ledger.path], {
        env: { PATH: process.env.PATH },
        timeout: 10000,
      }),
    ),
  );
  assert.equal(values.filter((v) => v.stdout === "won").length, 1);
  assert.equal(values.filter((v) => v.stdout === "refused").length, 3);
  assert.equal(f.ledger.forAction("action", 1).length, 1);
});
test("cross-instance start reservations issue one attempt", async (t) => {
  const f = await fixture(t),
    created = await f.box.create(f.prepared),
    results = await Promise.allSettled(
      Array.from({ length: 4 }, () => new EventLedger(f.ledger.path).reserveStart(created)),
    );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.ledger.counters("action", 1).startAttempts, 1);
});
test("separate processes cannot reserve the same durable start slot", async (t) => {
  const f = await fixture(t),
    created = await f.box.create(f.prepared),
    module = new URL("./event-ledger.ts", import.meta.url).href,
    script = `import {EventLedger} from ${JSON.stringify(module)};const ledger=new EventLedger(process.argv[1]);try{await ledger.reserveStart(JSON.parse(process.argv[2]));process.stdout.write('won');}catch(error){if(error.message!=='start_already_reserved')throw error;process.stdout.write('refused');}`;
  const child = () =>
    promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", script, f.ledger.path, JSON.stringify(created)],
      { env: { PATH: process.env.PATH }, timeout: 10000 },
    );
  const values = await Promise.all(Array.from({ length: 4 }, child));
  assert.equal(values.filter((v) => v.stdout === "won").length, 1);
  assert.equal(values.filter((v) => v.stdout === "refused").length, 3);
  assert.equal((await child()).stdout, "refused");
  assert.equal(f.ledger.counters("action", 1).startAttempts, 1);
  assert.equal(f.calls.filter((args) => args[0] === "start").length, 0);
});
for (const mode of ["missing", "replaced", "restarted", "invalid_exit"])
  test(`recovery ${mode} only observes and stays unknown`, async (t) => {
    const f = await fixture(t),
      created = await f.box.create(f.prepared);
    await f.box.startOnce(created);
    f.calls.length = 0;
    f.value.State.Status = "exited";
    if (mode === "missing") f.setInspect(null);
    if (mode === "replaced") f.value.Id = "e".repeat(64);
    if (mode === "restarted") f.value.RestartCount = 1;
    if (mode === "invalid_exit") f.value.State.ExitCode = 999;
    assert.equal((await f.box.recover("action", 1)).outcome, "unknown");
    assert(f.calls.every((c) => c[0] === "inspect" && c[1] === id));
  });
for (const change of [
  "user",
  "memory",
  "swap",
  "cpus",
  "pids",
  "ulimits",
  "tmpfs",
  "runtime",
  "network",
  "readonly",
  "privileged",
  "capdrop",
  "capadd",
  "nonewpriv",
  "restart",
  "logs",
  "mount_source",
  "mount_rw",
  "propagation",
  "extra_mount",
  "duplicate_mount",
  "secret_env",
])
  test(`daemon shape readback rejects ${change}`, async (t) => {
    const f = await fixture(t),
      v = f.value,
      h = v.HostConfig;
    switch (change) {
      case "user":
        v.Config.User = "0";
        break;
      case "memory":
        h.Memory++;
        break;
      case "swap":
        h.MemorySwap++;
        break;
      case "cpus":
        h.NanoCpus++;
        break;
      case "pids":
        h.PidsLimit++;
        break;
      case "ulimits":
        h.Ulimits[0]!.Hard++;
        break;
      case "tmpfs":
        h.Tmpfs["/tmp"] = "rw,size=1m";
        break;
      case "runtime":
        h.Runtime = "runc";
        break;
      case "network":
        h.NetworkMode = "host";
        break;
      case "readonly":
        h.ReadonlyRootfs = false;
        break;
      case "privileged":
        h.Privileged = true;
        break;
      case "capdrop":
        h.CapDrop = [];
        break;
      case "capadd":
        (h.CapAdd as string[]).push("ALL");
        break;
      case "nonewpriv":
        h.SecurityOpt = [];
        break;
      case "restart":
        h.RestartPolicy.Name = "always";
        break;
      case "logs":
        h.LogConfig.Type = "json-file";
        break;
      case "mount_source":
        v.Mounts[0]!.Source = "/";
        break;
      case "mount_rw":
        v.Mounts[0]!.RW = true;
        break;
      case "propagation":
        v.Mounts[0]!.Propagation = "shared";
        break;
      case "extra_mount":
        v.Mounts.push({ ...v.Mounts[0]!, Destination: "/etc" });
        break;
      case "duplicate_mount":
        v.Mounts.push({ ...v.Mounts[0]! });
        break;
      case "secret_env":
        v.Config.Env.push("OPENBOT_SECRET=bad");
        break;
    }
    assert.throws(() => assertCreatedShape(f.prepared.shape, v));
    await assert.rejects(f.box.create(f.prepared));
    assert.equal(
      f.ledger.forAction("action", 1).filter((r) => r.event === "container_created").length,
      0,
    );
  });
test("argv binds reviewed log and resource limits with literal workload strings", async (t) => {
  const f = await fixture(t),
    args = createArguments(f.prepared.shape);
  assert(args.includes("--pull=never"));
  assert(args.includes("max-file=2"));
  assert(args.includes("max-size=32k"));
  assert.deepEqual(args.slice(-f.command.argv.length), f.command.argv);
});
test("uncertain absence cannot be used by inspect or image inspect", async () => {
  const r = result("No such object", {
      status: null,
      ok: false,
      uncertain: true,
      outputTruncated: true,
    }),
    cli = new DockerCli({
      async run() {
        return r;
      },
    });
  assert.equal(absent(r), false);
  await assert.rejects(cli.inspect(id));
  await assert.rejects(cli.imageInspect("example@sha256:" + id));
});

test("immutable input hashing retains the full 20MiB protocol envelope", async (t) => {
  const f = await fixture(t),
    data = Buffer.alloc(20 * 1024 * 1024, 120);
  writeFileSync(join(f.input, "input.csv"), data);
  const seen = inputManifest(f.input);
  assert.equal(seen.entries[0]?.size, data.length);
  assert.equal(seen.entries[0]?.sha256, createHash("sha256").update(data).digest("hex"));
  writeFileSync(join(f.input, "extra"), "x");
  assert.throws(() => inputManifest(f.input), /input_capacity/);
});
