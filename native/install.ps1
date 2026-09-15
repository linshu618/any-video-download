param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
  [string]$FfmpegPath,
  [string]$DownloadDir,
  [string]$YtDlpPath
)
$ErrorActionPreference = 'Stop'
$avdNodeCommand = (Get-Command node -ErrorAction Stop).Source
$avdNodePath = (& $avdNodeCommand -p "require('node:fs').realpathSync(process.execPath)").Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $avdNodePath -PathType Leaf)) { throw 'Cannot resolve a stable Node.js executable path' }
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
if (-not $YtDlpPath) {
  $avdBundledDownloader = Join-Path $PSScriptRoot 'bin\yt-dlp.exe'
  if (Test-Path -LiteralPath $avdBundledDownloader -PathType Leaf) { $YtDlpPath = $avdBundledDownloader }
  else { $avdDownloaderCommand = Get-Command yt-dlp -ErrorAction SilentlyContinue; if ($avdDownloaderCommand) { $YtDlpPath = $avdDownloaderCommand.Source } }
}
if ($YtDlpPath) { $avdConfig.ytDlp = (Resolve-Path -LiteralPath $YtDlpPath).Path }
$avdUtf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'config.json'), ($avdConfig | ConvertTo-Json), $avdUtf8)
$avdLaunchPath = Join-Path $PSScriptRoot 'launch.cmd'
# CMD expands its own directory as Unicode; avoid embedding the article/project path.
# UTF-8 also preserves a non-ASCII Node installation path. Silence chcp for native framing.
$avdLaunchLines = @('@echo off', 'setlocal DisableDelayedExpansion', 'chcp 65001 >nul', ('"{0}" "%~dp0host.js" %*' -f $avdNodePath.Replace('%','%%')))
[System.IO.File]::WriteAllText($avdLaunchPath, (($avdLaunchLines -join "`r`n") + "`r`n"), $avdUtf8)
$avdManifestPath = Join-Path $PSScriptRoot 'host-manifest.json'
$avdHostManifest = @{name='com.any_video_download.helper'; description='Any Video Download FFmpeg helper'; path=$avdLaunchPath; type='stdio'; allowed_origins=@($avdOrigin)}
[System.IO.File]::WriteAllText($avdManifestPath, ($avdHostManifest | ConvertTo-Json), $avdUtf8)
foreach ($avdBrowserKey in @('Google\Chrome','Microsoft\Edge')) {
  $avdRegistryKey = "HKCU:\Software\$avdBrowserKey\NativeMessagingHosts\com.any_video_download.helper"
  New-Item -Path $avdRegistryKey -Force | Out-Null
  Set-Item -LiteralPath $avdRegistryKey -Value $avdManifestPath
}
Write-Output "Installed for $ExtensionId. Downloads: $DownloadDir"
