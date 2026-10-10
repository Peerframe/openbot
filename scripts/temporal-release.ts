/** Extracts only hash-pinned upstream binaries into a newly owned fixture directory. */
import { createHash } from "node:crypto";
import { constants, createReadStream, openSync, closeSync, writeSync, fchmodSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Parser, type ReadEntry } from "tar";

// Same inspected release and member hashes as the completed P4 native qualification.
export const NATIVE_TEMPORAL_RELEASE = Object.freeze({
  size: 96287042,
  sha256: "f95748376241f5941327fa4c4e8e76641e8c4a9acabf77de9c86eb3d8238f4d7",
  members: {
    "temporal-server": {
      size: 143368082,
      sha256: "f1663788fd4d8d702576b659db212b4d45a8dbfc0909eb7f7a86d0d442de6a60",
    },
    "temporal-sql-tool": {
      size: 39794690,
      sha256: "ae3f05c59696f3466800cb5a0e1d57d3809ffc35834e7de9ca2e6bd2c747e71b",
    },
  },
});
export type TemporalReleasePin = {
  size: number;
  sha256: string;
  members: Record<string, { size: number; sha256: string }>;
};
export const PREVIOUS_TEMPORAL_RELEASES: Readonly<Record<string, TemporalReleasePin>> =
  Object.freeze({
    amd64: {
      size: 93822307,
      sha256: "f2c3bf9f1115b506259e5972a62c38257296c043e15798358c3fb758625b96b8",
      members: {
        "temporal-server": {
          size: 131518626,
          sha256: "1277e5188925d0343d54d42dac697af370739bca6453cd18d0c894aa497c906e",
        },
        "temporal-sql-tool": {
          size: 38658210,
          sha256: "5e025abb70ca29a4ada125eb73c2004c73b360997894f3614f5c0ef861dc853d",
        },
      },
    },
    arm64: {
      size: 85585324,
      sha256: "9771a7930e2503e77510714d83b5e20f589ee846d270d4b352e1ee3fd487ed08",
      members: {
        "temporal-server": {
          size: 123011234,
          sha256: "e2d9ae19ff7d5761ab64ca43a57b0c66c2ef44b2c190d5997f2f3a1de843d829",
        },
        "temporal-sql-tool": {
          size: 36962466,
          sha256: "e55bc47580a0d2e0ac01b4c60e774b8de88f808826d86b1d115c733f9f49c221",
        },
      },
    },
  });
export async function extractNativeTemporal(
  archive: string,
  destination: string,
  signal: AbortSignal,
) {
  await extractPinnedTemporal(archive, destination, NATIVE_TEMPORAL_RELEASE, signal);
  return join(destination, "temporal-server");
}
export async function extractPreviousTemporal(
  archive: string,
  architecture: string,
  destination: string,
  signal: AbortSignal,
) {
  const release = PREVIOUS_TEMPORAL_RELEASES[architecture];
  if (!release) throw new Error("Unsupported Temporal release architecture.");
  return extractPinnedTemporal(archive, destination, release, signal);
}
/** Read-only tar parsing: archive names never select output paths or permission bits. */
export async function extractPinnedTemporal(
  archive: string,
  destination: string,
  release: TemporalReleasePin,
  signal: AbortSignal,
  bounds = { expandedBytes: 512 * 1024 * 1024, members: 128 },
) {
  signal.throwIfAborted();
  const input = await open(
    archive,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let created = false;
  const opened = new Set<number>();
  try {
    const info = await input.stat();
    if (!info.isFile() || info.size !== release.size)
      throw new Error("Temporal archive size/type differs from its pin.");
    const digest = createHash("sha256"),
      buffer = Buffer.alloc(1024 * 1024);
    for (let offset = 0; offset < info.size; ) {
      signal.throwIfAborted();
      const { bytesRead } = await input.read(
        buffer,
        0,
        Math.min(buffer.length, info.size - offset),
        offset,
      );
      if (!bytesRead) throw new Error("Temporal archive ended before its byte bound.");
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (digest.digest("hex") !== release.sha256)
      throw new Error("Temporal archive SHA-256 differs from its pin.");
    await mkdir(destination, { mode: 0o700 });
    created = true;
    const seen = new Set<string>(),
      extracted = new Set<string>();
    let expanded = 0,
      members = 0;
    const bound = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        expanded += chunk.length;
        done(
          expanded > bounds.expandedBytes
            ? new Error("Temporal archive exceeds expanded byte bound.")
            : null,
          chunk,
        );
      },
    });
    const parser = new Parser({ strict: true, maxMetaEntrySize: 4096 });
    const reject = (error: unknown) =>
      parser.abort(error instanceof Error ? error : new Error("Temporal archive parsing failed."));
    const count = () => {
      if (++members > bounds.members) throw new Error("Temporal archive exceeds member bound.");
    };
    parser.on("meta", () => {
      try {
        count();
      } catch (error) {
        reject(error);
      }
    });
    const entry = (item: ReadEntry) => {
      try {
        count();
        if (seen.has(item.path)) throw new Error("Duplicate Temporal archive member.");
        seen.add(item.path);
        if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > bounds.expandedBytes)
          throw new Error("Temporal archive exceeds member bound.");
        if (!["temporal-server", "temporal-sql-tool"].includes(item.path)) {
          item.resume();
          return;
        }
        if (item.type !== "File" && item.type !== "OldFile")
          throw new Error("Expected a regular Temporal release binary.");
        const expected = release.members[item.path];
        if (!expected || item.size !== expected.size)
          throw new Error("Temporal binary size differs from its pin.");
        const fd = openSync(
          join(destination, item.path),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        opened.add(fd);
        let bytes = 0;
        const hash = createHash("sha256");
        item.on("data", (chunk: Buffer) => {
          try {
            signal.throwIfAborted();
            bytes += chunk.length;
            if (bytes > expected.size) throw new Error("Temporal binary exceeds its byte bound.");
            hash.update(chunk);
            for (let offset = 0; offset < chunk.length; )
              offset += writeSync(fd, chunk, offset, chunk.length - offset);
          } catch (error) {
            reject(error);
          }
        });
        item.on("end", () => {
          try {
            if (bytes !== expected.size || hash.digest("hex") !== expected.sha256)
              throw new Error("Temporal binary SHA-256 differs from its pin.");
            fchmodSync(fd, 0o555);
            extracted.add(item.path);
          } catch (error) {
            reject(error);
          } finally {
            if (opened.delete(fd)) closeSync(fd);
          }
        });
        item.resume();
      } catch (error) {
        reject(error);
      }
    };
    parser.on("entry", entry);
    parser.on("ignoredEntry", entry);
    // Gunzip consumes and verifies the trailer even beyond tar's end markers. All expanded
    // bytes, including ignored files and padding, pass the same hard limit.
    await pipeline(
      createReadStream("", { fd: input.fd, start: 0, end: info.size - 1, autoClose: false }),
      createGunzip(),
      bound,
      parser,
      { signal },
    );
    if (extracted.size !== 2) throw new Error("Required Temporal release binaries are missing.");
    return Object.fromEntries([...extracted].map((name) => [name, join(destination, name)]));
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    for (const fd of opened) closeSync(fd);
    await input.close();
  }
}
