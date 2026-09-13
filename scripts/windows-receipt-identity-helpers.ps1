# Shared Windows receipt↔orchestrator identity helpers.
# Dot-sourced by check-windows-desktop-install.ps1 and check-windows-receipt-identity.ps1.
# Primary identity JSON reads use System.Text.Json so original ISO-7 startTimeUtc is preserved.
# ConvertTo-IsoStartTimeUtc is only a fallback when a value is already DateTime.

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

function Read-ProcessIdentityFromJsonElement {
  param([System.Text.Json.JsonElement]$Element)
  if ($Element.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { return $null }
  $pidEl = New-Object System.Text.Json.JsonElement
  $startEl = New-Object System.Text.Json.JsonElement
  $pathEl = New-Object System.Text.Json.JsonElement
  if (-not $Element.TryGetProperty('pid', [ref]$pidEl)) { return $null }
  if (-not $Element.TryGetProperty('startTimeUtc', [ref]$startEl)) { return $null }
  if (-not $Element.TryGetProperty('executablePath', [ref]$pathEl)) { return $null }
  if ($pidEl.ValueKind -ne [System.Text.Json.JsonValueKind]::Number) { return $null }
  if ($startEl.ValueKind -ne [System.Text.Json.JsonValueKind]::String) { return $null }
  $startTimeUtc = $startEl.GetString()
  if ($startTimeUtc -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$') { return $null }
  if ($pathEl.ValueKind -ne [System.Text.Json.JsonValueKind]::String) { return $null }
  $executablePath = $pathEl.GetString()
  if ([string]::IsNullOrWhiteSpace($executablePath)) { return $null }
  $processId = $pidEl.GetInt32()
  if ($processId -le 0) { return $null }
  return [pscustomobject]@{
    pid = $processId
    startTimeUtc = $startTimeUtc
    executablePath = $executablePath
  }
}

function Read-SmokeRoundIdentities {
  param([Parameter(Mandatory = $true)][string]$JsonText)
  $doc = [System.Text.Json.JsonDocument]::Parse($JsonText)
  try {
    $root = $doc.RootElement
    $result = [ordered]@{}
    foreach ($name in @('electron', 'postgres', 'server')) {
      $prop = New-Object System.Text.Json.JsonElement
      if ($root.TryGetProperty($name, [ref]$prop)) {
        $result[$name] = Read-ProcessIdentityFromJsonElement $prop
      } else {
        $result[$name] = $null
      }
    }
    return [pscustomobject]$result
  } finally {
    $doc.Dispose()
  }
}

# Fallback when identity fields already sit on a PS object (may be DateTime from ConvertFrom-Json).
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

function Initialize-WindowsProcessImageQuery {
  if ('OpenBot.WindowsProcessImage' -as [type]) { return }
  Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace OpenBot {
  public static class WindowsProcessImage {
    private const int BufferCharacters = 32768;

    [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW",
      CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(
      SafeProcessHandle process, uint flags, [Out] StringBuilder image, ref uint size);

    public static string Read(SafeProcessHandle process) {
      if (process == null || process.IsClosed || process.IsInvalid) {
        throw new ArgumentException("A valid open process handle is required.", nameof(process));
      }
      if (!OperatingSystem.IsWindows()) {
        throw new PlatformNotSupportedException("Windows process image queries require Windows.");
      }
      var image = new StringBuilder(BufferCharacters, BufferCharacters);
      uint size = BufferCharacters;
      // SafeHandle marshaling retains the caller-owned handle only for this call.
      // Do not reopen by PID or dispose the borrowed handle.
      if (!QueryFullProcessImageName(process, 0, image, ref size)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot query the held process image.");
      }
      if (size == 0 || size >= BufferCharacters || image.Length != size) {
        throw new InvalidOperationException("The process image path is empty or truncated.");
      }
      string path = image.ToString();
      if (String.IsNullOrWhiteSpace(path)) {
        throw new InvalidOperationException("The process image path is empty.");
      }
      return path;
    }
  }
}
'@
}

# Compile before any child starts so binding initialization cannot mask a startup race.
if ([OperatingSystem]::IsWindows()) { Initialize-WindowsProcessImageQuery }

# Observe the executable image, not the first module in a changing Windows loader list.
# PID/start time/path remain exact; this function borrows the caller's held process.
function Get-CanonicalProcessIdentity {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$HeldProcess
  )
  $heldHandle = $HeldProcess.Handle
  $HeldProcess.Refresh()
  if ($HeldProcess.Id -ne $ProcessId) { throw 'Held process identity does not match the requested process.' }
  if ($HeldProcess.HasExited) { throw "Process $ProcessId exited before identity could be observed." }
  $startTimeUtc = $HeldProcess.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
  $path = if ([OperatingSystem]::IsWindows()) {
    [OpenBot.WindowsProcessImage]::Read($HeldProcess.SafeHandle)
  } else {
    [string]$HeldProcess.MainModule.FileName
  }
  if ($HeldProcess.HasExited) { throw "Process $ProcessId exited before identity could be observed." }
  if ($HeldProcess.Handle -ne $heldHandle) { throw 'Held process handle changed during identity observation.' }
  if ([string]::IsNullOrWhiteSpace($path)) { throw 'The held process executable path is unavailable.' }
  return [pscustomobject]@{
    pid = [int]$HeldProcess.Id
    startTimeUtc = $startTimeUtc
    executablePath = $path
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
  $identity = Get-CanonicalProcessIdentity -ProcessId ([int]$Live.Id) -HeldProcess $Live
  if ($identity.startTimeUtc -ne $recordedStart) { return $false }
  $livePath = $identity.executablePath
  if ([string]::IsNullOrWhiteSpace($livePath)) { return $false }
  if ($livePath.ToLowerInvariant() -ne $recordedPath.ToLowerInvariant()) { return $false }
  return $true
}

function Test-ReceiptIdentityEqualsSpawn {
  param(
    [AllowNull()]$ReceiptIdentity,
    [Parameter(Mandatory = $true)]$SpawnIdentity
  )
  if ($null -eq $ReceiptIdentity -or $null -eq $SpawnIdentity) { return $false }
  foreach ($identity in @($ReceiptIdentity, $SpawnIdentity)) {
    if ($null -eq $identity.pid -or [long]$identity.pid -le 0 -or [long]$identity.pid -gt 2147483647 -or
        $identity.startTimeUtc -isnot [string] -or $identity.startTimeUtc -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$' -or
        $identity.executablePath -isnot [string] -or [string]::IsNullOrWhiteSpace($identity.executablePath)) { return $false }
  }
  # Path uses case-insensitive equality (-ieq), matching install-gate -ine failure checks.
  return (
    [int]$ReceiptIdentity.pid -eq [int]$SpawnIdentity.pid -and
    $ReceiptIdentity.startTimeUtc -eq $SpawnIdentity.startTimeUtc -and
    $ReceiptIdentity.executablePath -ieq $SpawnIdentity.executablePath
  )
}

# Resolve a single node Application path: first PATH hit only (TotalCount 1).
# Without TotalCount, Get-Command -CommandType Application can return multiple
# matches and (.Source) becomes a space-joined Object[] unfit for ProcessStartInfo.FileName.
# Docs: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/get-command?view=powershell-7.5
function Get-NodeApplicationPath {
  $cmd = Get-Command -Name node -CommandType Application -TotalCount 1 -ErrorAction Stop
  if ($null -eq $cmd) {
    throw 'Get-NodeApplicationPath: no node Application found on PATH.'
  }
  # TotalCount 1 must yield one CommandInfo; .Source must be one path string (not Object[]).
  $source = $cmd.Source
  if ($null -eq $source -or $source -is [System.Array] -or $source -isnot [string]) {
    $typeName = if ($null -eq $source) { 'null' } else { $source.GetType().FullName }
    throw "Get-NodeApplicationPath: expected a single string Source, got $typeName."
  }
  $path = $source.Trim()
  if ([string]::IsNullOrWhiteSpace($path)) {
    throw 'Get-NodeApplicationPath: node Application Source is empty.'
  }
  # Fail closed on space-joined multi-path (old bug): LiteralPath exists only for one real file.
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Get-NodeApplicationPath: Source is not a single existing path: [$path]"
  }
  return $path
}

# Compare the held host with the actual Node → WinPS smoke observer, not a second .NET read.
function Assert-CrossRuntimeProcessIdentityConsistency {
  $hostProcess = [Diagnostics.Process]::GetCurrentProcess()
  $observer = $null
  try {
    $hostIdentity = Get-CanonicalProcessIdentity -ProcessId $hostProcess.Id -HeldProcess $hostProcess
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = Get-NodeApplicationPath
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $helper = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../apps/desktop/scripts/windows-native-smoke-harness.mjs'))
    $code = 'import {pathToFileURL} from "node:url"; const {observeProcessIdentity}=await import(pathToFileURL(process.argv[1]).href); console.log(JSON.stringify({electron:observeProcessIdentity(Number(process.argv[2]))}));'
    foreach ($argument in @('--input-type=module', '-e', $code, $helper, [string]$hostProcess.Id)) {
      $info.ArgumentList.Add($argument)
    }
    $observer = [Diagnostics.Process]::Start($info)
    $null = $observer.Handle
    $observer.StandardInput.Close()
    $outputTask = $observer.StandardOutput.ReadToEndAsync()
    $errorTask = $observer.StandardError.ReadToEndAsync()
    if (!$observer.WaitForExit(20000)) { throw 'Node smoke identity observer exceeded 20 seconds.' }
    if (!$outputTask.Wait(2000) -or !$errorTask.Wait(2000)) { throw 'Node smoke identity streams did not close.' }
    if ($observer.ExitCode -ne 0 -or $outputTask.Result.Length -gt 8192 -or $errorTask.Result.Length -gt 4096) {
      throw 'Node smoke identity observer failed or exceeded its response bound.'
    }
    $smokeIdentity = (Read-SmokeRoundIdentities $outputTask.Result).electron
    if (!(Test-ReceiptIdentityEqualsSpawn -ReceiptIdentity $smokeIdentity -SpawnIdentity $hostIdentity)) {
      $hostEvidence = Format-ProcessIdentityEvidence -Identity $hostIdentity -Label 'host'
      $smokeEvidence = Format-ProcessIdentityEvidence -Identity $smokeIdentity -Label 'smoke'
      throw "Cross-runtime identity mismatch. $hostEvidence $smokeEvidence"
    }
    Write-Host "PASS: pwsh identity matches the actual Node/WinPS smoke observer (pid=$($hostIdentity.pid))."
  } finally {
    try {
      if ($null -ne $observer) {
        if (!$observer.HasExited) { $observer.Kill($true) }
        if (!$observer.WaitForExit(10000)) { throw 'Node smoke identity observer cleanup failed.' }
      }
    } catch {
      $script:cleanupVerified = $false
      throw
    } finally {
      if ($null -ne $observer) { $observer.Dispose() }
      $hostProcess.Dispose()
    }
  }
}
