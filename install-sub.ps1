param([Parameter(Mandatory=$true)][string]$Config, [switch]$NoAutoStart)
$ErrorActionPreference = 'Stop'
$configFile = (Resolve-Path -LiteralPath $Config).Path
$settings = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
if (-not $settings.managedBase -or -not $settings.runtimeDir) { throw 'Dedicated installation and runtime directories are required' }
$base = (Resolve-Path -LiteralPath $settings.managedBase).Path
$runtime = [IO.Path]::GetFullPath($settings.runtimeDir)
if (-not $runtime.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime directory escapes installation root' }
$entry = Join-Path $PSScriptRoot 'sub-server.mjs'
$node = (Get-Command node.exe).Source
if ($configFile.Contains('"') -or $entry.Contains('"') -or $node.Contains('"')) { throw 'Paths containing quotes are unsupported' }
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$pidFile = Join-Path $runtime 'sub-process.json'
$launcher = Join-Path $base 'launch-sub.ps1'
$quotedEntry = $entry.Replace("'", "''"); $quotedConfig = $configFile.Replace("'", "''")
$quotedScript = $PSCommandPath.Replace("'", "''"); $quotedBase = $base.Replace("'", "''")
$launcherText = "if (Test-Path -LiteralPath '$quotedBase\cleared.json') { exit 0 }`n& '$quotedScript' -Config '$quotedConfig' -NoAutoStart`n"
[IO.File]::WriteAllText($launcher, $launcherText, [Text.UTF8Encoding]::new($false))
if (-not $NoAutoStart) {
  $startupName = 'AipaHubSub-' + $settings.nodeId
  if ($startupName -notmatch '^AipaHubSub-[a-zA-Z0-9_-]{3,80}$') { throw 'Invalid device ID' }
  $runKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
  try { $runKey.SetValue($startupName, "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`"", [Microsoft.Win32.RegistryValueKind]::String) }
  finally { $runKey.Dispose() }
}
if (Test-Path -LiteralPath $pidFile) {
  $old = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($old.pid)" -ErrorAction SilentlyContinue
  if ($process -and $process.CommandLine.Contains($configFile)) { Write-Output 'Sub Hub already running; startup configuration verified'; exit 0 }
}
$proc = Start-Process -FilePath $node -ArgumentList @('"' + $entry + '"', '--config', '"' + $configFile + '"') -WorkingDirectory $base -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'sub.stdout.log') -RedirectStandardError (Join-Path $runtime 'sub.stderr.log')
[IO.File]::WriteAllText($pidFile, (@{pid=$proc.Id;entry=$entry;config=$configFile} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Output ('Sub Hub started, PID ' + $proc.Id)
