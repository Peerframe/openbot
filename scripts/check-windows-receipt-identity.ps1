# Independent Windows receipt↔orchestrator identity conformance checks.
# Exercises the same helpers as the install gate (dot-sourced, not duplicated).
# - On non-Windows: STJ-primary ISO round-trip + mismatch rejects (pwsh 7.4-safe).
# - On Windows: also runs bounded comparison with the actual Node/WinPS smoke observer.
# Does not launch NSIS, smoke.mjs, or product code.
[CmdletBinding()]
param(
  [switch]$SkipWindowsProcessChecks
)
$ErrorActionPreference = 'Stop'
$script:failures = @()

. (Join-Path $PSScriptRoot 'windows-receipt-identity-helpers.ps1')

function Write-CheckResult([string]$Name, [bool]$Passed, [string]$Detail = '') {
  if ($Passed) {
    Write-Host "PASS: $Name$(if ($Detail) { " ($Detail)" })"
  } else {
    Write-Host "FAIL: $Name$(if ($Detail) { " — $Detail" })"
    $script:failures += $Name
  }
}

function New-ReceiptJson {
  param(
    [string]$Iso,
    [int]$ElectronPid = 5060,
    [string]$ElectronPath = 'C:\Program Files\OpenBot\openbot.exe'
  )
  return (@{
    schemaVersion = 1
    platform = 'win32'
    arch = 'x64'
    mode = 'bootstrap'
    electron = @{
      pid = $ElectronPid
      startTimeUtc = $Iso
      executablePath = $ElectronPath
    }
    postgres = @{
      pid = 5061
      startTimeUtc = $Iso
      executablePath = 'C:\tmp\postgres.exe'
    }
    server = @{
      pid = 5062
      startTimeUtc = $Iso
      executablePath = 'C:\tmp\server.exe'
    }
  } | ConvertTo-Json -Depth 6)
}

