# Independent Windows receipt↔orchestrator identity conformance checks.
# Exercises the same helpers as the install gate (dot-sourced, not duplicated).
# - On every host: STJ-primary ISO round-trip, mismatch rejects, and real child startup/exit.
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
  $firstDir = Join-Path $tmpRoot 'first node'
  $secondDir = Join-Path $tmpRoot 'second node'
  $oldPath = $env:PATH
  $sep = [IO.Path]::PathSeparator
  try {
    New-Item -ItemType Directory -Path $firstDir | Out-Null
    New-Item -ItemType Directory -Path $secondDir | Out-Null

    $realNode = Get-NodeApplicationPath
    $stubName = if ([OperatingSystem]::IsWindows()) { 'node.exe' } else { 'node' }
    $firstStub = Join-Path $firstDir $stubName
    $secondStub = Join-Path $secondDir $stubName
    if ([OperatingSystem]::IsWindows()) {
      Copy-Item -LiteralPath $realNode -Destination $firstStub
      Copy-Item -LiteralPath $realNode -Destination $secondStub
    } else {
      # Unix supports unprivileged links; Windows uses copies without symlink privileges.
      $null = New-Item -ItemType SymbolicLink -Path $firstStub -Target $realNode
      $null = New-Item -ItemType SymbolicLink -Path $secondStub -Target $realNode
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
    $verInfo.RedirectStandardInput = $true
    $verInfo.RedirectStandardOutput = $true
    $verInfo.RedirectStandardError = $true
    $verInfo.ArgumentList.Add('--version')
    $verProc = [Diagnostics.Process]::Start($verInfo)
    try {
      $null = $verProc.Handle
      $verProc.StandardInput.Close()
      $outputTask = $verProc.StandardOutput.ReadToEndAsync()
      $errorTask = $verProc.StandardError.ReadToEndAsync()
      if (-not $verProc.WaitForExit(10000)) { throw 'node --version exceeded 10 seconds.' }
      if (!$outputTask.Wait(2000) -or !$errorTask.Wait(2000)) { throw 'Node version streams did not close.' }
      $stdout = $outputTask.Result
      Write-CheckResult -Name 'Dual-node PATH: ProcessStartInfo.FileName from helper launches node' -Passed (
        $verProc.ExitCode -eq 0 -and $stdout -match 'v?\d+\.\d+'
      ) -Detail ("exit=$($verProc.ExitCode); out=$($stdout.Trim())")
    } finally {
      if ($null -ne $verProc) {
        try {
          if (-not $verProc.HasExited) { $verProc.Kill($true) }
          if (-not $verProc.WaitForExit(5000)) { throw 'Node version observer cleanup failed.' }
        } finally { $verProc.Dispose() }
      }
    }
  } catch {
    Write-CheckResult -Name 'Dual-node PATH regression' -Passed $false -Detail ([string]$_.Exception.Message)
  } finally {
    $env:PATH = $oldPath
    if (Test-Path -LiteralPath $tmpRoot) {
      Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction Stop
    }
  }
}

