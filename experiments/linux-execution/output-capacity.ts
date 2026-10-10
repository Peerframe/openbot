/** Read-only descriptor-bound capacity evidence; neither provisions storage nor grants authority. */
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative } from "node:path";
import { filesystemFacts } from "./kernel-facts.ts";
export class OutputCapacityRefused extends Error {}
function requireCapacity(value: unknown, message: string): asserts value {
  if (!value) throw new OutputCapacityRefused(message);
}
export function readKernelText(path: string, limit = 1024 * 1024) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null);
      if (!n) break;
      length += n;
    }
    requireCapacity(length <= limit, "kernel capture limit exceeded");
    return new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}
function natural(value: string) {
  requireCapacity(/^[0-9]+$/.test(value), "invalid kernel integer");
  const n = Number(value);
  requireCapacity(Number.isSafeInteger(n), "invalid kernel integer");
  return n;
}
function unescapeMount(value: string) {
  return value.replace(/\\(040|011|012|134)/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}
export function mounts(text: string) {
  return text
    .trimEnd()
    .split("\n")
    .map((line) => {
      const sides = line.split(" - "),
        left = sides[0]!.trim().split(/\s+/),
        right = sides[1]?.trim().split(/\s+/);
      requireCapacity(
        sides.length === 2 && left.length >= 6 && right?.length === 3,
        "malformed kernel mountinfo",
      );
      return {
        id: natural(left[0]!),
        device: left[2]!,
        root: unescapeMount(left[3]!),
        path: unescapeMount(left[4]!),
        options: new Set(left[5]!.split(",")),
        propagation: left.slice(6),
        filesystem: right[0]!,
        superOptions: new Set(right[2]!.split(",")),
      };
    });
}
export type Mount = ReturnType<typeof mounts>[number];
export function mountId(fd: number, read = readKernelText) {
  const values = read(`/proc/self/fdinfo/${fd}`, 4096)
    .split("\n")
    .filter((line) => line.startsWith("mnt_id:"))
    .map((line) => line.slice(7).trim());
  requireCapacity(values.length === 1, "descriptor mount identity unavailable or ambiguous");
  return natural(values[0]!);
}
export function deviceNumbers(device: bigint) {
  const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n),
    minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n);
  return `${major}:${minor}`;
}
const within = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith("../") && !isAbsolute(path);
};
export type CapacityFacts = ReturnType<typeof filesystemFacts>;
/** Injection is confined to test-owned kernel readers; production defaults always use real facts. */
export function verifyOutputCapacity(
  path: string,
  limitBytes: number,
  dependencies: {
    platform?: string;
    read?: typeof readKernelText;
    filesystem?: (fd: number) => CapacityFacts;
  } = {},
) {
  const read = dependencies.read ?? readKernelText,
    filesystem = dependencies.filesystem ?? filesystemFacts;
  requireCapacity(
    (dependencies.platform ?? process.platform) === "linux",
    "output capacity requires Linux kernel mount/device facts",
  );
  requireCapacity(
    Number.isSafeInteger(limitBytes) && limitBytes > 0 && limitBytes <= 64 * 1024 * 1024,
    "output capacity limit must be an integer within 64 MiB",
  );
  let fd: number | undefined;
  try {
    requireCapacity(
      isAbsolute(path) && realpathSync(path) === path,
      "output path must be absolute and contain no symlinks",
    );
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const identity = fstatSync(fd, { bigint: true }),
      id = mountId(fd, read),
      mountinfo = read("/proc/self/mountinfo"),
      entries = mounts(mountinfo),
      matched = entries.filter((m) => m.id === id);
    requireCapacity(matched.length === 1, "output mount identity unavailable or ambiguous");
    const mount = matched[0]!;
    requireCapacity(
      mount.path === path && mount.root === "/",
      "output must be root of its dedicated filesystem",
    );
    requireCapacity(mount.filesystem === "ext4", "output filesystem must be persistent ext4");
    requireCapacity(
      ["rw", "nodev", "nosuid", "noexec"].every((flag) => mount.options.has(flag)) &&
        !mount.superOptions.has("ro"),
      "output mount must be writable with nodev,nosuid,noexec",
    );
    requireCapacity(
      !mount.propagation.some((p) => /^(shared|master|propagate_from):/.test(p)),
      "output mount propagation must be private",
    );
    requireCapacity(
      !entries.some((m) => within(path, m.path)),
      "nested output mounts can bypass capacity",
    );
    const device = deviceNumbers(identity.dev);
    requireCapacity(mount.device === device, "output descriptor and mount device disagree");
    requireCapacity(
      !entries.some((m) => m.id !== id && m.device === device),
      "output device has another mount",
    );
    const sectors = natural(read(`/sys/dev/block/${device}/size`, 64).trim()),
      deviceBytes = BigInt(sectors) * 512n,
      stats = filesystem(fd),
      filesystemBytes = stats.blocks * stats.fragmentSize;
    requireCapacity(
      0n < filesystemBytes && filesystemBytes <= deviceBytes && deviceBytes <= BigInt(limitBytes),
      "total output device capacity exceeds admitted bound or is invalid",
    );
    requireCapacity((stats.flags & 1n) === 0n, "output filesystem is read-only");
    const current = lstatSync(path, { bigint: true });
    requireCapacity(
      current.dev === identity.dev && current.ino === identity.ino,
      "output path changed during capacity inspection",
    );
    requireCapacity(
      mountId(fd, read) === id && read("/proc/self/mountinfo") === mountinfo,
      "mount topology changed during capacity inspection",
    );
    requireCapacity(
      identity.ino <= BigInt(Number.MAX_SAFE_INTEGER),
      "output inode outside exact integer range",
    );
    return {
      version: 1,
      path,
      mount_id: id,
      device,
      inode: Number(identity.ino),
      filesystem: "ext4",
      device_bytes: Number(deviceBytes),
      filesystem_bytes: Number(filesystemBytes),
      limit_bytes: limitBytes,
    };
  } catch (error) {
    if (error instanceof OutputCapacityRefused) throw error;
    throw new OutputCapacityRefused("output kernel capacity facts could not be verified", {
      cause: error,
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
