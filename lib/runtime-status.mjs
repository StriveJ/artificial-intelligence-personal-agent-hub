import { hostname, platform as osPlatform, arch as osArch } from 'node:os';

export function createRuntimeStatus({ startedAt, role, endpoints, getReadiness, getTasks, getNodes, activity, label = "Main Hub", getPublicEntry = () => null }) {
  const host = () => ({ name: safeHost(hostname()), platform: osPlatform(), arch: osArch(), node: process.version });
  const device = node => ({
    id: String(node.id || ''), role: 'sub', label: "Sub Hub", name: plain(node.name, 40) || null,
    status: node.status === 'online' ? 'online' : 'offline',
    lastSeen: node.lastSeen || null,
    taskBusy: node.taskBusy === true,
    platform: plain(node.capabilities?.platform, 16), arch: plain(node.capabilities?.arch, 16),
    releaseId: plain(node.capabilities?.releaseId, 96), testMode: node.capabilities?.testMode === true,
    protocolCompatible: node.protocolCompatible !== false,
    sync: safeSync(node.sync),
  });
  function snapshot() {
    const readiness = getReadiness(), at = Date.now();
    const tasks = getTasks().map(task => ({
      id: task.id, label: task.label, enabled: task.enabled === true, status: task.status,
      nextRunAt: task.nextRunAt || null, lastSuccessAt: task.lastSuccessAt || null,
      lastFinishedAt: task.lastFinishedAt || null, summary: plain(task.result?.summary, 160),
    }));
    const devices = getNodes().map(device);
    return {
      at: new Date(at).toISOString(),
      timeZone:readiness.timeZone||'Asia/Shanghai',
      main: {
        id: 'main-hub-server', role, label, status: 'online',
        releaseId: readiness.releaseId, deploymentGeneration: readiness.deploymentGeneration,
        testMode: readiness.testMode === true, protocol: readiness.protocol, runtimeSchema: readiness.runtimeSchema,
        idle: readiness.idle === true,
        maintenance: readiness.closing ? 'closing' : readiness.maintenance ? 'maintenance' : null,
        core: readiness.core ? { status: plain(readiness.core.status, 16), code: plain(readiness.core.code, 40), summary: plain(readiness.core.summary, 160), sourceSha256: /^[a-f0-9]{64}$/.test(readiness.core.sourceSha256 || '') ? readiness.core.sourceSha256 : null } : null,
        diagnostics:readiness.diagnostics||null,
        startedAt, uptimeMs: Math.max(0, at - Date.parse(startedAt)),
        host: host(), endpoints: { ...endpoints, publicOrigins: [...(endpoints.publicOrigins || [])] },
      },
      devices,
      tasks,
      publicEntry: getPublicEntry(),
      activity: { ...activity.stats(), retention: activity.retention },
    };
  }
  return { snapshot };
}

const plain = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const safeHost = value => plain(value, 64).replace(/[^a-zA-Z0-9._-]/g, '') || 'unknown';
function safeSync(sync) {
  if (!sync || typeof sync !== 'object') return null;
  return {
    status: plain(sync.status, 20) || null, code: plain(sync.code, 40) || null,
    commit: typeof sync.commit === 'string' && /^[a-f0-9]{7,12}$/.test(sync.commit) ? sync.commit : null,
    pushed: sync.pushed === true, pushSuppressed: sync.pushSuppressed === true,
  };
}
