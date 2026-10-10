/** Stages the reviewed standalone Node needed by Temporal and permission-bounded parser children. */
import { createHash } from "node:crypto";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateContainedResource } from "./package-resources.ts";
import { runRuntimeBuildStage } from "./runtime-build.ts";
export const NODE_ARCHIVE = Object.freeze({
  name: "node-v24.21.0-darwin-arm64.tar.gz",
  url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz",
  sha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
  maximumBytes: 64 * 1024 * 1024,
});

export interface RuntimeArchive {
  url: string;
  sha256: string;
  maximumBytes: number;
}

export async function verifiedDownload(
  archive: RuntimeArchive,
  destination: string,
): Promise<void> {
  const response = await fetch(archive.url, {
    signal: AbortSignal.timeout(120_000),
    redirect: "follow",
  });
  if (!response.ok || !response.body) throw new Error("Candidate runtime download failed.");
  const file = await open(destination, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const part of response.body) {
      bytes += part.byteLength;
      if (bytes > archive.maximumBytes) throw new Error("Candidate runtime exceeds its bound.");
      hash.update(part);
      await file.write(part);
    }
    if (hash.digest("hex") !== archive.sha256)
      throw new Error("Candidate runtime checksum mismatch.");
  } catch (error) {
    await response.body.cancel().catch(() => undefined);
    await file.close();
    await rm(destination, { force: true });
    throw error;
  }
  await file.close();
}

export async function stageNodeRuntime(output: string): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Only macOS arm64 has a reviewed local Server distribution.");
  const downloads = join(output, ".downloads");
  await mkdir(downloads);
  try {
    const path = join(downloads, NODE_ARCHIVE.name);
    await verifiedDownload(NODE_ARCHIVE, path);
    // Product children need only the executable and its complete upstream license. npm/node-gyp,
    // headers and debugging helpers are build inputs; never ship their Python scripts in this closure.
    await mkdir(join(output, "node"));
    await runRuntimeBuildStage("extract Node runtime", "/usr/bin/tar", [
      "-xzf", path, "--strip-components", "1", "-C", join(output, "node"),
      "node-v24.21.0-darwin-arm64/bin/node", "node-v24.21.0-darwin-arm64/LICENSE",
    ], output);
    await validateContainedResource(join(output, "node"));
    await writeFile(join(output, "node-provenance.json"), JSON.stringify({
      node: NODE_ARCHIVE, support: "unsigned macOS arm64 candidate; standalone Node retained with Owner approval after Electron permission qualification failed",
    }, null, 2) + "\n");
  } finally { await rm(downloads, { recursive: true, force: true }); }
}
