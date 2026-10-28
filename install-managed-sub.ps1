param([Parameter(Mandatory=$true)][string]$Installation, [switch]$NoAutoStart)
$ErrorActionPreference = 'Stop'
$installationFile = (Resolve-Path -LiteralPath $Installation).Path
$settings = Get-Content -LiteralPath $installationFile -Raw | ConvertFrom-Json
$configFile = (Resolve-Path -LiteralPath $settings.configFile).Path
$hubConfig = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
if ($settings.role -ne 'sub' -or $settings.installationId -ne $hubConfig.installationId) { throw 'Only the current local sub Hub installation binding is allowed' }
$base = (Resolve-Path -LiteralPath $settings.base).Path
$managed = (Resolve-Path -LiteralPath $hubConfig.managedBase).Path
if (-not $base.StartsWith($managed + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Program directory escapes installation root' }
if (Test-Path -LiteralPath (Join-Path $managed 'cleared.json')) { throw 'Installation cleared' }
$entry = Join-Path $base 'bootstrap/hub-launcher.mjs'
$node = (Get-Command node.exe).Source
if (@($entry,$installationFile,$node) | Where-Object { $_.Contains('"') }) { throw 'Paths containing quotes are unsupported' }
$lockFile = Join-Path $base 'control/launcher.lock'
$alreadyRunning = $false
if (Test-Path -LiteralPath $lockFile) {
  $old = Get-Content -LiteralPath $lockFile -Raw | ConvertFrom-Json
  $oldProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($old.pid)" -ErrorAction SilentlyContinue
  if ($oldProcess) { if (-not $oldProcess.CommandLine.Contains($installationFile)) { throw 'Runtime lock PID does not belong to this installation; verification required' }; $alreadyRunning = $true }
}
$launcher = Join-Path $managed 'launch-sub.ps1'
$quotedScript = $PSCommandPath.Replace("'", "''"); $quotedInstallation = $installationFile.Replace("'", "''"); $quotedManaged = $managed.Replace("'", "''")
[IO.File]::WriteAllText($launcher, "if (Test-Path -LiteralPath '$quotedManaged\cleared.json') { exit 0 }`n& '$quotedScript' -Installation '$quotedInstallation' -NoAutoStart`n", [Text.UTF8Encoding]::new($false))
if (-not $NoAutoStart) {
  $startupName = 'AipaHubSub-' + $hubConfig.nodeId
  if ($startupName -notmatch '^AipaHubSub-[a-zA-Z0-9_-]{3,80}$') { throw 'Invalid device ID' }
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
  try { $key.SetValue($startupName, "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`"", [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
}
if ($alreadyRunning) { Write-Output 'Launcher already running; startup configuration verified'; exit 0 }
$proc = Start-Process -FilePath $node -ArgumentList @('"' + $entry + '"', '--installation', '"' + $installationFile + '"') -WorkingDirectory $base -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $hubConfig.runtimeDir 'launcher.stdout.log') -RedirectStandardError (Join-Path $hubConfig.runtimeDir 'launcher.stderr.log')
Write-Output ('Sub Hub Launcher started, PID ' + $proc.Id)
