import { join } from 'node:path';
import { assertId, readJson, writeJson } from './storage.mjs';

export function createChatVisibility(runtimeDir) {
  const path = join(runtimeDir, 'chat-visibility.json');
  const read = () => readJson(path, { hidden: {} });
  return {
    hiddenIds() { return new Set(Object.keys(read().hidden)); },
    setHidden(id, hidden) {
      assertId(id);
      if (typeof hidden !== 'boolean') throw Object.assign(new Error("Specify whether to hide the conversation from the web list"), { status: 400 });
      const state = read();
      if (hidden) state.hidden[id] ||= new Date().toISOString();
      else delete state.hidden[id];
      writeJson(path, state);
    },
  };
}
