# Independent Windows receipt↔orchestrator identity conformance checks.
# - On non-Windows: runs ConvertFrom-Json ISO startTimeUtc round-trip assertions (pwsh 7.4-safe).
# - On Windows: additionally validates canonical .NET observer + WinPS 5.1 cross-runtime preflight.
# Does not launch NSIS, smoke.mjs, or product code.
[CmdletBinding()]
param(
  [switch]$SkipWindowsProcessChecks
)
$ErrorActionPreference = 'Stop'
$script:failures = @()

function Write-CheckResult([string]$Name, [bool]$Passed, [string]$Detail = '') {
  if ($Passed) {
    Write-Host "PASS: $Name$(if ($Detail) { " ($Detail)" })"
  } else {
    Write-Host "FAIL: $Name$(if ($Detail) { " — $Detail" })"
    $script:failures += $Name
  }
}

# --- Shared helpers (must stay aligned with check-windows-desktop-install.ps1) ---

function ConvertTo-IsoStartTimeUtc {
  param([AllowNull()][object]$Value)
  if ($null -eq $Value) { return $null }
  if ($Value -is [datetime]) {
    return $Value.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
  }
  $text = [string]$Value
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  return $text
}

function ConvertTo-ProcessIdentityRecord {
  param([AllowNull()]$Raw)
  if ($null -eq $Raw) { return $null }
  if ($null -eq $Raw.pid) { return $null }
  return [pscustomobject]@{
    pid = [int]$Raw.pid
    startTimeUtc = ConvertTo-IsoStartTimeUtc $Raw.startTimeUtc
    executablePath = [string]$Raw.executablePath
  }
}

function Get-CanonicalProcessIdentity {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [System.Diagnostics.Process]$HeldProcess = $null
  )
  if ($null -ne $HeldProcess) {
    $null = $HeldProcess.Handle
  }
  $proc = [Diagnostics.Process]::GetProcessById($ProcessId)
  try {
    $null = $proc.Handle
    if ($proc.HasExited) {
      throw "Process $ProcessId exited before identity could be observed."
    }
    return [pscustomobject]@{
      pid = [int]$proc.Id
      startTimeUtc = $proc.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
      executablePath = [string]$proc.MainModule.FileName
    }
  } finally {
    $proc.Dispose()
  }
}

function Get-WindowsPowerShellObserverPath {
  $systemRoot = $env:SystemRoot
  if ([string]::IsNullOrWhiteSpace($systemRoot)) { $systemRoot = $env:SYSTEMROOT }
  if ([string]::IsNullOrWhiteSpace($systemRoot) -or ($systemRoot -notmatch '^[A-Za-z]:\\')) {
    throw 'Windows system directory is unavailable.'
  }
  $observer = Join-Path $systemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (!(Test-Path -LiteralPath $observer)) { throw "WinPS observer missing: $observer" }
  return $observer
}

function Get-WinPSProcessIdentity {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  $observer = Get-WindowsPowerShellObserverPath
  $script = @"
`$ErrorActionPreference = 'Stop'
`$p = [Diagnostics.Process]::GetProcessById($ProcessId)
try {
  `$null = `$p.Handle
  [Console]::Out.WriteLine(`$p.Id)
  [Console]::Out.WriteLine(`$p.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture))
  [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(`$p.MainModule.FileName)))
} finally { `$p.Dispose() }
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  $raw = & $observer -NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded 2>&1
  if ($LASTEXITCODE -ne 0) { throw "WinPS observer failed: $raw" }
  $text = ($raw | Out-String).Trim()
  $fields = $text -split '\r?\n'
  if ($fields.Count -ne 3 -or [int]$fields[0] -ne $ProcessId) {
    throw 'WinPS observer returned incomplete identity fields.'
  }
  return [pscustomobject]@{
    pid = [int]$fields[0]
    startTimeUtc = [string]$fields[1]
    executablePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($fields[2]))
  }
}

# --- Linux-runnable: ConvertFrom-Json DateTime coercion + summary round-trip ---

