param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$PackagedDirectory,
  [Parameter(Mandatory = $true)][string]$Electron,
  [Parameter(Mandatory = $true)][string]$SmokeScript,
  [string]$EvidenceDirectory
)
$ErrorActionPreference = 'Stop'
if (![OperatingSystem]::IsWindows() -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
  throw 'The Desktop install gate requires Windows x64.'
}

if (!$EvidenceDirectory) {
  $EvidenceDirectory = Join-Path $env:RUNNER_TEMP ('OpenBotWindowsEvidence-' + [Guid]::NewGuid().ToString('N'))
}
if (Test-Path -LiteralPath $EvidenceDirectory) { throw 'Evidence destination must be fresh.' }
New-Item -ItemType Directory -Path $EvidenceDirectory | Out-Null
$script:roundEvidence = @()
$script:cleanupVerified = $true
$stage = 'install'
$passed = $false
$uninstalled = $false
$fixtureRemoved = $false
$ownershipTestsPassed = $false
$ColdStartRounds = 10
$expectedFinalChecks = 'postgresql,migrations,dpapi,owner-login,retained-data,stop,restart,cleanup,cold-start-10'
$target = Join-Path $env:RUNNER_TEMP ('OpenBotWindowsInstall-' + [Guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $target) { throw 'Test installation destination already exists.' }
$harness = Join-Path $env:RUNNER_TEMP ('OpenBotWindowsColdStart-' + [Guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $harness) { throw 'Cold-start harness destination already exists.' }
New-Item -ItemType Directory -Path $harness | Out-Null
$receipt = "$harness.final.result.json"
$stdout = "$harness.stdout.log"
$stderr = "$harness.stderr.log"
$statePath = Join-Path $harness 'cold-start-state.json'
$liveProcessesPath = Join-Path $harness 'harness-live-processes.json'
$failureSummary = $null
# This-round Electron identity from the held Start-Process handle (not JSON alone).
$script:currentRoundElectron = $null

function Write-SafeSummary([string]$Message) {
  Write-Host $Message
  $script:failureSummary = $Message
}

# ConvertFrom-Json (pwsh 7.4 default) coerces ISO timestamps to DateTime.
# Never use [string]$DateTime for identity — that yields a locale short string without
# 7-digit fractional seconds. Always restore round-trip ISO via InvariantCulture 'o'.
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
  $pidValue = $Raw.pid
  if ($null -eq $pidValue) { return $null }
  return [pscustomobject]@{
    pid = [int]$pidValue
    startTimeUtc = ConvertTo-IsoStartTimeUtc $Raw.startTimeUtc
    executablePath = [string]$Raw.executablePath
  }
}

function Format-ProcessIdentityEvidence {
  param([AllowNull()]$Identity, [string]$Label)
  $pidText = if ($null -eq $Identity -or $null -eq $Identity.pid) { '<missing>' } else { [string][int]$Identity.pid }
  $startText = if ($null -eq $Identity -or [string]::IsNullOrWhiteSpace([string]$Identity.startTimeUtc)) {
    '<missing>'
  } else {
    ConvertTo-IsoStartTimeUtc $Identity.startTimeUtc
  }
  $pathText = if ($null -eq $Identity -or [string]::IsNullOrWhiteSpace([string]$Identity.executablePath)) {
    '<missing>'
  } else {
    [string]$Identity.executablePath
  }
  return ("${Label}={pid=$pidText; startTimeUtc=$startText; executablePath=$pathText}")
}

# Canonical observer matching smoke's WindowsPowerShell 5.1 contract:
# GetProcessById → pin Handle → StartTime 'o'+InvariantCulture → MainModule.FileName.
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
  if ([string]::IsNullOrWhiteSpace($systemRoot)) {
    $systemRoot = $env:SYSTEMROOT
  }
  if ([string]::IsNullOrWhiteSpace($systemRoot) -or ($systemRoot -notmatch '^[A-Za-z]:\\')) {
    throw 'Windows system directory is unavailable for the WinPS identity observer.'
  }
  $observer = Join-Path $systemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (!(Test-Path -LiteralPath $observer)) {
    throw "Windows PowerShell 5.1 observer missing at $observer."
  }
  return $observer
}

