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
} finally {
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