function Test-StjPrimaryIdentityRoundTrip {
  $iso = '2026-09-13T08:25:04.1234567Z'
  $exePath = 'C:\Program Files\OpenBot\openbot.exe'
  $receiptJson = New-ReceiptJson -Iso $iso -ElectronPath $exePath

  # Contrast (not a forever-PASS): ConvertFrom-Json coerces ISO → DateTime; naive [string] is not ISO-7.
  $parsed = $receiptJson | ConvertFrom-Json
  $coerced = $parsed.electron.startTimeUtc -is [datetime]
  $naive = [string]$parsed.electron.startTimeUtc
  Write-CheckResult -Name 'ConvertFrom-Json DateTime coercion breaks naive [string] cast' -Passed (
    $coerced -and $naive -ne $iso
  ) -Detail "type=$($parsed.electron.startTimeUtc.GetType().FullName); cast=[$naive]"

  $identities = Read-SmokeRoundIdentities $receiptJson
  $stjElectron = $identities.electron
  Write-CheckResult -Name 'STJ primary read preserves original ISO-7 startTimeUtc' -Passed (
    $null -ne $stjElectron -and $stjElectron.startTimeUtc -eq $iso
  ) -Detail "got=[$($stjElectron.startTimeUtc)]"

  $spawnIdentity = [pscustomobject]@{
    pid = 5060
    startTimeUtc = $iso
    executablePath = $exePath
  }
  Write-CheckResult -Name 'STJ receipt electron matches spawn (pid + ISO eq + path -ine)' -Passed (
    Test-ReceiptIdentityEqualsSpawn -ReceiptIdentity $stjElectron -SpawnIdentity $spawnIdentity
  )

  # Summary projection keeps STJ strings (simulates Add-RoundEvidence → summary.json).
  $summaryElectronJson = (@{
    electron = [ordered]@{
      pid = [int]$stjElectron.pid
      startTimeUtc = [string]$stjElectron.startTimeUtc
      executablePath = [string]$stjElectron.executablePath
    }
    postgres = @{ pid = 1; startTimeUtc = $iso; executablePath = 'x' }
    server = @{ pid = 2; startTimeUtc = $iso; executablePath = 'y' }
  } | ConvertTo-Json -Depth 6)
  $reloaded = (Read-SmokeRoundIdentities $summaryElectronJson).electron
  Write-CheckResult -Name 'summary.json STJ round-trip keeps ISO-7 startTimeUtc' -Passed (
    $reloaded.startTimeUtc -eq $iso
  ) -Detail "got=[$($reloaded.startTimeUtc)]"

  # Reject: only last fractional digit of startTimeUtc changes.
  $tweakedIso = '2026-09-13T08:25:04.1234568Z'
  $tweaked = (Read-SmokeRoundIdentities (New-ReceiptJson -Iso $tweakedIso)).electron
  Write-CheckResult -Name 'Reject when only last fractional digit of startTimeUtc changes' -Passed (
    -not (Test-ReceiptIdentityEqualsSpawn -ReceiptIdentity $tweaked -SpawnIdentity $spawnIdentity)
  ) -Detail "receipt=[$($tweaked.startTimeUtc)]"

  # Reject: wrong PID.
  $wrongPid = (Read-SmokeRoundIdentities (New-ReceiptJson -Iso $iso -ElectronPid 9999)).electron
  Write-CheckResult -Name 'Reject wrong PID' -Passed (
    -not (Test-ReceiptIdentityEqualsSpawn -ReceiptIdentity $wrongPid -SpawnIdentity $spawnIdentity)
  ) -Detail "pid=$($wrongPid.pid)"

  # Reject: wrong path.
  $wrongPath = (Read-SmokeRoundIdentities (New-ReceiptJson -Iso $iso -ElectronPath 'C:\not-openbot.exe')).electron
  Write-CheckResult -Name 'Reject wrong path' -Passed (
    -not (Test-ReceiptIdentityEqualsSpawn -ReceiptIdentity $wrongPath -SpawnIdentity $spawnIdentity)
  ) -Detail "path=$($wrongPath.executablePath)"

  foreach ($invalidTime in @('null', '123', '{}', '"2026-09-13T08:25:04Z"')) {
    $invalidJson = $receiptJson.Replace(('"' + $iso + '"'), $invalidTime)
    $invalidIdentity = (Read-SmokeRoundIdentities $invalidJson).electron
    Write-CheckResult -Name "Reject incomplete timestamp token $invalidTime" -Passed ($null -eq $invalidIdentity)
  }
  $missing = [pscustomobject]@{ pid = 5060; startTimeUtc = $null; executablePath = $exePath }
  Write-CheckResult -Name 'Missing timestamps cannot match one another' -Passed (
    -not (Test-ReceiptIdentityEqualsSpawn -ReceiptIdentity $missing -SpawnIdentity $missing)
  )
}

