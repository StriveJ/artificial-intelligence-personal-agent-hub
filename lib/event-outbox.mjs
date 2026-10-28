import { join } from 'node:path';
import { readJson, writeJson } from './storage.mjs';

export function createEventOutbox(runtimeDir, deliver) {
  const path = join(runtimeDir, 'event-outbox.json');
  const state = readJson(path, { records: {} }); let running;
  const save = () => writeJson(path, state);
  function enqueue(type, text, chatId, id, occurredAt = new Date().toISOString(),project='') {
    const old = state.records[id];
    if (old && (old.type !== type || old.text !== text || old.chatId !== chatId || (old.project||'')!==project)) throw new Error("Event ID has different content");
    if (!Number.isFinite(Date.parse(occurredAt))) throw new Error("Invalid event occurrence time");
    if (!old) { state.records[id] = { id, type, text, chatId, occurredAt, project,status: 'pending' }; save(); }
  }
  async function flush() {
    if (running) return running;
    running = (async () => {
      for (const record of Object.values(state.records).filter(r => r.status === 'pending')) {
        let warning;
        try { warning = await deliver(record.type, record.text, record.chatId, record.id, record.occurredAt,record.project); } catch { warning = 'delivery-failed'; }
        if (!warning) { record.status = 'delivered'; record.deliveredAt = new Date().toISOString(); save(); }
      }
    })().finally(() => { running = null; }); return running;
  }
  return { enqueue, flush, async record(type, text, chatId, id, occurredAt,project) {
    enqueue(type, text, chatId, id, occurredAt,project); await flush();
    return state.records[id].status === 'delivered' ? null : "Original content saved; event registration pending";
  }, pending: () => Object.values(state.records).filter(r => r.status === 'pending').length };
}
