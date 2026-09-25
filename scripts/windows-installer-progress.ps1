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
  # NSIS writes its archive into $PLUGINSDIR and extracts it there before copying anything to
  # the installation directory, so destination file growth cannot observe that earlier work.
  # Accumulated processor time on the held process can observe work during this phase.
  # A 250 ms floor keeps ordinary timer wakeups from counting as progress, and it never suspends
  # the independent MaximumDurationMs ceiling.
  $cpuProgressThresholdSeconds = 0.25
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $lastProgressMs = 0L
  $lastCpuSeconds = $null
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
    # A failed sample leaves the previous baseline untouched; it must never invent activity.
    $cpuTotalSeconds = $null
    try { $cpuTotalSeconds = $Process.TotalProcessorTime.TotalSeconds } catch {}
    $fileProgress = ($files -gt $maximumFiles -or $bytes -gt $maximumBytes)
    $cpuProgress = $false
    if ($null -ne $cpuTotalSeconds) {
      if ($null -eq $lastCpuSeconds) {
        # The first sample only establishes the baseline for later deltas.
        $lastCpuSeconds = $cpuTotalSeconds
      } elseif (($cpuTotalSeconds - $lastCpuSeconds) -ge $cpuProgressThresholdSeconds) {
        $cpuProgress = $true
      }
    }
    if ($fileProgress -or $cpuProgress) {
      $lastProgressMs = $elapsedMs
      $maximumFiles = [Math]::Max($files, $maximumFiles)
      $maximumBytes = [Math]::Max($bytes, $maximumBytes)
      # Rebase the CPU baseline so already-counted work is not counted twice.
      if ($null -ne $cpuTotalSeconds) { $lastCpuSeconds = $cpuTotalSeconds }
    }
    $outcome = if ($exited) { 'completed' }
      elseif ($elapsedMs -ge $MaximumDurationMs) { 'duration-limit' }
      elseif (($elapsedMs - $lastProgressMs) -ge $IdleTimeoutMs) { 'stalled' }
      else { 'running' }
    $cpuSeconds = if ($null -ne $cpuTotalSeconds) { [Math]::Round($cpuTotalSeconds, 2) } else { $null }
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
