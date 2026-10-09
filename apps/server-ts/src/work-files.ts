import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, readSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { WorkConflict } from "@openbot/work";
import { linkAt, openAt, openDirectory, unlinkAt } from "./posix-files.js";
import { sha256 } from "./work-values.js";

export type WorkBlob = { sha256: string; sizeBytes: number };
const maximum = 8 * 1024 * 1024;
/** Control-private immutable content; never expose this directory to an executor. */
export class WorkFiles {
  constructor(readonly directory: string) {
    if (!isAbsolute(directory)) throw new Error("An absolute Work file directory is required.");
  }
  private withDirectory<T>(operation: (fd: number) => T): T {
    const fd = openDirectory(this.directory, false);
    try {
      const stat = fstatSync(fd);
      if (stat.uid !== process.geteuid?.() || stat.mode & 0o077)
        throw new Error("Work directory is not private.");
      return operation(fd);
    } finally {
      closeSync(fd);
    }
  }
  verify() {
    this.withDirectory(() => undefined);
  }
  private readAt(directory: number, descriptor: WorkBlob): Buffer {
    const { sizeBytes: size, sha256: digest } = descriptor;
    if (!/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(size) || size < 0 || size > maximum)
      throw new WorkConflict("invalid_file_descriptor");
    const fd = openAt(directory, digest, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== size) throw new Error("Work file integrity failure.");
      const data = Buffer.alloc(size + 1);
      let length = 0,
        count: number;
      do {
        count = readSync(fd, data, length, data.length - length, null);
        length += count;
      } while (count && length < data.length);
      if (length !== size || sha256(data.subarray(0, length)) !== digest)
        throw new Error("Work file integrity failure.");
      return data.subarray(0, length);
    } finally {
      closeSync(fd);
    }
  }
  read(descriptor: WorkBlob) {
    return this.withDirectory((fd) => this.readAt(fd, descriptor));
  }
  put(data: Buffer): WorkBlob {
    if (!Buffer.isBuffer(data) || data.length > maximum)
      throw new WorkConflict("artifact_size_limit");
    const descriptor = { sha256: sha256(data), sizeBytes: data.length };
    this.withDirectory((directory) => {
      const temporary = ".pending-" + randomBytes(16).toString("hex");
      let created = false;
      try {
        const fd = openAt(
          directory,
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        created = true;
        try {
          let offset = 0;
          while (offset < data.length) {
            const count = writeSync(fd, data, offset, data.length - offset);
            if (!count) throw new Error("Work file write failed.");
            offset += count;
          }
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        try {
          linkAt(directory, temporary, descriptor.sha256);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        unlinkAt(directory, temporary);
        created = false;
        fsyncSync(directory);
        this.readAt(directory, descriptor);
      } finally {
        if (created) unlinkAt(directory, temporary);
      }
    });
    return descriptor;
  }
}
