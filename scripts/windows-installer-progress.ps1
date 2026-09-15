function Wait-WindowsInstaller {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][string]$InstallationDirectory,
    [ValidateRange(1, 300000)][int]$IdleTimeoutMs = 120000,
    [ValidateRange(1, 600000)][int]$MaximumDurationMs = 300000,
    [ValidateRange(1, 15000)][int]$PollIntervalMs = 1000,
    [scriptblock]$OnProgress = {}
  )
  # The caller owns this launched process and fresh directory. A PID or an arbitrary
  # path supplied by a receipt must never be substituted here.
  $null = $Process.Handle
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $lastProgressMs = 0L
  $maximumFiles = 0L
  $maximumBytes = 0L
  $nextReportMs = 0L
  while ($true) {
    $exited = $Process.WaitForExit(0)
    $files = 0L
    $bytes = 0L
    if (Test-Path -LiteralPath $InstallationDirectory) {
      # Get-ChildItem does not follow directory symlinks without -FollowSymlink.
      foreach ($file in Get-ChildItem -LiteralPath $InstallationDirectory -Recurse -File -Force -ErrorAction Stop) {
        $files++
        $bytes += $file.Length
      }
    }
    $elapsedMs = $clock.ElapsedMilliseconds
    if ($files -gt $maximumFiles -or $bytes -gt $maximumBytes) {
      $lastProgressMs = $elapsedMs
      $maximumFiles = [Math]::Max($files, $maximumFiles)
      $maximumBytes = [Math]::Max($bytes, $maximumBytes)
    }
    $outcome = if ($exited) { 'completed' }
      elseif ($elapsedMs -ge $MaximumDurationMs) { 'duration-limit' }
      elseif (($elapsedMs - $lastProgressMs) -ge $IdleTimeoutMs) { 'stalled' }
      else { 'running' }
    $cpuSeconds = $null
    try { $cpuSeconds = [Math]::Round($Process.TotalProcessorTime.TotalSeconds, 2) } catch {}
    $snapshot = [pscustomobject]@{
      elapsedMs = $elapsedMs
      idleMs = $elapsedMs - $lastProgressMs
      files = $files
      bytes = $bytes
      cpuSeconds = $cpuSeconds
      outcome = $outcome
    }
    if ($elapsedMs -ge $nextReportMs -or $outcome -ne 'running') {
      $null = & $OnProgress $snapshot
      $nextReportMs = $elapsedMs + 15000
    }
    if ($outcome -ne 'running') { return $snapshot }
    $remainingMs = [Math]::Min($MaximumDurationMs - $elapsedMs, $IdleTimeoutMs - ($elapsedMs - $lastProgressMs))
    $null = $Process.WaitForExit([int][Math]::Min($PollIntervalMs, [Math]::Max(1, $remainingMs)))
  }
}
