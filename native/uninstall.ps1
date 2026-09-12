$ErrorActionPreference = 'Stop'
foreach ($avdBrowserKey in @('Google\Chrome','Microsoft\Edge')) {
  $avdRegistryKey = "HKCU:\Software\$avdBrowserKey\NativeMessagingHosts\com.any_video_download.helper"
  if (Test-Path -LiteralPath $avdRegistryKey) { Remove-Item -LiteralPath $avdRegistryKey }
}
Write-Output 'Native helper registration removed. Downloaded files were preserved.'
