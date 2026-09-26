# Copyright (c) Peerframe/openbot contributors.
# SPDX-License-Identifier: MIT
#
# Windows remote-only Desktop acceptance gate.
# Derived from the MIT-licensed Peerframe/openbot Windows native smoke gate at
# commit 1dacf4e814bba0947ea0ce54e5c3db45bb21b1b3. Copyright and license notices
# of the original source are retained.
#
# The local TypeScript business Server, PostgreSQL lifecycle, migrations and the
# ten-repeat database cold-start loop have been retired. This gate now:
#   1. installs the per-user NSIS package silently into an owned temp directory,
#   2. re-installs it in place to cover the per-user upgrade path,
#   3. asserts the installed executable, resources/app.asar and the absence of
#      resources/native-runtime against the reviewed package,
#   4. launches the pinned Electron remote smoke harness twice (first lifetime on
#      a fresh isolated profile, restart lifetime reusing that same profile) to
#      exercise system safeStorage encrypt/decrypt over one synthetic string,
#   5. verifies a safe receipt and writes an allowlisted evidence summary,
#   6. uninstalls and removes only the owned temporary directories.
#
# Safety helpers retained from the old gate: identity-verified process cleanup
# (never a PID-only kill), owned temporary directories only, resilient fixture
# removal, and bounded installer/smoke/uninstall timeouts. The harness and gate
# never touch an existing OpenBot profile.

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
if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  throw 'RUNNER_TEMP is required for owned temporary directories.'
}

if (!$EvidenceDirectory) {
  $EvidenceDirectory = Join-Path $env:RUNNER_TEMP ('OpenBotWindowsRemoteEvidence-' + [Guid]::NewGuid().ToString('N'))
}
if (Test-Path -LiteralPath $EvidenceDirectory) { throw 'Evidence destination must be fresh.' }
New-Item -ItemType Directory -Path $EvidenceDirectory | Out-Null

$script:installerEvidence = @()
$script:cleanupVerified = $true
$stage = 'install'
$passed = $false
$uninstalled = $false
$fixtureRemoved = $false
$ownershipTestsPassed = $false
$upgradeVerified = $false
$nativeRuntimeAbsent = $false
$ciphertextStable = $false
$stateFileStable = $false
$firstEvidence = $null
$restartEvidence = $null
$failureSummary = $null