function Test-DualNodePathResolution {
  $tmpRoot = Join-Path ([IO.Path]::GetTempPath()) ("openbot-dual-node-" + [guid]::NewGuid().ToString('N'))
  $firstDir = Join-Path $tmpRoot 'first'
  $secondDir = Join-Path $tmpRoot 'second'
  $oldPath = $env:PATH
  $sep = [IO.Path]::PathSeparator
  try {
    New-Item -ItemType Directory -Path $firstDir | Out-Null
    New-Item -ItemType Directory -Path $secondDir | Out-Null

    $realNode = Get-NodeApplicationPath
    $stubName = if ([OperatingSystem]::IsWindows()) { 'node.exe' } else { 'node' }
    $firstStub = Join-Path $firstDir $stubName
    $secondStub = Join-Path $secondDir $stubName
    Copy-Item -LiteralPath $realNode -Destination $firstStub
    Copy-Item -LiteralPath $realNode -Destination $secondStub
    if (-not [OperatingSystem]::IsWindows()) {
      # Ensure shims are executable on Unix.
      & chmod +x $firstStub
      & chmod +x $secondStub
    }

    # First PATH entry wins; arrange so Get-Command without TotalCount sees at least two.
    $env:PATH = ($firstDir + $sep + $secondDir + $sep + $oldPath)

    $multi = @(Get-Command -Name node -CommandType Application -ErrorAction Stop)
    Write-CheckResult -Name 'Dual-node PATH: Get-Command Application returns multiple matches' -Passed (
      $multi.Count -gt 1
    ) -Detail "count=$($multi.Count)"

    $oldSource = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    $oldIsSingleCleanPath = (
      $oldSource -is [string] -and
      -not [string]::IsNullOrWhiteSpace($oldSource) -and
      (Test-Path -LiteralPath $oldSource -PathType Leaf)
    )
    Write-CheckResult -Name 'Dual-node PATH: old-style .Source is NOT a single clean path' -Passed (
      -not $oldIsSingleCleanPath
    ) -Detail ("type=$($oldSource.GetType().FullName); joined=[$([string]$oldSource)]")

    $resolved = Get-NodeApplicationPath
    $firstExpected = [IO.Path]::GetFullPath($firstStub)
    Write-CheckResult -Name 'Dual-node PATH: Get-NodeApplicationPath returns first PATH entry' -Passed (
      $resolved -eq $firstExpected -and (Test-Path -LiteralPath $resolved -PathType Leaf)
    ) -Detail "got=[$resolved] expected=[$firstExpected]"

    $verInfo = [Diagnostics.ProcessStartInfo]::new()
    $verInfo.FileName = $resolved
    $verInfo.UseShellExecute = $false
    $verInfo.CreateNoWindow = $true
    $verInfo.RedirectStandardOutput = $true
    $verInfo.RedirectStandardError = $true
    $verInfo.ArgumentList.Add('--version')
    $verProc = [Diagnostics.Process]::Start($verInfo)
    try {
      $null = $verProc.Handle
      if (-not $verProc.WaitForExit(10000)) { throw 'node --version exceeded 10 seconds.' }
      $stdout = $verProc.StandardOutput.ReadToEnd()
      Write-CheckResult -Name 'Dual-node PATH: ProcessStartInfo.FileName from helper launches node' -Passed (
        $verProc.ExitCode -eq 0 -and $stdout -match 'v?\d+\.\d+'
      ) -Detail ("exit=$($verProc.ExitCode); out=$($stdout.Trim())")
    } finally {
      if ($null -ne $verProc) {
        if (-not $verProc.HasExited) { $verProc.Kill($true); $null = $verProc.WaitForExit(5000) }
        $verProc.Dispose()
      }
    }
  } catch {
    Write-CheckResult -Name 'Dual-node PATH regression' -Passed $false -Detail ([string]$_.Exception.Message)
  } finally {
    $env:PATH = $oldPath
    if (Test-Path -LiteralPath $tmpRoot) {
      Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Host "OpenBot Windows receipt identity checks (pwsh $($PSVersionTable.PSVersion); OS=$([System.Runtime.InteropServices.RuntimeInformation]::OSDescription))"
Test-StjPrimaryIdentityRoundTrip
Test-DualNodePathResolution

$runningOnWindows = [OperatingSystem]::IsWindows()
if (-not $runningOnWindows) {
  Write-Host 'SKIP: Windows Node/WinPS identity preflight (non-Windows host).'
} elseif ($SkipWindowsProcessChecks) {
  Write-Host 'SKIP: Windows Node/WinPS identity preflight (-SkipWindowsProcessChecks).'
} else {
  try {
    $null = Assert-CrossRuntimeProcessIdentityConsistency
    Write-CheckResult -Name 'Actual Node/WinPS cross-runtime identity preflight' -Passed $true
  } catch {
    Write-CheckResult -Name 'Actual Node/WinPS cross-runtime identity preflight' -Passed $false -Detail ([string]$_.Exception.Message)
  }
}

if ($script:failures.Count -gt 0) {
  Write-Host ("FAILED checks: " + ($script:failures -join ', '))
  exit 1
}
Write-Host 'All receipt identity checks passed.'
exit 0
