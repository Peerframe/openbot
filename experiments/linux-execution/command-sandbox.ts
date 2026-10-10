/** Protected Host's narrow create/start/recover adapter. Exact immutable IDs and durable slots only. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { directoryNames } from "../../apps/server/dist/posix-directory.js";
import { openAt } from "../../apps/server/dist/posix-files.js";
import {
  workCommandSchema,
  type WorkCommand,
} from "../../apps/server/dist/work-command-contract.js";
import { commandValue } from "../../apps/server/dist/work-command-values.js";
import { DockerCli, object } from "./docker-cli.ts";
import { EventLedger, type Association } from "./event-ledger.ts";
import { createArguments, assertCreatedShape, type Shape } from "./container-shape.ts";
import { verifyOutputCapacity } from "./output-capacity.ts";
import { requireFact } from "./protected-io.ts";
const hash = (value: unknown) =>
  "sha256:" + createHash("sha256").update(commandValue(value)).digest("hex");
const below = (root: string, path: string) => {
  const r = relative(root, path);
  return r !== "" && r !== ".." && !r.startsWith("../") && !isAbsolute(r);
};
const overlaps = (a: string, b: string) => a === b || below(a, b) || below(b, a);
export function inputManifest(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const names = directoryNames(fd, 8).sort(),
      entries: WorkCommand["inputManifest"] = [];
    let total = 0;
    for (const name of names) {
      const file = openAt(fd, name, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const info = fstatSync(file, { bigint: true });
        requireFact(
          info.isFile() && info.nlink === 1n && info.size >= 0n && info.size <= 20n * 1024n * 1024n,
          "invalid_input_file",
        );
        total += Number(info.size);
        requireFact(total <= 20 * 1024 ** 2, "input_capacity");
        const digest = createHash("sha256"),
          buffer = Buffer.alloc(65536);
        let bytes = 0;
        for (;;) {
          const n = readSync(file, buffer, 0, buffer.length, null);
          if (!n) break;
          bytes += n;
          requireFact(bytes <= Number(info.size), "input_changed");
          digest.update(buffer.subarray(0, n));
        }
        const after = fstatSync(file, { bigint: true });
        requireFact(
          BigInt(bytes) === info.size &&
            after.size === info.size &&
            after.mtimeNs === info.mtimeNs &&
            after.ctimeNs === info.ctimeNs,
          "input_changed",
        );
        entries.push({ path: name, size: bytes, sha256: digest.digest("hex") });
      } finally {
        closeSync(file);
      }
    }
    return { entries, digest: hash(entries) };
  } finally {
    closeSync(fd);
  }
}
const identity = (path: string) => {
  const s = lstatSync(path, { bigint: true });
  requireFact(s.isDirectory(), "not_data_directory");
  return [s.dev, s.ino] as const;
};
export type Prepared = {
  shape: Shape;
  inputIdentity: readonly [bigint, bigint];
  outputIdentity: readonly [bigint, bigint];
};
export type Created = Association & {
  wall_seconds: number;
  output_capacity: ReturnType<typeof verifyOutputCapacity>;
  image_reference: string;
  runtime: string;
  state: string;
};
export async function prepareAction(options: {
  root: string;
  input: string;
  output: string;
  action: string;
  epoch: number;
  command: WorkCommand;
  controlPaths: readonly string[];
}): Promise<Prepared> {
  const command = await workCommandSchema.parseAsync(options.command);
  requireFact(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.action) &&
      Number.isSafeInteger(options.epoch) &&
      options.epoch >= 1,
    "invalid_action_identity",
  );
  for (const path of [options.input, options.output]) {
    requireFact(
      isAbsolute(path) && realpathSync(path) === path && below(options.root, path),
      "data_path_outside_root",
    );
    requireFact(!options.controlPaths.some((p) => overlaps(path, p)), "control_path_exposure");
  }
  requireFact(!overlaps(options.input, options.output), "data_path_overlap");
  const output = openSync(
    options.output,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    requireFact(directoryNames(output, 1).length === 0, "output_not_empty");
  } finally {
    closeSync(output);
  }
  const manifest = inputManifest(options.input);
  requireFact(
    manifest.digest === command.inputDigest && same(manifest.entries, command.inputManifest),
    "input_readback_changed",
  );
  return {
    shape: {
      name: `openbot-linux-exec-${options.action}-${options.epoch}`,
      action: options.action,
      epoch: options.epoch,
      intent: hash({ action: options.action, epoch: options.epoch, command }),
      input: options.input,
      output: options.output,
      command,
    },
    inputIdentity: identity(options.input),
    outputIdentity: identity(options.output),
  };
}
export class CommandSandbox {
  readonly cli: DockerCli;
  readonly root: string;
  readonly ledger: EventLedger;
  readonly admittedImages: readonly string[];
  readonly expectedDaemonId: string;
  readonly expectedDaemonRoot: string;
  readonly capacity: typeof verifyOutputCapacity;
  readonly platform: string;
  readonly architecture: string;
  constructor(options: {
    cli: DockerCli;
    root: string;
    ledger: EventLedger;
    admittedImages: readonly string[];
    expectedDaemonId: string;
    expectedDaemonRoot: string;
    capacity?: typeof verifyOutputCapacity;
    platform?: string;
    architecture?: string;
  }) {
    this.cli = options.cli;
    this.root = options.root;
    this.ledger = options.ledger;
    this.admittedImages = options.admittedImages;
    this.expectedDaemonId = options.expectedDaemonId;
    this.expectedDaemonRoot = options.expectedDaemonRoot;
    this.capacity = options.capacity ?? verifyOutputCapacity;
    this.platform = options.platform ?? process.platform;
    this.architecture = options.architecture ?? process.arch;
  }
  async preflight(reference: string) {
    requireFact(
      this.platform === "linux" && this.architecture === "x64",
      "unqualified_native_platform",
    );
    requireFact(
      /^[^@\s]+@sha256:[0-9a-f]{64}$/.test(reference) && this.admittedImages.includes(reference),
      "unreviewed_image",
    );
    requireFact((await this.cli.version()) === "29.8.1", "docker_engine_changed");
    const info = await this.cli.info();
    requireFact(
      info.ID === this.expectedDaemonId && info.DockerRootDir === this.expectedDaemonRoot,
      "private_daemon_changed",
    );
    requireFact(
      info.OSType === "linux" &&
        ["x86_64", "amd64"].includes(String(info.Architecture)) &&
        String(info.CgroupVersion) === "2" &&
        Object.hasOwn(object(info.Runtimes), "runsc"),
      "docker_runtime_changed",
    );
    const image = await this.cli.imageInspect(reference);
    requireFact(
      image &&
        Array.isArray(image.RepoDigests) &&
        image.RepoDigests.some(
          (d) => typeof d === "string" && d.endsWith("@" + reference.split("@")[1]),
        ),
      "loaded_image_changed",
    );
    return { engine: "29.8.1", imageId: image.Id, runtime: "runsc", cgroupVersion: "2" };
  }
  async create(prepared: Prepared) {
    const v = prepared.shape;
    const current = await prepareAction({
      root: this.root,
      input: v.input,
      output: v.output,
      action: v.action,
      epoch: v.epoch,
      command: v.command,
      controlPaths: [this.ledger.path, this.ledger.path + ".lock"],
    });
    requireFact(same(current, prepared), "prepared_identity_changed");
    const capacity = this.capacity(v.output, v.command.limits.outputMiB * 1024 ** 2),
      args = createArguments(v);
    await this.ledger.reserveCreate(v.action, v.epoch, v.name, v.intent);
    const result = await this.cli.create(args);
    if (!result.ok) {
      await this.ledger.append(
        v.action,
        v.epoch,
        result.uncertain ? "container_create_unverified" : "container_create_failed",
        { container_name: v.name, status: result.status },
      );
      throw new Error("container_create_unknown");
    }
    const id = result.stdout.trim();
    requireFact(/^[a-f0-9]{64}$/.test(id), "invalid_create_receipt");
    const inspected = await this.cli.inspect(id);
    requireFact(inspected && inspected.Id === id, "created_object_unknown");
    assertCreatedShape(v, inspected);
    const record: Created = {
      action_id: v.action,
      action_epoch: v.epoch,
      container_name: v.name,
      container_id: id,
      intent_digest: v.intent,
      wall_seconds: v.command.limits.wallSeconds,
      output_capacity: capacity,
      image_reference: v.command.image,
      runtime: String(object(inspected.HostConfig).Runtime),
      state: String(object(inspected.State).Status),
    };
    await this.ledger.append(v.action, v.epoch, "container_created", record);
    return record;
  }
  async startOnce(record: Created) {
    requireFact(/^[a-f0-9]{64}$/.test(record.container_id), "invalid_container_id");
    await this.ledger.reserveStart(record);
    const durable = this.ledger.association(record),
      previous = durable.output_capacity as ReturnType<typeof verifyOutputCapacity>;
    requireFact(previous && typeof previous.path === "string", "missing_output_capacity");
    try {
      requireFact(
        same(this.capacity(previous.path, previous.limit_bytes), previous),
        "output_capacity_changed",
      );
    } catch (error) {
      await this.ledger.append(
        record.action_id,
        record.action_epoch,
        "start_refused_output_capacity",
        { container_id: record.container_id },
      );
      throw error;
    }
    const result = await this.cli.start(record.container_id);
    await this.ledger.append(
      record.action_id,
      record.action_epoch,
      result.ok ? "start_succeeded" : result.uncertain ? "start_unverified" : "start_failed",
      { container_id: record.container_id, status: result.status },
    );
    requireFact(result.ok, "container_start_unknown");
  }
  async recover(action: string, epoch: number) {
    const created = this.ledger
        .forAction(action, epoch)
        .filter((e) => e.event === "container_created"),
      unknown = {
        outcome: "unknown" as const,
        container_id: null as string | null,
        exit_code: null as number | null,
      };
    if (created.length !== 1) return unknown;
    const record = created[0]!.detail,
      id = record.container_id;
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) return unknown;
    const inspected = await this.cli.inspect(id);
    if (!inspected || inspected.Id !== id) return { ...unknown, container_id: id };
    const state = object(inspected.State),
      status = state.Status,
      counters = this.ledger.counters(action, epoch);
    if (inspected.RestartCount !== 0 || counters.startAttempts !== 1)
      return { ...unknown, container_id: id };
    if (status === "running")
      return { outcome: "running" as const, container_id: id, exit_code: null };
    if (
      status === "exited" &&
      Number.isSafeInteger(state.ExitCode) &&
      Number(state.ExitCode) >= 0 &&
      Number(state.ExitCode) <= 255
    )
      return { outcome: "exited" as const, container_id: id, exit_code: state.ExitCode as number };
    return { ...unknown, container_id: id };
  }
}