# Owned temporary destinations only. The smoke harness requires the fixture root
# to be fresh on the first lifetime, so the gate must not create it.
$target = Join-Path $env:RUNNER_TEMP ('OpenBotWindowsRemoteInstall-' + [Guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $target) { throw 'Test installation destination already exists.' }
$harness = Join-Path $env:RUNNER_TEMP ('OpenBotWindowsRemoteProfile-' + [Guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $harness) { throw 'Remote smoke fixture destination already exists.' }
# Outside $target: NSIS silent uninstall must run from a copy with _?= so WaitForExit sees the real work
# (https://nsis.sourceforge.io/When_I_use_ExecWait_uninstaller.exe_it_doesn%27t_wait_for_the_uninstaller%3F).
$uninstallCopyDir = Join-Path $env:RUNNER_TEMP ('OpenBotWindowsRemoteUninstallCopy-' + [Guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $uninstallCopyDir) { throw 'Uninstall copy destination already exists.' }

$firstReceipt = "$harness.first.result.json"
$restartReceipt = "$harness.restart.result.json"
$stdout = "$harness.stdout.log"
$stderr = "$harness.stderr.log"
$liveProcessesPath = Join-Path $harness 'harness-live-processes.json'
$statePath = Join-Path $harness 'remote-desktop-state.json'
$remoteFirstChecks = 'safe-storage-available,encrypt,decrypt,state-persisted,no-plaintext-secret'
$remoteRestartChecks = 'safe-storage-available,decrypt-after-restart,ciphertext-stable,no-plaintext-secret'
$smokeTimeoutMs = 90000
# This-round Electron identity from the held Start-Process handle (not JSON alone).
$script:currentRoundElectron = $null

function Write-SafeSummary([string]$Message) {
  Write-Host $Message
  $script:failureSummary = $Message
}

# --- Identity helpers (failure-closed, no PID-only kills) -------------------

. (Join-Path $PSScriptRoot 'windows-receipt-identity-helpers.ps1')
. (Join-Path $PSScriptRoot 'windows-installer-progress.ps1')

function Assert-NewProcessIdentity {
  param([AllowNull()]$Previous, [Parameter(Mandatory = $true)]$Current)
  $currentRecord = ConvertTo-ProcessIdentityRecord $Current
  if ($null -eq $currentRecord) { throw 'Current process identity is missing.' }
  if ($null -eq $Previous) { return }
  $previousRecord = ConvertTo-ProcessIdentityRecord $Previous
  if ($null -eq $previousRecord) { throw 'Previous process identity is invalid.' }
  if ([int]$previousRecord.pid -ne [int]$currentRecord.pid) { return }
  if ($previousRecord.startTimeUtc -ne $currentRecord.startTimeUtc) { return }
  if ($previousRecord.executablePath -ine $currentRecord.executablePath) { return }
  throw "The restart lifetime reused the first lifetime process identity (pid=$($currentRecord.pid))."
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
    $identity = $source.electron
    if ($null -eq $identity) { continue }
    Stop-VerifiedHarnessIdentity -Recorded $identity -Label 'electron'
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

# --- Installer progress (retained from the old per-user NSIS gate) ----------

function Assert-InstalledRemoteLayout {
  param(
    [Parameter(Mandatory = $true)][string]$InstallDirectory,
    [Parameter(Mandatory = $true)][string]$Packaged
  )
  $installedExe = Join-Path $InstallDirectory 'openbot.exe'
  if (!(Test-Path -LiteralPath $installedExe -PathType Leaf)) { throw 'Installed executable missing.' }
  $installedAsar = Join-Path $InstallDirectory 'resources/app.asar'
  if (!(Test-Path -LiteralPath $installedAsar -PathType Leaf)) { throw 'Installed packaged ASAR is missing.' }
  $packagedAsar = Join-Path $Packaged 'resources/app.asar'
  if (!(Test-Path -LiteralPath $packagedAsar -PathType Leaf)) { throw 'Reviewed package ASAR is missing.' }
  if ((Get-FileHash -LiteralPath $installedAsar -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $packagedAsar -Algorithm SHA256).Hash) {
    throw 'Installed application differs from the reviewed package.'
  }
  if ((Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $Packaged 'openbot.exe') -Algorithm SHA256).Hash) {
    throw 'Installed executable differs from the reviewed package.'
  }
  # The remote-only Desktop must not ship the retired local native runtime.
  $installedRuntime = Join-Path $InstallDirectory 'resources/native-runtime'
  if (Test-Path -LiteralPath $installedRuntime) { throw 'Remote-only Desktop must not install resources/native-runtime.' }
  $packagedRuntime = Join-Path $Packaged 'resources/native-runtime'
  if (Test-Path -LiteralPath $packagedRuntime) { throw 'Reviewed package still ships resources/native-runtime.' }
}

function Assert-SafeRemoteReceipt {
  param(
    [Parameter(Mandatory = $true)]$Round,
    [Parameter(Mandatory = $true)][string]$ExpectedMode,
    [Parameter(Mandatory = $true)][string]$ExpectedChecks
  )
  if ($Round.schemaVersion -ne 1 -or $Round.platform -ne 'win32' -or $Round.arch -ne 'x64') {
    throw 'Remote smoke receipt platform fields are incomplete.'
  }
  if ($Round.mode -ne $ExpectedMode) { throw 'Remote smoke receipt mode mismatch.' }
  if ($Round.ciphertextDigest -notmatch '^[0-9a-f]{64}$') {
    throw 'Remote smoke receipt ciphertextDigest must be a sha256 hex digest (no raw ciphertext).'
  }
  $identity = ConvertTo-ProcessIdentityRecord $Round.electron
  if ($null -eq $identity -or [long]$identity.pid -le 0 -or [long]$identity.pid -gt 2147483647 -or
      [string]::IsNullOrWhiteSpace([string]$identity.startTimeUtc) -or
      [string]::IsNullOrWhiteSpace([string]$identity.executablePath)) {
    throw 'Remote smoke receipt missing verified Electron process identity fields.'
  }
  if (($Round.checks -join ',') -ne $ExpectedChecks) {
    throw "Remote smoke receipt checks mismatch: $($Round.checks -join ',')"
  }
  # Refuse secrets in the receipt surface we persist/print.
  $raw = $Round | ConvertTo-Json -Depth 6 -Compress
  if ($raw -match '"ciphertext"\s*:' -or $raw -match '"password"\s*:' -or $raw -match '"plaintext"\s*:' -or $raw -match '"secret"\s*:') {
    throw 'Remote smoke receipt unexpectedly contains secret material.'
  }
}

function ConvertTo-SafeRoundEvidence($Round) {
  $identity = ConvertTo-ProcessIdentityRecord $Round.electron
  return [ordered]@{
    mode = [string]$Round.mode
    ciphertextDigest = [string]$Round.ciphertextDigest
    checks = @($Round.checks)
    electron = [ordered]@{
      pid = [int]$identity.pid
      startTimeUtc = [string]$identity.startTimeUtc
      executablePath = [string]$identity.executablePath
    }
  }
}

function Invoke-RemoteSmoke {
  param([string]$Mode, [string]$RoundReceipt, [int]$TimeoutMs)
  if (Test-Path -LiteralPath $RoundReceipt) { throw "Smoke result path must be fresh: $RoundReceipt" }
  foreach ($log in @($stdout, $stderr)) {
    if (Test-Path -LiteralPath $log) { Remove-Item -LiteralPath $log -Force }
  }
  if (Test-Path -LiteralPath $liveProcessesPath) { Remove-Item -LiteralPath $liveProcessesPath -Force }
  $script:currentRoundElectron = $null
  # Simplified harness contract: <fixtureRoot> <resultPath> <first|restart>.
  $arguments = "`"$SmokeScript`" `"$harness`" `"$RoundReceipt`" $Mode"
  $smoke = Start-Process -FilePath $Electron -ArgumentList $arguments -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  # Keep the Start-Process object even if querying its identity fails.
  $script:currentRoundElectron = [pscustomobject]@{ Process = $smoke; Identity = $null }
  $null = $smoke.Handle
  # Observe with the same .NET fields the smoke harness uses (not Start-Process .Path).
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
    throw "Remote smoke mode=$Mode exceeded $($TimeoutMs / 1000) seconds."
  }
  $smoke.WaitForExit()
  if ($smoke.ExitCode -ne 0 -or !(Test-Path -LiteralPath $RoundReceipt)) {
    Stop-RecordedHarnessProcesses
    foreach ($log in @($stdout, $stderr)) {
      if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 40 | Write-Host }
    }
    throw "Remote smoke mode=$Mode did not complete its assertions (exit=$($smoke.ExitCode))."
  }
  $receiptRaw = Get-Content -LiteralPath $RoundReceipt -Raw
  # Other scalars may still come from ConvertFrom-Json; identity fields must be STJ strings.
  $roundResult = $receiptRaw | ConvertFrom-Json
  $identities = Read-SmokeRoundIdentities $receiptRaw
  $receiptElectron = $identities.electron
  if (!(Test-ReceiptIdentityEqualsSpawn -ReceiptIdentity $receiptElectron -SpawnIdentity $spawnIdentity)) {
    $heldEvidence = Format-ProcessIdentityEvidence -Identity $spawnIdentity -Label 'held'
    $receiptEvidence = Format-ProcessIdentityEvidence -Identity $receiptElectron -Label 'receipt'
    throw "Remote smoke receipt does not match the Electron process held by the orchestrator. $heldEvidence $receiptEvidence"
  }
  # Overlay the STJ-preserved identity record onto the round object.
  $roundResult.electron = $identities.electron
  $smoke.Dispose()
  $script:currentRoundElectron = $null
  return $roundResult
}

function Invoke-OwnedInstaller {
  param([string]$Label)
  # NSIS /D is deliberately last and unquoted, per its documented command-line contract.
  $script:installerStageLabel = $Label
  $process = Start-Process -FilePath $Installer -ArgumentList "/S /D=$target" -PassThru
  try {
    $installation = Wait-WindowsInstaller -Process $process -InstallationDirectory $target -OnProgress {
      param($Snapshot)
      $script:installerEvidence += [pscustomobject]@{ stage = $script:installerStageLabel; snapshot = $Snapshot }
      Write-Host ("NSIS $($script:installerStageLabel) progress: " + ($Snapshot | ConvertTo-Json -Compress))
    }
    if ($installation.outcome -ne 'completed') {
      throw "NSIS $Label stopped: $($installation.outcome) after $($installation.elapsedMs) ms."
    }
    if ($process.ExitCode -ne 0) { throw "NSIS $Label failed." }
  } finally {
    try {
      if (!$process.HasExited) {
        $process.Kill($true)
        if (!$process.WaitForExit(15000)) { $script:cleanupVerified = $false }
      }
    } catch { $script:cleanupVerified = $false }
    $process.Dispose()
  }
}

try {
  $stage = 'process-identity-negative-checks'
  Test-HarnessProcessOwnership
  $ownershipTestsPassed = $true

  $stage = 'install'
  Invoke-OwnedInstaller -Label 'install'
  Assert-InstalledRemoteLayout -InstallDirectory $target -Packaged $PackagedDirectory
  $nativeRuntimeAbsent = $true

  $stage = 'upgrade'
  Invoke-OwnedInstaller -Label 'upgrade'
  Assert-InstalledRemoteLayout -InstallDirectory $target -Packaged $PackagedDirectory
  $upgradeVerified = $true
  Write-Host 'PASS: per-user NSIS install and in-place upgrade preserved the reviewed remote-only layout.'

  $stage = 'remote-first'
  $first = Invoke-RemoteSmoke -Mode 'first' -RoundReceipt $firstReceipt -TimeoutMs $smokeTimeoutMs
  Assert-SafeRemoteReceipt -Round $first -ExpectedMode 'first' -ExpectedChecks $remoteFirstChecks
  if (!(Test-Path -LiteralPath $statePath -PathType Leaf)) { throw 'First lifetime did not persist remote smoke state.' }
  $firstStateHash = (Get-FileHash -LiteralPath $statePath -Algorithm SHA256).Hash
  $firstEvidence = ConvertTo-SafeRoundEvidence $first
  Write-Host "PASS: remote safeStorage first lifetime verified ($remoteFirstChecks)."

  $stage = 'remote-restart'
  $restart = Invoke-RemoteSmoke -Mode 'restart' -RoundReceipt $restartReceipt -TimeoutMs $smokeTimeoutMs
  Assert-SafeRemoteReceipt -Round $restart -ExpectedMode 'restart' -ExpectedChecks $remoteRestartChecks
  if ($restart.ciphertextDigest -ne $first.ciphertextDigest) {
    throw 'safeStorage ciphertext digest changed across the two Electron lifetimes.'
  }
  if ((Get-FileHash -LiteralPath $statePath -Algorithm SHA256).Hash -ne $firstStateHash) {
    throw 'Remote smoke state changed across the Electron restart.'
  }
  Assert-NewProcessIdentity -Previous (ConvertTo-ProcessIdentityRecord $first.electron) -Current (ConvertTo-ProcessIdentityRecord $restart.electron)
  $ciphertextStable = $true
  $stateFileStable = $true
  $restartEvidence = ConvertTo-SafeRoundEvidence $restart
  Write-Host "PASS: remote safeStorage restart lifetime verified ($remoteRestartChecks)."
  $passed = $true
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
    $process = $null
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
      if (Test-Path -LiteralPath $harness) { Remove-FixtureTreeResilient -Path $harness }
      if (Test-Path -LiteralPath $uninstallCopyDir) { Remove-FixtureTreeResilient -Path $uninstallCopyDir }
      foreach ($file in @($firstReceipt, $restartReceipt, $stdout, $stderr)) {
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
      }
      $fixtureRemoved = (-not (Test-Path -LiteralPath $target)) -and
        (-not (Test-Path -LiteralPath $harness)) -and
        (-not (Test-Path -LiteralPath $uninstallCopyDir))
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
      schemaVersion = 2
      sourceCommit = $env:GITHUB_SHA
      platform = 'win32'
      arch = 'x64'
      passed = ($passed -and $uninstalled -and $script:cleanupVerified -and $fixtureRemoved -and $ownershipTestsPassed -and $upgradeVerified -and $nativeRuntimeAbsent)
      lastStage = $stage
      uninstallPassed = $uninstalled
      fixtureRemoved = $fixtureRemoved
      cleanupVerified = $script:cleanupVerified
      processIdentityNegativeTestsPassed = $ownershipTestsPassed
      upgradeVerified = $upgradeVerified
      nativeRuntimeAbsent = $nativeRuntimeAbsent
      ciphertextStableAcrossLifetimes = $ciphertextStable
      stateFileStableAcrossLifetimes = $stateFileStable
      remoteFirstReceipt = $firstEvidence
      remoteRestartReceipt = $restartEvidence
      installer = @($script:installerEvidence)
    }
    $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'summary.json') -Encoding utf8
    Write-Host "Safe Windows remote Desktop lifecycle evidence: $EvidenceDirectory"
  }
}
Write-Host 'Windows per-user NSIS install/upgrade, remote-only packaged ASAR (no native-runtime) and two-lifetime safeStorage restart checks passed.'
