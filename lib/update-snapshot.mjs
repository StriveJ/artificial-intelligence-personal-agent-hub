import { readdirSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { writeJson, safeInstancePath } from './storage.mjs';
import { sha256 } from './release-package.mjs';
import { setTimeout as yieldCopy } from 'node:timers/promises';

export async function snapshotInstallation({ root, runtimeDir, configFile, destination, maxBytes = 2_000_000_000 }) {
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  const files = [], omitted = []; let bytes = 0, copied = 0;
  async function copy(source, prefix) {
    if (prefix.startsWith('runtime/') && prefix.endsWith('.log')) { omitted.push({ path: prefix, reason: 'runtime-diagnostic-log' }); return; }
    const s = lstatSync(source);
    if (s.isSymbolicLink()) throw new Error("Snapshots reject symbolic links. Verify instance paths first.");
    if (s.isDirectory()) { for (const e of readdirSync(source)) {
      if (e === 'host.lock' || e.endsWith('.sock') || e.startsWith('aipa-hub-gate.sqlite')) continue;
      await copy(join(source, e), `${prefix}/${e}`);
    } return; }
    if (!s.isFile()) return;
    bytes += s.size; if (bytes > maxBytes) throw new Error("Snapshot exceeds capacity limit");
    const file = safeInstancePath(destination, join(destination, prefix)); mkdirSync(dirname(file), { recursive: true });
    const content = readFileSync(source); writeFileSync(file, content, { flag: 'wx', mode: 0o600 }); files.push({ path: prefix, size: content.length, sha256: sha256(content) });
    if (++copied % 16 === 0) await yieldCopy(0);
  }
  await copy(root, 'instance'); await copy(runtimeDir, 'runtime'); await copy(configFile, 'config.json');
  const db = new DatabaseSync(join(root, '.git/aipa-hub-gate.sqlite'), { readOnly: true });
  const path = join(destination, 'instance/.git/aipa-hub-gate.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  try { await backup(db, path); } finally { db.close(); }
  const content = readFileSync(path); files.push({ path: 'instance/.git/aipa-hub-gate.sqlite', size: content.length, sha256: sha256(content) });
  const manifest = { version: 1, createdAt: new Date().toISOString(), root, runtimeDir, files, omitted, bytes };
  writeJson(join(destination, 'snapshot.json'), manifest); return { files: files.length, bytes };
}
