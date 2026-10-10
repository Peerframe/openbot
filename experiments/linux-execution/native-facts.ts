/** Fixed native unit/mount/output readbacks. Never substitutes host claims for kernel facts. */
import { constants, openSync, closeSync, fstatSync, readSync, type Stats } from "node:fs";
import { join } from "node:path";
import { openAt } from "../../apps/server/dist/posix-files.js";
import { directoryNames } from "../../apps/server/dist/posix-directory.js";
import { strictCommandJson } from "../../apps/server/dist/work-command-values.js";
import { nativeClock, filesystemFacts } from "./kernel-facts.ts";
import { mounts, mountId, readKernelText, type Mount } from "./output-capacity.ts";
import { exclusive, readRecord, requireFact } from "./protected-io.ts";
export const unitProperties = {
  PrivateNetwork: "yes",
  PrivateMounts: "yes",
  Delegate: "yes",
  DelegateSubgroup: "supervisor",
  MemoryMax: "2500M",
  MemorySwapMax: "0",
  CPUQuota: "150%",
  TasksMax: "1536",
  RuntimeMaxSec: "60",
  RuntimeRandomizedExtraSec: "0",
  TimeoutStartSec: "10",
  TimeoutStopSec: "1",
  KillMode: "control-group",
  KillSignal: "SIGKILL",
  FinalKillSignal: "SIGKILL",
  SendSIGKILL: "yes",
  Restart: "no",
  NotifyAccess: "none",
};
export const unitShow = [
  "LoadState",
  "ActiveState",
  "SubState",
  "Result",
  "MainPID",
  "InvocationID",
  "ControlGroup",
  "ActiveEnterTimestampMonotonic",
  "RuntimeMaxUSec",
  "RuntimeRandomizedExtraUSec",
  "TimeoutStopUSec",
  "KillMode",
  "KillSignal",
  "FinalKillSignal",
  "SendSIGKILL",
  "Restart",
  "NRestarts",
  "Type",
  "NotifyAccess",
  "ExecStop",
  "ExecStopPost",
  "TriggeredBy",
  "PrivateNetwork",
  "PrivateMounts",
  "DelegateSubgroup",
  "MemoryMax",
  "MemorySwapMax",
  "TasksMax",
  "CPUQuotaPerSecUSec",
];
export function guard(
  value: { bootId: string; enforcerInstanceId: string; expiresBoottimeUs: number },
  instancePath: string,
  clock = nativeClock,
  read = readRecord,
) {
  const [mono, boot, id] = clock(),
    instance = read(instancePath) as { instanceId: unknown };
  requireFact(
    id === value.bootId &&
      boot < value.expiresBoottimeUs &&
      value.enforcerInstanceId === instance.instanceId,
    "native_guard_expired",
  );
  return [mono, boot] as const;
}
export function socketPaths(root: string) {
  return [
    join(root, "docker.sock"),
    join(root, "containerd.sock"),
    join(root, "docker-exec/libnetwork/0123456789ab.sock"),
    join(root, "containerd-state/s", "0".repeat(64)),
    join("/run/containerd/s", "0".repeat(64)),
  ];
}
export function preflightPaths(root: string) {
  requireFact(
    socketPaths(root).every((path) => Buffer.byteLength(path) <= 106),
    "native_socket_path_too_long",
  );
}
export function properties(runtimeMs: number, secrets: string) {
  requireFact(
    Number.isSafeInteger(runtimeMs) && runtimeMs >= 1 && runtimeMs <= 50000,
    "unqualified_runtime",
  );
  return {
    ...unitProperties,
    RuntimeMaxSec: runtimeMs + "ms",
    InaccessiblePaths: secrets,
    MountFlags: "private",
    TemporaryFileSystem: "/run/containerd:rw,nosuid,nodev,noexec,mode=0700,size=16m",
  };
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function typedReply(text: string, code: string) {
  try {
    return strictCommandJson(Buffer.from(text), 32768);
  } catch {
    requireFact(false, code);
  }
}
export async function privateMountFlags(
  unit: string,
  command: (argv: string[]) => Promise<string>,
) {
  const service = "org.freedesktop.systemd1",
    found = typedReply(
      await command([
        "/usr/bin/busctl",
        "--json=short",
        "call",
        service,
        "/org/freedesktop/systemd1",
        service + ".Manager",
        "GetUnit",
        "s",
        unit,
      ]),
      "unit_mount_object_changed",
    );
  requireFact(
    object(found) &&
      Object.keys(found).sort().join(",") === "data,type" &&
      found.type === "o" &&
      Array.isArray(found.data) &&
      found.data.length === 1 &&
      typeof found.data[0] === "string" &&
      /^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(found.data[0]),
    "unit_mount_object_changed",
  );
  const value = typedReply(
    await command([
      "/usr/bin/busctl",
      "--json=short",
      "get-property",
      service,
      found.data[0],
      service + ".Service",
      "MountFlags",
    ]),
    "unit_mount_flags_changed",
  );
  requireFact(
    object(value) &&
      Object.keys(value).sort().join(",") === "data,type" &&
      value.type === "t" &&
      value.data === 1 << 18,
    "unit_mount_flags_changed",
  );
  return value;
}
type MountIdentity = Pick<Stats, "uid" | "mode" | "dev" | "ino">;
export function socketMountSnapshot(
  entries: Mount[],
  identity: MountIdentity,
  id: number,
  filesystemBytes: number,
) {
  const matches = entries.filter((m) => m.id === id),
    value = {
      version: 1,
      mountId: id,
      matchCount: matches.length,
      device: identity.dev,
      inode: identity.ino,
      uid: identity.uid,
      mode: identity.mode & 0o777,
      filesystemBytes,
    };
  if (matches.length !== 1) return value;
  const mount = matches[0]!,
    known = new Set([
      "rw",
      "ro",
      "nosuid",
      "suid",
      "nodev",
      "dev",
      "noexec",
      "exec",
      "relatime",
      "strictatime",
      "noatime",
      "lazytime",
      "sync",
      "dirsync",
    ]);
  return {
    ...value,
    mount: {
      expectedPath: mount.path === "/run/containerd",
      filesystemRoot: mount.root === "/",
      filesystem: ["tmpfs", "ext4", "overlay"].includes(mount.filesystem)
        ? mount.filesystem
        : "other",
      flags: [...mount.options].filter((v) => known.has(v)).sort(),
      unknownFlagCount: [...mount.options].filter((v) => !known.has(v)).length,
      superReadOnly: mount.superOptions.has("ro"),
      propagation: mount.propagation.map((field) => {
        const match = /^(shared|master|propagate_from):([0-9]{1,16})$/.exec(field);
        return match && Number.isSafeInteger(Number(match[2]))
          ? { kind: match[1], group: Number(match[2]) }
          : { kind: field === "unbindable" ? "unbindable" : "unknown" };
      }),
    },
  };
}
export function checkSocketMountFacts(
  entries: Mount[],
  identity: MountIdentity,
  id: number,
  filesystemBytes: number,
) {
  const matches = entries.filter((m) => m.id === id);
  requireFact(matches.length === 1, "shim_mount_ambiguous");
  const mount = matches[0]!;
  requireFact(mount.path === "/run/containerd", "shim_mount_path");
  requireFact(mount.root === "/", "shim_mount_root");
  requireFact(mount.filesystem === "tmpfs", "shim_mount_filesystem");
  requireFact(
    ["rw", "nosuid", "nodev", "noexec"].every((f) => mount.options.has(f)),
    "shim_mount_options",
  );
  requireFact(!mount.superOptions.has("ro"), "shim_mount_readonly");
  requireFact(mount.propagation.length === 0, "shim_mount_propagation");
  requireFact(identity.uid === 0, "shim_mount_uid");
  requireFact((identity.mode & 0o777) === 0o700, "shim_mount_mode");
  requireFact(filesystemBytes > 0 && filesystemBytes <= 16 * 1024 ** 2, "shim_mount_capacity");
  return { mountId: id, device: identity.dev, inode: identity.ino, filesystemBytes };
}
export function verifyRuntimeSocketMount(
  recordPath?: string,
  ops = {
    open: () =>
      openSync(
        "/run/containerd",
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ),
    read: readKernelText,
    filesystem: filesystemFacts,
    identity: (fd: number) => fstatSync(fd),
    mountId,
    mounts,
    exclusive,
  },
) {
  const fd = ops.open();
  try {
    const before = ops.read("/proc/self/mountinfo"),
      stats = ops.filesystem(fd),
      entries = ops.mounts(before),
      identity = ops.identity(fd),
      id = ops.mountId(fd),
      size = Number(stats.blocks * stats.fragmentSize);
    requireFact(Number.isSafeInteger(size), "shim_mount_capacity");
    if (recordPath) ops.exclusive(recordPath, socketMountSnapshot(entries, identity, id, size));
    const result = checkSocketMountFacts(entries, identity, id, size);
    requireFact(ops.read("/proc/self/mountinfo") === before, "shim_mount_race");
    return result;
  } finally {
    closeSync(fd);
  }
}
export function configurationValues(root: string, unit: string, binaries: string) {
  const daemon = {
    hosts: ["unix://" + join(root, "docker.sock")],
    "data-root": join(root, "docker-data"),
    "exec-root": join(root, "docker-exec"),
    pidfile: join(root, "dockerd.pid"),
    bridge: "none",
    iptables: false,
    ip6tables: false,
    "ip-forward": false,
    "ip-masq": false,
    "userland-proxy": false,
    "live-restore": false,
    runtimes: { runsc: { path: join(binaries, "runsc"), runtimeArgs: ["--platform=systrap"] } },
    "default-runtime": "runsc",
    "exec-opts": ["native.cgroupdriver=cgroupfs"],
    "cgroup-parent": "/system.slice/" + unit,
    "log-driver": "local",
    "log-opts": { "max-size": "1m", "max-file": "1", compress: "false" },
    containerd: join(root, "containerd.sock"),
    "containerd-namespace": "openbot-command",
    "containerd-plugins-namespace": "openbot-command-plugins",
  };
  const containerd = `version = 3\nroot = "${root}/containerd-data"\nstate = "${root}/containerd-state"\ndisabled_plugins = ["io.containerd.cri.v1.images", "io.containerd.cri.v1.runtime"]\n[grpc]\n  address = "${root}/containerd.sock"\n`;
  return { daemon, containerd };
}
export function boundedOutput(path: string, output: { name: string; maxBytes: number }) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const names = directoryNames(fd, 2);
    requireFact(names.length === 1 && names[0] === output.name, "unexpected_output");
    const file = openAt(fd, output.name, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const before = fstatSync(file, { bigint: true });
      requireFact(
        before.isFile() &&
          before.nlink === 1n &&
          Number.isSafeInteger(output.maxBytes) &&
          output.maxBytes > 0 &&
          output.maxBytes <= 1048576 &&
          before.size >= 0n &&
          before.size <= BigInt(output.maxBytes),
        "output_bound",
      );
      const data = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < data.length) {
        const n = readSync(file, data, offset, Math.min(65536, data.length - offset), null);
        requireFact(n > 0, "output_shortened");
        offset += n;
      }
      const after = fstatSync(file, { bigint: true });
      requireFact(
        readSync(file, Buffer.alloc(1), 0, 1, null) === 0 &&
          after.size === before.size &&
          after.mtimeNs === before.mtimeNs &&
          after.ctimeNs === before.ctimeNs,
        "output_changed",
      );
      new TextDecoder("utf8", { fatal: true }).decode(data);
      requireFact(!data.includes(0), "output_not_text");
      return data;
    } finally {
      closeSync(file);
    }
  } finally {
    closeSync(fd);
  }
}
