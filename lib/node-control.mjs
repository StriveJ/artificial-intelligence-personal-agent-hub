import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { readJson, writeJson } from './storage.mjs';
import {HUB_PROTOCOL} from './support-contract.mjs';
const hash = s => createHash('sha256').update(String(s)).digest();
const idOK = s => typeof s === 'string' && /^[a-zA-Z0-9_-]{3,80}$/.test(s);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// Member identity (T1): a device carries one member. `id` addresses it and never changes;
// `name`/`aliases` are how it is called, and may be changed. Persona is presentation only.
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;
const PERSONA_KEYS = new Set(['tone', 'initiative']);
const INITIATIVE = new Set(['low', 'normal', 'high']);
const fold = s => String(s).trim().toLowerCase();

function memberFrom(body, state, id) {
  if (body === undefined) return null;
  if (!body || typeof body !== 'object') throw fail("Invalid member identity");
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!NAME_RE.test(name)) throw fail("Member name must be 1-40 characters of letters, digits, space, dot, hyphen or underscore");
  const aliases = body.aliases === undefined ? [] : body.aliases;
  if (!Array.isArray(aliases) || aliases.length > 5) throw fail("Member aliases must be an array of at most 5 names");
  const cleaned = [...new Set(aliases.map(a => (typeof a === 'string' ? a.trim() : '')).filter(Boolean))];
  if (cleaned.some(a => !NAME_RE.test(a))) throw fail("Member alias must be 1-40 characters of letters, digits, space, dot, hyphen or underscore");
  const persona = body.persona === undefined ? null : body.persona;
  let stored = null;
  if (persona !== null) {
    if (typeof persona !== 'object' || Array.isArray(persona)) throw fail("Invalid member persona");
    const unknown = Object.keys(persona).filter(k => !PERSONA_KEYS.has(k));
    if (unknown.length) throw fail(`Unknown member persona fields: ${unknown.join(', ')}`);
    stored = {};
    if (persona.tone !== undefined) {
      if (typeof persona.tone !== 'string' || persona.tone.length > 200) throw fail("Invalid member tone");
      stored.tone = persona.tone;
    }
    if (persona.initiative !== undefined) {
      if (!INITIATIVE.has(persona.initiative)) throw fail("Member initiative must be low, normal or high");
      stored.initiative = persona.initiative;
    }
  }
  const wanted = new Set([fold(name), ...cleaned.map(fold)]);
  for (const other of Object.values(state.nodes)) {
    if (other === state.nodes[id] || other.removedAt || !other.member) continue;
    for (const taken of [other.member.name, ...(other.member.aliases || [])]) if (wanted.has(fold(taken)) && fold(taken)) throw fail(`Member name already in use: ${taken}`, 409);
  }
  return { name, aliases: cleaned, persona: stored, updatedAt: new Date().toISOString() };
}

