param(
  [string]$Executable = '',
  [string]$UserData = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $Executable) {
  $Executable = Join-Path $projectRoot 'release-preview\win-unpacked\数字员工 AI Box.exe'
}
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
  throw "Preview executable not found: $Executable"
}
if (-not $UserData) {
  $UserData = Join-Path $projectRoot 'tmp\manual-preview\packaged-interactive'
}
New-Item -ItemType Directory -Force -Path $UserData | Out-Null

$shortcutPath = Join-Path $projectRoot 'tmp\manual-preview\OPC-Nexus-v2-preview.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = (Resolve-Path $Executable).Path
$shortcut.WorkingDirectory = Split-Path -Parent $Executable
$shortcut.Arguments = "--aibox-user-data=`"$UserData`" --in-process-gpu --use-gl=angle --use-angle=swiftshader --disable-gpu-sandbox"
$shortcut.WindowStyle = 1
$shortcut.Description = 'OPC-Nexus v2.0.0 manual preview'
$shortcut.Save()

Start-Process -FilePath $shortcutPath
Write-Host "Started: $shortcutPath"
