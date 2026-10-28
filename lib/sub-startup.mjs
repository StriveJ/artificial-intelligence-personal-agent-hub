import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export async function removeSubStartup(nodeId) {
  if (process.platform !== 'win32') return;
  if (!/^[a-zA-Z0-9_-]{3,80}$/.test(nodeId)) throw new Error("Invalid autostart registration ownership");
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run',$true); if ($k) { try { $k.DeleteValue('AipaHubSub-${nodeId}',$false) } finally { $k.Dispose() } }`], { windowsHide: true, timeout: 15_000 });
}