export function createNodeControl({ runtimeDir, now = Date.now, offlineAfterMs = 90_000 }) {
  const path = join(runtimeDir, 'nodes.json');
  const state = readJson(path, { version: 1, nodes: {}, operations: {} });
  const save = () => writeJson(path, state);
  for (const op of Object.values(state.operations)) if (op.kind === 'clear' && op.status === 'success' && state.nodes[op.nodeId]?.installationId === op.installationId) state.nodes[op.nodeId].removedAt ||= op.completedAt;
  function enroll(id) {
    if (!idOK(id) || state.nodes[id] && !state.nodes[id].removedAt) throw fail("Invalid or already registered device ID", 409);
    const token = randomBytes(32).toString('base64url');
    state.nodes[id] = { id, installationId: randomUUID(), tokenHash: hash(token).toString('hex'), lastSeen: null, disabled: false };
    save(); return { id, installationId: state.nodes[id].installationId, token };
  }
  function authenticate(id, token, allowDisabled = false) {
    const n = state.nodes[id];
    if (!n || n.disabled && !allowDisabled || typeof token !== 'string' || !timingSafeEqual(hash(token), Buffer.from(n.tokenHash, 'hex'))) throw fail("Device credentials invalid or device removed", 401);
    return n;
  }
  const list = () => Object.values(state.nodes).filter(n => !n.removedAt).map(({ tokenHash, ...n }) => ({ ...n, status: !n.disabled && n.lastSeen && now() - Date.parse(n.lastSeen) < offlineAfterMs ? 'online' : 'offline' }));
  function request(id, kind, requestId = randomUUID()) {
    const n = state.nodes[id];
    if (!n || !['sync', 'clear'].includes(kind) || !idOK(requestId)) throw fail("Invalid device operation");
    const old = state.operations[requestId];
    if (old) { if (old.nodeId !== id || old.kind !== kind || old.installationId !== n.installationId) throw fail("Duplicate operation ID", 409); return old; }
    const operation = { id: requestId, nodeId: id, installationId: n.installationId, kind, status: 'queued', createdAt: new Date(now()).toISOString() };
    state.operations[requestId] = operation; save(); return operation;
  }
  function poll(id, token, body) {
    const n = authenticate(id, token);
    if (body.installationId !== n.installationId) throw fail("Installation binding mismatch", 409);
    n.lastSeen = new Date(now()).toISOString();
    n.sync = body.sync && typeof body.sync === 'object' ? { status: String(body.sync.status || '').slice(0, 30), code: String(body.sync.code || '').slice(0, 60), commit: String(body.sync.commit || '').slice(0, 40), pushed: body.sync.pushed === true, pushSuppressed: body.sync.pushSuppressed === true } : null;
    n.taskBusy = body.taskBusy === true;
    const c = body.capabilities;
    if (c && (typeof c !== 'object' || !Number.isInteger(c.protocolMin) || !Number.isInteger(c.protocolMax) || c.protocolMin > c.protocolMax)) throw fail("Invalid device protocol capabilities");
    n.protocolCompatible = !c || c.protocolMin <= HUB_PROTOCOL.max && c.protocolMax >= HUB_PROTOCOL.min;
    n.capabilities = c ? { protocolMin: c.protocolMin, protocolMax: c.protocolMax, releaseId: String(c.releaseId || '').slice(0, 96), deploymentGeneration: Number.isSafeInteger(c.deploymentGeneration) ? c.deploymentGeneration : 0, runtimeSchema: c.runtimeSchema, updaterVersion: c.updaterVersion || null, platform: String(c.platform || '').slice(0, 20), arch: String(c.arch || '').slice(0, 20), testMode: c.testMode === true } : { legacy: true };
    const member = memberFrom(body.member, state, id);
    if (member) n.member = member;
    const operations = n.protocolCompatible ? Object.values(state.operations).filter(o => o.nodeId === id && o.installationId === n.installationId && o.status === 'queued').slice(0, 20) : [];
    save(); return { operations, protocol:HUB_PROTOCOL.max, compatible: n.protocolCompatible };
  }
  function ack(id, token, body) {
    const op = state.operations[body.id];
    const n = authenticate(id, token, op?.kind === 'clear' && op?.status === 'success' && op?.nodeId === id);
    if (!op || op.nodeId !== id || op.installationId !== n.installationId) throw fail("Operation does not belong to this device", 403);
    if (!['success', 'deferred', 'error'].includes(body.status)) throw fail("Invalid operation result");
    if (op.status !== 'queued') return op;
    if (body.status !== 'deferred') { op.status = body.status; op.completedAt = new Date(now()).toISOString(); }
    op.result = { status: body.status, code: String(body.code || '').slice(0, 60), commit: String(body.commit || '').slice(0, 40), pushed: body.pushed === true, pushSuppressed: body.pushSuppressed === true };
    if (op.kind === 'clear' && body.status === 'success' && body.code === 'cleared') { n.disabled = true; n.removedAt = op.completedAt; }
    save(); return op;
  }
  function offline(id) { if (!state.nodes[id]) throw fail("Device not found", 404); state.nodes[id].disabled = true; save(); }
  // Address a device by its stable id or by the member name/alias it advertises. Ambiguous
  // names are rejected at poll time, so a name lookup can only match one live device.
  function resolve(ref) {
    const key = fold(ref ?? '');
    if (!key) return null;
    for (const n of Object.values(state.nodes)) if (!n.removedAt && fold(n.id) === key) return n.id;
    for (const n of Object.values(state.nodes)) {
      if (n.removedAt || !n.member) continue;
      if (fold(n.member.name) === key || (n.member.aliases || []).some(a => fold(a) === key)) return n.id;
    }
    return null;
  }
  return { enroll, list, request, poll, ack, offline, resolve, operations: () => Object.values(state.operations) };
}
