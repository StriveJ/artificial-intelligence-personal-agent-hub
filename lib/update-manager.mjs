import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson, writeJson, safeInstancePath } from './storage.mjs';
import { createTaskGate } from './task-gate.mjs';
import { verifyRelease, stageRelease, verifyInstalled, releaseIdOK, UPDATER_VERSION, canonical, sha256 } from './release-package.mjs';
import { snapshotInstallation } from './update-snapshot.mjs';

const failure = (message, status = 409) => Object.assign(new Error(message), { status });
const terminal = op => ['succeeded', 'failed', 'cancelled', 'recovery_required'].includes(op.status);
const updateAccess=()=>({schema:1,operation:'hub-program-update',dataAccess:'instance-snapshot',reads:['installation-config','instance/**','runtime/**'],writes:['managed-program','installation-control','snapshot-copy'],startsHub:true,restoresPersonalData:false});
function requireDataAccess(value){
 if(['no-personal-data','framework-only'].includes(value))throw Object.assign(failure("Hub updates require instance/runtime snapshots and starting a candidate Hub. A no-personal-data policy rejects this request; services have not stopped and no snapshot has run."),{code:'personal_data_access_required'});
 if(value!==undefined&&value!=='instance-snapshot')throw failure("Invalid program-update data access policy",400);
}

