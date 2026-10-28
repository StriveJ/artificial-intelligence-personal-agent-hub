import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertId, readJson, writeJson } from './storage.mjs';

export function createPushService({ store, runtimeDir, now = Date.now }) {
  const producers = new Map(), running = new Map();
  const readPath = join(runtimeDir, 'push-reads.json');
  function publish(type, message, { silent = false } = {}) {
    if (!producers.has(type) || !message || typeof message.title !== 'string' || !message.title.trim() || message.title.length > 240 || typeof message.summary !== 'string' || message.summary.length > 2000 || !message.payload || typeof message.payload !== 'object') throw new Error("Invalid notification content format");
    const id = assertId(message.id || randomUUID());
    const previous = store.readPush(id);
    if (previous && previous.type !== type) throw new Error("Notification ID conflicts with its type");
    const content = { type, title: message.title.trim(), summary: message.summary, payload: message.payload };
    if (previous && JSON.stringify({ type: previous.type, title: previous.title, summary: previous.summary, payload: previous.payload }) === JSON.stringify(content)) return previous;
    const stamp = new Date(now()).toISOString();
    return store.savePush({ version: 1, id, ...content, createdAt: previous?.createdAt || stamp, updatedAt: stamp,
      attentionRevision: silent && previous ? previous.attentionRevision || previous.updatedAt : randomUUID() });
  }
  return {
    register({ id, label, description = '', run }) {
      if (!/^[a-z][a-z0-9-]{1,63}$/.test(id) || producers.has(id) || typeof run !== 'function') throw new Error("Invalid notification producer registration");
      producers.set(id, { id, label, description, run });
    },
    producers: () => [...producers.values()].map(({ id, label, description }) => ({ id, label, description })),
    publish,
    run(id, context = {}) {
      const producer = producers.get(id);
      if (!producer) throw Object.assign(new Error("Notification type not found"), { status: 404 });
      if (running.has(id)) return running.get(id);
      const result = Promise.resolve().then(() => producer.run(context)).then(result => {
        if (result?.push) publish(id, result.push);
        const { push, ...status } = result || {}; return status;
      }).finally(() => running.delete(id));
      running.set(id, result); return result;
    },
    list() {
      const reads = readJson(readPath, {});
      return store.listPushes().map(p => ({ id: p.id, type: p.type, title: p.title, summary: p.summary, createdAt: p.createdAt, updatedAt: p.updatedAt, unread: reads[p.id] !== (p.attentionRevision || p.updatedAt) }));
    },
    markRead(id) {
      const push = store.readPush(id);
      if (!push) throw Object.assign(new Error("Notification not found"), { status: 404 });
      const reads = readJson(readPath, {}); reads[id] = push.attentionRevision || push.updatedAt;
      const ids = new Set(store.listPushes().map(p => p.id));
      writeJson(readPath, Object.fromEntries(Object.entries(reads).filter(([key]) => ids.has(key))));
    },
  };
}
