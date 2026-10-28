#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const node = process.execPath;
const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const repo = resolve('.');
const work = resolve(option('--work', '.aipa-hub/rehearsal-managed'));
const role = option('--role', 'sub');
if (!['main', 'sub'].includes(role)) throw new Error("Rehearsal role must be main or sub");
const startedAt = Date.now();
const log = (...parts) => console.log(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s]`, ...parts);

const run = args => execFileSync(node, args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const json = text => JSON.parse(text);

const rel = relative(repo, work);
if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error("Rehearsal directory must be inside the Hub source repository. Use --work for an isolated test directory.");

if (existsSync(join(work, 'program/control'))) {
  for (const file of ['child.json', 'launcher.lock']) {
    const path = join(work, 'program/control', file);
    if (!existsSync(path)) continue;
    try { const { pid } = json(readFileSync(path, 'utf8')); if (Number.isInteger(pid)) process.kill(pid); } catch {  }
  }
  await delay(1500);
}
if (existsSync(work)) rmSync(work, { recursive: true, force: true });
for (const name of ['keys', 'catalog', 'instance', 'runtime']) mkdirSync(join(work, name), { recursive: true });

const snapRoot = join(tmpdir(), 'aipa-rehearsal-' + Date.now());
process.on('exit', () => { try { rmSync(snapRoot, { recursive: true, force: true }); } catch {  } });
const srcHealthy = join(snapRoot, 'src'), srcUpgrade = join(snapRoot, 'src-upgrade'), srcBroken = join(snapRoot, 'src-broken');
const skip = new Set(['.git', '.aipa-hub', 'aipa-test-tmp', 'node_modules', 'coverage']);
cpSync(repo, srcHealthy, { recursive: true, filter: source => { const sub = source.slice(repo.length + 1); return !sub || !skip.has(sub.split(/[\\/]/)[0]); } });
cpSync(srcHealthy, srcUpgrade, { recursive: true });
cpSync(srcHealthy, srcBroken, { recursive: true });
const runtimeFile = join(srcBroken, 'lib/managed-runtime.mjs'), original = readFileSync(runtimeFile, 'utf8');
const patched = original.replace('releaseId: process.env.AIPA_HUB_RELEASE_ID', "releaseId: 'mismatched-release'");
if (patched === original) throw new Error("Cannot construct a candidate readiness failure. Check the reported fields here.");
writeFileSync(runtimeFile, patched);
for (const [dir, version] of [[srcHealthy,'0.2.0'],[srcUpgrade,'0.2.1'],[srcBroken,'0.2.2']]) {
  for(const file of ['package.json','package-lock.json']){const path=join(dir,file);if(!existsSync(path))continue;const value=JSON.parse(readFileSync(path));value.version=version;if(value.packages?.[''])value.packages[''].version=version;writeFileSync(path,JSON.stringify(value,null,2)+'\n');}
  git(dir, 'init');
  git(dir, '-c', 'user.name=rehearsal', '-c', 'user.email=rehearsal@localhost', 'add', '-A');
  git(dir, '-c', 'user.name=rehearsal', '-c', 'user.email=rehearsal@localhost', 'commit', '-m', 'rehearsal snapshot');
  log("Source snapshot committed", dir === srcHealthy ? 'healthy' : 'broken', git(dir, 'rev-parse', '--short', 'HEAD'));
}

run(['release.mjs', 'keygen', '--out', join(work, 'keys'), '--key-id', 'rehearsal-1']);
const trust = join(work, 'keys/trust.json'), privateKey = join(work, 'keys/private.pem'), catalog = join(work, 'catalog');
const pack = (source, id, version, sequence) => {
  const out = join(catalog, id + '.hubpkg.json');
  log("Package", id, run(['release.mjs', 'pack', '--source', source, '--id', id, '--version', version, '--sequence', String(sequence), '--key', privateKey, '--out', out, '--key-id', 'rehearsal-1']).trim());
};
const baseline = 'rehearsal-baseline', upgrade = 'rehearsal-upgrade', broken = 'rehearsal-broken-candidate';
pack(srcHealthy, baseline, '0.2.0', 1);
pack(srcUpgrade, upgrade, '0.2.1', 2);
pack(srcBroken, broken, '0.2.2', 3);

const root = join(work, 'instance'), runtimeDir = join(work, 'runtime'), base = join(work, 'program');
git(root, 'init');
writeFileSync(join(root, 'AIPA-MANIFEST.yaml'), 'owner: rehearsal-fixture\nversion: 1\n');
mkdirSync(join(root, '.git'), { recursive: true });
writeFileSync(join(root, '.git/aipa-hub-no-push.json'), '{"reason":"rehearsal"}\n');
const installationId = randomUUID();
const configFile = join(work, 'sub-config.json'), installationFile = join(work, 'installation.json');
if (role === 'main') {
  const framework = option('--framework');
  if (!framework || !existsSync(join(framework, 'lib/privacy-policy.mjs'))) throw new Error("main rehearsal requires --framework <generic-core-space/scripts-directory>");
  cpSync(resolve(framework), join(root, 'core-space/scripts'), { recursive: true });
}
writeFileSync(configFile, JSON.stringify({ root, runtimeDir, nodeId: 'rehearsal-node', installationId, token: 'r'.repeat(40), mainUrl: 'http://127.0.0.1:65535', engine: 'codex', testMode: true,
  ...(role === 'main' ? { port: 0, tasks: { 'repo-sync': { enabled: false } }, briefing: { enabled: false } } : {}),
}, null, 2));
writeFileSync(installationFile, JSON.stringify({ base, configFile, role, installationId, catalogDir: catalog, probationMs: 1500 }, null, 2));

log("Bootstrap managed installation", json(run(['install-managed.mjs', '--installation', installationFile, '--package', join(catalog, baseline + '.hubpkg.json'), '--trust', trust])).releaseId);

const launcherLog = [];
const launcher = spawn(node, [join(base, 'bootstrap/hub-launcher.mjs'), '--installation', installationFile], { cwd: base, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
launcher.stdout.on('data', d => launcherLog.push(String(d)));
launcher.stderr.on('data', d => launcherLog.push(String(d)));
let exited = false, exitCode = null; launcher.once('exit', code => { exited = true; exitCode = code; });

function hubctl(command, body) {
  const args = ['hubctl.mjs', 'update', command, '--config', configFile];
  if (body) {
    const bodies = join(work, 'bodies'); mkdirSync(bodies, { recursive: true });
    const file = join(bodies, `${command}-${randomUUID()}.json`); writeFileSync(file, JSON.stringify(body)); args.push('--body', file);
  }
  try { return json(run(args)); }
  catch (error) { throw new Error(`hubctl ${command} failed: ${String((error.stdout || '') + (error.stderr || '')).trim()}`); }
}
async function waitFor(label, predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (exited) throw new Error(`launcher exited (${exitCode ?? 'signal'}): ${launcherLog.join('')}`);
    const value = await predicate(); if (value) return value;
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting: ${label}\n${launcherLog.join('')}`);
}
const status = () => hubctl('status');

