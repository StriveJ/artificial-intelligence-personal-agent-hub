import { join } from 'node:path';
import { mkdirSync, readdirSync } from 'node:fs';
import { readJson, writeJson, assertId, titleForTurn } from './storage.mjs';
import { turnOptions, sameTurnRequest } from './turn-request.mjs';
import {attachmentEventTextV1} from './attachments.mjs';

export function createCaptureInbox({ runtimeDir, store, schedule, record, attachments }) {
  const dir = join(runtimeDir, 'capture-inbox'); mkdirSync(dir, { recursive: true });
  const records = readdirSync(dir).filter(n => /^(note|turn)-[a-zA-Z0-9_-]{8,80}\.json$/.test(n)).map(n => readJson(join(dir, n)));
  const save = r => writeJson(join(dir, `${r.kind}-${r.id}.json`), r);
  function enqueue(kind, id, data) {
    assertId(id); if (!['note', 'turn'].includes(kind)) throw new Error("Invalid input kind");
    const previous = records.find(r => r.id === id && r.kind === kind);
    if (previous) { if (JSON.stringify(previous.data) !== JSON.stringify(data)) throw Object.assign(new Error("Repeated input has different content"), { status: 409 }); return previous; }
    if (records.filter(r => r.status === 'pending').length >= 200) throw Object.assign(new Error("Too many inputs await archival. Keep your input and retry later."), { status: 503 });
    const r = { id, kind, data, createdAt: new Date().toISOString(), status: 'pending', recovered: false }; save(r); records.push(r); return r;
  }
  for (const r of records) if (r.status === 'pending') r.recovered = true;
  function virtualChat(id) {
    const chat = store.readChat(id); if (!chat) return null;
    for (const r of records.filter(r => r.kind === 'turn' && r.data.chatId === id && r.status === 'pending')) {
      if (!chat.turns.some(t => t.id === r.id)) chat.turns.push({ id: r.id, input: r.data.text, ...turnOptions(r.data), created: r.createdAt, status: r.recovered ? 'interrupted' : 'queued', warning: "Original input saved; awaiting archival" });
    }
    return chat;
  }
  async function flush({interruptModels=false}={}) {
    for (const r of records.filter(r => r.status === 'pending')) {
      attachments?.archive(r.data.attachmentIds || []);
      if (r.kind === 'note') {
        const note = store.saveNote(r.id, r.data.text, r.createdAt, r.data.attachmentIds || []); await record('user_message', note.text, 'notes', `hub-note-${r.id}`, r.createdAt);
        if(note.attachmentIds?.length)await record('tool_result',attachmentEventTextV1('',note.attachmentIds),'notes',`hub-note-attachments-${r.id}`,r.createdAt);
      } else {
        const chat = store.readChat(r.data.chatId); if (!chat) { r.status = 'needs-review'; save(r); continue; }
        const existing = chat.turns.find(t => t.id === r.id);
        if (existing && !sameTurnRequest(existing, r.data.text, r.data)) { r.status = 'needs-review'; save(r); continue; }
        if (!existing) {
          const interrupted=r.recovered||interruptModels;
          const turn = { id: r.id, input: r.data.text, ...turnOptions(r.data), created: r.createdAt, status: interrupted ? 'interrupted' : 'queued', consentedAt: r.createdAt, attempts: 1 };
          if(turn.attachmentIds.length && !turn.analyzeImages) {turn.status='completed';turn.processing='storage-only';turn.answer="Images and descriptions saved without analysis or sending to a model.";}
          if(turn.analyzeImages)turn.processing=turn.allowWeb?'vision-web':'vision';
          if (interrupted && (!turn.attachmentIds.length || turn.analyzeImages)) turn.error = "Service restarted or entered maintenance. Text and images are preserved; renew consent and retry.";
          chat.turns.push(turn); chat.updated = r.createdAt; if (chat.turns.length === 1) chat.title = titleForTurn(turn); store.saveChat(chat);
          await record('user_message', turn.input, chat.id, `hub-user-${r.id}`, r.createdAt,turn.project??chat.project??'');
          if(turn.attachmentIds?.length)await record('tool_result',attachmentEventTextV1('',turn.attachmentIds,turn.analyzeImages),chat.id,`hub-attachments-${r.id}`,r.createdAt,turn.project??chat.project??'');
          if (!interrupted && (!turn.attachmentIds.length || turn.analyzeImages)) schedule(chat.id, r.id);
        }
      }
      r.status = 'delivered'; save(r);
    }
  }
  return { enqueue, flush, virtualChat, pending: () => records.some(r => r.status === 'pending') };
}
