/** Protected records and kernel peer/clock facts; no command or execution authority. */
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import type { Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { commandValue, strictCommandJson } from "../../apps/server/src/work-command-values.ts";
export class Refused extends Error {}
export function requireFact(value: unknown, code = "invalid_request"): asserts value {
  if (!value) throw new Refused(code);
}
export function directory(path: string, uid = 0, privateMode = true) {
  requireFact(isAbsolute(path) && realpathSync(path) === path, "unsafe_path");
  for (let part = path; ; part = dirname(part)) {
    const info = lstatSync(part);
    requireFact(info.isDirectory() && info.uid === uid && !(info.mode & 0o022), "unsafe_directory");
    if (dirname(part) === part) break;
  }
  if (privateMode) requireFact((lstatSync(path).mode & 0o777) === 0o700, "unsafe_directory");
  return path;
}
export function readBytes(path: string, maximum: number, { uid = 0, privateMode = true } = {}) {
  requireFact(
    Number.isSafeInteger(maximum) && maximum >= 0 && maximum <= 2 * 1024 * 1024,
    "invalid_bound",
  );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd, { bigint: true });
    requireFact(
      info.isFile() && info.uid === BigInt(uid) && info.nlink === 1n && !(info.mode & 0o022n),
      "unsafe_file",
    );
    if (privateMode) requireFact((info.mode & 0o777n) === 0o600n, "unsafe_file");
    requireFact(info.size >= 0n && info.size <= BigInt(maximum), "oversized_file");
    const bytes = Buffer.alloc(Number(info.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    const after = fstatSync(fd, { bigint: true });
    requireFact(
      BigInt(count) === info.size &&
        after.ino === info.ino &&
        after.size === info.size &&
        after.mtimeNs === info.mtimeNs &&
        after.ctimeNs === info.ctimeNs,
      "changed_file",
    );
    return bytes.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}
export function fsyncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** A failed fsync still consumes the name; never compensate by unlinking or retrying. */
export function exclusive(path: string, value: unknown) {
  const bytes = commandValue(value, 32768),
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  try {
    for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at, bytes.length - at);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}
export const readRecord = (path: string, uid = 0) =>
  strictCommandJson(readBytes(path, 32768, { uid }), 32768);
export function digest(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    requireFact(before.isFile() && before.nlink === 1n, "unsafe_file");
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(1024 * 1024);
    let size = 0n;
    while (true) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      size += BigInt(n);
      requireFact(size <= before.size, "changed_file");
      hash.update(buffer.subarray(0, n));
    }
    const after = fstatSync(fd, { bigint: true });
    requireFact(
      size === before.size &&
        after.size === before.size &&
        after.mtimeNs === before.mtimeNs &&
        after.ctimeNs === before.ctimeNs,
      "changed_file",
    );
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
/** Sequential 32KiB framing retains original duplicate-key and integer-token rejection. */
export async function* receive(socket: Socket) {
  let pending = Buffer.alloc(0);
  for await (const chunk of socket) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    requireFact(pending.length + bytes.length <= 65536, "oversized_frame_queue");
    pending = Buffer.concat([pending, bytes]);
    while (pending.length >= 4) {
      const size = pending.readUInt32BE(0);
      requireFact(size >= 1 && size <= 32768, "oversized_frame");
      if (pending.length < size + 4) break;
      const frame = pending.subarray(4, size + 4);
      pending = pending.subarray(size + 4);
      yield strictCommandJson(frame, 32768);
    }
  }
  requireFact(pending.length === 0, "partial_frame_eof");
}
export async function send(socket: Socket, value: unknown) {
  const bytes = commandValue(value, 32768),
    frame = Buffer.alloc(4 + bytes.length);
  frame.writeUInt32BE(bytes.length);
  bytes.copy(frame, 4);
  await new Promise<void>((resolve, reject) =>
    socket.write(frame, (error) => (error ? reject(error) : resolve())),
  );
}
