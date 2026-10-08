import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, writeSync } from "node:fs";
import {
  attachmentId,
  attachmentMaximum,
  type Attachment,
  FileSession,
  readFileAt,
} from "./owner-files.js";
import { refuse } from "./owner-transaction.js";
import { directoryNames, removeDirectoryAt, renameAt } from "./posix-directory.js";
import { mkdirAt, openAt, unlinkAt } from "./posix-files.js";

const suffixes = [".json", ".bin", ".text.json"] as const;
type Suffix = (typeof suffixes)[number];
type Entry = { id: string; channelId: string; suffixes: Suffix[] };
export type PurgeJournal = { operation: string; entries: Entry[] };
const maximum = 262144;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
export const purgeMarker = (item: Pick<Entry, "id" | "channelId">) =>
  Buffer.from(JSON.stringify({ id: item.id, channelId: item.channelId, purged: true }));
function privateSize(directory: number, name: string, limit: number): number {
  const fd = openAt(directory, name, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.geteuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size < 0 ||
      info.size > limit
    )
      return refuse(503, "purge_file_refused");
    return info.size;
  } finally {
    closeSync(fd);
  }
}
export class PurgeFiles {
  constructor(readonly files: FileSession) {}
  open(name: string) {
    if (!name.startsWith(".purge-") || !attachmentId.test(name.slice(7)))
      return refuse(503, "purge_journal_refused");
    const fd = openAt(this.files.directory, name, constants.O_RDONLY | constants.O_DIRECTORY),
      info = fstatSync(fd);
    if (info.uid !== process.geteuid?.() || (info.mode & 0o077) !== 0) {
      closeSync(fd);
      return refuse(503, "purge_journal_refused");
    }
    return fd;
  }
  journals() {
    const names = this.files.names().filter((name) => name.startsWith(".purge-"));
    if (names.length > 16) return refuse(503, "purge_journal_limit");
    return names.sort();
  }
  usage(item: Attachment): Partial<Record<Suffix, number>> {
    if (!item.channelId) return refuse(503, "purge_file_refused");
    this.files.content(item.channelId, item.id);
    const sizes: Partial<Record<Suffix, number>> = {};
    for (const suffix of suffixes)
      try {
        sizes[suffix] = privateSize(
          this.files.directory,
          item.id + suffix,
          suffix === ".bin" ? attachmentMaximum : suffix === ".text.json" ? 2097152 : 4096,
        );
      } catch (error) {
        if (suffix !== ".text.json" || !missing(error)) throw error;
      }
    return sizes;
  }
  stage(items: readonly Attachment[]): string {
    if (items.length < 1 || items.length > 1024) return refuse(503, "purge_batch_limit");
    const operation = randomUUID(),
      entries = items.map((item) => ({
        id: item.id,
        channelId: item.channelId!,
        suffixes: Object.keys(this.usage(item)) as Suffix[],
      }));
    const data = Buffer.from(JSON.stringify({ operation, entries }));
    if (data.length > maximum) return refuse(503, "purge_journal_limit");
    const name = ".purge-" + operation,
      root = this.files.directory;
    mkdirAt(root, name);
    const fd = this.open(name);
    try {
      const journal = openAt(
        fd,
        "manifest.pending",
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      );
      try {
        let offset = 0;
        while (offset < data.length) {
          const count = writeSync(journal, data, offset, data.length - offset);
          if (!count) throw new Error("Journal write did not advance.");
          offset += count;
        }
        fsyncSync(journal);
      } finally {
        closeSync(journal);
      }
      // Nothing moves before the durable manifest. SQL receipts decide recovery after COMMIT loss.
      renameAt(fd, "manifest.pending", fd, "manifest.json");
      fsyncSync(fd);
      fsyncSync(root);
      for (const entry of entries)
        for (const suffix of entry.suffixes)
          renameAt(root, entry.id + suffix, fd, entry.id + suffix);
      fsyncSync(fd);
      fsyncSync(root);
      return operation;
    } finally {
      closeSync(fd);
    }
  }
  read(name: string): PurgeJournal {
    const fd = this.open(name);
    try {
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          readFileAt(fd, "manifest.json", maximum, true),
        ),
      );
      const object = (v: unknown): v is Record<string, unknown> =>
        v !== null && typeof v === "object" && !Array.isArray(v);
      if (
        !object(value) ||
        Object.keys(value).sort().join() !== "entries,operation" ||
        value.operation !== name.slice(7) ||
        !Array.isArray(value.entries) ||
        value.entries.length < 1 ||
        value.entries.length > 1024
      )
        return refuse(503, "purge_journal_refused");
      const identities = new Set<string>(),
        allowed = new Set(["manifest.json"]);
      for (const item of value.entries) {
        if (
          !object(item) ||
          Object.keys(item).sort().join() !== "channelId,id,suffixes" ||
          typeof item.id !== "string" ||
          !attachmentId.test(item.id) ||
          typeof item.channelId !== "string" ||
          !attachmentId.test(item.channelId) ||
          identities.has(item.id) ||
          !Array.isArray(item.suffixes) ||
          ![".bin,.json", ".bin,.json,.text.json"].includes([...item.suffixes].sort().join())
        )
          return refuse(503, "purge_journal_refused");
        identities.add(item.id);
        for (const suffix of item.suffixes) allowed.add(item.id + suffix);
      }
      if (directoryNames(fd, 3073).some((name) => !allowed.has(name)))
        return refuse(503, "purge_journal_refused");
      return value as PurgeJournal;
    } catch (error) {
      if (missing(error)) throw error;
      return refuse(503, "purge_journal_refused");
    } finally {
      closeSync(fd);
    }
  }
  discardUnstarted(name: string) {
    const fd = this.open(name);
    try {
      const names = directoryNames(fd, 3073);
      if (names.some((name) => name !== "manifest.pending"))
        return refuse(503, "purge_journal_refused");
      if (names.includes("manifest.pending")) {
        privateSize(fd, "manifest.pending", maximum);
        unlinkAt(fd, "manifest.pending");
      }
      fsyncSync(fd);
      removeDirectoryAt(this.files.directory, name);
      fsyncSync(this.files.directory);
    } finally {
      closeSync(fd);
    }
  }
  stagedBytes(name: string, entry: Entry): number {
    const fd = this.open(name);
    try {
      return entry.suffixes.reduce(
        (sum, suffix) => sum + privateSize(fd, entry.id + suffix, attachmentMaximum),
        0,
      );
    } finally {
      closeSync(fd);
    }
  }
  resolve(name: string, value: PurgeJournal, committed: ReadonlySet<string>) {
    const fd = this.open(name),
      root = this.files.directory;
    try {
      const names = new Set(directoryNames(fd, 3073)),
        destinations = new Set(this.files.names());
      // Preflight the whole restore before moving any entry; never overwrite an existing inode.
      for (const item of value.entries)
        for (const suffix of item.suffixes) {
          const filename = item.id + suffix;
          if (!names.has(filename)) continue;
          privateSize(fd, filename, attachmentMaximum);
          if (!committed.has(item.id) && destinations.has(filename))
            return refuse(503, "purge_recovery_conflict");
        }
      for (const item of value.entries) {
        if (committed.has(item.id)) this.files.write(item.id + ".purged.json", purgeMarker(item));
        for (const suffix of item.suffixes) {
          const filename = item.id + suffix;
          if (!names.has(filename)) continue;
          if (committed.has(item.id)) unlinkAt(fd, filename);
          else renameAt(fd, filename, root, filename);
        }
      }
      fsyncSync(fd);
      fsyncSync(root);
      unlinkAt(fd, "manifest.json");
      fsyncSync(fd);
      removeDirectoryAt(root, name);
      fsyncSync(root);
    } finally {
      closeSync(fd);
    }
  }
}
