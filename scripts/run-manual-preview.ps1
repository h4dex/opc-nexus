param(
  [string]$UserData = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not $UserData) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $UserData = Join-Path $projectRoot "tmp\manual-preview\interactive-$stamp"
}

New-Item -ItemType Directory -Force -Path $UserData | Out-Null
$env:AIBOX_USER_DATA_DIR = (Resolve-Path $UserData).Path

Write-Host "OPC-Nexus v2.0.0 manual preview"
Write-Host "User data: $env:AIBOX_USER_DATA_DIR"
Write-Host 'Keep this window open while testing.'

& npm.cmd run dev -- --remoteDebuggingPort 9333 -- --in-process-gpu --use-gl=angle --use-angle=swiftshader --disable-gpu-sandbox
