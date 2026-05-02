<#
.SYNOPSIS
Exports YouTube cookies from a local browser and uploads them to the VPS.

.DESCRIPTION
Uses the project's bundled yt-dlp binary to export Netscape-format cookies from
Google Chrome by default, uploads the cookie jar to /opt/lizzo/youtube-cookies.txt,
locks the file to mode 600, and restarts lizzo-bot.service.
#>

[CmdletBinding()]
param(
  [string]$Browser = "chrome",
  [string]$VpsHost = "146.190.171.90",
  [int]$VpsPort = 22,
  [string]$VpsUser = "lizzo",
  [string]$RemotePath = "/opt/lizzo/youtube-cookies.txt",
  [string]$CookiesPath = "",
  [string]$YtDlpPath = "",
  [string]$SshKeyPath = "",
  [switch]$CloseBrowser,
  [switch]$NoRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-ProjectRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Resolve-YtDlpPath {
  param([string]$ProjectRoot, [string]$ExplicitPath)

  if ($ExplicitPath) {
    $resolvedPath = (Resolve-Path $ExplicitPath).Path
    if (-not (Test-Path $resolvedPath -PathType Leaf)) {
      throw "YtDlpPath does not point to a file: $resolvedPath"
    }

    return $resolvedPath
  }

  $bundledPath = Join-Path $ProjectRoot "node_modules\@distube\yt-dlp\bin\yt-dlp.exe"
  if (Test-Path $bundledPath -PathType Leaf) {
    return $bundledPath
  }

  $pathCommand = Get-Command "yt-dlp" -ErrorAction SilentlyContinue
  if ($pathCommand) {
    return $pathCommand.Source
  }

  throw "Could not find yt-dlp. Run npm install first, or pass -YtDlpPath."
}

function Get-RemoteTarget {
  param([string]$User, [string]$HostName, [string]$Path)

  return "${User}@${HostName}:$Path"
}

function Get-SshArgs {
  param([int]$Port, [string]$KeyPath)

  $args = @("-p", [string]$Port, "-o", "StrictHostKeyChecking=accept-new")
  if ($KeyPath) {
    $resolvedKeyPath = (Resolve-Path $KeyPath).Path
    $args += @("-i", $resolvedKeyPath, "-o", "IdentitiesOnly=yes")
  }

  return $args
}

function Get-ScpArgs {
  param([int]$Port, [string]$KeyPath)

  $args = @("-P", [string]$Port, "-o", "StrictHostKeyChecking=accept-new")
  if ($KeyPath) {
    $resolvedKeyPath = (Resolve-Path $KeyPath).Path
    $args += @("-i", $resolvedKeyPath, "-o", "IdentitiesOnly=yes")
  }

  return $args
}

function Invoke-CheckedCommand {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$FailureMessage
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage Exit code: $LASTEXITCODE"
  }
}

function Get-BrowserProcessName {
  param([string]$BrowserSpec)

  $browserName = ($BrowserSpec -split "[:+]", 2)[0].ToLowerInvariant()
  switch ($browserName) {
    "brave" { return "brave" }
    "chrome" { return "chrome" }
    "chromium" { return "chromium" }
    "edge" { return "msedge" }
    "opera" { return "opera" }
    "vivaldi" { return "vivaldi" }
    default { return "" }
  }
}

function Close-BrowserProcesses {
  param([string]$BrowserSpec, [switch]$ForceClose)

  $processName = Get-BrowserProcessName -BrowserSpec $BrowserSpec
  if (-not $processName) {
    return
  }

  $processes = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
  if ($processes.Count -eq 0) {
    return
  }

  if (-not $ForceClose) {
    throw "$BrowserSpec is currently running, which can lock its cookie database. Close it fully and rerun this script, or rerun with -CloseBrowser after saving anything important."
  }

  Write-Host "Closing $BrowserSpec so its cookie database can be copied..."
  foreach ($process in $processes | Where-Object { $_.MainWindowHandle -ne 0 }) {
    [void]$process.CloseMainWindow()
  }

  Start-Sleep -Seconds 5

  $remainingProcesses = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
  if ($remainingProcesses.Count -gt 0) {
    Stop-Process -InputObject $remainingProcesses -Force
    Start-Sleep -Seconds 2
  }
}

