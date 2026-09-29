import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgumentPairs } from "./argument-pairs.ts";
import {
  assertMacOSExtendedAttributes,
  inspectMachOArchitecture,
  stageMacOSWorkerHostApplication,
  verifyMacOSNodeRuntimeArchive,
} from "./macos-worker-host-release.ts";
import { validateNccStats } from "./node-linux-release.ts";
import { assertSourceCommit, assertSourceTreeState } from "./release-source.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function buildMacOSWorkerHostCandidate(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("The macOS Worker Host candidate can only be built on macOS.");
  }

  const options = parseMacOSCandidateArguments(arguments_);
  assertSourceTreeState(
    options.sourceCommit,
    run("/usr/bin/git", ["rev-parse", "HEAD"]),
    run("/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=normal"]),
  );
  const outputMetadata = await lstat(options.outputDirectory);
  if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink()) {
    throw new Error("macOS candidate output must be a real existing directory.");
  }
  if (run(options.npmCli, ["--version"]).trim() !== "10.9.9") {
    throw new Error("The macOS candidate requires npm 10.9.9.");
  }
  run(options.npmCli, ["run", "build", "--workspace", "@openbot/node"]);

  const runtime = await verifyMacOSNodeRuntimeArchive(options.nodeArchive, options.architecture);
  const scratch = await mkdtemp(path.join(tmpdir(), "openbot-macos-candidate-"));
  try {
    run(process.execPath, [
      path.join(repositoryRoot, "node_modules/@vercel/ncc/dist/ncc/cli.js"),
      "build",
      path.join(repositoryRoot, "apps/node/dist/macos-service.js"),
      "--out",
      path.join(scratch, "node-bundle"),
      "--no-cache",
      "--quiet",
      "--license",
      "third-party-licenses.txt",
      "--stats-out",
      path.join(scratch, "ncc-stats.json"),
      "--target",
      "es2022",
    ]);
    const stats: unknown = JSON.parse(await readFile(path.join(scratch, "ncc-stats.json"), "utf8"));
    validateNccStats(stats, await readdir(path.join(scratch, "node-bundle")));

    const runtimeRoot = path.join(scratch, "runtime");
    await mkdir(runtimeRoot);
    run("/usr/bin/tar", [
      "-xzf",
      options.nodeArchive,
      "-C",
      runtimeRoot,
      `${runtime.directory}/bin/node`,
      `${runtime.directory}/LICENSE`,
    ]);
    const nodeBinary = path.join(runtimeRoot, runtime.directory, "bin/node");
    if (run(nodeBinary, ["--version"]).trim() !== "v22.22.2") {
      throw new Error("The extracted macOS Node runtime has an unexpected version.");
    }
    if (inspectMachOArchitecture(nodeBinary) !== options.architecture) {
      throw new Error("The extracted macOS Node runtime has an unexpected architecture.");
    }

    const swiftArguments = [
      "swift",
      "build",
      "--package-path",
      path.join(repositoryRoot, "apps/worker-host-macos"),
      "--configuration",
      "release",
      "--arch",
      options.architecture === "x64" ? "x86_64" : "arm64",
    ];
    if (options.sdk !== undefined) swiftArguments.push("--sdk", options.sdk);
    run("/usr/bin/xcrun", swiftArguments);

    const binArguments = [...swiftArguments];
    binArguments.push("--show-bin-path");
    const binaryDirectory = run("/usr/bin/xcrun", binArguments).trim();
    const controlBinary = path.join(binaryDirectory, "OpenBotWorkerHostControl");
    for (const binary of [controlBinary]) {
      if (inspectMachOArchitecture(binary) !== options.architecture) {
        throw new Error("A macOS native binary has an unexpected architecture.");
      }
    }

    const application = path.join(options.outputDirectory, "OpenBot Worker Host.app");
    await stageMacOSWorkerHostApplication({
      architecture: options.architecture,
      buildVersion: options.buildVersion,
      controlBinary,
      destination: application,
      enrollmentDocumentation: path.join(repositoryRoot, "docs/NODE_ENROLLMENT.md"),
      enrollmentDocumentationChinese: path.join(repositoryRoot, "docs/NODE_ENROLLMENT.zh-CN.md"),
      infoTemplate: path.join(
        repositoryRoot,
        "apps/worker-host-macos/Resources/Info.plist.template",
      ),
      launchAgentPlist: path.join(
        repositoryRoot,
        "apps/worker-host-macos/Resources/com.openbot.worker-host.node.plist",
      ),
      nodeBinary,
      nodeBundleDirectory: path.join(scratch, "node-bundle"),
      nodeLicense: path.join(runtimeRoot, runtime.directory, "LICENSE"),
      openBotLicense: path.join(repositoryRoot, "LICENSE"),
      sourceCommit: options.sourceCommit,
      version: options.version,
    });
    run("/usr/bin/xattr", ["-cr", application]);
    assertMacOSExtendedAttributes(run("/usr/bin/xattr", ["-r", application]), {
      allowProvenance: true,
    });
    run("/usr/bin/plutil", ["-lint", path.join(application, "Contents/Info.plist")]);
    run("/usr/bin/plutil", [
      "-lint",
      path.join(application, "Contents/Library/LaunchAgents/com.openbot.worker-host.node.plist"),
    ]);
    process.stdout.write(`${JSON.stringify({ application, signed: false }, null, 2)}\n`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function run(command: string, arguments_: readonly string[], cwd = repositoryRoot): string {
  return execFileSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function parseMacOSCandidateArguments(arguments_: readonly string[]) {
  const values = parseArgumentPairs(
    arguments_,
    "macOS candidate arguments must be unique --name value pairs.",
  );
  const allowed = new Set([
    "--arch",
    "--build-version",
    "--node-archive",
    "--npm-cli",
    "--out-dir",
    "--sdk",
    "--source-commit",
    "--version",
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error(`Unknown macOS candidate argument: ${key}.`);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`Missing macOS candidate argument: ${key}.`);
    return value;
  };
  const requiredAbsolute = (key: string): string => {
    const value = path.resolve(required(key));
    if (!path.isAbsolute(required(key)))
      throw new Error(`macOS argument must be absolute: ${key}.`);
    return value;
  };
  const sdk = values.get("--sdk");
  if (sdk !== undefined && !path.isAbsolute(sdk)) {
    throw new Error("macOS SDK path must be absolute.");
  }
  return {
    architecture: required("--arch"),
    buildVersion: required("--build-version"),
    nodeArchive: requiredAbsolute("--node-archive"),
    npmCli: requiredAbsolute("--npm-cli"),
    outputDirectory: requiredAbsolute("--out-dir"),
    ...(sdk === undefined ? {} : { sdk }),
    sourceCommit: assertSourceCommit(required("--source-commit")),
    version: required("--version"),
  };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  await buildMacOSWorkerHostCandidate();
}
