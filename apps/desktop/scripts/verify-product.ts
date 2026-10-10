/** Read-only pre-install inventory: exact built code, runtime closure, fuse policy and P0 byte scope. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractFile, listPackage } from "@electron/asar";
import { TS_CANDIDATE } from "../src/ts-product-manifest.ts";
import { validateDesktopAsarEntries, verifyDesktopFuses } from "./package-policy.ts";
import { validateContainedResource } from "./package-resources.ts";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
async function regularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await regularFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
async function fileBytes(paths: readonly string[]) {
  let total = 0;
  for (const path of paths) total += (await lstat(path)).size;
  return total;
}

export async function verifyProductCandidate(app: string) {
  assert(process.platform === "darwin" && process.arch === "arm64", "Only macOS arm64 is qualified here.");
  const resources = join(app, "Contents/Resources"), runtime = join(resources, "native-runtime");
  await validateContainedResource(runtime);
  const marker: unknown = JSON.parse(await readFile(join(runtime, "ts-control.json"), "utf8"));
  assert.deepEqual(marker, TS_CANDIDATE, "Candidate marker differs from this source.");
  const asar = join(resources, "app.asar");
  validateDesktopAsarEntries(listPackage(asar, { isPack: false }));
  await verifyDesktopFuses(app, process.platform, process.arch);
  const desktop = join(workspace, "apps/desktop/dist"), desktopFiles = await regularFiles(desktop);
  for (const path of desktopFiles) {
    const name = `dist/${relative(desktop, path)}`;
    assert.equal(sha256(extractFile(asar, name)), sha256(await readFile(path)), `Desktop build mismatch: ${name}`);
  }
  const server = join(workspace, "apps/server/dist"), packagedServer = join(runtime, "apps/server/dist");
  const serverFiles = await regularFiles(server), packagedFiles = await regularFiles(packagedServer);
  assert.deepEqual(packagedFiles.map(p => relative(packagedServer, p)), serverFiles.map(p => relative(server, p)), "Stale or missing Server output.");
  for (const path of serverFiles)
    assert.equal(sha256(await readFile(join(packagedServer, relative(server, path)))), sha256(await readFile(path)), "Server build mismatch.");
  const native = await regularFiles(runtime), names = native.map(p => relative(runtime, p));
  assert(!names.some(name => /\.(?:py|pyc|whl)$|(?:^|\/)(?:python(?:3(?:\.\d+)?)?|server-python|harness)(?:\/|$)/.test(name)), "Retired Python payload remains.");
  assert(!names.some(name => /(?:runtime-port|worker-tunnel|work-python-drain)\.(?:js|d\.ts)(?:\.map)?$/.test(name)), "Retired Server output remains.");
  const nativeHashes: [string, string][] = [];
  for (let index = 0; index < native.length; index++) nativeHashes.push([names[index]!, sha256(await readFile(native[index]!))]);
  return {
    kind: "p5-candidate-static-preflight", app,
    asarSha256: sha256(await readFile(asar)), nativeTreeSha256: sha256(JSON.stringify(nativeHashes)),
    marker: TS_CANDIDATE.format, desktopCompiledFilesMatched: desktopFiles.length,
    serverCompiledFilesMatched: serverFiles.length, retiredPayloadFiles: 0,
    bundleRegularFileBytes: await fileBytes(await regularFiles(app)), nativeRegularFileBytes: await fileBytes(native),
    nodeRegularFileBytes: await fileBytes(await regularFiles(join(runtime, "node"))),
    postgresRegularFileBytes: await fileBytes(await regularFiles(join(runtime, "postgres"))),
    standaloneNodeApproved: true, installed: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv.length === 3 && process.argv[2], "Usage: verify-product.ts /path/to/OpenBot.app");
  console.log(JSON.stringify(await verifyProductCandidate(resolve(process.argv[2])), null, 2));
}