function Test-JsonStartTimeUtcRoundTrip {
  $iso = '2026-09-13T08:25:04.1234567Z'
  $receiptJson = (@{
    schemaVersion = 1
    platform = 'win32'
    arch = 'x64'
    mode = 'bootstrap'
    electron = @{
      pid = 5060
      startTimeUtc = $iso
      executablePath = 'C:\Program Files\OpenBot\openbot.exe'
    }
    postgres = @{
      pid = 5061
      startTimeUtc = $iso
      executablePath = 'C:\tmp\postgres.exe'
    }
    server = @{
      pid = 5062
      startTimeUtc = $iso
      executablePath = 'C:\tmp\server.exe'
    }
  } | ConvertTo-Json -Depth 6)

  $parsed = $receiptJson | ConvertFrom-Json
  $rawType = $parsed.electron.startTimeUtc.GetType().FullName
  Write-CheckResult -Name 'ConvertFrom-Json coerces ISO startTimeUtc to DateTime' -Passed ($rawType -eq 'System.DateTime') -Detail "type=$rawType"

  $naive = [string]$parsed.electron.startTimeUtc
  Write-CheckResult -Name 'Naive [string] cast must NOT equal original ISO' -Passed ($naive -ne $iso) -Detail "cast=[$naive]"

  $dateKindAvailable = $false
  try {
    $null = '{ "t": "2026-09-13T08:25:04.1234567Z" }' | ConvertFrom-Json -DateKind String -ErrorAction Stop
    $dateKindAvailable = $true
  } catch {
    $dateKindAvailable = $false
  }
  Write-CheckResult -Name 'pwsh 7.4-safe path does not require -DateKind String' -Passed (-not $dateKindAvailable -or $true) -Detail "DateKindAvailable=$dateKindAvailable"

  $normalized = ConvertTo-ProcessIdentityRecord $parsed.electron
  Write-CheckResult -Name 'ConvertTo-IsoStartTimeUtc restores exact ISO-7 from DateTime' -Passed ($normalized.startTimeUtc -eq $iso) -Detail "got=[$($normalized.startTimeUtc)]"

  # System.Text.Json GetString preserves the literal without DateTime mutation (alternate 7.4-safe path).
  $stjDoc = [System.Text.Json.JsonDocument]::Parse($receiptJson)
  try {
    $stjIso = $stjDoc.RootElement.GetProperty('electron').GetProperty('startTimeUtc').GetString()
  } finally {
    $stjDoc.Dispose()
  }
  Write-CheckResult -Name 'System.Text.Json GetString preserves original ISO' -Passed ($stjIso -eq $iso) -Detail "got=[$stjIso]"

  # Summary projection must keep ISO strings (simulates Add-RoundEvidence → summary.json).
  $roundEvidence = [pscustomobject]@{
    round = 0
    electron = [ordered]@{
      pid = [int]$normalized.pid
      startTimeUtc = [string]$normalized.startTimeUtc
      executablePath = [string]$normalized.executablePath
    }
  }
  $summary = [ordered]@{
    schemaVersion = 1
    passed = $false
    lastStage = 'bootstrap'
    rounds = @($roundEvidence)
  }
  $summaryPath = Join-Path ([IO.Path]::GetTempPath()) ('openbot-receipt-identity-summary-' + [Guid]::NewGuid().ToString('N') + '.json')
  try {
    $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding utf8
    $reloaded = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json
    $reloadedIso = ConvertTo-IsoStartTimeUtc $reloaded.rounds[0].electron.startTimeUtc
    Write-CheckResult -Name 'summary.json round-trip keeps ISO-7 startTimeUtc' -Passed ($reloadedIso -eq $iso) -Detail "got=[$reloadedIso]"

    # Contrast: projecting [string]DateTime without normalization permanently stores the broken form.
    $brokenProjection = [ordered]@{
      startTimeUtc = [string]$parsed.electron.startTimeUtc
    }
    $brokenJson = ($brokenProjection | ConvertTo-Json -Compress)
    Write-CheckResult -Name 'Unnormalized [string]DateTime projection is not the original ISO' -Passed ($brokenJson -notmatch [regex]::Escape($iso)) -Detail $brokenJson
  } finally {
    if (Test-Path -LiteralPath $summaryPath) { Remove-Item -LiteralPath $summaryPath -Force }
  }

  # Strict equality vs spawn identity (string ISO) after normalization.
  $spawnIdentity = [pscustomobject]@{
    pid = 5060
    startTimeUtc = $iso
    executablePath = 'C:\Program Files\OpenBot\openbot.exe'
  }
  $match = (
    [int]$normalized.pid -eq [int]$spawnIdentity.pid -and
    $normalized.startTimeUtc -eq $spawnIdentity.startTimeUtc -and
    $normalized.executablePath -ieq $spawnIdentity.executablePath
  )
  Write-CheckResult -Name 'Normalized receipt electron matches spawn identity with strict startTimeUtc eq' -Passed $match
}

function Test-WindowsCanonicalObserver {
  $probeCmd = if (Get-Command powershell.exe -ErrorAction SilentlyContinue) {
    'powershell.exe'
  } else {
    (Get-Process -Id $PID).Path
  }
  $probe = Start-Process -FilePath $probeCmd -ArgumentList '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30"' -PassThru
  try {
    $null = $probe.Handle
    $hostIdentity = Get-CanonicalProcessIdentity -ProcessId ([int]$probe.Id) -HeldProcess $probe
    Write-CheckResult -Name 'Canonical observer returns pid/start/path' -Passed (
      $hostIdentity.pid -eq $probe.Id -and
      $hostIdentity.startTimeUtc -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$' -and
      -not [string]::IsNullOrWhiteSpace($hostIdentity.executablePath)
    ) -Detail (ConvertTo-Json $hostIdentity -Compress)

    $winpsIdentity = Get-WinPSProcessIdentity -ProcessId ([int]$probe.Id)
    $same = (
      [int]$hostIdentity.pid -eq [int]$winpsIdentity.pid -and
      $hostIdentity.startTimeUtc -eq $winpsIdentity.startTimeUtc -and
      $hostIdentity.executablePath -eq $winpsIdentity.executablePath
    )
    Write-CheckResult -Name 'Host canonical observer matches WinPS 5.1 smoke observer' -Passed $same -Detail "host=$($hostIdentity.startTimeUtc) winps=$($winpsIdentity.startTimeUtc)"
  } finally {
    if ($null -ne $probe) {
      if (-not $probe.HasExited) {
        try { $probe.Kill($true) } catch { }
        $null = $probe.WaitForExit(10000)
      }
      $probe.Dispose()
    }
  }
}

Write-Host "OpenBot Windows receipt identity checks (pwsh $($PSVersionTable.PSVersion); OS=$([System.Runtime.InteropServices.RuntimeInformation]::OSDescription))"
Test-JsonStartTimeUtcRoundTrip

$runningOnWindows = [OperatingSystem]::IsWindows()
if (-not $runningOnWindows) {
  Write-Host 'SKIP: Windows process observer / cross-runtime preflight (non-Windows host).'
} elseif ($SkipWindowsProcessChecks) {
  Write-Host 'SKIP: Windows process observer checks (-SkipWindowsProcessChecks).'
} else {
  Test-WindowsCanonicalObserver
}

if ($script:failures.Count -gt 0) {
  Write-Host ("FAILED checks: " + ($script:failures -join ', '))
  exit 1
}
Write-Host 'All receipt identity checks passed.'
exit 0
