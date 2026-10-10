/** Fetches and verifies the existing reviewed browser fixture pin; never reads personal settings. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import pinned from "./product-browser-upstream.json" with { type: "json" };
export const ORIGINAL = Buffer.from("  port: PORT,"),
  LOOPBACK = Buffer.from('  hostname: "127.0.0.1",\n  port: PORT,');
export type SourceManifest = {
  repository: string;
  commit: string;
  files: { path: string; bytes: number; sha256: string }[];
};
const here = fileURLToPath(new URL("./", import.meta.url));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function patchListener(content: Buffer, reverse = false): Buffer {
  const from = reverse ? LOOPBACK : ORIGINAL,
    to = reverse ? ORIGINAL : LOOPBACK,
    at = content.indexOf(from);
  assert(
    at >= 0 && content.indexOf(from, at + from.length) === -1,
    reverse ? "Expected loopback-only upstream patch" : "Unexpected listener shape",
  );
  return Buffer.concat([content.subarray(0, at), to, content.subarray(at + from.length)]);
}
export async function verifyBrowserUpstream(root: string, manifest: SourceManifest = pinned) {
  for (const entry of manifest.files) {
    let content: Buffer = await readFile(join(root, entry.path));
    if (entry.path === "src/index.ts") content = patchListener(content, true);
    assert(
      content.length === entry.bytes && hash(content) === entry.sha256,
      "Pinned browser fixture source mismatch: " + entry.path,
    );
  }
  for (const name of ["package.json", "package-lock.json"])
    assert(
      (await readFile(join(root, name))).equals(
        await readFile(join(here, "browser-fixture-" + name)),
      ),
      "Browser fixture dependencies changed",
    );
}
class HttpFailure extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Public fixture HTTP refused");
    this.status = status;
  }
}
export type UpstreamIO = { fetch: typeof fetch; sleep: (ms: number) => Promise<unknown> };
const defaultIO: UpstreamIO = { fetch, sleep: delay };
export async function downloadBrowserSource(
  entry: SourceManifest["files"][number],
  manifest: SourceManifest = pinned,
  io: UpstreamIO = defaultIO,
) {
  const relative = entry.path === "LICENSE" ? entry.path : "agent-computer/" + entry.path;
  const url = `https://raw.githubusercontent.com/${manifest.repository}/${manifest.commit}/${relative}`;
  let content: Buffer | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await io.fetch(url, {
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new HttpFailure(response.status);
      }
      const reader = response.body?.getReader(),
        parts: Buffer[] = [];
      let length = 0;
      try {
        if (reader)
          while (length <= entry.bytes) {
            const item = await reader.read();
            if (item.done) break;
            const part = Buffer.from(item.value).subarray(0, entry.bytes + 1 - length);
            parts.push(part);
            length += part.length;
          }
        content = Buffer.concat(parts);
      } finally {
        await reader?.cancel();
      }
      break;
    } catch (error) {
      if (
        attempt === 2 ||
        (error instanceof HttpFailure && !(error.status >= 500 && error.status < 600))
      )
        throw error;
      await io.sleep((attempt + 1) * 1000);
    }
  }
  // Integrity and local write errors never request a second copy of the source.
  assert(
    content && content.length === entry.bytes && hash(content) === entry.sha256,
    "Public upstream hash mismatch: " + entry.path,
  );
  return content;
}
export async function prepareBrowserUpstream(
  root: string,
  manifest: SourceManifest = pinned,
  io: UpstreamIO = defaultIO,
) {
  await mkdir(root, { mode: 0o700 });
  for (const entry of manifest.files) {
    let content = await downloadBrowserSource(entry, manifest, io);
    if (entry.path === "src/index.ts") content = patchListener(content);
    const target = join(root, entry.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { mode: 0o600, flag: "wx" });
  }
  for (const name of ["package.json", "package-lock.json"])
    await copyFile(join(here, "browser-fixture-" + name), join(root, name));
  await verifyBrowserUpstream(root, manifest);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, flag, ...rest] = process.argv.slice(2);
  assert(
    directory && (flag === undefined || flag === "--verify") && rest.length === 0,
    "Usage: product-browser-upstream.ts <fresh directory> [--verify]",
  );
  await (flag ? verifyBrowserUpstream : prepareBrowserUpstream)(resolve(directory));
}
