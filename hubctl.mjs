import { resolve } from 'node:path';
import { readJson } from './lib/storage.mjs';
import { updateCommand } from './lib/update-ipc.mjs';
import { randomUUID } from 'node:crypto';

const mutating = new Set(['check', 'plan', 'prepare', 'apply', 'cancel']);
let key;
try {
  const args = process.argv.slice(2), at = args.indexOf('--config');
  if (at < 0 || args[0] !== 'update') throw new Error("Usage: node hubctl.mjs update <status|check|releases|plan|get-plan|prepare|apply|operation|cancel|history|recover> --config <hub-config> [--body <json-file>] [--key <idempotency-key>]");
  const config = readJson(resolve(args[at + 1]), null), bodyAt = args.indexOf('--body'), keyAt = args.indexOf('--key');
  const body = bodyAt < 0 ? {} : readJson(resolve(args[bodyAt + 1]), null);
  key = keyAt < 0 ? randomUUID() : args[keyAt + 1];
  console.log(JSON.stringify(await updateCommand(config.runtimeDir, args[1], body, key), null, 2));
} catch (error) {
  console.error(error.message);
  if (key && mutating.has(process.argv[3])) console.error(`Reuse the same idempotency key to retry or verify: --key ${key}`);
  process.exitCode = 1;
}
