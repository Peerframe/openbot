/** Protected Host adapter over the fixed systemd/runsc packet. Unknown effects are lookup-only. */
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual as same } from "node:util";
import type {
  CommandClaims,
  CommandOperation,
} from "../../apps/server/dist/work-command-contract.js";
import type { NativeHost, NativeRecord, Launch } from "./protected-host.ts";
import { inputManifest } from "./command-sandbox.ts";
import { EventLedger } from "./event-ledger.ts";
import { nativeClock } from "./kernel-facts.ts";
import {
  configurationValues,
  guard,
  preflightPaths,
  privateMountFlags,
  properties,
} from "./native-facts.ts";
import {
  nativeEnvironment,
  qualifyNativeTools,
  validateNativeConfiguration,
  type NativeConfiguration,
} from "./native-config.ts";
import {
  command,
  NativeCommandFailure,
  cgroupMembers,
  showUnit,
  stopHooks,
  unitName,
  validateUnit,
} from "./native-unit.ts";
import { namespaceCommand } from "./namespace-command.ts";
import { readKernelText } from "./output-capacity.ts";
import {
  directory,
  exclusive,
  fsyncDirectory,
  readRecord,
  requireFact,
  Refused,
} from "./protected-io.ts";
type Authorization = Parameters<NativeHost["reserve"]>[1];
export type NativeReservation = NativeRecord & {
  unit: string;
  binding: Parameters<NativeHost["reserve"]>[0];
  instanceId: string;
  instancePath: string;
  configuration: NativeConfiguration;
  runtimeMaxMs: number;
  timingPolicyDigest: string;
};
export type RuntimeReady = {
  bootId: string;
  invocationId: string;
  cgroupInode: number;
  supervisorPid: number;
  containerdPid: number;
  dockerPid: number;
  namespaces: { mnt: string; net: string };
  runtimeIdentityDigest: string;
  runtimeShapeDigest: string;
};
export const runtimeReady = (record: NativeReservation) =>
  readRecord(join(record.root, "runtime-ready.json")) as RuntimeReady;
