import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SETUP_DOTNET_PIN = "actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68";

export function validateWindowsWorkerHostBuildLane({
  workflow,
  globalJson,
  buildProps,
  hostProject,
  artifactChecker,
}) {
  const jobStart = workflow.indexOf("\n  windows-worker-host:\n");
  const databaseStart = workflow.indexOf("\n  python-product-container:\n");
  if (jobStart === -1 || databaseStart <= jobStart) {
    throw new Error("CI must define the Windows Worker Host job before the Python product container job.");
  }

  const job = workflow.slice(jobStart, databaseStart);
  const requiredJobFragments = [
    "name: Windows Worker Host (build only)",
    "runs-on: windows-2025",
    "timeout-minutes: 20",
    "defaults:\n      run:\n        working-directory: apps/worker-host-windows",
    "DOTNET_CLI_TELEMETRY_OPTOUT: 1",
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "persist-credentials: false",
    SETUP_DOTNET_PIN,
    "global-json-file: apps/worker-host-windows/global.json",
    "dotnet restore OpenBot.WorkerHost.Windows.ContractTests/OpenBot.WorkerHost.Windows.ContractTests.csproj --locked-mode",
    "dotnet build OpenBot.WorkerHost.Windows.ContractTests/OpenBot.WorkerHost.Windows.ContractTests.csproj --configuration Release --no-restore",
    "dotnet run --project OpenBot.WorkerHost.Windows.ContractTests/OpenBot.WorkerHost.Windows.ContractTests.csproj --configuration Release --no-build --no-restore",
    "dotnet publish OpenBot.WorkerHost.Windows/OpenBot.WorkerHost.Windows.csproj --configuration Release --runtime win-x64 --self-contained true --no-restore",
    "../../scripts/check-windows-worker-host-artifact.ps1",
  ];
  for (const fragment of requiredJobFragments) {
    if (!job.includes(fragment)) {
      throw new Error(`Windows Worker Host job is missing required fragment: ${fragment}`);
    }
  }

  if (
    /continue-on-error:|windows-latest|actions\/upload-artifact|cache:\s*(?:true|nuget)|uses: actions\/setup-dotnet@(?!a98b56852c35b8e3190ac28c8c2271da59106c68)/.test(
      job,
    )
  ) {
    throw new Error(
      "Windows Worker Host job broadens its runner, dependency, or artifact boundary.",
    );
  }

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

  const sdk = JSON.parse(globalJson).sdk;
  if (
    sdk?.version !== "10.0.400" ||
    sdk?.rollForward !== "disable" ||
    sdk?.allowPrerelease !== false
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
