# shimau ヘルパーを Windows からアンインストールする
$ErrorActionPreference = 'Stop'

$HostName = 'com.shimau.helper'
$AppDir = Join-Path $env:LOCALAPPDATA 'shimau'

foreach ($key in @(
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName")) {
  if (Test-Path $key) { Remove-Item -Path $key -Force }
}
Remove-Item -LiteralPath (Join-Path $AppDir 'shimau-helper.exe') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $AppDir "$HostName.json") -Force -ErrorAction SilentlyContinue
Write-Host "✓ ヘルパーを削除しました（設定ファイル $env:APPDATA\shimau\config.json は残しています）"
