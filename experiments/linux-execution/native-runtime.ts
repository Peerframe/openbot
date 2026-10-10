/** Fixed helper inside the original native unit; PID1 owns every producer's lifetime. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  openSync,
  readlinkSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CommandSandbox, prepareAction } from "./command-sandbox.ts";
import { DockerCli, object } from "./docker-cli.ts";
import { EventLedger } from "./event-ledger.ts";
import { nativeClock } from "./kernel-facts.ts";
import { checkedReservation, runtimeReady, type NativeReservation } from "./linux-native.ts";
import { hashValue, nativeEnvironment, trustedFile } from "./native-config.ts";
import {
  boundedOutput,
  guard,
  privateMountFlags,
  verifyRuntimeSocketMount,
} from "./native-facts.ts";
import { command, showUnit, type NativePhase } from "./native-unit.ts";
import { verifyEnteredNamespaces } from "./namespace-command.ts";
import { readKernelText, verifyOutputCapacity } from "./output-capacity.ts";
import { directory, exclusive, fsyncDirectory, readRecord, requireFact } from "./protected-io.ts";
import { SubprocessCommander } from "./subprocess.ts";
import type {
  CommandClaims,
  CommandOperation,
} from "../../apps/server/dist/work-command-contract.js";
import type { Launch } from "./protected-host.ts";
export function childRecord(root: string, progress: (phase: NativePhase) => void = () => {}) {
  requireFact(
    process.platform === "linux" && process.arch === "x64" && process.geteuid?.() === 0,
    "qualified_linux_root_required",
  );
  directory(root);
  const record = checkedReservation(readRecord(join(root, "native.json")) as NativeReservation);
  requireFact(record.root === root, "native_root_changed");
  progress("record-verified");
  trustedFile(record.configuration.helper, record.configuration.helperSha256);
  trustedFile(record.configuration.node, record.configuration.nodeSha256);
  progress("helper-pins-verified");
  // The secrets directory is intentionally inaccessible inside this unit; helpers never read it.
  for (const [name, hash] of Object.entries(record.configuration.binaryHashes))
    trustedFile(join(record.configuration.binaries, name), hash);
  progress("runtime-pins-verified");
  return record;
}
export function dockerCli(record: NativeReservation) {
  return new DockerCli(
    new SubprocessCommander({
      binary: join(record.configuration.binaries, "docker"),
      environment: nativeEnvironment(record.configuration),
      arguments: [
        "--config",
        join(record.root, "docker-config"),
        "--host",
        "unix://" + join(record.root, "docker.sock"),
      ],
    }),
    2000,
  );
}
export function sandbox(record: NativeReservation) {
  const facts = readRecord(join(record.root, "daemon.json")) as { ID: string };
  return new CommandSandbox({
    cli: dockerCli(record),
    root: join(record.root, "work"),
    ledger: new EventLedger(join(record.root, "work/events.jsonl")),
    admittedImages: [record.configuration.image],
    expectedDaemonId: facts.ID,
    expectedDaemonRoot: join(record.root, "docker-data"),
  });
}
function producer(binary: string, args: string[], environment: Record<string, string>) {
  const child = spawn(binary, args, { env: environment, stdio: "ignore", shell: false });
  let stopped = false;
  const done = new Promise<void>((resolve) => {
    child.once("error", () => {
      stopped = true;
      resolve();
    });
    child.once("exit", () => {
      stopped = true;
      resolve();
    });
  });
  return { child, done, alive: () => !stopped && child.pid !== undefined };
}
export async function daemon(record: NativeReservation) {
  const { root, configuration: config } = record,
    env = nativeEnvironment(config),
    run = command(env),
    startup = readRecord(join(root, "startup.json")) as Launch;
  guard(startup, record.instancePath);
  const socketMount = verifyRuntimeSocketMount(join(root, "shim-mount-readback.json")),
    mountFlags = await privateMountFlags(record.unit, run);
  exclusive(join(root, "unit-mount-flags.json"), mountFlags);
  const group = "/sys/fs/cgroup/system.slice/" + record.unit;
  requireFact(
    readKernelText("/proc/self/cgroup").trim() === `0::/system.slice/${record.unit}/supervisor`,
    "wrong_producer_cgroup",
  );
  requireFact(readKernelText(join(group, "cgroup.procs")).trim() === "", "occupied_delegation");
  const controllers = ["cpu", "memory", "pids", "io", "cpuset"],
    available = readKernelText(join(group, "cgroup.controllers")).split(/\s+/);
  requireFact(
    controllers.every((v) => available.includes(v)),
    "missing_controller",
  );
  writeFileSync(
    join(group, "cgroup.subtree_control"),
    controllers
      .sort()
      .map((v) => "+" + v)
      .join(" "),
  );
  guard(startup, record.instancePath);
  const containerd = producer(
      join(config.binaries, "containerd"),
      ["--config", join(root, "config/containerd.toml")],
      env,
    ),
    end = nativeClock()[0] + (record.runtimeMaxMs - 2000) * 1000;
  while (!existsSync(join(root, "containerd.sock"))) {
    requireFact(containerd.alive() && nativeClock()[0] < end, "containerd_not_ready");
    await delay(25);
  }
  guard(startup, record.instancePath);
  const docker = producer(
      join(config.binaries, "dockerd"),
      ["--config-file=" + join(root, "config/daemon.json")],
      env,
    ),
    cli = dockerCli(record);
  let info: Record<string, unknown>;
  for (;;) {
    requireFact(containerd.alive() && docker.alive() && nativeClock()[0] < end, "daemon_not_ready");
    try {
      info = await cli.info();
      break;
    } catch {
      await delay(25);
    }
  }
  requireFact(
    typeof info.ID === "string" &&
      info.DockerRootDir === join(root, "docker-data") &&
      object(info.Containerd).Address === join(root, "containerd.sock") &&
      info.LiveRestoreEnabled === false &&
      info.LoggingDriver === "local",
    "private_daemon_changed",
  );
  exclusive(join(root, "daemon.json"), {
    ID: info.ID,
    DockerRootDir: info.DockerRootDir,
    Containerd: info.Containerd,
  });
  exclusive(join(root, "image-load-reserved.json"), { image: config.image });
  const remaining = () => Math.max(10, (end - nativeClock()[0]) / 1000);
  requireFact(
    (await cli.commander.run(["load", "--input", config.archive], remaining())).ok,
    "image_load_unknown",
  );
  requireFact(
    (
      await cli.commander.run(
        ["image", "tag", config.image.split("@")[1]!, config.imageTag],
        remaining(),
      )
    ).ok,
    "image_tag_unknown",
  );
  await sandbox(record).preflight(config.image);
  const disk = join(root, "output.ext4"),
    fd = openSync(
      disk,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  let inode: number;
  try {
    ftruncateSync(fd, 64 * 1024 ** 2);
    fsyncSync(fd);
    inode = fstatSync(fd).ino;
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(root);
  await run(["/usr/sbin/mkfs.ext4", "-q", "-F", "-m", "0", disk]);
  exclusive(join(root, "loop-reserved.json"), { backing: disk, inode });
  const loop = await run(["/usr/sbin/losetup", "--find", "--show", disk]);
  requireFact(/^\/dev\/loop[0-9]+$/.test(loop), "invalid_loop");
  exclusive(join(root, "loop.json"), { device: loop, backing: disk, inode });
  await run(["/usr/bin/mount", "-t", "ext4", "-o", "nodev,nosuid,noexec", loop, record.output]);
  await run(["/usr/bin/mount", "--make-private", record.output]);
  rmdirSync(join(record.output, "lost+found"));
  chownSync(record.output, 10001, 10001);
  chmodSync(record.output, 0o700);
  const capacity = verifyOutputCapacity(record.output, 64 * 1024 ** 2),
    observed = await showUnit(record.unit, env),
    cgroupInode = lstatSync(group).ino;
  requireFact(
    /^[a-f0-9]{32}$/.test(observed.InvocationID ?? "") && nativeClock()[0] < end,
    "native_identity_missing",
  );
  const namespaces = {
    mnt: readlinkSync("/proc/self/ns/mnt"),
    net: readlinkSync("/proc/self/ns/net"),
  };
  requireFact(
    Object.entries(namespaces).every(
      ([name, value]) => value !== readlinkSync("/proc/1/ns/" + name),
    ),
    "private_namespace_missing",
  );
  const identity = {
      ID: info.ID,
      root: info.DockerRootDir,
      containerd: info.Containerd,
      binaryHashes: config.binaryHashes,
    },
    shape = {
      socketMount,
      unit: record.unit,
      invocationId: observed.InvocationID,
      cgroupInode,
      namespaces,
      capacity,
      runtimeMaxMs: record.runtimeMaxMs,
    };
  exclusive(join(root, "runtime-ready.json"), {
    bootId: nativeClock()[2],
    invocationId: observed.InvocationID,
    cgroupInode,
    supervisorPid: process.pid,
    containerdPid: containerd.child.pid,
    dockerPid: docker.child.pid,
    namespaces,
    runtimeIdentityDigest: hashValue(identity),
    runtimeShapeDigest: hashValue(shape),
  });
  // Exiting this main process lets PID1 kill its whole group; no restart or extended watchdog.
  await Promise.race([docker.done, containerd.done]);
}
export async function joinOriginal(record: NativeReservation, producer: boolean) {
  const ready = runtimeReady(record),
    current = await showUnit(record.unit, nativeEnvironment(record.configuration));
  requireFact(
    current.InvocationID === ready.invocationId &&
      current.ActiveState === "active" &&
      Number(current.MainPID) === ready.supervisorPid,
    "original_native_not_active",
  );
  const group = "/sys/fs/cgroup/system.slice/" + record.unit;
  requireFact(lstatSync(group).ino === ready.cgroupInode, "cgroup_replaced");
  // nsenter received already-open descriptors. Recheck both entered namespaces before side effects.
  verifyEnteredNamespaces(ready.namespaces);
  if (producer) {
    writeFileSync(join(group, "supervisor/cgroup.procs"), String(process.pid));
    requireFact(
      readKernelText("/proc/self/cgroup").trim() === `0::/system.slice/${record.unit}/supervisor`,
      "wrong_producer_cgroup",
    );
  }
}
export function guardLifecycle(
  cli: DockerCli,
  launch: Launch,
  instancePath: string,
  clock = nativeClock,
  read = readRecord,
) {
  const create = cli.create.bind(cli),
    start = cli.start.bind(cli);
  const budget = () => {
    const [, boot] = guard(launch, instancePath, clock, read);
    return (launch.expiresBoottimeUs - boot) / 1000;
  };
  cli.create = (args) => create(args, budget());
  cli.start = (id) => start(id, budget());
  return cli;
}
export async function execute(
  record: NativeReservation,
  progress: (phase: NativePhase) => void = () => {},
) {
  const launch = readRecord(join(record.root, "launch.json")) as {
    operation: CommandOperation;
    guard: Launch;
  };
  guard(launch.guard, record.instancePath);
  progress("guard-verified");
  await joinOriginal(record, true);
  progress("namespace-joined");
  guard(launch.guard, record.instancePath);
  const engine = sandbox(record),
    prepared = await prepareAction({
      root: join(record.root, "work"),
      input: record.input,
      output: record.output,
      action: record.binding.actionId,
      epoch: record.binding.originalEpoch,
      command: launch.operation.command,
      controlPaths: [
        engine.ledger.path,
        engine.ledger.path + ".lock",
        join(record.root, "docker.sock"),
        join(record.root, "containerd.sock"),
        join(record.root, "config"),
        record.configuration.secretsDirectory,
      ],
    });
  progress("prepared");
  guardLifecycle(engine.cli, launch.guard, record.instancePath);
  progress("create-requested");
  const created = await engine.create(prepared),
    inspected = await engine.cli.inspect(created.container_id);
  requireFact(
    inspected?.Id === created.container_id &&
      object(object(object(inspected.HostConfig).LogConfig).Config).compress === "false",
    "logging_readback_changed",
  );
  progress("created");
  guard(launch.guard, record.instancePath);
  progress("start-requested");
  await engine.startOnce(created);
  progress("start-observed");
  exclusive(join(record.root, "created.json"), created);
}
export async function lookup(record: NativeReservation, includeOutput = false) {
  await joinOriginal(record, false);
  const engine = sandbox(record),
    binding = record.binding,
    found = await engine.recover(binding.actionId, binding.originalEpoch),
    counters = engine.ledger.counters(binding.actionId, binding.originalEpoch),
    ready = runtimeReady(record);
  const phase = found.outcome,
    observation: CommandClaims<"work_command_receipt">["observation"] = {
      phase,
      containerId: found.container_id,
      startAttempts: Math.min(1, counters.startAttempts),
      exitCode: phase === "exited" ? found.exit_code : null,
      sequence: 1,
      runtimeShapeDigest: phase === "unknown" ? null : ready.runtimeShapeDigest,
      outputs: [],
      truncated: false,
    };
  let data: Buffer | null = null;
  if (phase === "exited" && includeOutput) {
    const operation = (
        readRecord(join(record.root, "launch.json")) as { operation: CommandOperation }
      ).operation,
      output = operation.command.output;
    data = boundedOutput(record.output, output);
    observation.outputs = [
      {
        name: output.name,
        mediaType: output.mediaType,
        sizeBytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      },
    ];
  }
  return { observation, data: data?.toString("base64") ?? null };
}
