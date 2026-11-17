# shimau ヘルパーを Windows にインストールする（管理者権限は不要）
# 実行: powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'

$HostName = 'com.shimau.helper'
$ExtId = 'clnofopcnjnjgknoflaipaohdofeolng'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Join-Path $env:LOCALAPPDATA 'shimau'
$Src = Join-Path $Here 'shimau-helper-windows-amd64.exe'

if (-not (Test-Path -LiteralPath $Src)) {
  Write-Error "$Src が見つかりません。配布用の zip を展開したフォルダで実行してください。"
}

New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
$Exe = Join-Path $AppDir 'shimau-helper.exe'
Copy-Item -LiteralPath $Src -Destination $Exe -Force
Unblock-File -LiteralPath $Exe

$Manifest = [ordered]@{
  name            = $HostName
  description     = 'shimau helper'
  path            = $Exe
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtId/")
} | ConvertTo-Json
$ManifestPath = Join-Path $AppDir "$HostName.json"
[System.IO.File]::WriteAllText($ManifestPath, $Manifest, (New-Object System.Text.UTF8Encoding $false))

# Brave がどちらのキーを読むか版によって違うため、両方に登録する
foreach ($key in @(
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName")) {
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(default)' -Value $ManifestPath
}

Write-Host "✓ インストールしました: $Exe"
& $Exe --version
Write-Host 'Brave を再起動し、shimau の設定画面の「ヘルパー」で「接続中」になっているか確認してください。'
