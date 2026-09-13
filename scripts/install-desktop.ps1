param([string]$Version = "0.1.0-alpha.8")
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Net.Http

function Save-OpenBotReleaseDownload {
  param(
    [Parameter(Mandatory = $true)][System.Net.Http.HttpClient]$Client,
    [Parameter(Mandatory = $true)][Uri]$Uri,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][long]$MaximumBytes,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )
  if ($MaximumBytes -lt 1 -or $MaximumBytes -gt 2147483648 -or $TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 900) {
    throw "Invalid release download bounds."
  }
  $cancellation = New-Object System.Threading.CancellationTokenSource
  $cancellation.CancelAfter([TimeSpan]::FromSeconds($TimeoutSeconds))
  $output = $null
  $createdOutput = $false
  $completed = $false
  try {
    for ($redirect = 0; $redirect -le 5; $redirect++) {
      if ($Uri.Scheme -ne "https" -or $Uri.Port -ne 443 -or $Uri.UserInfo -or $Uri.Fragment -or
          @("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com") -notcontains $Uri.DnsSafeHost) {
        throw "Release downloads require HTTPS on an approved GitHub host."
      }
      $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $Uri)
      $response = $null
      $inputStream = $null
      try {
        $response = $Client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancellation.Token).GetAwaiter().GetResult()
        if (@(301, 302, 303, 307, 308) -contains [int]$response.StatusCode) {
          if ($redirect -eq 5 -or $null -eq $response.Headers.Location) { throw "Release redirect limit exceeded or location missing." }
          $Uri = New-Object Uri($Uri, $response.Headers.Location)
          continue
        }
        if ([int]$response.StatusCode -ne 200) { throw "Release download was rejected by the server." }
        $declaredLength = $response.Content.Headers.ContentLength
        if ($null -ne $declaredLength -and $declaredLength -gt $MaximumBytes) { throw "Release download exceeds its byte limit." }
        $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $output = New-Object IO.FileStream($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $createdOutput = $true
        $buffer = New-Object byte[] 65536
        [long]$total = 0
        while ($true) {
          $count = $inputStream.ReadAsync($buffer, 0, $buffer.Length, $cancellation.Token).GetAwaiter().GetResult()
          if ($count -eq 0) { break }
          $total += $count
          if ($total -gt $MaximumBytes) { throw "Release download exceeds its byte limit." }
          $output.Write($buffer, 0, $count)
        }
        $output.Flush($true)
        $completed = $true
        return
      } finally {
        if ($null -ne $inputStream) { $inputStream.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
        $request.Dispose()
      }
    }
  } finally {
    if ($null -ne $output) { $output.Dispose() }
    $cancellation.Dispose()
    if ($createdOutput -and -not $completed) { Remove-Item -LiteralPath $Destination -Force }
  }
}

if ($Version -notmatch '^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$') { throw "Invalid Desktop version." }
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
  throw "This installer supports Windows x64 only."
}
$asset = "openbot-desktop-$Version-win32-x64.exe"
$base = "https://github.com/yxflc11/openbot/releases/download/desktop-v$Version"
$stage = Join-Path ([IO.Path]::GetTempPath()) ("openbot-install-" + [Guid]::NewGuid().ToString("N"))
[IO.Directory]::CreateDirectory($stage) | Out-Null
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.AllowAutoRedirect = $false
$handler.UseCookies = $false
$handler.SslProtocols = [System.Security.Authentication.SslProtocols]::Tls12
$client = New-Object System.Net.Http.HttpClient($handler)
$client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
try {
  $checksums = Join-Path $stage "SHA256SUMS"
  $installer = Join-Path $stage $asset
  Save-OpenBotReleaseDownload -Client $client -Uri "$base/SHA256SUMS" -Destination $checksums -MaximumBytes 16384 -TimeoutSeconds 60
  if ((Get-Item $checksums).Length -gt 16384) { throw "Release checksum list is too large." }
  $matching = @(Get-Content $checksums | Where-Object { $_ -match ('^([a-f0-9]{64})  ' + [Regex]::Escape($asset) + '$') })
  if ($matching.Count -ne 1) { throw "The release does not contain exactly one checksum for this installer." }
  $expected = $matching[0].Substring(0, 64)
  Save-OpenBotReleaseDownload -Client $client -Uri "$base/$asset" -Destination $installer -MaximumBytes 2147483648 -TimeoutSeconds 900
  if ((Get-FileHash -Algorithm SHA256 $installer).Hash.ToLowerInvariant() -ne $expected) {
    throw "Installer checksum mismatch; nothing was installed."
  }
  # Keep the Internet-zone marker. Never unblock the file or bypass Windows trust policy.
  Set-Content -LiteralPath $installer -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3"
  Write-Host "Starting the OpenBot Desktop per-user installer. Windows trust prompts still apply."
  $process = Start-Process -FilePath $installer -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Desktop installer exited with code $($process.ExitCode)." }
  Write-Host "Open OpenBot from the Start menu. Connect a Server and configure your model there."
} finally {
  $client.Dispose()
  Remove-Item -LiteralPath $stage -Recurse -Force
}
