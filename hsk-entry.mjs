#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, statSync, chownSync, openSync, closeSync, readSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson } from './lib/storage.mjs';
import { parseTunnelLog, mergeTunnelOrigin, needsRebuild } from './lib/public-entry.mjs';
import { createActivityLog } from './lib/activity-log.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const configArgument = arg('config');
if (!configArgument || configArgument.startsWith('--')) {
  console.error("Explicit --config <private-hub-config> is required");
  process.exit(1);
}
const configFile = resolve(configArgument);
const tunnelUnit = arg('tunnel-unit', 'aipa-hsk-main.service');
const hubUnit = arg('hub-unit', 'aipa-hub-main.service');
const tunnelLogArgument = arg('tunnel-log');
const dryRun = process.argv.includes('--dry-run');
const report = { config: configFile, tunnelUnit, hubUnit };

function systemctl(...args) {
  const result = spawnSync('systemctl', args, { encoding: 'utf8', timeout: 60_000 });
  return { ok: result.status === 0, out: `${result.stdout || ''}${result.stderr || ''}`.trim().slice(0, 200) };
}
function tail(path, bytes = 256 * 1024) {
  if (!existsSync(path)) return '';
  const size = statSync(path).size, length = Math.min(bytes, size);
  const buffer = Buffer.alloc(length), fd = openSync(path, 'r');
  try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
  return buffer.toString('utf8');
}
function writeEntry(file, reference, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try { const owner = statSync(reference); chownSync(file, owner.uid, owner.gid); } catch {  }
}
function notify(runtimeDir, record) {

  try { createActivityLog({ runtimeDir }).append(record); } catch {  }
}

