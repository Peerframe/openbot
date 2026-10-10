/** Reads Linux kernel peer identity and both monotonic clocks; never accepts wire claims. */
import { readFileSync } from "node:fs";
import type { Socket } from "node:net";
import koffi from "koffi";
function requireFact(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
let abi:
  | {
      clock: (id: number, value: BigInt64Array) => number;
      filesystem: (fd: number, value: BigUint64Array) => number;
      peer: (
        fd: number,
        level: number,
        option: number,
        value: Uint32Array,
        length: Uint32Array,
      ) => number;
    }
  | undefined;
function linuxAbi() {
  requireFact(
    process.platform === "linux" && ["x64", "arm64"].includes(process.arch),
    "unsupported_kernel_abi",
  );
  if (!abi) {
    const libc = koffi.load(null);
    abi = {
      filesystem: libc.func("int fstatvfs(int, _Out_ uint64_t *)"),
      clock: libc.func("int clock_gettime(int, _Out_ int64_t *)"),
      peer: libc.func("int getsockopt(int, int, int, _Out_ void *, _Inout_ uint32_t *)"),
    };
  }
  return abi;
}
export function nativeClock(): readonly [number, number, string] {
  const { clock } = linuxAbi();
  const sample = (id: number) => {
    const value = new BigInt64Array(2);
    requireFact(clock(id, value) === 0, "kernel_clock_failed");
    requireFact(
      value[0]! >= 0n && value[1]! >= 0n && value[1]! < 1000000000n,
      "kernel_clock_invalid",
    );
    const us = Number(value[0]! * 1000000n + value[1]! / 1000n);
    requireFact(Number.isSafeInteger(us), "kernel_clock_invalid");
    return us;
  };
  const mono = sample(1),
    boot = sample(7),
    identity = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  requireFact(
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(identity),
    "kernel_boot_invalid",
  );
  return [mono, boot, identity];
}
export function peerUid(socket: Socket) {
  // Node exposes no public SO_PEERCRED wrapper. The pinned runtime's live accepted handle is
  // checked before the syscall; an unavailable/closed handle fails closed, never uses wire UID.
  const fd = (socket as Socket & { _handle?: { fd?: unknown } })._handle?.fd;
  requireFact(
    typeof fd === "number" && Number.isInteger(fd) && fd >= 0 && fd <= 2147483647,
    "unsupported_peer_credentials",
  );
  const credential = new Uint32Array(3),
    size = new Uint32Array([12]);
  requireFact(
    linuxAbi().peer(fd, 1, 17, credential, size) === 0 && size[0] === 12,
    "peer_credentials_failed",
  );
  return credential[1]!;
}

/** Linux LP64 statvfs is 112 bytes; only stable leading fields are interpreted. */
export function filesystemFacts(fd: number) {
  const raw = new BigUint64Array(16);
  requireFact(linuxAbi().filesystem(fd, raw) === 0, "kernel_filesystem_failed");
  return { blocks: raw[2]!, fragmentSize: raw[1]!, flags: raw[9]! };
}
