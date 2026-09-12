param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
  [string]$FfmpegPath,
  [string]$DownloadDir
)
$ErrorActionPreference = 'Stop'
$avdNodePath = (Get-Command node -ErrorAction Stop).Source
if (-not $FfmpegPath) { $FfmpegPath = (Get-Command ffmpeg -ErrorAction Stop).Source }
$FfmpegPath = (Resolve-Path -LiteralPath $FfmpegPath).Path
if (-not (Test-Path -LiteralPath (Join-Path (Split-Path $FfmpegPath) 'ffprobe.exe'))) { throw 'ffprobe.exe must be installed alongside ffmpeg.exe' }
if (-not $DownloadDir) {
  $avdFolders = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
  $DownloadDir = [Environment]::ExpandEnvironmentVariables($avdFolders.'{374DE290-123F-4565-9164-39C4925E467B}')
  if (-not $DownloadDir) { $DownloadDir = Join-Path $env:USERPROFILE 'Downloads' }
}
$avdOrigin = "chrome-extension://$ExtensionId/"
$avdConfig = @{ffmpeg=$FfmpegPath; downloadDir=$DownloadDir; allowedOrigins=@($avdOrigin)}
$avdUtf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'config.json'), ($avdConfig | ConvertTo-Json), $avdUtf8)
$avdLaunchPath = Join-Path $PSScriptRoot 'launch.cmd'
$avdHostScript = Join-Path $PSScriptRoot 'host.js'
@('@echo off', ('"{0}" "{1}" %*' -f $avdNodePath,$avdHostScript)) | Set-Content -LiteralPath $avdLaunchPath -Encoding ascii
$avdManifestPath = Join-Path $PSScriptRoot 'host-manifest.json'
$avdHostManifest = @{name='com.any_video_download.helper'; description='Any Video Download FFmpeg helper'; path=$avdLaunchPath; type='stdio'; allowed_origins=@($avdOrigin)}
[System.IO.File]::WriteAllText($avdManifestPath, ($avdHostManifest | ConvertTo-Json), $avdUtf8)
foreach ($avdBrowserKey in @('Google\Chrome','Microsoft\Edge')) {
  $avdRegistryKey = "HKCU:\Software\$avdBrowserKey\NativeMessagingHosts\com.any_video_download.helper"
  New-Item -Path $avdRegistryKey -Force | Out-Null
  Set-Item -LiteralPath $avdRegistryKey -Value $avdManifestPath
}
Write-Output "Installed for $ExtensionId. Downloads: $DownloadDir"
