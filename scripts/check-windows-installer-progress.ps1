$ErrorActionPreference = 'Stop'
if (![OperatingSystem]::IsWindows()) { throw 'This check requires native Windows.' }
. (Join-Path $PSScriptRoot 'windows-installer-progress.ps1')
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('openbot-installer-progress-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
try {
  # 'cpu', 'cpu-stall' and 'cpu-bounded' hold the destination empty so only processor time can
  # prove work. They keep the 120 s production gap covered without scanning any temp directory.
  foreach ($mode in @('progress', 'stalled', 'bounded', 'nonzero', 'cpu', 'cpu-stall', 'cpu-bounded')) {
    $directory = Join-Path $fixtureRoot $mode
    New-Item -ItemType Directory -Path $directory | Out-Null
    $scriptFile = Join-Path $fixtureRoot "$mode.ps1"
    $commands = switch ($mode) {
      'progress' { '$directory = $args[0]; 1..12 | ForEach-Object { Add-Content -LiteralPath (Join-Path $directory "progress.txt") -Value "fixture"; Start-Sleep -Milliseconds 250 }' }
      'bounded' { '$directory = $args[0]; while ($true) { Add-Content -LiteralPath (Join-Path $directory "progress.txt") -Value "fixture"; Start-Sleep -Milliseconds 100 }' }
      'cpu' { '$directory = $args[0]; $clock = [System.Diagnostics.Stopwatch]::StartNew(); while ($clock.ElapsedMilliseconds -lt 4000) { $spin = 1 }' }
      'cpu-stall' { '$directory = $args[0]; $clock = [System.Diagnostics.Stopwatch]::StartNew(); while ($clock.ElapsedMilliseconds -lt 1500) { $spin = 1 }; Start-Sleep -Seconds 30' }
      'cpu-bounded' { '$directory = $args[0]; while ($true) { $spin = 1 }' }
      'nonzero' { 'exit 7' }
      default { 'Start-Sleep -Seconds 30' }
    }
    Set-Content -LiteralPath $scriptFile -Value ('$ErrorActionPreference = "Stop"; ' + $commands) -Encoding utf8
    $process = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList "-NoProfile -NonInteractive -File `"$scriptFile`" `"$directory`"" -PassThru
    try {
      $maximumMs = switch ($mode) {
        'bounded' { 2000 }
        'cpu-bounded' { 3000 }
        default { 10000 }
      }
      $result = Wait-WindowsInstaller -Process $process -InstallationDirectory $directory -IdleTimeoutMs 2500 -MaximumDurationMs $maximumMs -PollIntervalMs 100
      $expected = switch ($mode) {
        'stalled' { 'stalled' }
        'cpu-stall' { 'stalled' }
        'bounded' { 'duration-limit' }
        'cpu-bounded' { 'duration-limit' }
        default { 'completed' }
      }
      if ($result.outcome -ne $expected) { throw "$mode returned $($result.outcome), expected $expected." }
      if ($mode -eq 'progress' -and ($result.bytes -le 0 -or $result.elapsedMs -le 2500)) {
        throw 'The fixture did not prove progress beyond the idle deadline.'
      }
      # The completed process may no longer expose processor time, so the proof for this mode is
      # that it outlived the idle deadline with zero destination bytes.
      if ($mode -eq 'cpu' -and ($result.bytes -ne 0 -or $result.elapsedMs -le 3000)) {
        throw 'The fixture did not prove CPU work without destination writes beyond the idle deadline.'
      }
      if ($mode -eq 'cpu-stall' -and ($result.cpuSeconds -le 0 -or $result.elapsedMs -le 3000)) {
        throw 'The fixture did not prove CPU work before the stall.'
      }
      if ($mode -eq 'cpu-bounded' -and ($result.cpuSeconds -le 0 -or $result.elapsedMs -lt $maximumMs)) {
        throw 'The endless CPU fixture did not reach the absolute ceiling.'
      }
      if ($mode -eq 'nonzero' -and $process.ExitCode -ne 7) { throw 'Nonzero exit status was lost.' }
      Write-Host "PASS: installer observer $mode ($($result.outcome))."
    } finally {
      try {
        if (!$process.HasExited) { $process.Kill($true) }
        if (!$process.WaitForExit(15000)) { throw 'Fixture process did not exit.' }
      } finally { $process.Dispose() }
    }
  }
  # Reproduce the actual filesystem race after Test-Path succeeds, without mocking enumeration.
  $raceDirectory = Join-Path $fixtureRoot 'removed-after-exists'
  New-Item -ItemType Directory -Path $raceDirectory | Out-Null
  Set-Content -LiteralPath (Join-Path $raceDirectory 'archive.txt') -Value 'fixture'
  function Test-Path {
    [CmdletBinding()]
    param([string]$LiteralPath)
    $exists = Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath
    if ($exists -and $LiteralPath -eq $raceDirectory) {
      Remove-Item -LiteralPath $LiteralPath -Recurse -Force
    }
    return $exists
  }
  $raceScript = Join-Path $fixtureRoot 'removed-after-exists.ps1'
  Set-Content -LiteralPath $raceScript -Value 'Start-Sleep -Seconds 30'
  $process = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList "-NoProfile -NonInteractive -File `"$raceScript`"" -PassThru
  try {
    $result = Wait-WindowsInstaller -Process $process -InstallationDirectory $raceDirectory -IdleTimeoutMs 2500 -MaximumDurationMs 10000 -PollIntervalMs 100
    if ($result.outcome -ne 'stalled' -or $result.files -ne 0 -or $result.bytes -ne 0) {
      throw 'A real disappearing directory invented progress or lost the idle ceiling.'
    }
    Write-Host 'PASS: real directory deletion after existence check keeps the installer bounded.'
  } finally {
    Remove-Item Function:\Test-Path
    try {
      if (!$process.HasExited) { $process.Kill($true) }
      if (!$process.WaitForExit(15000)) { throw 'Filesystem-race fixture process did not exit.' }
    } finally { $process.Dispose() }
  }

  # Make the provider fail after emitting a partial sample, exactly at the upgrade race.
  # Only disappeared paths are transient; permission and unrelated I/O errors stay failures.
  function Get-ChildItem {
    [CmdletBinding()]
    param([string]$LiteralPath, [switch]$Recurse, [switch]$File, [switch]$Force)
    [pscustomobject]@{ Length = 123456 }
    $failure = switch ($script:directoryScanFailure) {
      'missing-root' { [System.Management.Automation.ItemNotFoundException]::new('fixture root disappeared') }
      'missing-child' { [IO.DirectoryNotFoundException]::new('fixture child disappeared') }
      'missing-file' { [IO.FileNotFoundException]::new('fixture file disappeared') }
      'permission' { [UnauthorizedAccessException]::new('fixture access denied') }
      'io' { [IO.IOException]::new('fixture unrelated I/O failure') }
    }
    $PSCmdlet.WriteError([System.Management.Automation.ErrorRecord]::new(
      $failure, 'FixtureDirectoryReadError', [System.Management.Automation.ErrorCategory]::ReadError, $LiteralPath))
  }
  try {
    foreach ($mode in @('missing-root', 'missing-child', 'missing-file', 'permission', 'io')) {
      $script:directoryScanFailure = $mode
      $directory = Join-Path $fixtureRoot $mode
      New-Item -ItemType Directory -Path $directory | Out-Null
      $scriptFile = Join-Path $fixtureRoot "$mode.ps1"
      Set-Content -LiteralPath $scriptFile -Value 'Start-Sleep -Seconds 30' -Encoding utf8
      $process = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList "-NoProfile -NonInteractive -File `"$scriptFile`"" -PassThru
      try {
        $snapshots = [Collections.Generic.List[object]]::new()
        $failure = $null
        try {
          $result = Wait-WindowsInstaller -Process $process -InstallationDirectory $directory -IdleTimeoutMs 2500 -MaximumDurationMs 10000 -PollIntervalMs 100 -OnProgress {
            param($Snapshot)
            $snapshots.Add($Snapshot)
          }
        } catch { $failure = $_ }
        if ($mode -in @('permission', 'io')) {
          if ($null -eq $failure -or $failure.Exception.Message -notlike 'fixture *') {
            throw "$mode directory errors must remain failures."
          }
        } else {
          if ($null -ne $failure) { throw $failure }
          if ($result.outcome -ne 'stalled' -or $result.elapsedMs -ge 10000) {
            throw "$mode invented progress or lost the idle ceiling."
          }
          if ($snapshots.Count -eq 0 -or @($snapshots | Where-Object { $_.files -ne 0 -or $_.bytes -ne 0 }).Count -ne 0) {
            throw "$mode retained an incomplete directory sample."
          }
        }
        Write-Host "PASS: installer observer $mode preserves the failure/progress boundary."
      } finally {
        try {
          if (!$process.HasExited) { $process.Kill($true) }
          if (!$process.WaitForExit(15000)) { throw 'Directory-race fixture process did not exit.' }
        } finally { $process.Dispose() }
      }
    }
  } finally {
    Remove-Item Function:\Get-ChildItem
  }
} finally {
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
