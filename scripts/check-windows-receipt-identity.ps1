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

Write-Host "OpenBot Windows receipt identity checks (pwsh $($PSVersionTable.PSVersion); OS=$([System.Runtime.InteropServices.RuntimeInformation]::OSDescription))"
Test-StjPrimaryIdentityRoundTrip

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
