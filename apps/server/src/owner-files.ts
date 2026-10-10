/** Implements owner files behavior for the Server. */
import { hasIntegerTokens, parseJsonInput } from "./json-input.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, readSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { directoryNames, renameAt } from "./posix-directory.js";
import { exclusiveLock, openAt, openDirectory, unlinkAt } from "./posix-files.js";
import { refuse } from "./owner-transaction.js";
import { HttpFailure } from "./http-errors.js";

export const attachmentMaximum = 10 * 1024 * 1024;
export const attachmentId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const textExtensions = new Set(
  "txt md markdown csv tsv json jsonl yaml yml xml html css js jsx ts tsx mjs cjs py go rs java c cpp cxx h hpp swift kt kts sh bash zsh sql toml ini conf log r rb php vue svelte diff patch tex rst ipynb srt".split(
    " ",
  ),
);
const office: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
};
const media = new Set([
  ...Object.values(office),
  ..."text/plain image/png image/jpeg application/pdf audio/mpeg audio/wav audio/mp4 audio/webm video/mp4 video/webm".split(
    " ",
  ),
]);
export type Attachment = {
  id: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  channelId?: string;
  scopeKind?: "owner";
  ownerId?: "owner";
  deletedAt?: string;
  processing?: unknown;
};
export function attachmentName(name: unknown): string {
  if (
    typeof name !== "string" ||
    [...name].length < 1 ||
    [...name].length > 160 ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._()-]*$/u.test(name)
  )
    return refuse(400, "invalid_attachment_name");
  return name;
}
export function attachmentMedia(name: string, data: Buffer): string {
  attachmentName(name);
  if (!data.length || data.length > attachmentMaximum) return refuse(413, "attachment_size_limit");
  const ext = name.split(".").at(-1)!.toLowerCase();
  const starts = (bytes: number[]) => data.subarray(0, bytes.length).equals(Buffer.from(bytes));
  if (textExtensions.has(ext)) {
    if (data.length > 256 * 1024) return refuse(413, "text_attachment_size_limit");
    try {
      if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data).includes("\0"))
        throw new Error();
    } catch {
      return refuse(415, "attachment_utf8_required");
    }
    return "text/plain";
  }
  if (["png", "jpg", "jpeg"].includes(ext)) {
    if (data.length > 5 * 1024 * 1024) return refuse(413, "image_attachment_size_limit");
    if (ext === "png" && starts([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
    if (
      ext !== "png" &&
      starts([255, 216, 255]) &&
      data.subarray(-2).equals(Buffer.from([255, 217]))
    )
      return "image/jpeg";
  } else if (
    ext === "pdf" &&
    /^%PDF-[12]\.[0-9]/.test(data.subarray(0, 8).toString("latin1")) &&
    data.subarray(-1024).includes(Buffer.from("%%EOF"))
  )
    return "application/pdf";
  else if (office[ext] && starts([80, 75, 3, 4])) return office[ext]!;
  else if (ext === "wav" && starts([82, 73, 70, 70]) && data.subarray(8, 12).toString() === "WAVE")
    return "audio/wav";
  else if (
    ext === "mp3" &&
    (starts([73, 68, 51]) || (data.length > 1 && data[0] === 255 && (data[1]! & 224) === 224))
  )
    return "audio/mpeg";
  else if (["mp4", "m4a"].includes(ext) && data.subarray(4, 8).toString() === "ftyp")
    return ext === "m4a" ? "audio/mp4" : "video/mp4";
  else if (ext === "webm" && starts([26, 69, 223, 163])) return "video/webm";
  return refuse(415, "attachment_format_refused");
}
export function readFileAt(
  directory: number,
  name: string,
  maximum: number,
  privateFile = false,
): Buffer {
  const fd = openAt(directory, name, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.size > maximum ||
      (privateFile &&
        (info.nlink !== 1 || info.uid !== process.geteuid?.() || (info.mode & 0o077) !== 0))
    )
      return refuse(503, privateFile ? "purge_file_refused" : "invalid_attachment_file");
    const bytes = Buffer.alloc(Math.min(maximum + 1, info.size + 1));
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > maximum || size !== info.size || fstatSync(fd).size !== info.size)
      return refuse(503, "attachment_file_limit");
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}
export function writeFileAt(directory: number, name: string, data: Buffer) {
  const pending = ".pending-" + randomBytes(16).toString("hex");
  let fd: number | undefined;
  try {
    fd = openAt(directory, pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    let offset = 0;
    while (offset < data.length) {
      const count = writeSync(fd, data, offset, data.length - offset);
      if (!count) throw new Error("Protected write did not advance.");
      offset += count;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameAt(directory, pending, directory, name);
    fsyncSync(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    removeFileAt(directory, pending);
  }
}
export function removeFileAt(directory: number, name: string) {
  try {
    unlinkAt(directory, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fsyncSync(directory);
}
const json = (data: Buffer): unknown =>
  parseJsonInput(new TextDecoder("utf-8", { fatal: true }).decode(data));
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export class FileSession {
  constructor(
    readonly directory: number,
    readonly signal: AbortSignal = new AbortController().signal,
  ) {}
  private name(name: string) {
    const split = name.indexOf(".");
    if (
      split < 0 ||
      !attachmentId.test(name.slice(0, split)) ||
      !["json", "bin", "text.json", "purged.json"].includes(name.slice(split + 1))
    )
      refuse(400, "invalid_attachment_identity");
    return name;
  }
  read(name: string, maximum: number) {
    return readFileAt(this.directory, this.name(name), maximum);
  }
  write(name: string, data: Buffer) {
    writeFileAt(this.directory, this.name(name), data);
  }
  remove(name: string) {
    removeFileAt(this.directory, this.name(name));
  }
  names() {
    return directoryNames(this.directory, 10000);
  }
  metadata(channel: string | null, id: string): Attachment {
    if ((channel !== null && !attachmentId.test(channel)) || !attachmentId.test(id))
      return refuse(404, "attachment_not_found");
    if (channel !== null) {
      let receipt: unknown;
      try {
        receipt = json(this.read(id + ".purged.json", 256));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          return refuse(503, "purged_attachment_receipt_unavailable");
      }
      if (
        record(receipt) &&
        Object.keys(receipt).length === 3 &&
        receipt.id === id &&
        receipt.channelId === channel &&
        receipt.purged === true
      )
        throw new HttpFailure(410, { error: "attachment_purged", purged: true });
    }
    try {
      const item = json(this.read(id + ".json", 4096));
      const required = [
        "id",
        "name",
        "mediaType",
        "sizeBytes",
        "sha256",
        "createdAt",
        ...(channel === null ? ["scopeKind", "ownerId"] : ["channelId"]),
      ];
      if (
        !record(item) ||
        !hasIntegerTokens(item, ["sizeBytes"]) ||
        required.some((key) => !(key in item)) ||
        Object.keys(item).some((key) => ![...required, "deletedAt", "processing"].includes(key)) ||
        item.id !== id ||
        (channel === null
          ? item.scopeKind !== "owner" || item.ownerId !== "owner"
          : item.channelId !== channel) ||
        typeof item.mediaType !== "string" ||
        !media.has(item.mediaType) ||
        typeof item.sizeBytes !== "number" ||
        !Number.isSafeInteger(item.sizeBytes) ||
        item.sizeBytes < 1 ||
        item.sizeBytes > attachmentMaximum ||
        typeof item.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.sha256) ||
        typeof item.createdAt !== "string" ||
        !Number.isFinite(Date.parse(item.createdAt))
      )
        throw new Error();
      attachmentName(item.name);
      return item as Attachment;
    } catch {
      return refuse(404, "attachment_not_found");
    }
  }
  content(channel: string | null, id: string): { item: Attachment; data: Buffer } {
    const item = this.metadata(channel, id);
    try {
      const data = this.read(id + ".bin", attachmentMaximum);
      if (
        data.length !== item.sizeBytes ||
        createHash("sha256").update(data).digest("hex") !== item.sha256 ||
        attachmentMedia(item.name, data) !== item.mediaType
      )
        throw new Error();
      return { item, data };
    } catch {
      return refuse(404, "attachment_integrity");
    }
  }
  list(channel: string | null): Attachment[] {
    const ids = this.names()
      .filter((name) => name.endsWith(".json") && attachmentId.test(name.slice(0, -5)))
      .map((name) => name.slice(0, -5));
    if (ids.length > 1024) return refuse(503, "attachment_count_limit");
    const items: Attachment[] = [];
    for (const id of ids)
      try {
        items.push(this.metadata(channel, id));
      } catch (error) {
        if (!(error instanceof HttpFailure)) throw error;
      }
    return items.sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    );
  }
  persist(channel: string | null, name: string, data: Buffer): Attachment {
    if (channel !== null && !attachmentId.test(channel)) return refuse(400, "invalid_channel");
    const mediaType = attachmentMedia(name, data);
    const names = this.names().filter(
      (name) => name.endsWith(".bin") && attachmentId.test(name.slice(0, -4)),
    );
    let size = 0;
    for (const name of names) {
      const fd = openAt(this.directory, name, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) return refuse(503, "invalid_attachment_file");
        size += stat.size;
      } finally {
        closeSync(fd);
      }
    }
    if (names.length >= 1024 || size + data.length > 256 * 1024 * 1024)
      return refuse(413, "attachment_quota");
    const id = randomUUID();
    const item: Attachment = {
      id,
      ...(channel === null
        ? ({ scopeKind: "owner", ownerId: "owner" } as const)
        : { channelId: channel }),
      name,
      mediaType,
      sizeBytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      createdAt: new Date().toISOString(),
    };
    this.write(id + ".bin", data);
    try {
      this.write(id + ".json", Buffer.from(JSON.stringify(item)));
    } catch (error) {
      this.remove(id + ".bin");
      throw error;
    }
    return item;
  }
  setDeleted(channel: string | null, id: string, deleted: boolean) {
    const item = this.metadata(channel, id);
    if (deleted) item.deletedAt ??= new Date().toISOString();
    else delete item.deletedAt;
    this.write(id + ".json", Buffer.from(JSON.stringify(item)));
    return item;
  }
  purgeChannel(channel: string) {
    if (!attachmentId.test(channel)) return refuse(400, "invalid_channel");
    const items = this.list(channel);
    for (const item of items)
      for (const suffix of [".text.json", ".bin", ".json"]) this.remove(item.id + suffix);
    return items.length;
  }
}
export class OwnerFiles {
  recover: ((session: FileSession) => Promise<void>) | undefined;
  constructor(readonly root: string) {
    if (!isAbsolute(root)) throw new Error("Explicit attachment root required.");
  }
  directory(create = false) {
    const fd = openDirectory(this.root, create),
      info = fstatSync(fd);
    if (info.uid !== process.geteuid?.() || (info.mode & 0o077) !== 0) {
      closeSync(fd);
      return refuse(503, "private_attachment_root_required");
    }
    return fd;
  }
  verify() {
    closeSync(this.directory(true));
  }
  async withLock<T>(
    operation: (session: FileSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const directory = this.directory();
    let lock: number | undefined;
    const deadline = AbortSignal.timeout(15000),
      bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      lock = openAt(directory, ".authority.lock", constants.O_CREAT | constants.O_RDWR);
      await exclusiveLock(lock, 15000, bounded);
      const session = new FileSession(directory, bounded);
      if (this.recover) await this.recover(session);
      bounded.throwIfAborted();
      return await operation(session);
    } finally {
      if (lock !== undefined) closeSync(lock);
      closeSync(directory);
    }
  }
}