await waitFor("Baseline ready", () => { try { const s = status(); return s.current?.releaseId === baseline && s.knownGood?.includes(baseline) ? s : null; } catch { return null; } });
log("Baseline ready", baseline, 'generation', status().current.deploymentGeneration);

const planBody = (releaseId, action) => {
  const s = status();
  return { target: { kind: role, installationId, ...(role === 'sub' ? { nodeId: 'rehearsal-node' } : {}) }, action, releaseId, expectedCurrentReleaseId: s.current.releaseId, expectedDeploymentGeneration: s.current.deploymentGeneration, when: 'idle', waitTimeoutSeconds: 30 };
};
async function switchTo(releaseId, action = 'upgrade') {
  const plan = hubctl('plan', planBody(releaseId, action));
  hubctl('prepare', { id: plan.id });
  const prepared = hubctl('get-plan', { id: plan.id });
  const operation = hubctl('apply', { id: plan.id, expectedPlanRevision: prepared.revision });
  await waitFor(`${action} ${releaseId} ended`, () => status().active === null ? true : null);
  return hubctl('operation', { id: operation.id });
}

const upgraded = await switchTo(upgrade);
const afterUpgrade = status();
log("Upgrade result", upgraded.status, upgraded.result, "Current release", afterUpgrade.current.releaseId);
if (upgraded.status !== 'succeeded' || afterUpgrade.current.releaseId !== upgrade) throw new Error("Normal upgrade failed");

const failedCandidate = await switchTo(broken);
const afterRecovery = status();
log("Bad candidate result", failedCandidate.status, 'recovered=', Boolean(failedCandidate.recovered), "Current release", afterRecovery.current.releaseId);
if (failedCandidate.status !== 'failed' || !failedCandidate.recovered || afterRecovery.current.releaseId !== upgrade) throw new Error("Automatic rollback after candidate failure failed");

const rolledBack = await switchTo(baseline, 'rollback');
const finalStatus = status();
log("Explicit rollback result", rolledBack.status, rolledBack.result, "Current release", finalStatus.current.releaseId);
if (rolledBack.status !== 'succeeded' || finalStatus.current.releaseId !== baseline) throw new Error("Explicit rollback failed");
if (!existsSync(join(root, '.git/aipa-hub-no-push.json'))) throw new Error("No-push marker lost after upgrade or rollback");
if (finalStatus.maintenance !== null) throw new Error("Maintenance remains paused after upgrade or rollback");

console.log('REHEARSAL_RESULT ' + JSON.stringify({
  baseline, upgraded: afterUpgrade.current.releaseId,
  badCandidate: { status: failedCandidate.status, recovered: Boolean(failedCandidate.recovered), error: failedCandidate.error, currentAfterRecovery: afterRecovery.current.releaseId },
  rolledBack: finalStatus.current.releaseId, finalGeneration: finalStatus.current.deploymentGeneration,
  noPushMarkerKept: true, maintenance: finalStatus.maintenance,
  history: hubctl('history').map(o => `${o.kind}:${o.releaseId}:${o.status}${o.recovered ? '+recovered' : ''}`),
}, null, 2));

launcher.kill();
for (let i = 0; i < 120 && !exited; i++) await delay(250);
if (!exited) throw new Error("launcher did not exit within 30 seconds");
console.log('REHEARSAL_OK');
