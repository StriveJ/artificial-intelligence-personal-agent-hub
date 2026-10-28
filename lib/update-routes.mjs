import { updateCommand } from './update-ipc.mjs';

export async function handleUpdateRoute({ pathname, method, body, query, key, runtimeDir, send }) {
  if (!pathname.startsWith('/api/admin/updates/')) return false;
  const target = body?.target || query.get('target') || 'main';
  if (typeof target === 'string' ? target !== 'main' : target.kind !== 'main') throw Object.assign(new Error("Use the local updater for sub Hub maintenance; this main Hub does not support remote updates"), { status: 409 });
  const call = (action, args = {}) => updateCommand(runtimeDir, action, args, key);
  const local = await call('status');
  const boundTarget = { kind: 'main', nodeId: 'main', installationId: local.installationId };
  if (typeof target === 'object' && (target.installationId !== local.installationId || target.nodeId !== 'main')) throw Object.assign(new Error("Installation binding mismatch"), { status: 409 });
  const operationView = op => ({ operationId: op.id, planId: op.planId || null, target: boundTarget, kind: ['upgrade', 'rollback'].includes(op.kind) ? 'apply' : op.kind, status: op.status, phase: op.status === 'recovery_required' ? 'recovery_required' : op.phase, result: op.result === 'recovery_required' ? 'failed' : op.result, reasonCode: op.error ? op.recovered ? 'UPGRADE_FAILED_ROLLBACK_VERIFIED' : 'UPDATE_FAILED' : null, message: op.error || '', canCancel: op.status === 'running' && ['queued', 'waiting_idle', 'draining', 'snapshotting'].includes(op.phase), createdAt: op.createdAt, lastObservedAt: op.updatedAt || op.completedAt || op.createdAt, finishedAt: op.completedAt || null, ...(op.original ? { releaseBefore: op.original.releaseId } : {}), ...(op.releaseId ? { releaseAfter: op.recovered ? op.original.releaseId : op.releaseId } : {}) });
  const planView = p => ({ planId: p.id, planRevision: p.revision, request: Object.fromEntries(['target', 'action', 'releaseId', 'expectedCurrentReleaseId', 'expectedDeploymentGeneration', 'when', 'waitTimeoutSeconds'].map(k => [k, p[k]])), state: p.status === 'applied' ? 'invalidated' : Date.now() >= Date.parse(p.expiresAt) ? 'expired' : p.status, testMode: local.current?.testMode !== false, blockers: [], createdAt: p.createdAt, expiresAt: p.expiresAt });
  const suffix = pathname.slice('/api/admin/updates/'.length);
  let result, status = 200, match;
  if (method === 'GET' && suffix === 'status') result = { apiVersion: 'hub-updates/v1', target: boundTarget, releaseId: local.current?.releaseId || 'uninitialized', previousReleaseId: local.previous?.releaseId || null, deploymentGeneration: local.current?.deploymentGeneration || 0, testMode: local.current?.testMode !== false, maintenance: Boolean(local.maintenance), canRollback: local.knownGood.some(id => id !== local.current?.releaseId), blockers: local.configured ? [] : [{ code: 'NO_CATALOG', message: "No trusted release catalog configured" }], activeOperationId: local.active, observedAt: new Date().toISOString(), updaterVersion: String(local.updaterVersion) };
  else if (method === 'GET' && suffix === 'releases') {
    const releases = await call('releases'); result = { releases: releases.map(r => ({ releaseId: r.releaseId, version: r.version, sourceCommit: r.sourceCommit, channel: r.channel || 'stable', role: 'main', platform: process.platform, architecture: process.arch, compatible: true, blockers: [], publishedAt: r.createdAt })), verifiedAt: new Date().toISOString(), metadataExpiresAt: releases.length ? releases.map(r => r.expiresAt).sort()[0] : null, stale: false };
  }
  else if (method === 'GET' && suffix === 'history') {
    const limit = Number(query.get('limit') || 20); if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error("Invalid history limit"), { status: 400 });
    const history = await call('history'), cursor = query.get('cursor'); const index = cursor ? history.findIndex(o => o.id === cursor) + 1 : 0;
    if (cursor && !index) throw Object.assign(new Error("Invalid history cursor"), { status: 400 });
    result = { items: history.slice(index, index + limit).map(operationView), nextCursor: history.length > index + limit ? history[index + limit - 1].id : null };
  } else if (method === 'POST' && suffix === 'check') { if (!body.target || !['stable', 'preview'].includes(body.channel)) throw Object.assign(new Error("Target and release channel are required"), { status: 400 }); result = operationView(await call('check', body)); }
  else if (method === 'POST' && suffix === 'plans') { result = planView(await call('plan', body)); status = 201; }
  else if ((match = suffix.match(/^plans\/([a-f0-9-]{36})(?:\/(prepare|apply))?$/))) {
    const [, id, action] = match;
    if (method === 'GET' && !action) result = planView(await call('get-plan', { id }));
    else if (method === 'POST' && action) { result = operationView(await call(action, { ...body, id })); status = 202; }
  } else if ((match = suffix.match(/^operations\/([a-f0-9-]{36})(?:\/(cancel))?$/))) {
    const [, id, action] = match;
    if (method === 'GET' && !action) result = operationView(await call('operation', { id }));
    else if (method === 'POST' && action) { result = operationView(await call('cancel', { id })); status = 202; }
  }
  if (result === undefined) throw Object.assign(new Error("Maintenance endpoint not found"), { status: 404 });
  send(result, status); return true;
}
