import { connect } from 'node:net';
import { join } from 'node:path';
import { readJson } from './storage.mjs';
import {localSocket} from './local-socket.mjs';
export const ipcPath = runtimeDir => localSocket(runtimeDir,'hub');
export async function subCommand(runtimeDir, action, args = {}) {
  const access = readJson(join(runtimeDir, 'ipc-access.json'), null); if (!access) throw new Error("Local sub Hub credentials not found");
  return new Promise((yes, no) => {
    const socket = connect(ipcPath(runtimeDir)); let raw = '';
    socket.setTimeout(300_000, () => socket.destroy(new Error("Sub Hub operation timed out")));
    socket.on('connect', () => socket.write(JSON.stringify({ ...args, action, token: access.token }) + '\n'));
    socket.on('data', data => { raw += data; if (raw.length > 1_000_000) socket.destroy(new Error("IPC response too large")); });
    socket.on('end', () => { try { const value = JSON.parse(raw); if (!value.ok) throw new Error(value.error); yes(value.result); } catch (e) { no(e); } }); socket.on('error', no);
  });
}
