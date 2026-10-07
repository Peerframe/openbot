import { cp, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type NativeRuntimeLock,
  nativeOptionalPackageApplies,
  pythonCandidateGraph,
  mixedCandidateGraph,
} from "./native-runtime-policy.ts";
import { buildPostgresSupervisor } from "./postgres-supervisor-build.ts";
import { stagePythonProduct } from "./python-runtime.ts";
import { TS_CANDIDATE } from "../src/ts-product-manifest.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
if (
  args.length > 1 ||
  (args.length === 1 && !["--python-product", "--ts-product"].includes(args[0]!))
)
  throw new Error("Native runtime preparation accepts only --python-product or --ts-product.");
const pythonProduct = args[0] === "--python-product";
const tsProduct = args[0] === "--ts-product";
if ((pythonProduct || tsProduct) && (process.platform !== "darwin" || process.arch !== "arm64"))
  throw new Error("Native product candidates support only macOS arm64.");
const output = join(
  root,
  "apps/desktop",
  tsProduct
    ? "out/ts-product-runtime"
    : pythonProduct
      ? "out/python-product-runtime"
      : "native-runtime",
);
if (process.platform !== "darwin" || process.arch !== "arm64") {
  // Remove only generated staging, never profiles or installed services.
  await rm(output, { recursive: true, force: true });
  console.log("Native Python service omitted: this platform ships the remote client.");
  process.exit(0);
}
const lock: NativeRuntimeLock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const graph = tsProduct ? mixedCandidateGraph(lock) : pythonCandidateGraph(lock);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(root, "LICENSE"), join(output, "LICENSE"));
await cp(join(root, "apps/desktop/resources/native-notices"), join(output, "native-notices"), {
  recursive: true,
});
await cp(join(root, "THIRD_PARTY_NOTICES.md"), join(output, "THIRD_PARTY_NOTICES.md"));
await cp(join(root, "licenses/runtime"), join(output, "runtime-notices"), { recursive: true });
await mkdir(join(output, "node_modules/@openbot"), { recursive: true });
for (const key of graph.workspaceKeys) {
  const destination = join(output, key);
  await mkdir(destination, { recursive: true });
  await cp(join(root, key, "dist"), join(destination, "dist"), { recursive: true });
  await cp(join(root, key, "package.json"), join(destination, "package.json"));
  if (key === "packages/db") {
    await cp(join(root, key, "migrations"), join(destination, "migrations"), { recursive: true });
  }
  const name = lock.packages?.[key]?.name;
  if (typeof name !== "string") throw new Error("Workspace package name is missing.");
  const link = join(output, "node_modules", name);
  await symlink(relative(dirname(link), destination), link);
}
for (const key of graph.packageKeys) {
  const entry = lock.packages?.[key];
  if (!entry) throw new Error("Locked package entry is missing.");
  if (entry.optional && !nativeOptionalPackageApplies(entry, process.platform, process.arch))
    continue;
  await mkdir(dirname(join(output, key)), { recursive: true });
  await cp(join(root, key), join(output, key), { recursive: true, verbatimSymlinks: true });
}
{
  await buildPostgresSupervisor(
    join(root, "apps/desktop/native/postgres-supervisor.c"),
    join(output, "postgres-supervisor"),
  );
  const binaryRoot = join(root, "node_modules/@embedded-postgres", `darwin-${process.arch}`);
  const manifest = JSON.parse(await readFile(join(binaryRoot, "package.json"), "utf8"));
  if (manifest.version !== "17.10.0-beta.17")
    throw new Error("Unexpected PostgreSQL binary version.");
  await cp(join(binaryRoot, "native"), join(output, "postgres"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await cp(join(binaryRoot, "LICENSE.md"), join(output, "postgres/PACKAGER-LICENSE.md"));
  // npm strips symlinks. Recreate only links within the already locked binary package, at build time.
  const links = JSON.parse(await readFile(join(output, "postgres/pg-symlinks.json"), "utf8"));
  for (const { source, target } of links) {
    const toLocal = (value: unknown): string => {
      if (
        typeof value !== "string" ||
        !value.startsWith("native/") ||
        value.includes("..") ||
        isAbsolute(value)
      ) {
        throw new Error("PostgreSQL link escaped package.");
      }
      return join(output, "postgres", value.slice(7));
    };
    const targetPath = toLocal(target);
    const sourcePath = toLocal(source);
    try {
      await lstat(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await symlink(relative(dirname(targetPath), sourcePath), targetPath);
    }
  }
}
await stagePythonProduct(root, output);
await readdir(join(output, "postgres/bin"));
// Selection is written only after the complete locked payload has been staged.
if (tsProduct) {
  await accessTsEntry();
  await writeFile(join(output, "ts-control.json"), `${JSON.stringify(TS_CANDIDATE, null, 2)}\n`);
}
console.log("Staged app-owned native Server runtime; no services started.");

async function accessTsEntry() {
  for (const path of ["apps/server-ts/dist/desktop-entry.js", "apps/server-ts/dist/app.js"])
    if (!(await lstat(join(output, path))).isFile()) throw new Error("TS entry is incomplete.");
}
