import { closeSync, constants } from "node:fs";
import koffi from "koffi";

let bound: ReturnType<typeof bind> | undefined;
function bind() {
  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch))
    throw new Error("Protected directory ABI unavailable.");
  const libc = koffi.load(null);
  // Darwin arm64 has only the 64-bit inode ABI; x86_64 retains the versioned symbol.
  const suffix = process.platform === "darwin" && process.arch === "x64" ? "$INODE64" : "";
  return {
    open: libc.func("int openat(int dirfd, const char *name, int flags, ...)"),
    directory: libc.func("fdopendir" + suffix, "void *", ["int"]),
    next: libc.func("readdir" + suffix, "void *", ["void *"]),
    close: libc.func("int closedir(void *directory)"),
    rename: libc.func("int renameat(int fromfd, const char *from, int tofd, const char *to)"),
    unlink: libc.func("int unlinkat(int dirfd, const char *name, int flags)"),
  };
}
const api = () => (bound ??= bind());
function checked(result: number) {
  if (result >= 0) return result;
  const errno = koffi.errno();
  const error = new Error("Protected directory operation failed.") as NodeJS.ErrnoException;
  error.code = Object.entries(koffi.os.errno).find(([, value]) => value === errno)?.[0] ?? "EIO";
  throw error;
}
function child(name: string) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0"))
    throw new Error("Invalid protected entry.");
  return name;
}
export function renameAt(fromFd: number, from: string, toFd: number, to: string) {
  checked(api().rename(fromFd, child(from), toFd, child(to)));
}
export function removeDirectoryAt(fd: number, name: string) {
  checked(api().unlink(fd, child(name), process.platform === "darwin" ? 0x80 : 0x200));
}
export function directoryNames(fd: number, maximum = 8192): string[] {
  const native = api(),
    cloexec = process.platform === "darwin" ? 0x1000000 : 0x80000;
  // A fresh open description gives each enumeration its own offset while remaining inode-relative.
  const owned = checked(
    native.open(
      fd,
      ".",
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | cloexec,
      "int",
      0,
    ),
  );
  const directory = native.directory(owned);
  if (!directory) {
    const errno = koffi.errno();
    closeSync(owned);
    koffi.errno(errno);
    checked(-1);
  }
  const names: string[] = [];
  try {
    for (;;) {
      koffi.errno(0);
      const pointer = native.next(directory);
      const errno = koffi.errno();
      if (!pointer) {
        if (errno) {
          koffi.errno(errno);
          checked(-1);
        }
        break;
      }
      // Native ABI facts only, checked against the platform headers; no struct source is copied.
      // Both supported 64-bit layouts put d_reclen at16; Darwin adds d_namlen before d_type.
      const length = koffi.decode(pointer, 16, "uint16_t") as number;
      const offset = process.platform === "darwin" ? 21 : 19;
      if (length <= offset || length > 65535) throw new Error("Invalid directory record.");
      const bytes = Buffer.from(
        koffi.decode(pointer, offset, koffi.array("uint8_t", length - offset)),
      );
      const end = bytes.indexOf(0);
      if (
        end < 0 ||
        end > 1023 ||
        (process.platform === "darwin" && koffi.decode(pointer, 18, "uint16_t") !== end)
      )
        throw new Error("Invalid directory name.");
      const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
      if (name === "." || name === "..") continue;
      names.push(child(name));
      if (names.length > maximum) throw new Error("Protected directory entry limit.");
    }
    return names;
  } finally {
    checked(native.close(directory));
  }
}