try {
  const config = readJson(configFile, null);
  if (!config?.runtimeDir) throw new Error("An existing Hub configuration is required");
  const runtimeDir = resolve(config.runtimeDir);
  const logFile = resolve(tunnelLogArgument || join(runtimeDir, 'hsk-main.log'));
  mkdirSync(runtimeDir, { recursive: true });
  const entryFile = join(runtimeDir, 'public-entry.json');
  const activity = record => dryRun ? undefined : notify(runtimeDir, record);

  const active = systemctl('is-active', tunnelUnit).out === 'active';
  report.tunnelActive = active;
  if (!active) {
    const started = systemctl('start', tunnelUnit);
    report.restarted = started.ok;
    activity({ kind: 'system', action: 'entry', status: started.ok ? 'info' : 'failed', summary: `HSK tunnel is not running; restart attempted (${started.ok ? "Success" : "Failed"})` });
    await delay(12_000);
  }

  const parsed = parseTunnelLog(tail(logFile));
  report.parsed = parsed && { url: parsed.url, claimed: parsed.claimed, expiresAt: parsed.expiresAt, verifyCode: Boolean(parsed.verifyCode) };
  if (!parsed?.url) {
    report.result = 'no-entry';
    console.log(JSON.stringify(report));
    process.exit(0);
  }

  if (needsRebuild(parsed.expiresAt)) {
    const restarted = systemctl('restart', tunnelUnit);
    report.rebuiltForExpiry = restarted.ok;
    activity({ kind: 'system', action: 'entry', status: restarted.ok ? 'info' : 'failed', summary: `HSK entry expires soon; rebuilt early (${restarted.ok ? "Success" : "Failed"})` });
    report.result = 'rebuilding';
    console.log(JSON.stringify(report));
    process.exit(0);
  }

  const probe = async target => {
    try {
      const response = await fetch(`${target}/healthz`, { signal: AbortSignal.timeout(15_000), redirect: 'manual' });
      const body = (await response.text()).slice(0, 200);
      if (response.status === 200) return { state: 'ok', status: response.status };
      if (body.includes("This access domain is not configured")) return { state: 'needs-origin', status: response.status };
      if (/forbidden/i.test(body)) return { state: 'unclaimed', status: response.status };
      return { state: 'blocked', status: response.status, body: body.slice(0, 80) };
    } catch (error) { return { state: 'unreachable', error: String(error.message).slice(0, 120) }; }
  };
  const first = await probe(parsed.url);
  report.probe = first;
  const checkFile = join(runtimeDir, 'entry-check.json');
  const check = readJson(checkFile, { failures: 0, lastState: null, checkedAt: null });
  if (['unreachable', 'blocked'].includes(first.state)) {
    check.failures = (check.failures || 0) + 1;
    check.lastState = first.state; check.checkedAt = new Date().toISOString();
    if (!dryRun) writeEntry(checkFile, configFile, check);
    report.failures = check.failures;
    if (check.failures >= 2) {
      const restarted = systemctl('restart', tunnelUnit);
      activity({ kind: 'system', action: 'entry', status: restarted.ok ? 'info' : 'failed', summary: `Public entry failed ${check.failures} consecutive checks; HSK tunnel restarted` });
      check.failures = 0; check.checkedAt = new Date().toISOString();
      if (!dryRun) writeEntry(checkFile, configFile, check);
      report.tunnelRestarted = restarted.ok;
      report.result = 'healed';
      console.log(JSON.stringify(report));
      process.exit(0);
    }
  } else {
    if ((check.failures || 0) > 0 || check.lastState !== first.state) {
      check.failures = 0; check.lastState = first.state; check.checkedAt = new Date().toISOString();
      if (!dryRun) writeEntry(checkFile, configFile, check);
    }
    report.failures = 0;
  }
  if (first.state === 'unclaimed' || first.state === 'blocked' || first.state === 'unreachable') {
    report.result = first.state;
    report.hint = parsed.verifyCode ? `Open ${parsed.raw} in a browser to claim it, or sign in to hsk-cli for automatic claims` : "Sign in to hsk-cli to claim new mappings automatically";
    const previous = readJson(entryFile, null);
    if (previous?.raw !== parsed.raw) {
      if (!dryRun) writeEntry(entryFile, configFile, { url: parsed.url, raw: parsed.raw, claimed: false, verifyCode: parsed.verifyCode, userCode: parsed.userCode, updatedAt: new Date().toISOString() });
      activity({ kind: 'system', action: 'entry', status: 'blocked', summary: `HSK entry ${parsed.url} is unavailable externally (${first.state}); waiting for claim or sign-in` });
    }
    console.log(JSON.stringify(report));
    process.exit(0);
  }

  const origins = Array.isArray(config.publicOrigins) ? config.publicOrigins : [];
  const next = mergeTunnelOrigin(origins, parsed.url);
  const changed = JSON.stringify(origins) !== JSON.stringify(next);
  report.entry = parsed.url;
  report.configChanged = changed;
  if (changed) {
    if (!dryRun) {
      const owner = statSync(configFile);
      writeFileSync(configFile, JSON.stringify({ ...config, publicOrigins: next }, null, 2) + '\n', { mode: 0o600 });
      try { chownSync(configFile, owner.uid, owner.gid); } catch {  }
    }
    const restarted = dryRun ? { ok: true, out: 'dry-run' } : systemctl('restart', hubUnit);
    report.hubRestarted = restarted.ok;
    activity({ kind: 'system', action: 'entry', status: restarted.ok ? 'success' : 'failed', summary: `Public entry updated to ${parsed.url}${restarted.ok ? "; Hub restarted successfully" : "; Hub restart failed"}` });
    if (restarted.ok && !dryRun) { await delay(3_000); }
  }

  if (!dryRun) writeEntry(entryFile, configFile, { url: parsed.url, raw: parsed.raw, claimed: true, expiresAt: parsed.expiresAt, updatedAt: new Date().toISOString() });
  const second = changed && !dryRun ? await probe(parsed.url) : first;
  report.verified = second.state;
  report.result = changed ? (second.state === 'ok' ? 'updated' : 'updated-unverified') : 'unchanged';
  if (changed && second.state !== 'ok') report.hint = "Domain added to allowlist, but verification failed. Check Hub and tunnel.";
  console.log(JSON.stringify(report));
} catch (error) {
  report.error = String(error.message).slice(0, 300);
  console.log(JSON.stringify(report));
  process.exitCode = 1;
}
