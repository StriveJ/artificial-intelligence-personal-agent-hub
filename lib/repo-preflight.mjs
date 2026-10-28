import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isPrivate } from './runtime-policy.mjs';

export const portablePath = path => path.split('/').every(part => part && !/[<>:"\\|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part));
export function inspectTreePaths(paths) {
  const seen = new Map(), issues = [];
  for (const path of paths) {
    const key = path.normalize('NFC').toLowerCase();
    if (!portablePath(path)) issues.push({ path, code: 'nonportable_path' });
    if (seen.has(key) && seen.get(key) !== path) issues.push({ path, other: seen.get(key), code: 'case_or_unicode_collision' });
    seen.set(key, path);
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) if (seen.has(parts.slice(0, i).join('/'))) issues.push({ path, code: 'file_directory_collision' });
  }
  return issues;
}
export function inspectRepository(root) {
  const git = (...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe', timeout: 15_000 }).trim();
  const paths = git('ls-files', '-z').split('\0').filter(Boolean), privateTracked = paths.filter(isPrivate);
  const manualTransactions = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'index.lock', 'rebase-merge', 'rebase-apply'].filter(p => existsSync(join(root, '.git', p)));
  let upstream = false; try { git('rev-parse', '@{upstream}'); upstream = true; } catch {  }
  return { root: realpathSync(root), ownRoot: realpathSync(git('rev-parse', '--show-toplevel')) === realpathSync(root), instance: existsSync(join(root, 'AIPA-MANIFEST.yaml')), standalone: lstatSync(join(root, '.git')).isDirectory(), branch: git('symbolic-ref', '--short', 'HEAD'), upstream, privateTracked, pathIssues: inspectTreePaths(paths.sort()), manualTransactions, testProtected: existsSync(join(root, '.git/aipa-hub-no-push.json')), externalPushTested: false };
}
