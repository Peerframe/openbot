/** Read-only parsing of hash-pinned native downloads and OCI metadata; archive names never select writes. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Parser, type ReadEntry } from "tar";
import { z } from "zod";

const MIB = 1024 * 1024;
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
export type DownloadPin = { size: number; sha256: string };
export type ArchiveBounds = { expanded: number; members: number; selected: number };
async function openedArchive(path: string, signal: AbortSignal, pin?: DownloadPin) {
  signal.throwIfAborted();
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await input.stat();
    assert(
      info.isFile() && info.size > 0 && info.size <= 2 * 1024 * MIB,
      "Native archive size/type changed",
    );
    if (pin) {
      assert.equal(info.size, pin.size, "Native download size changed");
      const digest = createHash("sha256"),
        buffer = Buffer.alloc(MIB);
      for (let position = 0; position < info.size; ) {
        signal.throwIfAborted();
        const value = await input.read(
          buffer,
          0,
          Math.min(buffer.length, info.size - position),
          position,
        );
        assert(value.bytesRead > 0, "Native download shortened");
        digest.update(buffer.subarray(0, value.bytesRead));
        position += value.bytesRead;
      }
      assert.equal(digest.digest("hex"), pin.sha256, "Native download pin changed");
    }
    return {
      input,
      stream: () =>
        Readable.from(
          (async function* () {
            for (let position = 0; position < info.size; ) {
              signal.throwIfAborted();
              const buffer = Buffer.alloc(Math.min(MIB, info.size - position));
              const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
              assert(bytesRead > 0, "Native archive shortened");
              position += bytesRead;
              yield buffer.subarray(0, bytesRead);
            }
          })(),
        ),
    };
  } catch (error) {
    await input.close();
    throw error;
  }
}
/** Fully consume the decoded stream, including trailers/padding; never let Parser auto-decompress. */
async function selectedTar(
  source: Readable,
  select: (name: string, size: number) => number | undefined,
  bounds: ArchiveBounds,
  signal: AbortSignal,
) {
  const values = new Map<string, Buffer>(),
    seen = new Set<string>();
  let expanded = 0,
    selected = 0,
    entries = 0,
    prefix = Buffer.alloc(0),
    checked = false;
  const bound = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      expanded += chunk.length;
      if (expanded > bounds.expanded)
        return done(new Error("Native archive expansion bound exceeded"));
      if (checked) return done(null, chunk);
      prefix = Buffer.concat([prefix, chunk]);
      if (prefix.length < 4) return done();
      checked = true;
      if (
        prefix.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])) ||
        prefix.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
      )
        return done(new Error("Nested native archive compression refused"));
      done(null, prefix);
      prefix = Buffer.alloc(0);
    },
    flush(done) {
      done(checked ? undefined : new Error("Native archive header missing"));
    },
  });
  const parser = new Parser({ strict: true, maxMetaEntrySize: 4096, brotli: false, zstd: false });
  const fail = (error: unknown) =>
    parser.abort(error instanceof Error ? error : new Error("Native archive invalid"));
  const count = () => {
    assert(++entries <= bounds.members, "Native archive member count exceeded");
  };
  parser.on("meta", () => {
    try {
      count();
    } catch (error) {
      fail(error);
    }
  });
  const entry = (item: ReadEntry) => {
    try {
      count();
      assert(!seen.has(item.path), "Duplicate native archive member");
      seen.add(item.path);
      assert(
        Number.isSafeInteger(item.size) && item.size >= 0 && item.size <= bounds.expanded,
        "Native archive member size changed",
      );
      const maximum = select(item.path, item.size);
      if (maximum === undefined) {
        item.resume();
        return;
      }
      assert(
        ["File", "OldFile"].includes(item.type) && item.size > 0 && item.size <= maximum,
        "Native selected member type/size changed",
      );
      selected += item.size;
      assert(selected <= bounds.selected, "Native selected bytes exceeded");
      const chunks: Buffer[] = [];
      let length = 0;
      item.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > item.size) fail(new Error("Native member expanded beyond header"));
        else chunks.push(chunk);
      });
      item.on("end", () => {
        try {
          assert.equal(length, item.size);
          values.set(item.path, Buffer.concat(chunks));
        } catch (error) {
          fail(error);
        }
      });
      item.resume();
    } catch (error) {
      fail(error);
    }
  };
  parser.on("entry", entry);
  parser.on("ignoredEntry", entry);
  await pipeline(source, bound, parser, { signal });
  return values;
}
function bzip2() {
  // Replaces Python's bz2 reader with the distribution tool; no environment-supplied options.
  const file = lstatSync("/usr/bin/bzip2");
  assert(file.isFile() && file.uid === 0 && !(file.mode & 0o022), "Trusted bzip2 required");
  const env = { LANG: "C", LC_ALL: "C" };
  const version = spawnSync("/usr/bin/bzip2", ["--version"], {
    env,
    input: "",
    timeout: 5000,
    encoding: "utf8",
    maxBuffer: 8192,
  });
  assert.equal(version.status, 0, "bzip2 version unavailable");
  assert(
    /bzip2, a block-sorting file compressor\.\s+Version 1\.0\.8,/.test(
      version.stdout + version.stderr,
    ),
    "Reviewed bzip2 1.0.8 required",
  );
  return spawn("/usr/bin/bzip2", ["--decompress", "--stdout"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
export async function pinnedNativeMembers(
  archive: string,
  pin: DownloadPin,
  expected: Readonly<Record<string, string>>,
  prefix: string,
  compression: "gzip" | "bzip2",
  signal: AbortSignal = AbortSignal.timeout(120000),
) {
  signal.throwIfAborted();
  const owned = await openedArchive(archive, signal, pin);
  const select = (path: string) =>
    path.startsWith(prefix) && Object.hasOwn(expected, path.slice(prefix.length))
      ? 120 * MIB
      : undefined;
  const bounds = { expanded: 768 * MIB, selected: 640 * MIB, members: 2048 };
  try {
    let values: Map<string, Buffer>;
    if (compression === "gzip") {
      const source = owned.stream(),
        decoded = createGunzip();
      const pump = pipeline(source, decoded, { signal });
      pump.catch(() => {});
      try {
        values = await selectedTar(decoded, select, bounds, signal);
        await pump;
      } finally {
        source.destroy();
        decoded.destroy();
        await pump.catch(() => {});
      }
    } else {
      signal.throwIfAborted();
      const child = bzip2();
      let stderr = 0;
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.length;
        if (stderr > 8192) child.kill("SIGKILL");
      });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      closed.catch(() => {});
      const abort = () => child.kill("SIGKILL");
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const source = owned.stream(),
        pump = pipeline(source, child.stdin, { signal });
      pump.catch(() => {});
      try {
        values = await selectedTar(child.stdout, select, bounds, signal);
        await pump;
        assert.equal(await closed, 0, "Native bzip2 stream failed CRC or exited unsuccessfully");
        assert(stderr <= 8192, "bzip2 diagnostic bound exceeded");
      } finally {
        signal.removeEventListener("abort", abort);
        source.destroy();
        child.stdin.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await Promise.allSettled([pump, closed]);
      }
    }
    const result = new Map<string, Buffer>();
    for (const [name, expectedHash] of Object.entries(expected)) {
      const bytes = values.get(prefix + name);
      assert(bytes, "Required native binary missing");
      assert.equal(hash(bytes), expectedHash, "Native binary pin changed");
      result.set(name, bytes);
    }
    return result;
  } finally {
    await owned.input.close();
  }
}
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const descriptor = z.object({
  digest: sha,
  size: z
    .number()
    .int()
    .positive()
    .max(256 * 1024),
});
export async function ociIdentity(
  path: string,
  expected?: string,
  manifest?: string,
  signal: AbortSignal = AbortSignal.timeout(120000),
) {
  const owned = await openedArchive(path, signal);
  try {
    const values = await selectedTar(
      owned.stream(),
      (name, size) =>
        name === "index.json" || (size <= 256 * 1024 && /^blobs\/sha256\/[a-f0-9]{64}$/.test(name))
          ? 256 * 1024
          : undefined,
      { expanded: 2 * 1024 * MIB, selected: 16 * MIB, members: 4096 },
      signal,
    );
    const blob = (name: string, pin?: z.infer<typeof descriptor>) => {
      const bytes = values.get(name);
      assert(bytes, "Required OCI metadata missing");
      if (pin) {
        assert.equal(bytes.length, pin.size, "OCI metadata size changed");
        assert.equal("sha256:" + hash(bytes), pin.digest, "OCI metadata pin changed");
      }
      return JSON.parse(bytes.toString()) as unknown;
    };
    const index = z.object({ manifests: z.array(descriptor).length(1) }).parse(blob("index.json"));
    const image = index.manifests[0];
    assert(image);
    if (manifest) assert.equal(image.digest, manifest, "Reviewed OCI manifest changed");
    const configuration = z
      .object({ config: descriptor })
      .parse(blob("blobs/sha256/" + image.digest.slice(7), image)).config;
    if (expected) assert.equal(configuration.digest, expected, "Reviewed OCI content changed");
    const config = z
      .object({
        architecture: z.literal("amd64"),
        os: z.literal("linux"),
        rootfs: z.object({ diff_ids: z.array(sha).max(256) }),
      })
      .parse(blob("blobs/sha256/" + configuration.digest.slice(7), configuration));
    return {
      manifest: image.digest,
      config: configuration.digest,
      diffIds: config.rootfs.diff_ids,
    };
  } finally {
    await owned.input.close();
  }
}