function Get-WinPSProcessIdentity {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  $observer = Get-WindowsPowerShellObserverPath
  # Same observation script body smoke uses (EncodedCommand / no cmdlet autoload).
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
  if ($LASTEXITCODE -ne 0) {
    throw "WinPS process observer failed for pid=$ProcessId (exit=$LASTEXITCODE): $raw"
  }
  $text = ($raw | Out-String).Trim()
  $fields = $text -split '\r?\n'
  if ($fields.Count -ne 3 -or [int]$fields[0] -ne $ProcessId -or [string]::IsNullOrWhiteSpace($fields[1]) -or [string]::IsNullOrWhiteSpace($fields[2])) {
    throw "WinPS process observer returned incomplete identity fields for pid=$ProcessId."
  }
  return [pscustomobject]@{
    pid = [int]$fields[0]
    startTimeUtc = [string]$fields[1]
    executablePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($fields[2]))
  }
}

function Assert-CrossRuntimeProcessIdentityConsistency {
  # Fast pre-flight: current host .NET observation must match WinPS 5.1 (smoke) for the same PID.
  $probe = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30"' -PassThru
  try {
    $null = $probe.Handle
    $hostIdentity = Get-CanonicalProcessIdentity -ProcessId ([int]$probe.Id) -HeldProcess $probe
    $winpsIdentity = Get-WinPSProcessIdentity -ProcessId ([int]$probe.Id)
    if (
      [int]$hostIdentity.pid -ne [int]$winpsIdentity.pid -or
      $hostIdentity.startTimeUtc -ne $winpsIdentity.startTimeUtc -or
      $hostIdentity.executablePath -ne $winpsIdentity.executablePath
    ) {
      $heldEvidence = Format-ProcessIdentityEvidence -Identity $hostIdentity -Label 'host'
      $winpsEvidence = Format-ProcessIdentityEvidence -Identity $winpsIdentity -Label 'winps'
      throw "Cross-runtime process identity preflight failed. $heldEvidence $winpsEvidence"
    }
    Write-Host "PASS: cross-runtime process identity preflight (pid=$($hostIdentity.pid))."
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

function Test-ProcessIdentityMatch {
  param(
    [Parameter(Mandatory = $true)]$Recorded,
    [Parameter(Mandatory = $true)]$Live
  )
  if ($null -eq $Recorded -or $null -eq $Live) { return $false }
  $recordedStart = ConvertTo-IsoStartTimeUtc $Recorded.startTimeUtc
  $recordedPath = [string]$Recorded.executablePath
  if ([string]::IsNullOrWhiteSpace($recordedStart)) { return $false }
  if ([string]::IsNullOrWhiteSpace($recordedPath)) { return $false }
  if ([int]$Recorded.pid -ne [int]$Live.Id) { return $false }
  # Match smoke / canonical observer: pin handle, InvariantCulture 'o', MainModule.FileName.
  $null = $Live.Handle
  $liveStart = $Live.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
  if ($liveStart -ne $recordedStart) { return $false }
  $livePath = [string]$Live.MainModule.FileName
  if ([string]::IsNullOrWhiteSpace($livePath)) { return $false }
  if ($livePath.ToLowerInvariant() -ne $recordedPath.ToLowerInvariant()) { return $false }
  return $true
}

function Stop-VerifiedHarnessIdentity {
  param([Parameter(Mandatory = $true)]$Recorded, [string]$Label)
  $identity = ConvertTo-ProcessIdentityRecord $Recorded
  if ($null -eq $identity -or $null -eq $identity.pid) { return }
  if ([string]::IsNullOrWhiteSpace([string]$identity.startTimeUtc) -or [string]::IsNullOrWhiteSpace([string]$identity.executablePath)) {
    $script:cleanupVerified = $false
    Write-Host "Skipping stop for $Label pid=$($identity.pid): incomplete recorded identity (refusing PID-only kill)."
    return
  }
  $proc = $null
  try {
    $proc = Get-Process -Id ([int]$identity.pid) -ErrorAction SilentlyContinue
    if ($null -eq $proc) { return }
    # Pin the OS process object before querying identity; retain it through Kill.
    $null = $proc.Handle
    if ($proc.HasExited) { return }
    if (-not (Test-ProcessIdentityMatch -Recorded $identity -Live $proc)) {
      Write-Host "Skipping stop for $Label pid=$($identity.pid): live identity does not match recorded harness process."
      return
    }
    $proc.Kill($true)
    if (!$proc.WaitForExit(10000)) { throw "Verified harness process did not exit." }
    Write-Host "Stopped leftover harness process $Label pid=$($identity.pid) after identity verification."
  } catch {
    $script:cleanupVerified = $false
    Write-Host "Unable to verify cleanup for $Label; no PID-only fallback is allowed."
  } finally {
    if ($null -ne $proc) { $proc.Dispose() }
  }
}

function Read-JsonObject([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return $null }
  try {
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Read-NormalizedProcessIdentityFile([string]$Path) {
  $raw = Read-JsonObject $Path
  if ($null -eq $raw) { return $null }
  $normalized = [ordered]@{}
  foreach ($name in @('server', 'postgres', 'electron')) {
    if ($null -ne $raw.$name) {
      $normalized[$name] = ConvertTo-ProcessIdentityRecord $raw.$name
    }
  }
  # Preserve other properties if present (cold-start state may carry more fields).
  foreach ($prop in $raw.PSObject.Properties) {
    if ($normalized.Contains($prop.Name)) { continue }
    $normalized[$prop.Name] = $prop.Value
  }
  return [pscustomobject]$normalized
}

function Stop-RecordedHarnessProcesses {
  # Prefer live-process file (this round, including failure-before-state) then durable state.
  $sources = @()
  $live = Read-NormalizedProcessIdentityFile $liveProcessesPath
  if ($null -ne $live) { $sources += $live }
  $state = Read-NormalizedProcessIdentityFile $statePath
  if ($null -ne $state) { $sources += $state }

  foreach ($source in $sources) {
    foreach ($name in @('server', 'postgres', 'electron')) {
      $identity = $source.$name
      if ($null -eq $identity) { continue }
      Stop-VerifiedHarnessIdentity -Recorded $identity -Label $name
    }
  }

  # Held Start-Process handle for this round's Electron — never rely on JSON PID alone.
  if ($null -ne $script:currentRoundElectron -and $null -ne $script:currentRoundElectron.Process) {
    try {
      $held = $script:currentRoundElectron.Process
      if (-not $held.HasExited) {
        # This object owns the Start-Process handle; optional metadata is not authority.
        $held.Kill($true)
        Write-Host "Stopped this-round Electron through its held process handle (pid=$($held.Id))."
      }
      if (!$held.WaitForExit(10000)) { $script:cleanupVerified = $false }
    } catch {
      $script:cleanupVerified = $false
    }
  }
}

function Assert-SafeRoundReceipt($Round, [string]$ExpectedMode) {
  if ($Round.schemaVersion -ne 1 -or $Round.platform -ne 'win32' -or $Round.arch -ne 'x64') {
    throw 'Smoke receipt platform fields are incomplete.'
  }
  if ($Round.mode -ne $ExpectedMode) {
    throw 'Bootstrap receipt mode mismatch.'
  }
  $expectedLogins = if ($ExpectedMode -eq 'bootstrap') { 2 } else { 1 }
  if ($null -eq $Round.loginCount -or [int]$Round.loginCount -ne $expectedLogins) {
    throw 'Smoke receipt loginCount is missing.'
  }
  if ($Round.ciphertextDigest -notmatch '^[0-9a-f]{64}$') {
    throw 'Smoke receipt ciphertextDigest must be a sha256 hex digest (no raw ciphertext).'
  }
  foreach ($name in @('electron', 'postgres', 'server')) {
    $identity = ConvertTo-ProcessIdentityRecord $Round.$name
    if ($null -eq $identity -or [long]$identity.pid -le 0 -or [long]$identity.pid -gt 2147483647 -or [string]::IsNullOrWhiteSpace([string]$identity.startTimeUtc) -or [string]::IsNullOrWhiteSpace([string]$identity.executablePath)) {
      throw "Smoke receipt missing verified process identity fields for $name."
    }
  }
  if ($script:roundEvidence.Count -gt 0 -and $Round.ciphertextDigest -ne $script:roundEvidence[0].ciphertextDigest) {
    throw 'Bootstrap ciphertext digest changed across independent process lifetimes.'
  }
  # Refuse secrets in the receipt surface we persist/print.
  $raw = $Round | ConvertTo-Json -Depth 6 -Compress
  if ($raw -match 'databasePassword' -or $raw -match '"encryptedBootstrap"' -or $raw -match '"ciphertext"\s*:') {
    throw 'Smoke receipt unexpectedly contains secret material.'
  }
}

function Invoke-NativeSmoke([string]$Mode, [string]$RoundReceipt, [int]$TimeoutMs) {
  if (Test-Path -LiteralPath $RoundReceipt) { throw "Smoke result path must be fresh: $RoundReceipt" }
  foreach ($log in @($stdout, $stderr)) {
    if (Test-Path -LiteralPath $log) { Remove-Item -LiteralPath $log -Force }
  }
  if (Test-Path -LiteralPath $liveProcessesPath) { Remove-Item -LiteralPath $liveProcessesPath -Force }
  $script:currentRoundElectron = $null
  $arguments = "`"$SmokeScript`" `"$runtime`" `"$RoundReceipt`" $Mode `"$harness`""
  $smoke = Start-Process -FilePath $Electron -ArgumentList $arguments -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  # Keep the Start-Process object even if querying its identity fails.
  $script:currentRoundElectron = [pscustomobject]@{ Process = $smoke; Identity = $null }
  $null = $smoke.Handle
  # Observe with the same .NET fields smoke uses (not Start-Process .Path / culture-default 'o').
  $spawnIdentity = Get-CanonicalProcessIdentity -ProcessId ([int]$smoke.Id) -HeldProcess $smoke
  $script:currentRoundElectron.Identity = $spawnIdentity
  if (!$smoke.WaitForExit($TimeoutMs)) {
    try {
      $smoke.Kill($true)
    } catch { }
    if (!$smoke.WaitForExit(15000)) { $script:cleanupVerified = $false }
    Stop-RecordedHarnessProcesses
    foreach ($log in @($stdout, $stderr)) {
      if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 40 | Write-Host }
    }
    throw "Native smoke mode=$Mode exceeded $($TimeoutMs / 1000) seconds."
  }
  $smoke.WaitForExit()
  if ($smoke.ExitCode -ne 0 -or !(Test-Path -LiteralPath $RoundReceipt)) {
    Stop-RecordedHarnessProcesses
    foreach ($log in @($stdout, $stderr)) {
      if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 40 | Write-Host }
    }
    throw "Native smoke mode=$Mode did not complete its assertions (exit=$($smoke.ExitCode))."
  }
  $roundResult = Get-Content -LiteralPath $RoundReceipt -Raw | ConvertFrom-Json
  $receiptElectron = ConvertTo-ProcessIdentityRecord $roundResult.electron
  if ($null -eq $receiptElectron -or
      [int]$receiptElectron.pid -ne [int]$spawnIdentity.pid -or
      $receiptElectron.startTimeUtc -ne $spawnIdentity.startTimeUtc -or
      $receiptElectron.executablePath -ine $spawnIdentity.executablePath) {
    $heldEvidence = Format-ProcessIdentityEvidence -Identity $spawnIdentity -Label 'held'
    $receiptEvidence = Format-ProcessIdentityEvidence -Identity $receiptElectron -Label 'receipt'
    throw "Round receipt does not match the Electron process held by the orchestrator. $heldEvidence $receiptEvidence"
  }
  # Keep normalized ISO strings on the receipt object so later evidence projection stays exact.
  $roundResult.electron = $receiptElectron
  $roundResult.postgres = ConvertTo-ProcessIdentityRecord $roundResult.postgres
  $roundResult.server = ConvertTo-ProcessIdentityRecord $roundResult.server
  $smoke.Dispose()
  $script:currentRoundElectron = $null
  return $roundResult
}

function Add-RoundEvidence($Round, [int]$Index) {
  $record = [ordered]@{
    round = $Index
    mode = $Round.mode
    loginCount = [int]$Round.loginCount
    ciphertextDigest = $Round.ciphertextDigest
    checks = @($Round.checks)
  }
  foreach ($name in @('electron', 'postgres', 'server')) {
    $identity = ConvertTo-ProcessIdentityRecord $Round.$name
    $record[$name] = [ordered]@{
      pid = [int]$identity.pid
      startTimeUtc = [string]$identity.startTimeUtc
      executablePath = [string]$identity.executablePath
    }
  }
  $script:roundEvidence += [pscustomobject]$record
}

function Remove-FixtureTreeResilient {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (!(Test-Path -LiteralPath $Path)) { return }
  $maxAttempts = 8
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    try {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    } catch {
      $message = [string]$_.Exception.Message
      $isVanished = $message -match 'Could not find file|ItemNotFound|Cannot find path|cannot find the file' -or
        $_.FullyQualifiedErrorId -match 'PathNotFound|ItemNotFound' -or
        ($null -ne $_.Exception.InnerException -and [string]$_.Exception.InnerException.Message -match 'Could not find file')
      if (-not $isVanished) { throw }
    }
    if (!(Test-Path -LiteralPath $Path)) { return }
    Start-Sleep -Milliseconds ([Math]::Min(2000, 100 * [Math]::Pow(2, $attempt - 1)))
  }
  if (Test-Path -LiteralPath $Path) {
    throw "Fixture tree still present after resilient removal: $Path"
  }
}

function Test-HarnessProcessOwnership {
  # Exercise the same cleanup function on an owned real process before installing.
  $probe = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 60"' -PassThru
  try {
    $null = $probe.Handle
    $identity = Get-CanonicalProcessIdentity -ProcessId ([int]$probe.Id) -HeldProcess $probe
    $wrongStart = [pscustomobject]@{
      pid = $identity.pid; startTimeUtc = '2000-01-01T00:00:00.0000000Z'; executablePath = $identity.executablePath
    }
    $wrongPath = [pscustomobject]@{
      pid = $identity.pid; startTimeUtc = $identity.startTimeUtc; executablePath = 'C:\not-the-probe.exe'
    }
    Stop-VerifiedHarnessIdentity -Recorded $wrongStart -Label 'negative-start'
    if ($probe.HasExited) { throw 'Cleanup killed a process with a mismatching start time.' }
    Stop-VerifiedHarnessIdentity -Recorded $wrongPath -Label 'negative-path'
    if ($probe.HasExited) { throw 'Cleanup killed a process with a mismatching executable.' }
    Stop-VerifiedHarnessIdentity -Recorded $identity -Label 'owned-probe'
    if (!$probe.WaitForExit(10000)) { throw 'Cleanup did not stop the verified owned process.' }
    if (!$script:cleanupVerified) { throw 'Process identity negative checks failed.' }
  } finally {
    if (!$probe.HasExited) { $probe.Kill(); $null = $probe.WaitForExit(10000) }
    $probe.Dispose()
  }
  $heldProbe = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 60"' -PassThru
  try {
    $null = $heldProbe.Handle
    $script:currentRoundElectron = [pscustomobject]@{
      Process = $heldProbe
      Identity = [pscustomobject]@{ pid = $heldProbe.Id; startTimeUtc = $null; executablePath = '' }
    }
    Stop-RecordedHarnessProcesses
    if (!$heldProbe.HasExited) { throw 'Held process cleanup incorrectly depended on optional path metadata.' }
    if (!$script:cleanupVerified) { throw 'Held process cleanup failed.' }
  } finally {
    if (!$heldProbe.HasExited) { $heldProbe.Kill(); $null = $heldProbe.WaitForExit(10000) }
    $heldProbe.Dispose()
    $script:currentRoundElectron = $null
  }
}

try {
  $stage = 'process-identity-preflight'
  Assert-CrossRuntimeProcessIdentityConsistency
  $stage = 'process-identity-negative-checks'
  Test-HarnessProcessOwnership
  $ownershipTestsPassed = $true
  $stage = 'install'
  # NSIS /D is deliberately last and unquoted, per its documented command-line contract.
  $process = Start-Process -FilePath $Installer -ArgumentList "/S /D=$target" -PassThru
  try {
    if (!$process.WaitForExit(120000)) { $process.Kill(); throw 'NSIS installation timed out.' }
    if ($process.ExitCode -ne 0) { throw 'NSIS installation failed.' }
  } finally { $process.Dispose() }
  $installedAsar = Join-Path $target 'resources/app.asar'
  $packagedAsar = Join-Path $PackagedDirectory 'resources/app.asar'
  if ((Get-FileHash -LiteralPath $installedAsar -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $packagedAsar -Algorithm SHA256).Hash) {
    throw 'Installed application differs from the reviewed package.'
  }
  if (!(Test-Path -LiteralPath (Join-Path $target 'openbot.exe'))) { throw 'Installed executable missing.' }
  $runtime = Join-Path $target 'resources/native-runtime'

  $stage = 'bootstrap'
  $bootstrapReceiptPath = Join-Path $harness 'bootstrap.result.json'
  $bootstrap = Invoke-NativeSmoke -Mode 'bootstrap' -RoundReceipt $bootstrapReceiptPath -TimeoutMs 120000
  $expectedBootstrap = 'postgresql,migrations,dpapi,owner-login,retained-data,stop,restart,cleanup'
  if (($bootstrap.checks -join ',') -ne $expectedBootstrap) {
    throw 'Bootstrap native smoke result is incomplete.'
  }
  Assert-SafeRoundReceipt -Round $bootstrap -ExpectedMode 'bootstrap'
  Add-RoundEvidence -Round $bootstrap -Index 0
  Write-Host "PASS: bootstrap smoke receipt verified ($expectedBootstrap)."

  $final = $null
  for ($round = 1; $round -le $ColdStartRounds; $round++) {
    $stage = "cold-start-$round"
    $roundReceiptPath = Join-Path $harness ("cold-start-$round.result.json")
    # Each lifetime is an independent Electron process; 120s bound matches the historical gate.
    $final = Invoke-NativeSmoke -Mode 'cold-start' -RoundReceipt $roundReceiptPath -TimeoutMs 120000
    Assert-SafeRoundReceipt -Round $final -ExpectedMode 'cold-start'
    if ($final.coldStartsCompleted -ne $round) {
      throw "Cold-start progress mismatch: expected $round."
    }
    $expectedRoundChecks = if ($round -eq $ColdStartRounds) { $expectedFinalChecks } else {
      "postgresql,dpapi,owner-login,retained-data,stop,cleanup,cold-start-$round"
    }
    if (($final.checks -join ',') -ne $expectedRoundChecks) { throw 'Cold-start round assertions incomplete.' }
    Add-RoundEvidence -Round $final -Index $round
    Write-Host "PASS: cold-start $round/$ColdStartRounds (pid=$($final.electron.pid))."
  }

  if ($final.schemaVersion -ne 1 -or $final.platform -ne 'win32' -or $final.arch -ne 'x64' -or $final.coldStarts -ne $ColdStartRounds -or ($final.checks -join ',') -ne $expectedFinalChecks) {
    throw 'Installed native runtime cold-start result is incomplete.'
  }
  $passed = $true
  Write-Host "PASS: native smoke receipt verified ($expectedFinalChecks)."
} catch {
  Stop-RecordedHarnessProcesses
  Write-SafeSummary ("FAIL: " + $_.Exception.Message)
  throw
} finally {
  try {
    Stop-RecordedHarnessProcesses
    if (!$script:cleanupVerified) { throw 'Harness process cleanup could not be verified.' }
    if ($passed) { $stage = 'uninstall' }
    $uninstaller = Join-Path $target 'Uninstall OpenBot.exe'
    if (Test-Path -LiteralPath $uninstaller) {
      $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru
      try {
        if (!$process.WaitForExit(60000)) { $process.Kill(); throw 'NSIS uninstall timed out.' }
        if ($process.ExitCode -ne 0) { throw 'NSIS uninstall failed.' }
      } finally { $process.Dispose() }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ((Test-Path -LiteralPath (Join-Path $target 'openbot.exe')) -and [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 250
    }
    if (Test-Path -LiteralPath (Join-Path $target 'openbot.exe')) { throw 'Uninstall left the executable installed.' }
    $uninstalled = $true
    Remove-FixtureTreeResilient -Path $target
    Remove-FixtureTreeResilient -Path $harness
    foreach ($file in @($receipt, $stdout, $stderr)) {
      if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
    }
    $fixtureRemoved = $true
  } finally {
    if ($null -ne $script:currentRoundElectron) { $script:currentRoundElectron.Process.Dispose() }
    # This allowlist is the only uploaded evidence. No raw logs, profile, or fixture secrets.
    $summary = [ordered]@{
      schemaVersion = 1
      sourceCommit = $env:GITHUB_SHA
      platform = 'win32'
      arch = 'x64'
      passed = ($passed -and $uninstalled -and $script:cleanupVerified -and $fixtureRemoved -and $ownershipTestsPassed)
      lastStage = $stage
      uninstallPassed = $uninstalled
      fixtureRemoved = $fixtureRemoved
      cleanupVerified = $script:cleanupVerified
      processIdentityNegativeTestsPassed = $ownershipTestsPassed
      coldStartsCompleted = [Math]::Max(0, $script:roundEvidence.Count - 1)
      rounds = @($script:roundEvidence)
    }
    $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'summary.json') -Encoding utf8
    Write-Host "Safe Windows lifecycle evidence: $EvidenceDirectory"
  }
}
Write-Host 'Windows per-user NSIS install, installed native runtime cold-start (10 Electron lifetimes) and uninstall checks passed.'
