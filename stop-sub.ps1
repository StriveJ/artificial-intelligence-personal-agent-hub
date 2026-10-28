param([Parameter(Mandatory=$true)][string]$Config, [switch]$RemoveAutoStart)
$ErrorActionPreference = 'Stop'
$configFile = (Resolve-Path -LiteralPath $Config).Path
$settings = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$pidFile = Join-Path $settings.runtimeDir 'sub-process.json'
if (Test-Path -LiteralPath $pidFile) {
  $record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
  if ($proc -and $proc.CommandLine.Contains($configFile) -and $proc.CommandLine.Contains('sub-server.mjs')) {
    $node = (Get-Command node.exe).Source
    & $node (Join-Path $PSScriptRoot 'sub-server.mjs') --config $configFile stop
    if ($LASTEXITCODE -ne 0) { throw 'Sub Hub did not respond to graceful stop; data and process unchanged' }
    for ($attempt = 0; $attempt -lt 30 -and (Get-Process -Id $record.pid -ErrorAction SilentlyContinue); $attempt++) { Start-Sleep -Milliseconds 200 }
    if (Get-Process -Id $record.pid -ErrorAction SilentlyContinue) { throw 'Sub Hub is waiting for the current write to finish. Check status later.' }
  }
}
if ($RemoveAutoStart -and $settings.nodeId -match '^[a-zA-Z0-9_-]{3,80}$') {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run', $true)
  if ($key) { try { $key.DeleteValue(('AipaHubSub-' + $settings.nodeId), $false) } finally { $key.Dispose() } }
}
Write-Output 'Sub Hub stopped; local information preserved'
