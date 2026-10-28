import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// ESM caches the entire import graph. A query on an entry module does not reload
// its dependencies. Bind each instance to one code image for this process;
// program changes require a new process, while data/config remain live reads.
const images = new Map();
function fingerprint(root) {
  const rows = [];
  function visit(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("Core program paths cannot be links");
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    else if (stat.isFile()) rows.push([relative(root, path).replaceAll('\\', '/'), createHash('sha256').update(readFileSync(path)).digest('hex')]);
    else throw new Error("Core program paths accept regular files only");
  }
  if (!lstatSync(join(root, 'core-space')).isDirectory() || lstatSync(join(root, 'core-space')).isSymbolicLink()) throw new Error("Invalid Core directory");
  visit(join(root, 'core-space/scripts'));
  visit(join(root, 'AIPA-MANIFEST.yaml'));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
export function createCoreRuntime(instanceRoot) {
  const root = realpathSync(instanceRoot);
  if (!images.has(root)) images.set(root, { sha256: fingerprint(root), loadFailed: false });
  const image = images.get(root), loaded = image.sha256;
  function status() {
    try {
      if (!image.loadFailed && fingerprint(root) === loaded) return { status: 'ready', code: 'current', sourceSha256: loaded };
    } catch { /* Missing, unreadable and linked program files all fail closed. */ }
    return { status: 'blocked', code: 'core_restart_required', sourceSha256: loaded, summary: "Core program changed, failed to load, or cannot be verified. Restart Hub before continuing; saved information is preserved." };
  }
  function assertCurrent() {
    const value = status();
    if (value.status !== 'ready') throw Object.assign(new Error(value.summary), { code: value.code, status: 503, publicMessage: value.summary });
  }
  function wrap(fn) {
    return function (...args) {
      assertCurrent();
      const result = fn.apply(this, args);
      if (result && typeof result.then === 'function') return result.then(value => { assertCurrent(); return value; });
      assertCurrent(); return result;
    };
  }
  function guard(value) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === 'function' ? wrap(item) : item]));
  }
  assertCurrent();
  return { status, assertCurrent, wrap, guard, async lib(name) {
    if (!/^[-a-z0-9]+\.mjs$/.test(name)) throw new Error("Invalid Core module name");
    assertCurrent();
    try {
      const result = await import(pathToFileURL(join(root, 'core-space/scripts/lib', name)).href);
      assertCurrent(); return result;
    } catch (error) {
      // An incomplete import graph (including rejected modules) remains cached.
      // Restoring files cannot prove that this process can reuse that graph.
      image.loadFailed = true; throw error;
    }
  } };
}
