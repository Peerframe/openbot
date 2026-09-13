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
  $startTimeUtc = $null
  if ($startEl.ValueKind -eq [System.Text.Json.JsonValueKind]::String) {
    $startTimeUtc = $startEl.GetString()
  } else {
    # Unexpected non-string token; fall back only if somehow already DateTime-like.
    $startTimeUtc = ConvertTo-IsoStartTimeUtc $startEl.ToString()
  }
  if ([string]::IsNullOrWhiteSpace($startTimeUtc)) { return $null }
  if ($pathEl.ValueKind -ne [System.Text.Json.JsonValueKind]::String) { return $null }
  $executablePath = $pathEl.GetString()
  if ([string]::IsNullOrWhiteSpace($executablePath)) { return $null }
  return [pscustomobject]@{
    pid = $pidEl.GetInt32()
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

function Test-ReceiptIdentityEqualsSpawn {
  param(
    [AllowNull()]$ReceiptIdentity,
    [Parameter(Mandatory = $true)]$SpawnIdentity
  )
  if ($null -eq $ReceiptIdentity) { return $false }
  # Path uses case-insensitive equality (-ieq), matching install-gate -ine failure checks.
  return (
    [int]$ReceiptIdentity.pid -eq [int]$SpawnIdentity.pid -and
    $ReceiptIdentity.startTimeUtc -eq $SpawnIdentity.startTimeUtc -and
    $ReceiptIdentity.executablePath -ieq $SpawnIdentity.executablePath
  )
}

# Bounded preflight: two canonical reads on the same held process (no WinPS child / no unbounded &).
function Assert-CanonicalProcessIdentityConsistency {
  $probeCmd = if (Get-Command powershell.exe -ErrorAction SilentlyContinue) {
    'powershell.exe'
  } elseif (Get-Command pwsh -ErrorAction SilentlyContinue) {
    (Get-Command pwsh).Source
  } else {
    (Get-Process -Id $PID).Path
  }
  $probe = Start-Process -FilePath $probeCmd -ArgumentList '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30"' -PassThru
  try {
    if ($null -eq $probe) { throw 'Canonical identity preflight failed to start probe process.' }
    $null = $probe.Handle
    $first = Get-CanonicalProcessIdentity -ProcessId ([int]$probe.Id) -HeldProcess $probe
    $second = Get-CanonicalProcessIdentity -ProcessId ([int]$probe.Id) -HeldProcess $probe
    if (
      [int]$first.pid -ne [int]$second.pid -or
      $first.startTimeUtc -ne $second.startTimeUtc -or
      $first.executablePath -ne $second.executablePath
    ) {
      $firstEvidence = Format-ProcessIdentityEvidence -Identity $first -Label 'first'
      $secondEvidence = Format-ProcessIdentityEvidence -Identity $second -Label 'second'
      throw "Canonical process identity preflight failed. $firstEvidence $secondEvidence"
    }
    if (
      [int]$first.pid -ne [int]$probe.Id -or
      [string]::IsNullOrWhiteSpace($first.startTimeUtc) -or
      [string]::IsNullOrWhiteSpace($first.executablePath)
    ) {
      throw 'Canonical process identity preflight returned incomplete fields.'
    }
    Write-Host "PASS: canonical process identity preflight (pid=$($first.pid))."
    return $first
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
