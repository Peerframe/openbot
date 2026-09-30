import assert from "node:assert/strict";
import {
  CHECKOUT,
  assertNoFailureBypass,
  field,
  hasCommands,
  requiredJob,
  runs,
  workflowDocument,
} from "./workflow-policy.ts";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SETUP_DOTNET_PIN = "actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68";

export interface WindowsWorkerHostSources {
  readonly workflow: string;
  readonly globalJson: string;
  readonly buildProps: string;
  readonly hostProject: string;
  readonly artifactChecker: string;
}

export function validateWindowsWorkerHostBuildLane({
  workflow,
  globalJson,
  buildProps,
  hostProject,
  artifactChecker,
}: WindowsWorkerHostSources): void {
  const lane = requiredJob(workflowDocument(workflow), "windows-worker-host");
  assertNoFailureBypass(lane, "Windows Worker Host");
  const boundary = "Windows Worker Host job broadens its runner, dependency, or artifact boundary.";
  assert.equal(lane.source["runs-on"], "windows-2025", boundary);
  assert.equal(
    field(lane.source, "defaults", "run", "working-directory"),
    "apps/worker-host-windows",
    boundary,
  );
  assert.equal(lane.env.DOTNET_CLI_TELEMETRY_OPTOUT, 1, boundary);
  const checkout = lane.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert(checkout?.uses === CHECKOUT && checkout.with["persist-credentials"] === false, boundary);
  const setup = lane.steps.find((step) => step.uses?.startsWith("actions/setup-dotnet@"));
  assert(
    setup?.uses === SETUP_DOTNET_PIN &&
      setup.with["global-json-file"] === "apps/worker-host-windows/global.json" &&
      !setup.with.cache,
    boundary,
  );
  assert(!lane.steps.some((step) => step.uses?.startsWith("actions/upload-artifact")), boundary);
  const commands = [
    "dotnet restore OpenBot.WorkerHost.Windows.ContractTests/OpenBot.WorkerHost.Windows.ContractTests.csproj --locked-mode",
    "dotnet build OpenBot.WorkerHost.Windows.ContractTests/OpenBot.WorkerHost.Windows.ContractTests.csproj --configuration Release --no-restore",
    "dotnet run --project OpenBot.WorkerHost.Windows.ContractTests/OpenBot.WorkerHost.Windows.ContractTests.csproj --configuration Release --no-build --no-restore",
    "dotnet publish OpenBot.WorkerHost.Windows/OpenBot.WorkerHost.Windows.csproj --configuration Release --runtime win-x64 --self-contained true --no-restore",
    "../../scripts/check-windows-worker-host-artifact.ps1",
  ];
  hasCommands(lane, commands, "Windows Worker Host job is missing required fragment");
  const job = runs(lane);

  const restore = job.indexOf("dotnet restore ");
  const build = job.indexOf("dotnet build ");
  const test = job.indexOf("dotnet run --project ");
  const publish = job.indexOf("dotnet publish ");
  const inventory = job.indexOf("../../scripts/check-windows-worker-host-artifact.ps1");
  if (
    restore === -1 ||
    build <= restore ||
    test <= build ||
    publish <= test ||
    inventory <= publish
  ) {
    throw new Error(
      "Windows Worker Host job must restore, build, test, publish, then inspect in order.",
    );
  }

  const sdk = field(JSON.parse(globalJson) as unknown, "sdk");
  if (
    field(sdk, "version") !== "10.0.400" ||
    field(sdk, "rollForward") !== "disable" ||
    field(sdk, "allowPrerelease") !== false
  ) {
    throw new Error("Windows Worker Host global.json must select only .NET SDK 10.0.400.");
  }

  const requiredBuildFragments = [
    "<RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>",
    "<RestoreLockedMode Condition=\"'$(CI)' == 'true'\">true</RestoreLockedMode>",
    "<Deterministic>true</Deterministic>",
    "<TreatWarningsAsErrors>true</TreatWarningsAsErrors>",
  ];
  for (const fragment of requiredBuildFragments) {
    if (!buildProps.includes(fragment)) {
      throw new Error(`Windows Worker Host build properties are missing: ${fragment}`);
    }
  }

  const requiredProjectFragments = [
    '<PackageReference Include="Meziantou.Framework.Win32.Jobs" Version="[4.0.0]" />',
    '<PackageReference Include="Microsoft.Extensions.Hosting.WindowsServices" Version="[10.0.11]" />',
    "<RuntimeIdentifiers>win-x64</RuntimeIdentifiers>",
    "<SelfContained Condition=\"'$(RuntimeIdentifier)' == 'win-x64'\">true</SelfContained>",
    "<PublishSingleFile Condition=\"'$(RuntimeIdentifier)' == 'win-x64'\">true</PublishSingleFile>",
  ];
  for (const fragment of requiredProjectFragments) {
    if (!hostProject.includes(fragment)) {
      throw new Error(`Windows Worker Host project is missing: ${fragment}`);
    }
  }

  const requiredCheckerFragments = [
    '"OpenBot.WorkerHost.Windows.exe"',
    '"THIRD_PARTY_NOTICES.md"',
    "$minimumExecutableBytes = 40MB",
    "$maximumExecutableBytes = 128MB",
    "$stream.ReadByte() -ne 0x4D",
    "$stream.ReadByte() -ne 0x5A",
    "[IO.FileAttributes]::ReparsePoint",
    "Get-FileHash -Algorithm SHA256",
    "$actualNoticeHash -cne $expectedNoticeHash",
  ];
  for (const fragment of requiredCheckerFragments) {
    if (!artifactChecker.includes(fragment)) {
      throw new Error(`Windows Worker Host artifact checker is missing: ${fragment}`);
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [workflow, globalJson, buildProps, hostProject, artifactChecker] = await Promise.all([
    readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    readFile(new URL("../apps/worker-host-windows/global.json", import.meta.url), "utf8"),
    readFile(new URL("../apps/worker-host-windows/Directory.Build.props", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../apps/worker-host-windows/OpenBot.WorkerHost.Windows/OpenBot.WorkerHost.Windows.csproj",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(new URL("./check-windows-worker-host-artifact.ps1", import.meta.url), "utf8"),
  ]);
  validateWindowsWorkerHostBuildLane({
    workflow,
    globalJson,
    buildProps,
    hostProject,
    artifactChecker,
  });
  console.info("Windows Worker Host build-lane checks passed.");
}
