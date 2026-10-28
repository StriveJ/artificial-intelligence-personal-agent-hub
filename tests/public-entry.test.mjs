// Synthetic tunnel log and origin fixtures; no real deployment identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTunnelLog, mergeTunnelOrigin, needsRebuild, tunnelOrigin } from '../lib/public-entry.mjs';

const LOG = `
[AI_INFO] Connecting to mux server hfw-hz-1.yctou.net:6064 (protocol: tcp) ...
  "publicUrl": "https://synthetic-old.hz-1.aicp.space",
  "expires_at": "2026-10-18T22:57:02+08:00"
  "publicUrl": "https://synthetic-new.hz-1.aicp.space?verify_code=0000",
  "expires_at": "2026-10-19T08:40:18+08:00"
`;

test("Tunnel logs use the latest assignment, remove query strings, and retain claim hints", () => {
  const parsed = parseTunnelLog(LOG);
  assert.equal(parsed.url, 'https://synthetic-new.hz-1.aicp.space');
  assert.equal(parsed.raw, 'https://synthetic-new.hz-1.aicp.space?verify_code=0000');
  assert.equal(parsed.verifyCode, '0000');
  assert.equal(parsed.expiresAt, '2026-10-19T00:40:18.000Z');
  assert.equal(parsed.claimed, false);
  assert.equal(parseTunnelLog('nothing here'), null);
});

test("Only HSK trial subdomains are accepted", () => {
  assert.equal(tunnelOrigin('https://abc123.hz-1.aicp.space'), 'https://abc123.hz-1.aicp.space');
  assert.equal(tunnelOrigin('https://abc123.hz-1.aicp.space?verify_code=1'), 'https://abc123.hz-1.aicp.space');
  assert.equal(tunnelOrigin('http://abc123.hz-1.aicp.space'), null, "HTTPS only");
  assert.equal(tunnelOrigin('https://evil.example.com'), null);
  assert.equal(tunnelOrigin('https://abc.hz-1.aicp.space.evil.com'), null);
  assert.equal(tunnelOrigin(''), null);
});

test("Allowlist follows trial subdomain changes while preserving other origins", () => {
  const origins = ['https://synthetic-hub.tail000000.ts.net', 'https://synthetic-old.hz-1.aicp.space', 'https://synthetic-tunnel.goho.co'];
  assert.deepEqual(mergeTunnelOrigin(origins, 'https://synthetic-new.hz-1.aicp.space'), [
    'https://synthetic-hub.tail000000.ts.net', 'https://synthetic-tunnel.goho.co', 'https://synthetic-new.hz-1.aicp.space',
  ]);
  assert.deepEqual(mergeTunnelOrigin(['https://synthetic-new.hz-1.aicp.space'], 'https://synthetic-new.hz-1.aicp.space'), ['https://synthetic-new.hz-1.aicp.space']);
});

test("Expiring entries rebuild early to prevent unexpected disconnection", () => {
  const now = Date.parse('2026-10-19T08:00:00+08:00');
  assert.equal(needsRebuild('2026-10-19T08:10:00+08:00', now), true);
  assert.equal(needsRebuild('2026-10-19T09:00:00+08:00', now), false);
  assert.equal(needsRebuild(null, now), false);
});

test("Tunnel helper rejects missing explicit configuration without guessing maintainer paths", () => {
  for (const args of [[], ['--config'], ['--config', '--dry-run']]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../hsk-entry.mjs', import.meta.url)), ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Explicit --config/i);
    assert.doesNotMatch(result.stdout + result.stderr, /\/home\/jun/);
  }
});
