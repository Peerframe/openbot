/** Flat immutable input receiver: no replayed offsets, sparse writes or interpreted paths. */
import { createHash, type Hash } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fsyncSync,
  fchmodSync,
  fstatSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { requireFact, fsyncDirectory } from "./protected-io.ts";
import type { WorkCommand } from "../../apps/server/dist/work-command-contract.js";
export class Inputs {
  readonly path: string;
  readonly manifest: WorkCommand["inputManifest"];
  readonly offsets: number[];
  readonly done: boolean[];
  private readonly fds: (number | undefined)[] = [];
  private readonly hashes: Hash[] = [];
  constructor(path: string, manifest: WorkCommand["inputManifest"]) {
    this.path = path;
    this.manifest = manifest;
    this.offsets = manifest.map(() => 0);
    this.done = manifest.map(() => false);
    requireFact(
      manifest.length <= 8 && new Set(manifest.map((e) => e.path)).size === manifest.length,
      "invalid_manifest",
    );
    try {
      for (const entry of manifest) {
        requireFact(
          /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(entry.path) &&
            Number.isSafeInteger(entry.size) &&
            entry.size >= 0 &&
            /^[a-f0-9]{64}$/.test(entry.sha256),
          "invalid_manifest",
        );
        this.fds.push(
          openSync(
            join(path, entry.path),
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          ),
        );
        this.hashes.push(createHash("sha256"));
        if (entry.size === 0) this.finish(this.fds.length - 1);
      }
      fsyncDirectory(path);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private finish(i: number) {
    requireFact(this.hashes[i]!.digest("hex") === this.manifest[i]!.sha256, "input_digest_changed");
    const fd = this.fds[i]!;
    fsyncSync(fd);
    fchmodSync(fd, 0o444);
    closeSync(fd);
    this.fds[i] = undefined;
    this.done[i] = true;
    fsyncDirectory(this.path);
  }
  append(value: { fileIndex: number; offset: number; data: string }) {
    const i = value.fileIndex;
    requireFact(
      Number.isInteger(i) && i >= 0 && i < this.manifest.length && !this.done[i],
      "input_slot_closed",
    );
    const data = Buffer.from(value.data, "base64");
    requireFact(data.toString("base64") === value.data, "invalid_input_encoding");
    requireFact(
      value.offset === this.offsets[i] &&
        data.length > 0 &&
        data.length <= 16384 &&
        this.offsets[i]! + data.length <= this.manifest[i]!.size,
      "input_offset_changed",
    );
    const fd = this.fds[i]!;
    const info = fstatSync(fd);
    requireFact(
      info.nlink === 1 && info.size === this.offsets[i] && info.isFile(),
      "input_file_changed",
    );
    requireFact(writeSync(fd, data) === data.length, "input_write_unknown");
    this.hashes[i]!.update(data);
    this.offsets[i]! += data.length;
    if (this.offsets[i] === this.manifest[i]!.size) this.finish(i);
    return this.offsets[i]!;
  }
  complete() {
    return this.done.every(Boolean);
  }
  close() {
    for (let i = 0; i < this.fds.length; i++) {
      const fd = this.fds[i];
      if (fd !== undefined) {
        this.fds[i] = undefined;
        closeSync(fd);
      }
    }
  }
}
