$ErrorActionPreference = 'Stop'
$runtimeDir = Join-Path $PSScriptRoot '.aipa-hub'
$recordPath = Join-Path $runtimeDir 'process.json'
if (-not (Test-Path -LiteralPath $recordPath)) { Write-Output 'No background Hub process recorded'; exit 0 }
$record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
$process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if (-not $process) { Write-Output 'Hub stopped'; exit 0 }
$actual = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$record.pid)
$expectedStart = if ($record.started -is [datetime]) { $record.started.ToUniversalTime() } else { [datetime]::Parse($record.started).ToUniversalTime() }
if ($process.ProcessName -ne 'node' -or -not $actual.CommandLine.Contains($record.server) -or $process.StartTime.ToUniversalTime().Ticks -ne $expectedStart.Ticks) {
    throw 'Process identity differs from startup record; refusing to stop another program'
}
& taskkill.exe /PID $process.Id /T /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not stop the Hub process tree. Check current process status.' }
Write-Output 'Hub stopped; personal instance records preserved'
