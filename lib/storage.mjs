import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, realpathSync, openSync, fsyncSync, closeSync, lstatSync } from 'node:fs';
import { join, dirname, relative, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(id);
export function titleForTurn(turn = {}) {
  const text = typeof turn.input === 'string' ? turn.input.trim() : '';
  if (text) return text.slice(0, 36);
  const count = Array.isArray(turn.attachmentIds) ? turn.attachmentIds.length : 0;
  return count ? `${turn.analyzeImages ? "Image conversation" : "Image note"}${count > 1 ? ` (${count} images)` : ''}` : "New conversation";
}
export function displayChatTitle(chat) {
  return typeof chat.title === 'string' && chat.title.trim() ? chat.title.trim() : titleForTurn(chat.turns?.[0]);
}
export function assertId(id) {
  if (!validId(id)) throw Object.assign(new Error("Invalid record ID"), { status: 400 });
  return id;
}
export function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
export const writeJson = (path, value) => atomicWrite(path, JSON.stringify(value, null, 2) + '\n');
export function safeInstancePath(root, path) {
  const base = realpathSync(root), full = resolve(path), rel = relative(base, full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error("Instance path escapes its root");
  let current = base;
  for (const part of rel.split(/[\\/]/)) { current = join(current, part); try { if (lstatSync(current).isSymbolicLink()) throw new Error("Instance data paths cannot traverse links"); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  return full;
}
export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error("Cannot read record. Original file preserved; check local logs.", { cause: error }); }
}
function inside(root, path) {
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error("Data directory cannot point outside the instance");
}
export function createStore(instanceRoot) {
  const root = realpathSync(instanceRoot);
  if (!existsSync(join(root, 'AIPA-MANIFEST.yaml'))) throw new Error("Specify a personal AIPA instance, not the Origin build repository");
  let base = root;
  for (const part of ['user-space', 'logs', 'hub']) {
    base = join(base, part);
    if (existsSync(base)) inside(root, realpathSync(base));
    else mkdirSync(base);
  }
  const chats = join(base, 'conversations');
  const notes = join(base, 'notes');
  const briefings = join(base, 'briefings');
  const pushes = join(base, 'pushes');
  for (const path of [chats, notes, briefings, pushes]) {
    if (existsSync(path)) inside(root, realpathSync(path));
    else mkdirSync(path);
  }
  const chatPath = id => join(chats, `${assertId(id)}.json`);
  function readChat(id) { return readJson(chatPath(id), null); }
  function saveChat(chat) { writeJson(chatPath(chat.id), chat); }
  function briefingPath(day) {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw Object.assign(new Error("Invalid briefing date"), { status: 400 });
    return join(briefings, `${day}.json`);
  }
  function listChats() {
    return readdirSync(chats).filter(f => /^[a-zA-Z0-9_-]{8,80}\.json$/.test(f))
      .map(f => readJson(join(chats, f), null)).filter(Boolean)
      .sort((a, b) => b.updated.localeCompare(a.updated));
  }
  for (const chat of listChats()) {
    let changed = false;
    for (const turn of chat.turns) if (['queued', 'running'].includes(turn.status)) {
      turn.status = 'interrupted'; turn.error = "Service restarted; input saved. Click Retry to continue."; changed = true;
    }
    if (changed) saveChat(chat);
  }
  return {
    root, base, readChat, saveChat, listChats,
    readPush(id) { return readJson(join(pushes, `${assertId(id)}.json`), null); },
    savePush(push) { writeJson(join(pushes, `${assertId(push.id)}.json`), push); return push; },
    listPushes() {
      return readdirSync(pushes).filter(f => /^[a-zA-Z0-9_-]{8,80}\.json$/.test(f)).map(f => readJson(join(pushes, f), null)).filter(Boolean)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 120);
    },
    readBriefing(day) { return readJson(briefingPath(day), null); },
    listBriefings() {
      return readdirSync(briefings).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, 90)
        .map(f => readJson(join(briefings, f), null)).filter(Boolean);
    },
    saveBriefing(briefing) {
      const path = briefingPath(briefing.day);
      const md = [`# ${briefing.day} Daily briefing`, '', `Generated at: ${briefing.generatedAt}`, '', briefing.intro, ''];
      for (const section of briefing.sections) {
        md.push(`## ${section.label}`, '', section.items.length ? '' : 'No new information was available in this run.', '');
        for (const item of section.items) md.push(`### ${item.title}`, '', item.summary, '', `Source: [${item.sourceName}](${item.url}) · ${item.publishedAt}`, '');
      }
      for (const warning of briefing.warnings || []) md.push(`> ${warning}`, '');
      atomicWrite(join(briefings, `${briefing.day}.md`), md.join('\n'));
      writeJson(path, briefing);
      return briefing;
    },
    createChat({project=''}={}) {
      const now = new Date().toISOString();
      const chat = { id: randomUUID(), title: "New conversation", project, created: now, updated: now, turns: [] };
      saveChat(chat); return chat;
    },
    saveNote(id, text, created = new Date().toISOString(), attachmentIds = []) {
      assertId(id);
      const path = join(notes, `${id}.json`);
      const existing = readJson(path, null);
      if (existing) {
        if (existing.text !== text || JSON.stringify(existing.attachmentIds || []) !== JSON.stringify(attachmentIds)) throw Object.assign(new Error("Repeated ID has different content"), { status: 409 });
        return existing;
      }
      if (!Number.isFinite(Date.parse(created))) throw new Error("Invalid record occurrence time");
      const note = { id, text, created, kind: 'note', title: text.split('\n')[0].slice(0, 48) || "Image note", ...(attachmentIds.length ? {attachmentIds} : {}) };
      writeJson(path, note);
      atomicWrite(join(notes, `${id}.md`), `# ${note.title}\n\nRecorded at: ${note.created}\n\n${text}\n${attachmentIds.map(id=>`\nImage reference: ${id} (saved only; not analyzed)`).join('')}\n`);
      return note;
    },
    listNotes() {
      return readdirSync(notes).filter(f => /^[a-zA-Z0-9_-]{8,80}\.json$/.test(f))
        .map(f => readJson(join(notes, f), null)).filter(Boolean)
        .sort((a, b) => b.created.localeCompare(a.created));
    },
  };
}