export const helperArguments = (record: NativeReservation, mode: string) => [
  record.configuration.node,
  record.configuration.helper,
  mode,
  "--root",
  record.root,
];
export function checkedReservation(
  record: NativeRecord,
  config?: NativeConfiguration,
): NativeReservation {
  const r = record as NativeReservation,
    cfg = config ?? r.configuration;
  requireFact(
    r &&
      typeof r.root === "string" &&
      dirname(r.root) === cfg.base &&
      /^[a-f0-9]{12}$/.test(r.root.split("/").at(-1) ?? "") &&
      realpathSync(r.root) === r.root,
    "native_root_changed",
  );
  directory(r.root);
  unitName(r.unit);
  requireFact(
    same(readRecord(join(r.root, "native.json")), r) && same(r.configuration, cfg),
    "native_record_changed",
  );
  return r;
}
export class LinuxNative implements NativeHost {
  readonly config: NativeConfiguration;
  instancePath?: string;
  private constructor(config: NativeConfiguration) {
    this.config = config;
  }
  static async open(config: NativeConfiguration) {
    validateNativeConfiguration(config);
    await qualifyNativeTools(config);
    return new LinuxNative(config);
  }
  environment() {
    return nativeEnvironment(this.config);
  }
  command(argv: readonly string[], timeoutMs = 3000, limit = 1048576) {
    return command(this.environment())(argv, timeoutMs, limit);
  }
  show(unit: string) {
    return showUnit(unit, this.environment());
  }
  checked(record: NativeRecord) {
    return checkedReservation(record, this.config);
  }
  async reserve(
    binding: Parameters<NativeHost["reserve"]>[0],
    authorization: Authorization,
    instance: string,
  ) {
    requireFact(
      authorization.staging.image === this.config.image &&
        authorization.staging.limits.outputMiB === 64,
      "unsupported_image_or_capacity",
    );
    requireFact(
      this.instancePath && /^[a-f0-9-]{36}$/.test(binding.preparationId),
      "missing_instance_or_preparation",
    );
    const id = binding.preparationId.replaceAll("-", ""),
      root = join(this.config.base, id.slice(0, 12)),
      unit = unitName("openbot-command-" + id + ".service");
    preflightPaths(root);
    requireFact((await this.show(unit)).LoadState === "not-found", "unit_already_exists");
    mkdirSync(root, { mode: 0o700 });
    fsyncDirectory(this.config.base);
    for (const name of ["config", "docker-config", "work", "work/input", "work/output"])
      mkdirSync(join(root, name), { mode: 0o700 });
    const record: NativeReservation = {
      root,
      unit,
      input: join(root, "work/input"),
      output: join(root, "work/output"),
      binding,
      instanceId: instance,
      instancePath: this.instancePath,
      configuration: this.config,
      runtimeMaxMs: authorization.timing.runtimeMaxMs,
      timingPolicyDigest: authorization.timing.policyDigest,
    };
    exclusive(join(root, "native.json"), record);
    const values = configurationValues(root, unit, this.config.binaries);
    exclusive(join(root, "config/daemon.json"), values.daemon);
    const fd = openSync(
      join(root, "config/containerd.toml"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const bytes = Buffer.from(values.containerd);
      for (let offset = 0; offset < bytes.length; ) {
        const n = writeSync(fd, bytes, offset, bytes.length - offset);
        requireFact(n > 0, "native_config_write_unknown");
        offset += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(join(root, "config"));
    return record;
  }
  async prepare(
    value: NativeRecord,
    authorization: Authorization,
    start: readonly [number, number, string],
  ) {
    const record = this.checked(value),
      root = record.root,
      startup = {
        bootId: start[2],
        enforcerInstanceId: record.instanceId,
        expiresBoottimeUs: start[1] + authorization.timing.challengeBudgetMs * 1000,
      };
    exclusive(join(root, "startup.json"), startup);
    guard(startup, record.instancePath);
    exclusive(join(root, "unit-reserved.json"), { unit: record.unit, guard: startup });
    await this.command([
      "/usr/bin/systemd-run",
      "--unit=" + record.unit,
      "--service-type=exec",
      ...Object.entries(properties(record.runtimeMaxMs, this.config.secretsDirectory)).map(
        ([k, v]) => "--property=" + k + "=" + v,
      ),
      ...Object.entries(this.environment()).map(([k, v]) => "--setenv=" + k + "=" + v),
      ...helperArguments(record, "daemon"),
    ]);
    const end =
      nativeClock()[0] +
      Math.min(authorization.timing.prepareBudgetMs, record.runtimeMaxMs - 1000) * 1000;
    while (nativeClock()[0] < end) {
      const state = await this.show(record.unit);
      requireFact(
        !["failed", "inactive"].includes(state.ActiveState ?? ""),
        "native_preparation_failed",
      );
      if (state.ActiveState === "active" && !existsSync(join(root, "unit-observed.json"))) {
        const pid = Number(state.MainPID);
        requireFact(Number.isSafeInteger(pid) && pid > 0, "native_main_process_changed");
        const argv = readKernelText(`/proc/${pid}/cmdline`, 16384).replace(/\0+$/, "").split("\0");
        requireFact(same(argv, helperArguments(record, "daemon")), "native_main_process_changed");
        exclusive(join(root, "unit-observed.json"), { invocationId: state.InvocationID, pid });
      }
      if (existsSync(join(root, "runtime-ready.json"))) {
        await this.checkAlive(record);
        return;
      }
      await delay(25);
    }
    throw new Refused("native_preparation_unknown");
  }
  async checkAlive(value: NativeRecord) {
    const record = this.checked(value),
      current = await this.show(record.unit);
    Object.assign(current, await stopHooks(record.unit, this.command.bind(this)));
    await privateMountFlags(record.unit, this.command.bind(this));
    const active = validateUnit(current, record.unit, record.runtimeMaxMs),
      observed = runtimeReady(record),
      group = "/sys/fs/cgroup" + current.ControlGroup;
    requireFact(
      current.InvocationID === observed.invocationId &&
        Number(current.MainPID) === observed.supervisorPid &&
        lstatSync(group).ino === observed.cgroupInode,
      "unit_identity_changed",
    );
    const [mono, boot, bootId] = nativeClock();
    requireFact(
      mono < active + record.runtimeMaxMs * 1000 && bootId === observed.bootId,
      "native_expired",
    );
    const members = new Set(cgroupMembers(group));
    requireFact(
      [observed.supervisorPid, observed.containerdPid, observed.dockerPid].every((pid) =>
        members.has(pid),
      ),
      "runtime_escaped",
    );
    for (const kind of ["mnt", "net"] as const)
      requireFact(
        readlinkSync(`/proc/${observed.supervisorPid}/ns/${kind}`) === observed.namespaces[kind] &&
          observed.namespaces[kind] !== readlinkSync(`/proc/1/ns/${kind}`),
        "namespace_changed",
      );
    return { current, observed, mono, boot };
  }
  async readiness(value: NativeRecord, authorization: Authorization) {
    const record = this.checked(value),
      { current, observed, mono, boot } = await this.checkAlive(record),
      manifest = inputManifest(record.input);
    requireFact(manifest.digest === authorization.staging.inputDigest, "input_readback_changed");
    chmodSync(record.input, 0o555);
    return {
      bootId: observed.bootId,
      enforcerInstanceId: record.instanceId,
      unitName: record.unit,
      invocationId: observed.invocationId,
      cgroupPath: current.ControlGroup!,
      cgroupInode: observed.cgroupInode,
      activeMonotonicUs: Number(current.ActiveEnterTimestampMonotonic),
      runtimeMaxUs: record.runtimeMaxMs * 1000,
      observedMonotonicUs: mono,
      observedBoottimeUs: boot,
      runtimeIdentityDigest: observed.runtimeIdentityDigest,
      runtimeShapeDigest: observed.runtimeShapeDigest,
      timingPolicyDigest: record.timingPolicyDigest,
      startAttempts: 0 as const,
    };
  }
  async helper(record: NativeReservation, mode: string, timeoutMs: number, limit = 1048576) {
    const ready = runtimeReady(record),
      result = await namespaceCommand({
        pid: ready.supervisorPid,
        namespaces: ready.namespaces,
        argv: helperArguments(record, mode),
        environment: this.environment(),
        timeoutMs,
        captureLimit: limit,
      });
    if (!result.ok) throw new NativeCommandFailure(mode, result);
    return result.stdout.trim();
  }
  async execute(value: NativeRecord, operation: CommandOperation, launch: Launch) {
    const record = this.checked(value);
    await this.checkAlive(record);
    guard(launch, record.instancePath);
    exclusive(join(record.root, "launch.json"), { operation, guard: launch });
    await this.helper(
      record,
      "execute",
      Math.min(5000, Math.max(10, (launch.expiresBoottimeUs - nativeClock()[1]) / 1000)),
    );
  }
  async lookup(value: NativeRecord, _operation: CommandOperation, includeOutput: boolean) {
    const record = this.checked(value),
      attempts = new EventLedger(join(record.root, "work/events.jsonl")).counters(
        record.binding.actionId,
        record.binding.originalEpoch,
      ).startAttempts;
    const unknown: CommandClaims<"work_command_receipt">["observation"] = {
      phase: "unknown",
      containerId: null,
      startAttempts: Math.min(1, attempts),
      exitCode: null,
      sequence: 1,
      runtimeShapeDigest: null,
      outputs: [],
      truncated: false,
    };
    try {
      await this.checkAlive(record);
      const value = JSON.parse(
        await this.helper(record, includeOutput ? "lookup-output" : "lookup", 3000, 2 * 1048576),
      ) as { observation: typeof unknown; data: string | null };
      const data = includeOutput && value.data !== null ? Buffer.from(value.data, "base64") : null;
      requireFact(
        data === null || (data.length <= 1048576 && data.toString("base64") === value.data),
        "invalid_output_capture",
      );
      if (!includeOutput) value.observation.outputs = [];
      return { observation: value.observation, data };
    } catch {
      return { observation: unknown, data: null };
    }
  }
  async stop(value: NativeRecord) {
    const record = this.checked(value),
      current = await this.show(record.unit);
    if (current.LoadState === "not-found") return;
    const path = join(
      record.root,
      existsSync(join(record.root, "runtime-ready.json"))
        ? "runtime-ready.json"
        : "unit-observed.json",
    );
    requireFact(existsSync(path), "unit_identity_unknown");
    const original = readRecord(path) as { invocationId: string };
    requireFact(current.InvocationID === original.invocationId, "unit_identity_changed");
    await this.command(["/usr/bin/systemctl", "stop", record.unit], 5000);
  }
  /** Operator-only cleanup after transport closure. Reservations and output evidence stay retained. */
  async cleanup(value: NativeRecord) {
    const record = this.checked(value),
      root = record.root,
      current = await this.show(record.unit),
      original = readRecord(
        join(
          root,
          existsSync(join(root, "runtime-ready.json"))
            ? "runtime-ready.json"
            : "unit-observed.json",
        ),
      ) as { invocationId: string };
    requireFact(
      current.InvocationID === original.invocationId &&
        ["inactive", "failed"].includes(current.ActiveState ?? "") &&
        current.NRestarts === "0",
      "original_unit_not_terminal",
    );
    requireFact(
      cgroupMembers("/sys/fs/cgroup/system.slice/" + record.unit).length === 0,
      "runtime_tree_not_empty",
    );
    if (existsSync(join(root, "loop.json"))) {
      const loop = readRecord(join(root, "loop.json")) as {
          backing: string;
          inode: number;
          device: string;
        },
        disk = join(root, "output.ext4");
      requireFact(
        loop.backing === disk &&
          /^\/dev\/loop[0-9]+$/.test(loop.device) &&
          lstatSync(disk).ino === loop.inode &&
          lstatSync(disk).isFile(),
        "backing_changed",
      );
      const found = JSON.parse(
        await this.command([
          "/usr/sbin/losetup",
          "--json",
          "--list",
          "--output",
          "NAME,BACK-FILE",
          loop.device,
        ]),
      );
      requireFact(
        same(found.loopdevices, [{ name: loop.device, "back-file": disk }]),
        "loop_identity_changed",
      );
      await this.command(["/usr/sbin/losetup", "--detach", loop.device]);
      unlinkSync(disk);
      fsyncDirectory(root);
    } else requireFact(!existsSync(join(root, "loop-reserved.json")), "loop_ack_unknown");
    for (const name of ["docker-data", "docker-exec", "containerd-data", "containerd-state"]) {
      const path = join(root, name);
      if (existsSync(path)) {
        requireFact(
          realpathSync(path) === path && lstatSync(path).uid === 0 && lstatSync(path).isDirectory(),
          "cleanup_path_changed",
        );
        rmSync(path, { recursive: true });
      }
    }
    exclusive(join(root, "cleaned.json"), {
      invocationId: original.invocationId,
      originalReservationRetained: true,
    });
  }
}
