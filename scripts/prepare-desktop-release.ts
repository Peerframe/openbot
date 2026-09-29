import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DESKTOP_INSTALLER_TARGET_NAMES,
  isDesktopTargetName,
  verifyInstallerManifest,
  type DesktopTargetName,
  type InstallerFile,
  type InstallerManifest,
} from "../apps/desktop/scripts/installer-policy.ts";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function validateDesktopReleaseRun(run: unknown, repository: string): string {
  const repo = isRecord(run) && isRecord(run.repository) ? run.repository.full_name : undefined;
  const sha = isRecord(run) ? run.head_sha : undefined;
  if (
    !isRecord(run) ||
    repo !== repository ||
    run.path !== ".github/workflows/ci.yml" ||
    run.event !== "push" ||
    run.head_branch !== "main" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    typeof sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(sha)
  )
    throw new Error(
      "Desktop releases require a successful main-branch push CI run in this repository.",
    );
  return sha;
}
export function desktopReleaseTargets(
  targets?: unknown,
  windowsOnly: unknown = false,
): DesktopTargetName[] {
  if (typeof windowsOnly !== "boolean")
    throw new Error("Windows-only scope must be an explicit boolean.");
  if (targets !== undefined && windowsOnly)
    throw new Error("Choose targets or legacy Windows-only scope, not both.");
  const selected: unknown =
    targets ?? (windowsOnly ? ["win32-x64"] : DESKTOP_INSTALLER_TARGET_NAMES);
  if (
    !Array.isArray(selected) ||
    !selected.length ||
    selected.length > DESKTOP_INSTALLER_TARGET_NAMES.length ||
    ![...selected].every(isDesktopTargetName) ||
    new Set(selected).size !== selected.length
  )
    throw new Error("Targets must be a nonempty unique subset of reviewed Desktop platforms.");
  return DESKTOP_INSTALLER_TARGET_NAMES.filter((target) => selected.includes(target));
}
export type PrepareDesktopReleaseInput = {
  readonly inputDirectory: string;
  readonly outputDirectory: string;
  readonly version: string;
  readonly sourceCommit: string;
  readonly windowsOnly?: unknown;
  readonly targets?: unknown;
};
export async function prepareDesktopRelease(input: PrepareDesktopReleaseInput) {
  const { inputDirectory, outputDirectory, version, sourceCommit, windowsOnly = false } = input;
  const targets = desktopReleaseTargets(input.targets, windowsOnly);
  const children = await readdir(inputDirectory);
  const allFiles: (InstallerFile & { readonly directory: string })[] = [];
  const manifests: InstallerManifest[] = [];
  for (const target of targets) {
    const name = `openbot-installers-${target}-${sourceCommit}`;
    if (!children.includes(name))
      throw new Error(`Missing successful CI installer target: ${target}`);
    const directory = join(inputDirectory, name);
    const manifest = await verifyInstallerManifest(directory, { version, sourceCommit });
    if (`${manifest.platform}-${manifest.arch}` !== target)
      throw new Error("Installer target was swapped.");
    manifests.push(manifest);
    for (const file of manifest.files) allFiles.push({ ...file, directory });
  }
  // Assemble only after every target and checksum has passed.
  await mkdir(outputDirectory, { recursive: false });
  for (const file of allFiles)
    await copyFile(join(file.directory, file.name), join(outputDirectory, file.name));
  await writeFile(
    join(outputDirectory, "SHA256SUMS"),
    allFiles.map((file) => `${file.sha256}  ${file.name}\n`).join(""),
  );
  await writeFile(
    join(outputDirectory, "desktop-manifest.json"),
    `${JSON.stringify({ version, sourceCommit, targets: manifests }, null, 2)}\n`,
  );
  return { version, sourceCommit, assetCount: allFiles.length };
}
const USAGE =
  "Usage: prepare-desktop-release <downloads> <new-output-dir> <run-json> <version> <owner/repo> [--windows-only | --targets=darwin-arm64,win32-x64]";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output, runPath, version, repository, scope] = process.argv.slice(2);
  if (
    !input ||
    !output ||
    !runPath ||
    !version ||
    !repository ||
    (scope !== undefined && scope !== "--windows-only" && !scope.startsWith("--targets=")) ||
    (process.argv.length !== 7 && process.argv.length !== 8)
  )
    throw new Error(USAGE);
  const run: unknown = JSON.parse(await readFile(runPath, "utf8"));
  const sourceCommit = validateDesktopReleaseRun(run, repository);
  console.info(
    await prepareDesktopRelease({
      inputDirectory: resolve(input),
      outputDirectory: resolve(output),
      version,
      sourceCommit,
      windowsOnly: scope === "--windows-only",
      ...(scope?.startsWith("--targets=") ? { targets: scope.slice(10).split(",") } : {}),
    }),
  );
}