$projectRoot = Resolve-ProjectRoot
$ytDlp = Resolve-YtDlpPath -ProjectRoot $projectRoot -ExplicitPath $YtDlpPath
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("lizzo-youtube-cookies-" + [Guid]::NewGuid().ToString("N"))
$exportedCookiesPath = Join-Path $tempDir "youtube-cookies.txt"
$remoteTempPath = "$RemotePath.upload"

New-Item -ItemType Directory -Path $tempDir | Out-Null

try {
  if ($CookiesPath) {
    $cookiesPath = (Resolve-Path $CookiesPath).Path
    if (-not (Test-Path $cookiesPath -PathType Leaf)) {
      throw "CookiesPath does not point to a file: $cookiesPath"
    }

    Write-Host "Using existing cookies file: $cookiesPath"
  } else {
    $cookiesPath = $exportedCookiesPath
    Close-BrowserProcesses -BrowserSpec $Browser -ForceClose:$CloseBrowser

    Write-Host "Exporting YouTube cookies from $Browser with yt-dlp..."
    $ytDlpArgs = @(
      "--cookies-from-browser", $Browser,
      "--cookies", $cookiesPath,
      "--skip-download",
      "--simulate",
      "--no-warnings",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    )
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $ytDlpOutput = & $ytDlp @ytDlpArgs 2>&1
      $ytDlpExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }

    if ($ytDlpExitCode -ne 0) {
      $details = ($ytDlpOutput | Out-String).Trim()
      if ($details -match "Could not copy .*cookie database") {
        throw "$Browser is locking its cookie database. Close it fully and rerun this script, or rerun with -CloseBrowser after saving anything important."
      }

      if ($details -match "Failed to decrypt with DPAPI") {
        throw "yt-dlp could not decrypt $Browser cookies with Windows DPAPI. Newer Chrome and Edge versions protect cookies with App-Bound Encryption. Use -CookiesPath with a Netscape-format cookies.txt export, or use -Browser firefox after logging into YouTube in Firefox."
      }

      throw "yt-dlp could not export browser cookies. Exit code: $ytDlpExitCode`n$details"
    }
  }

  if (-not (Test-Path $cookiesPath -PathType Leaf)) {
    throw "yt-dlp did not create a cookie file."
  }

  $cookieLines = Get-Content -Path $cookiesPath | Where-Object {
    $_ -and -not $_.StartsWith("#")
  }
  $youtubeCookieLines = $cookieLines | Where-Object {
    $_ -match "youtube\.com|google\.com"
  }

  if (-not $youtubeCookieLines) {
    Write-Warning "No youtube.com or google.com cookie rows were found. Uploading anyway, but playback may still be challenged."
  }

  $scpArgs = Get-ScpArgs -Port $VpsPort -KeyPath $SshKeyPath
  $sshArgs = Get-SshArgs -Port $VpsPort -KeyPath $SshKeyPath
  $remoteTempTarget = Get-RemoteTarget -User $VpsUser -HostName $VpsHost -Path $remoteTempPath

  Write-Host "Uploading cookies to $VpsUser@$VpsHost..."
  Invoke-CheckedCommand -FilePath "scp" -Arguments ($scpArgs + @($cookiesPath, $remoteTempTarget)) -FailureMessage "scp upload failed."

  $restartCommand = ""
  if (-not $NoRestart) {
    $restartCommand = "sudo /usr/bin/systemctl restart lizzo-bot.service; sudo /usr/bin/systemctl is-active --quiet lizzo-bot.service;"
  }

  $remoteCommand = @"
set -euo pipefail
umask 077
test -s '$remoteTempPath'
mv '$remoteTempPath' '$RemotePath'
chmod 600 '$RemotePath'
$restartCommand
stat -c '%U:%G %a %n' '$RemotePath'
"@

  Invoke-CheckedCommand -FilePath "ssh" -Arguments ($sshArgs + @("$VpsUser@$VpsHost", $remoteCommand)) -FailureMessage "remote install failed."
  Write-Host "YouTube cookies are installed for the bot."
} finally {
  if (Test-Path $tempDir) {
    Remove-Item -LiteralPath $tempDir -Recurse -Force
  }
}
