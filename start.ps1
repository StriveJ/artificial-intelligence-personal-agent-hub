param(
    [string]$Root,
    [string]$Hostname = '',
    [ValidateSet('codex', 'claude')][string]$Engine = 'codex',
    [int]$Port = 4317,
    [switch]$Background
)
$ErrorActionPreference = 'Stop'
$projectDir = $PSScriptRoot
$runtimeDir = Join-Path $projectDir '.aipa-hub'
$configPath = Join-Path $runtimeDir 'config.json'
$serverPath = Join-Path $PSScriptRoot 'server.mjs'
$nodePath = (Get-Command node -ErrorAction Stop).Source
if (-not $env:HTTPS_PROXY) {
    $proxy = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if ($proxy.ProxyEnable -eq 1 -and $proxy.ProxyServer -match '^([a-zA-Z0-9.\-]+):(\d+)$') {
        $env:HTTPS_PROXY = 'http://' + $proxy.ProxyServer
        if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = $env:HTTPS_PROXY }
        $env:NO_PROXY = (@($env:NO_PROXY, '127.0.0.1', 'localhost', '::1') | Where-Object { $_ }) -join ','
    }
}
if (Test-Path -LiteralPath $configPath) {
    $previous = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if (-not $Root) { $Root = $previous.root }
    if (-not $PSBoundParameters.ContainsKey('Hostname')) { $Hostname = $previous.hostname }
    if (-not $PSBoundParameters.ContainsKey('Engine') -and $previous.engine) { $Engine = $previous.engine }
    if (-not $PSBoundParameters.ContainsKey('Port') -and $previous.port) { $Port = $previous.port }
}
if (-not $Root) { throw 'Use -Root to specify a personal AIPA instance directory' }
$instanceRoot = (Resolve-Path -LiteralPath $Root).Path
if (-not (Test-Path -LiteralPath (Join-Path $instanceRoot 'AIPA-MANIFEST.yaml'))) { throw 'Selected directory is not a personal AIPA instance' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535' }
if ($Hostname -and $Hostname -notmatch '^[a-z0-9.-]+\.ts\.net$') { throw 'Hostname must be this device .ts.net domain' }
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
@{ root = $instanceRoot; port = $Port; hostname = $Hostname; engine = $Engine } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
if (-not $Background) { & $nodePath $serverPath --config $configPath; exit $LASTEXITCODE }
foreach ($path in @($serverPath, $configPath)) { if ($path.Contains('"') -or $path.Contains("`n")) { throw 'Path contains invalid quotes or newlines' } }
$arguments = @(('"' + $serverPath + '"'), '--config', ('"' + $configPath + '"'))
$process = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDir 'server.log') -RedirectStandardError (Join-Path $runtimeDir 'server-error.log')
@{ pid = $process.Id; server = $serverPath; started = $process.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeDir 'process.json') -Encoding utf8
Start-Sleep -Milliseconds 800
$process.Refresh()
if ($process.HasExited) { throw ('Hub startup failed; see ' + (Join-Path $runtimeDir 'server-error.log')) }
Write-Output ('Hub started: http://127.0.0.1:' + $Port + '(PID ' + $process.Id + ')')