function Test-StartedProcessIdentityLifecycle {
  $nodePath = Get-NodeApplicationPath
  for ($round = 1; $round -le 10; $round++) {
    $child = $null
    try {
      $info = [Diagnostics.ProcessStartInfo]::new()
      $info.FileName = $nodePath
      $info.UseShellExecute = $false
      $info.CreateNoWindow = $true
      $info.RedirectStandardInput = $true
      $info.RedirectStandardOutput = $true
      $info.RedirectStandardError = $true
      $info.ArgumentList.Add('-e')
      $info.ArgumentList.Add('process.stdout.write(JSON.stringify({pid:process.pid,executablePath:process.execPath})+"\n");process.stdin.once("data",()=>process.exit(0));process.stdin.resume();')
      $child = [Diagnostics.Process]::Start($info)
      # Observe immediately, before waiting for the child's startup handshake.
      $identity = Get-CanonicalProcessIdentity -ProcessId $child.Id -HeldProcess $child
      $originalHandle = $child.Handle
      $lineTask = $child.StandardOutput.ReadLineAsync()
      $errorTask = $child.StandardError.ReadToEndAsync()
      if (!$lineTask.Wait(5000) -or $null -eq $lineTask.Result -or $lineTask.Result.Length -gt 4096) {
        throw 'Startup identity child did not return a bounded handshake.'
      }
      $reported = $lineTask.Result | ConvertFrom-Json
      Write-CheckResult -Name "Startup $round/10: held identity matches real child PID and executable" -Passed (
        $identity.pid -eq $reported.pid -and
        -not [string]::IsNullOrWhiteSpace($identity.executablePath) -and
        $identity.executablePath -ieq $reported.executablePath -and
        $identity.startTimeUtc -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$'
      ) -Detail ("held={$(Format-ProcessIdentityEvidence $identity)}; child={pid=$($reported.pid); executablePath=$($reported.executablePath)}")
      $child.Refresh()
      $refreshed = Get-CanonicalProcessIdentity -ProcessId $child.Id -HeldProcess $child
      Write-CheckResult -Name "Startup $round/10: refresh retains handle and complete identity" -Passed (
        $child.Handle -eq $originalHandle -and
        (Test-ReceiptIdentityEqualsSpawn -ReceiptIdentity $refreshed -SpawnIdentity $identity)
      ) -Detail ("before={$(Format-ProcessIdentityEvidence $identity)}; after={$(Format-ProcessIdentityEvidence $refreshed)}; handleBefore=$originalHandle; handleAfter=$($child.Handle)")

      $child.StandardInput.WriteLine('exit')
      $child.StandardInput.Close()
      if (!$child.WaitForExit(5000)) { throw 'Startup identity child did not exit on request.' }
      if (!$errorTask.Wait(2000) -or $errorTask.Result.Length -gt 4096 -or $child.ExitCode -ne 0) {
        throw 'Startup identity child exited unsuccessfully or left its error stream open.'
      }
      $exitRejection = ''
      try {
        $null = Get-CanonicalProcessIdentity -ProcessId $child.Id -HeldProcess $child
      } catch {
        $exitRejection = $_.Exception.Message
      }
      Write-CheckResult -Name "Startup $round/10: exited held process cannot produce an identity" -Passed (
        $exitRejection -match 'exited before identity could be observed'
      )
    } catch {
      Write-CheckResult -Name "Real process startup/exit $round/10" -Passed $false -Detail $_.Exception.Message
    } finally {
      if ($null -ne $child) {
        try {
          if (!$child.HasExited) { $child.Kill($true) }
          if (!$child.WaitForExit(5000)) { throw 'Startup identity child cleanup could not be verified.' }
        } finally { $child.Dispose() }
      }
    }
  }
}

function Test-WindowsProcessImageBindingGuards {
  # Compile the actual shared binding on every host; invalid handles must never enter Win32.
  Initialize-WindowsProcessImageQuery
  $invalid = [Microsoft.Win32.SafeHandles.SafeProcessHandle]::new([IntPtr]::Zero, $false)
  $self = [Diagnostics.Process]::GetCurrentProcess()
  # Close only a non-owning wrapper around our real handle, not the live process's handle.
  $closed = [Microsoft.Win32.SafeHandles.SafeProcessHandle]::new($self.Handle, $false)
  $closed.Dispose()
  try {
    foreach ($state in @('invalid', 'closed')) {
      $handle = if ($state -eq 'closed') { $closed } else { $invalid }
      $message = ''
      try { $null = [OpenBot.WindowsProcessImage]::Read($handle) } catch { $message = $_.Exception.Message }
      Write-CheckResult -Name "Image query rejects $state handles before calling Win32" -Passed (
        $message -match 'A valid open process handle is required'
      )
    }
  } finally {
    $invalid.Dispose()
    $closed.Dispose()
    $self.Dispose()
  }
  if (-not [OperatingSystem]::IsWindows()) {
    Write-Host 'SKIP: successful Windows image API invocation (non-Windows host); only binding compilation/guards checked.'
  }
}

Write-Host "OpenBot Windows receipt identity checks (pwsh $($PSVersionTable.PSVersion); framework=$([Runtime.InteropServices.RuntimeInformation]::FrameworkDescription); OS=$([System.Runtime.InteropServices.RuntimeInformation]::OSDescription))"
Test-StjPrimaryIdentityRoundTrip
Test-DualNodePathResolution
Test-WindowsProcessImageBindingGuards
Test-StartedProcessIdentityLifecycle

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
