/** Performs descriptor-relative file reads and writes without following replaced paths. */
import { closeSync, constants, openSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import koffi from "koffi";

// Private fixed signatures only. No caller-supplied library, symbol, pointer or signature.
// Node does not expose openat/flock; the inode locks must interoperate with retained Python.
let native: ReturnType<typeof bind> | undefined;
function bind() {
  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch))
    throw new Error("Protected POSIX files are unavailable on this platform.");
  const libc = koffi.load(null);
  return {
    open: libc.func("int openat(int dirfd, const char *path, int flags, ...)"),
    mkdir: libc.func("int mkdirat(int dirfd, const char *path, uint32_t mode)"),
    link: libc.func(
      "int linkat(int fromfd, const char *from, int tofd, const char *to, int flags)",
    ),
    unlink: libc.func("int unlinkat(int dirfd, const char *path, int flags)"),
    lock: libc.func("int flock(int fd, int operation)"),
  };
}
const api = () => (native ??= bind());
const childName = (name: string) => {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0"))
    throw new Error("Invalid protected file name.");
  return name;
};
function checked(value: number) {
  if (value >= 0) return value;
  // Capture errno synchronously, before any other native call can overwrite it.
  const errno = koffi.errno();
  const error = new Error("Protected file operation failed.") as NodeJS.ErrnoException;
  error.errno = errno;
  error.code = Object.entries(koffi.os.errno).find(([, value]) => value === errno)?.[0] ?? "EIO";
  throw error;
}
export function openAt(fd: number, name: string, flags: number, mode = 0o600): number {
  const libc = api();
  // Reviewed Darwin and Linux64 ABI values; create descriptors atomically close-on-exec.
  const cloexec = process.platform === "darwin" ? 0x1000000 : 0x80000;
  return checked(
    libc.open(fd, childName(name), flags | constants.O_NOFOLLOW | cloexec, "int", mode),
  );
}
export function mkdirAt(fd: number, name: string): void {
  checked(api().mkdir(fd, childName(name), 0o700));
}
export function linkAt(fd: number, from: string, to: string): void {
  checked(api().link(fd, childName(from), fd, childName(to), 0));
}
export function unlinkAt(fd: number, name: string): void {
  checked(api().unlink(fd, childName(name), 0));
}
export function openDirectory(path: string, create: boolean): number {
  api();
  if (typeof path !== "string" || path.includes("\0") || path.length > 4096)
    throw new Error("Invalid protected directory.");
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const name of resolve(path).split("/").filter(Boolean)) {
      let next: number;
      try {
        next = openAt(fd, name, constants.O_RDONLY | constants.O_DIRECTORY);
      } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          mkdirAt(fd, name);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        }
        next = openAt(fd, name, constants.O_RDONLY | constants.O_DIRECTORY);
      }
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
export async function exclusiveLock(
  fd: number,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  const end = performance.now() + milliseconds;
  for (;;) {
    signal?.throwIfAborted();
    const value = api().lock(fd, 2 | 4); // LOCK_EX | LOCK_NB; same protocol as Python fcntl.flock.
    if (value === 0) return;
    const errno = koffi.errno();
    if (
      ![koffi.os.errno.EAGAIN, koffi.os.errno.EWOULDBLOCK].includes(errno) ||
      performance.now() >= end
    )
      throw new Error("Protected file lock unavailable.");
    await delay(Math.min(10, Math.max(1, end - performance.now())), undefined, { signal });
  }
}
