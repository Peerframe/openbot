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
$crossRuntimeIdentityPassed = $false
$ColdStartRounds = 10
$expectedFinalChecks = 'postgresql,migrations,dpapi,owner-login,retained-data,stop,restart,cleanup,cold-start-10'
$target = Join-Path $env:RUNNER_TEMP ('OpenBotWindowsInstall-' + [Guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $target) { throw 'Test installation destination already exists.' }
$harness = Join-Path $env:RUNNER_TEMP ('OpenBotWindowsColdStart-' + [Guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $harness) { throw 'Cold-start harness destination already exists.' }
New-Item -ItemType Directory -Path $harness | Out-Null
# Outside $target: NSIS silent uninstall must run from a copy with _?= so WaitForExit sees the real work
# (https://nsis.sourceforge.io/When_I_use_ExecWait_uninstaller.exe_it_doesn%27t_wait_for_the_uninstaller%3F).
$uninstallCopyDir = Join-Path $env:RUNNER_TEMP ('OpenBotWindowsUninstallCopy-' + [Guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $uninstallCopyDir) { throw 'Uninstall copy destination already exists.' }
$receipt = "$harness.final.result.json"
$stdout = "$harness.stdout.log"
$stderr = "$harness.stderr.log"
$statePath = Join-Path $harness 'cold-start-state.json'
$liveProcessesPath = Join-Path $harness 'harness-live-processes.json'
$failureSummary = $null
# This-round Electron identity from the held Start-Process handle (not JSON alone).
$script:currentRoundElectron = $null

$script:windowsReceiptIdentityHelpers = Join-Path $PSScriptRoot 'windows-receipt-identity-helpers.ps1'
. $script:windowsReceiptIdentityHelpers

function Write-SafeSummary([string]$Message) {
  Write-Host $Message
  $script:failureSummary = $Message
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

function Read-ProcessIdentityFile([string]$Path) {
  # STJ primary read of known identity fields only (preserves original ISO startTimeUtc).
  if (!(Test-Path -LiteralPath $Path)) { return $null }
  try {
    $rawText = Get-Content -LiteralPath $Path -Raw
    if ([string]::IsNullOrWhiteSpace($rawText)) { return $null }
    return Read-SmokeRoundIdentities $rawText
  } catch {
    return $null
  }
}

function Stop-RecordedHarnessProcesses {
  # Prefer live-process file (this round, including failure-before-state) then durable state.
  $sources = @()
  $live = Read-ProcessIdentityFile $liveProcessesPath
  if ($null -ne $live) { $sources += $live }
  $state = Read-ProcessIdentityFile $statePath
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
  $receiptRaw = Get-Content -LiteralPath $RoundReceipt -Raw
  # Other scalars may still come from ConvertFrom-Json; identity fields must be STJ strings.
  $roundResult = $receiptRaw | ConvertFrom-Json
  $identities = Read-SmokeRoundIdentities $receiptRaw
  $receiptElectron = $identities.electron
  if (!(Test-ReceiptIdentityEqualsSpawn -ReceiptIdentity $receiptElectron -SpawnIdentity $spawnIdentity)) {
    $heldEvidence = Format-ProcessIdentityEvidence -Identity $spawnIdentity -Label 'held'
    $receiptEvidence = Format-ProcessIdentityEvidence -Identity $receiptElectron -Label 'receipt'
    throw "Round receipt does not match the Electron process held by the orchestrator. $heldEvidence $receiptEvidence"
  }
  # Overlay STJ-preserved identity records onto the round object for Assert/Add-RoundEvidence.
  $roundResult.electron = $identities.electron
  $roundResult.postgres = $identities.postgres
  $roundResult.server = $identities.server
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
  $crossRuntimeIdentityPassed = $true
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
    $uninstallProcessExitedOk = $false
    if (Test-Path -LiteralPath $uninstaller) {
      # Copy once outside the install tree; invoke with /S _?=<dir> ( _? last, path unquoted ).
      # Do not wait on the in-place uninstaller stub — it exits after spawning a temp copy.
      New-Item -ItemType Directory -Path $uninstallCopyDir | Out-Null
      $uninstallCopy = Join-Path $uninstallCopyDir 'Uninstall OpenBot.exe'
      Copy-Item -LiteralPath $uninstaller -Destination $uninstallCopy -Force
      $process = Start-Process -FilePath $uninstallCopy -ArgumentList "/S _?=$target" -PassThru
      try {
        $null = $process.Handle
        if (!$process.WaitForExit(60000)) {
          try {
            $process.Kill($true)
            if (!$process.WaitForExit(15000)) { $script:cleanupVerified = $false }
          } catch { $script:cleanupVerified = $false }
          throw 'NSIS uninstall timed out.'
        }
        if ($process.ExitCode -ne 0) { throw "NSIS uninstall failed (exit=$($process.ExitCode))." }
        $uninstallProcessExitedOk = $true
      } finally {
        if ($null -ne $process) { $process.Dispose() }
      }
    } elseif (-not (Test-Path -LiteralPath (Join-Path $target 'openbot.exe'))) {
      # Install never produced openbot.exe (or already gone) — no silent-uninstall wait needed.
      $uninstallProcessExitedOk = $true
    } else {
      throw 'NSIS uninstaller missing while openbot.exe is still present under the install directory.'
    }
    # Only after the held uninstall process completed: wait for openbot.exe to vanish.
    if ($uninstallProcessExitedOk) {
      $deadline = [DateTime]::UtcNow.AddSeconds(30)
      while ((Test-Path -LiteralPath (Join-Path $target 'openbot.exe')) -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 250
      }
      if (Test-Path -LiteralPath (Join-Path $target 'openbot.exe')) {
        throw 'Uninstall left the executable installed.'
      }
      $uninstalled = $true
    }
    if ($uninstalled) {
      Remove-FixtureTreeResilient -Path $target
      Remove-FixtureTreeResilient -Path $harness
      Remove-FixtureTreeResilient -Path $uninstallCopyDir
      foreach ($file in @($receipt, $stdout, $stderr)) {
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
      }
      $fixtureRemoved = $true
    } else {
      # Best-effort remove of the outside uninstall copy even when uninstall did not pass.
      if (Test-Path -LiteralPath $uninstallCopyDir) {
        try { Remove-FixtureTreeResilient -Path $uninstallCopyDir } catch { }
      }
    }
  } finally {
    if ($null -ne $script:currentRoundElectron) { $script:currentRoundElectron.Process.Dispose() }
    # This allowlist is the only uploaded evidence. No raw logs, profile, or fixture secrets.
    $summary = [ordered]@{
      schemaVersion = 1
      sourceCommit = $env:GITHUB_SHA
      platform = 'win32'
      arch = 'x64'
      passed = ($passed -and $uninstalled -and $script:cleanupVerified -and $fixtureRemoved -and $ownershipTestsPassed -and $crossRuntimeIdentityPassed)
      lastStage = $stage
      uninstallPassed = $uninstalled
      fixtureRemoved = $fixtureRemoved
      cleanupVerified = $script:cleanupVerified
      processIdentityNegativeTestsPassed = $ownershipTestsPassed
      crossRuntimeIdentityPassed = $crossRuntimeIdentityPassed
      coldStartsCompleted = [Math]::Max(0, $script:roundEvidence.Count - 1)
      rounds = @($script:roundEvidence)
    }
    $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'summary.json') -Encoding utf8
    Write-Host "Safe Windows lifecycle evidence: $EvidenceDirectory"
  }
}
Write-Host 'Windows per-user NSIS install, installed native runtime cold-start (10 Electron lifetimes) and uninstall checks passed.'