export function createUpdateManager({ base, configFile, role, installationId, catalogDir, driver, now = Date.now, probationMs = 60_000 }) {
  base = realpathSync(base); configFile = realpathSync(configFile);
  if (!['main', 'sub'].includes(role) || typeof installationId !== 'string') throw failure("Invalid installation identity");
  const config = readJson(configFile, null), root = realpathSync(config.root), runtimeDir = realpathSync(config.runtimeDir);
  if (config.testMode === false && existsSync(join(root, '.git/aipa-hub-no-push.json'))) throw failure("A permanent test instance cannot bootstrap as a production installation");
  for (const path of [root, runtimeDir]) { const rel = relative(path, base); if (!rel || !rel.startsWith('..') && !isAbsolute(rel)) throw failure("Update directory cannot be inside the instance or runtime directory"); }
  const control = join(base, 'control'), releases = join(base, 'releases'); mkdirSync(control, { recursive: true }); mkdirSync(releases, { recursive: true });
  const path = join(control, 'updates.json'), state = readJson(path, { version: 1, highestSequence: 0, plans: {}, operations: {}, keys: {}, knownGood: {}, active: null });
  const gate = createTaskGate(root), current = () => readJson(join(control, 'current.json'), null);
  const trust = () => readJson(join(control, 'trust.json'), null);
  const save = () => writeJson(path, state);
  const frozen = () => existsSync(join(base, 'cleared.json')) || config.managedBase && existsSync(join(config.managedBase, 'cleared.json')) || !existsSync(root);
  function assertInstallation() {
    if (frozen()) throw failure("Installation cleared; updates and rebuilding are prohibited");
    const c = readJson(configFile, null);
    if (realpathSync(c.root) !== root || realpathSync(c.runtimeDir) !== runtimeDir || c.testMode !== config.testMode || c.installationId && c.installationId !== installationId) throw failure("Installation binding or test mode changed");
  }
  function readCurrent() {
    const c = current(); if (!c || c.installationId !== installationId || !releaseIdOK(c.releaseId) || !Number.isSafeInteger(c.deploymentGeneration)) throw failure("Invalid current release pointer"); return c;
  }
  const packagePath = id => { if (!releaseIdOK(id)) throw failure("Invalid release ID", 400); if (!catalogDir) throw failure("No trusted release catalog configured"); return safeInstancePath(catalogDir, join(catalogDir, id + '.hubpkg.json')); };
  const verify = (id, rollback = false) => verifyRelease(packagePath(id), trust(), { role, allowExpired: rollback, now: now() });
  function record(kind, result, detail = {}) { const id = randomUUID(); const op = { id, kind, status: 'succeeded', phase: 'verified', result, createdAt: new Date(now()).toISOString(), ...detail }; state.operations[id] = op; save(); return structuredClone(op); }
  function idempotent(key, body, action) {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9._:-]{8,128}$/.test(key)) throw failure("A valid Idempotency-Key is required", 400);
    const fingerprint = sha256(canonical(body)), previous = state.keys[key];
    if (previous) { if (previous.fingerprint !== fingerprint) throw failure("Idempotency key does not match request body"); return structuredClone(previous.result); }
    const result = action(); state.keys[key] = { fingerprint, result }; save(); return structuredClone(result);
  }
  function listReleases() {
    assertInstallation(); if (!catalogDir) return [];
    const items = [];
    for (const file of readdirSync(catalogDir).filter(n => n.endsWith('.hubpkg.json')).sort()) {
      try { const checked = verify(file.slice(0, -12)); items.push({ ...checked.manifest, files: undefined, digest: checked.digest }); } catch {  }
    }
    return items;
  }
  function bound(plan, expiry = true) {
    assertInstallation(); const c = readCurrent();
    if (c.releaseId !== plan.expectedCurrentReleaseId || c.deploymentGeneration !== plan.expectedDeploymentGeneration || plan.target.installationId !== installationId) throw failure("Plan binding expired. Check again.");
    if (expiry && now() >= Date.parse(plan.expiresAt)) throw failure("Update plan expired");
    return c;
  }
  function createPlan(body) {
    requireDataAccess(body.dataAccess);
    const c = readCurrent(); assertInstallation();
    if (!['upgrade', 'rollback'].includes(body.action) || !releaseIdOK(body.releaseId) || body.target?.kind !== role || body.target.installationId !== installationId || body.expectedCurrentReleaseId !== c.releaseId || body.expectedDeploymentGeneration !== c.deploymentGeneration || body.when !== 'idle' || !Number.isInteger(body.waitTimeoutSeconds) || body.waitTimeoutSeconds < 1 || body.waitTimeoutSeconds > 1800) throw failure("Update plan parameters or current generation mismatch");
    if (body.releaseId === c.releaseId) throw failure("Target release is already running");
    const checked = verify(body.releaseId, body.action === 'rollback');
    if (body.action === 'rollback' ? state.knownGood[body.releaseId]?.digest !== checked.digest : checked.manifest.sequence < state.highestSequence) throw failure("Unaccepted rollback releases or older release metadata are rejected");
    const plan = { ...body, dataAccess:'instance-snapshot',access:updateAccess(),id: randomUUID(), revision: 1, digest: checked.digest, status: 'planned', createdAt: new Date(now()).toISOString(), expiresAt: new Date(Math.min(now() + 86400_000, body.action === 'rollback' ? Infinity : Date.parse(checked.manifest.expiresAt))).toISOString() };
    state.plans[plan.id] = plan; save(); return plan;
  }
  function getPlan(id) { const p = state.plans[id]; if (!p) throw failure("Plan not found", 404); return structuredClone(p); }
  function prepare(id) {
    const plan = state.plans[id]; if (!plan) throw failure("Plan not found", 404); bound(plan);
    const checked = verify(plan.releaseId, plan.action === 'rollback'); if (checked.digest !== plan.digest) throw failure("Release content changed");
    stageRelease(releases, checked); plan.status = 'prepared'; plan.revision++; save();
    return record('prepare', 'prepared', { planId: id, releaseId: plan.releaseId, planRevision: plan.revision });
  }
  function phase(op, phase) { op.phase = phase; op.updatedAt = new Date(now()).toISOString(); save(); }
  async function probe(op, c) {
    const until = now() + probationMs;
    do { if (!await driver.ready(c)) throw failure("Candidate readiness check failed"); if (now() >= until) return; await delay(Math.min(1000, probationMs)); } while (true);
  }
  async function rollback(op) {
    phase(op, 'rolling_back'); await driver.stop();
    const old = op.original, installed = verifyRelease(join(releases, old.releaseId + '.hubpkg.json'), trust(), { role, allowExpired: true, now: now() });
    if (state.knownGood[old.releaseId]?.digest !== installed.digest || old.digest !== installed.digest) throw failure("No verifiable accepted rollback release");
    verifyInstalled(join(releases, old.releaseId), installed.manifest);
    const c = { ...old, deploymentGeneration: readCurrent().deploymentGeneration + 1 }; writeJson(join(control, 'current.json'), c);
    await driver.start(c); await probe(op, c); return c;
  }
  async function execute(op) {
    const plan = state.plans[op.planId]; let cut = false;
    try {
      bound(plan); phase(op, 'waiting_idle'); gate.pause(op.id, 'update');
      const deadline = now() + plan.waitTimeoutSeconds * 1000;
      while (gate.state()) {
        if (op.cancelRequested) throw failure("Operation cancelled");
        if (now() >= deadline) throw failure("Timed out waiting for idle; existing tasks preserved");
        await delay(100);
      }
      if (op.cancelRequested) throw failure("Operation cancelled");
      bound(plan); phase(op, 'draining');
      await driver.stop(); bound(plan); phase(op, 'snapshotting');
      op.snapshot = await snapshotInstallation({ root, runtimeDir, configFile, destination: join(base, 'snapshots', op.id) }); save();
      if (op.cancelRequested) throw failure("Operation cancelled");
      const checked = verify(plan.releaseId, plan.action === 'rollback'); if (checked.digest !== plan.digest) throw failure("Target release content changed");
      const targetDir = join(releases, plan.releaseId); verifyInstalled(targetDir, checked.manifest);
      bound(plan); phase(op, 'switching');
      const c = { releaseId: plan.releaseId, installationId, deploymentGeneration: op.original.deploymentGeneration + 1, digest: checked.digest, role, runtimeSchema: 1, testMode: config.testMode !== false };
      writeJson(join(control, 'current.json'), c); cut = true; phase(op, 'starting');
      await driver.start(c); phase(op, 'probation'); await probe(op, c);
      phase(op, 'committing'); state.knownGood[c.releaseId] = { digest: checked.digest, verifiedAt: new Date(now()).toISOString() };
      state.highestSequence = Math.max(state.highestSequence, checked.manifest.sequence);
      writeJson(join(control, 'previous.json'), op.original);
      op.status = 'succeeded'; op.result = plan.action === 'rollback' ? 'rolled_back' : 'installed'; plan.status = 'applied';
    } catch (error) {
      op.error = String(error.message).slice(0, 200); op.status = op.cancelRequested && !cut ? 'cancelled' : 'failed'; op.result = op.status;
      try {
        if (cut) { await rollback(op); op.recovered = true; }
        else if (!frozen()) await driver.start(readCurrent());
      } catch { op.status = 'recovery_required'; op.error = "Recovery incomplete; maintenance remains paused. Run the local recovery command."; }
    }
    op.completedAt = new Date(now()).toISOString(); state.active = op.status === 'recovery_required' ? op.id : null; save();
    if (op.status !== 'recovery_required' && gate.maintenance()?.operationId === op.id) gate.resume(op.id);
    return structuredClone(op);
  }
  let running;
  function apply(id, revision) {
    const plan = state.plans[id]; if (!plan || plan.status !== 'prepared' || revision !== plan.revision || state.active) throw failure("Plan unprepared, revision changed, or another operation active");
    requireDataAccess(plan.dataAccess);
    bound(plan); if (state.knownGood[readCurrent().releaseId]?.digest !== readCurrent().digest) throw failure("Current release has no accepted rollback baseline");
    const idOp = randomUUID(), op = { id: idOp, kind: plan.action, planId: id, releaseId: plan.releaseId, original: readCurrent(), status: 'running', phase: 'queued', result: null, createdAt: new Date(now()).toISOString() };
    state.operations[idOp] = op; state.active = idOp; save();
    running = Promise.resolve().then(() => execute(op)).finally(() => { running = null; }); return structuredClone(op);
  }
  async function recover() {
    if (running) throw failure("Update still running; concurrent recovery prohibited");
    const op = state.operations[state.active];
    if (!op) {
      const m = gate.maintenance();
      if (m?.operationId === 'bootstrap-baseline') { await driver.start(readCurrent()); await acceptBaseline(); }
      else if (m && terminal(state.operations[m.operationId] || {})) gate.resume(m.operationId);
      return;
    }
    gate.pause(op.id, 'update');
    if (gate.state()) throw failure("Recovery waits for instance tasks to finish");
    try {
      if (['switching', 'starting', 'probation', 'committing', 'rolling_back'].includes(op.phase)) { await rollback(op); op.recovered = true; }
      else await driver.start(readCurrent());
      op.status = 'failed'; op.result = 'failed'; op.error = "Previous update interrupted; accepted release restored"; state.active = null; save(); gate.resume(op.id);
    } catch (error) { op.status = 'recovery_required'; op.error = String(error.message).slice(0, 200); save(); throw error; }
  }
  function bootstrap(checked) {
    assertInstallation(); if (current()) throw failure("Installation already bootstrapped");
    const baselineGate = gate.pause('bootstrap-baseline', 'update'); if (!baselineGate.idle) throw failure("Baseline bootstrap waits for instance tasks to finish");
    const path = stageRelease(releases, checked); verifyInstalled(path, checked.manifest);
    const c = { releaseId: checked.manifest.releaseId, installationId, deploymentGeneration: 1, digest: checked.digest, role, runtimeSchema: 1, testMode: config.testMode !== false };
    writeJson(join(control, 'current.json'), c); save(); return c;
  }
  async function acceptBaseline() {
    if (state.active) throw failure("Operation in progress"); const c = readCurrent();
    const installed = verifyRelease(join(releases, c.releaseId + '.hubpkg.json'), trust(), { role, allowExpired: true, now: now() }); if (installed.digest !== c.digest) throw failure("Baseline signed package identity mismatch"); verifyInstalled(join(releases, c.releaseId), installed.manifest);
    await probe(null, c); state.knownGood[c.releaseId] = { digest: c.digest, verifiedAt: new Date(now()).toISOString() }; state.highestSequence = Math.max(state.highestSequence, installed.manifest.sequence); save();
    if (gate.maintenance()?.operationId === 'bootstrap-baseline') gate.resume('bootstrap-baseline');
  }
  mkdirSync(join(base, 'snapshots'), { recursive: true });
  return { bootstrap, acceptBaseline, recover, idempotent, listReleases, createPlan, getPlan, prepare, apply,
    current: readCurrent, wait: () => running,
    status: () => ({ updaterVersion: UPDATER_VERSION, role, installationId, current: current(), previous: readJson(join(control, 'previous.json'), null), maintenance: gate.maintenance(), active: state.active, configured: Boolean(catalogDir), knownGood: Object.keys(state.knownGood),updateAccess:updateAccess() }),
    check: () => record('check', 'check_complete', { releases: listReleases() }),
    operation(id) { const op = state.operations[id]; if (!op) throw failure("Operation not found", 404); return structuredClone(op); },
    cancel(id) { const op = state.operations[id]; if (!op || terminal(op) || !['queued', 'waiting_idle', 'draining', 'snapshotting'].includes(op.phase)) throw failure("Cannot cancel this phase"); op.cancelRequested = true; save(); return structuredClone(op); },
    history: () => Object.values(state.operations).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(o => structuredClone(o)),
  };
}
