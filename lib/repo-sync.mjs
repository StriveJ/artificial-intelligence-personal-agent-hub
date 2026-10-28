import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, realpathSync, readFileSync, unlinkSync, lstatSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson, atomicWrite, safeInstancePath } from './storage.mjs';
import { resolveConflicts } from './conflict-resolution.mjs';
import { privatePaths, isPrivate } from './runtime-policy.mjs';
import { inspectTreePaths } from './repo-preflight.mjs';

const execute = promisify(execFile);
const blocked = (code, summary) => ({ status: 'blocked', code, summary });
export function createRepoSync({ root, runtimeDir, afterUpdate = async () => {}, push = false, capturePaths = [], testMode = false, autoResolve = false }) {
  if (typeof testMode !== 'boolean' || typeof autoResolve !== 'boolean') throw new Error("Synchronization protection settings must be boolean");
  const testMarker = join(root, '.git', 'aipa-hub-no-push.json');
  if (existsSync(testMarker)) testMode = true;
  else if (testMode) {
    if (!existsSync(join(root, '.git')) || !lstatSync(join(root, '.git')).isDirectory() || lstatSync(join(root, '.git')).isSymbolicLink()) throw new Error("Test instances require fresh standalone clones without links or shared worktrees");
    writeJson(testMarker, { version: 1, reason: 'personal-instance-test-no-push' });
  }
  const hooks = join(runtimeDir, 'sync-empty-hooks'); mkdirSync(hooks, { recursive: true });
  const localOnly = privatePaths;
  const journalPath = join(runtimeDir, 'repo-sync-local-overlay.json');
  function restoreOverlay() {
    const journal = readJson(journalPath, null);
    if (!journal) return;
    if (journal.root !== realpathSync(root) || !Array.isArray(journal.files) || journal.files.some(f => !localOnly.includes(f.path) || !(f.absent === true || typeof f.base64 === 'string'))) throw new Error("Invalid synchronization recovery record. Check the Hub runtime directory.");
    for (const file of journal.files) {
      const path = safeInstancePath(root, join(root, file.path));
      if (file.absent === true) { if (existsSync(path)) unlinkSync(path); }
      else atomicWrite(path, Buffer.from(file.base64, 'base64'));
    }
    unlinkSync(journalPath);
  }
  restoreOverlay();
  if (!Array.isArray(capturePaths) || capturePaths.some(p => typeof p !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(p) || p.startsWith('/') || p.split('/').includes('..'))) throw new Error("Invalid automatic-save path");
  const owns = file => !isPrivate(file) && capturePaths.some(path => file === path || file.startsWith(path + '/'));
  async function git(args, { accept = [], cwd = root } = {}) {
    if (testMode && args.includes('push')) throw new Error("Git push is blocked in test mode");
    try {
      const { stdout } = await execute('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true', '-C', cwd, ...args], {
        encoding: 'utf8', windowsHide: true, timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      });
      return { code: 0, text: stdout.trim(), raw: stdout };
    } catch (error) {
      if (accept.includes(error.code)) return { code: error.code, text: '', raw: '' };
      const auth = /authentication|could not read username|permission denied|terminal prompts disabled|access denied|invalid credentials/i.test(error.stderr || '');
      const action = args.find(arg => ['fetch', 'push', 'merge', 'worktree', 'restore', 'add', 'commit'].includes(arg)) || 'read';
      const phase = { fetch: "Pull", push: "Push", merge: "Merge", worktree: "Prepare merge", restore: "Protect local state", add: "Save records", commit: "Commit records", read: "Read repository status" }[action];
      const failure = new Error('repo sync failed', { cause: error });
      failure.publicMessage = auth ? `Repository${phase} authentication failed; configure ${push ? "read/write" : "read"} permission; local records saved` : error.killed ? `Repository${phase} timed out; local records preserved` : `Repository${phase} incomplete; local records preserved. Check network, repository permissions, and Git state.`;
      throw failure;
    }
  }
  const files = result => result.raw.split('\0').filter(Boolean);
  return async function sync(attempt = 0) {
    if (realpathSync((await git(['rev-parse', '--show-toplevel'])).text) !== realpathSync(root)) return blocked('wrong_root', "Instance must be the root of a standalone repository");
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock']) {
      const location = (await git(['rev-parse', '--git-path', name])).text;
      if (existsSync(resolve(root, location))) return blocked('git_busy', "Repository has an unfinished Git operation. Resolve it before synchronization.");
    }
    const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { accept: [1] });
    if (!branch.text) return blocked('detached', "Repository has no checked-out branch; automatic synchronization unavailable");
    const remote = (await git(['config', '--get', `branch.${branch.text}.remote`], { accept: [1] })).text;
    const upstream = await git(['rev-parse', '--symbolic-full-name', '@{upstream}'], { accept: [128] });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote) || !upstream.text.startsWith('refs/remotes/')) return blocked('no_upstream', "Configure a remote tracking branch for the instance branch first");
    const mergeRef = (await git(['config', '--get', `branch.${branch.text}.merge`], { accept: [1] })).text;
    if (!/^refs\/heads\/[^\s:]+$/.test(mergeRef)) return blocked('no_upstream', "Invalid upstream branch configuration; automatic synchronization unavailable");
    let checkpoint = false;
    if (push) {
      const staged = files(await git(['diff', '--cached', '--name-only', '-z']));
      if (staged.some(file => !owns(file))) return blocked('staged_changes', "Other files are manually staged. Handle them first; Hub will not commit those changes.");
      const paths = [...new Set([...files(await git(['diff', '--name-only', '-z', 'HEAD'])), ...files(await git(['ls-files', '--others', '--exclude-standard', '-z']))])].filter(owns);
      if (paths.length) {
        await git(['add', '--all', '--', ...paths]);
        if (files(await git(['diff', '--cached', '--name-only', '-z'])).length) {
          await git(['-c', 'user.name=AIPA Hub', '-c', 'user.email=aipa-hub@localhost', 'commit', '-m', "[AIPA Hub] Sync personal instance records"]);
          checkpoint = true;
        }
      }
    }
    await git(['fetch', '--no-tags', '--no-recurse-submodules', '--', remote]);
    const before = (await git(['rev-parse', 'HEAD'])).text;
    const target = (await git(['rev-parse', '@{upstream}^{commit}'])).text;
    const pathIssues = inspectTreePaths(files(await git(['ls-tree', '-r', '--name-only', '-z', target])).sort());
    if (pathIssues.length) return { ...blocked('nonportable_tree', "Remote contains cross-platform duplicate or invalid paths. Local records preserved; overwrite blocked."), pathIssues };
    let candidate = before;
    const localAhead = before === target || (await git(['merge-base', '--is-ancestor', target, before], { accept: [1] })).code === 0;
    if (!localAhead) {
      if ((await git(['merge-base', '--is-ancestor', before, target], { accept: [1] })).code === 0) candidate = target;
      else {
        if (!push) return blocked('diverged', "Local and remote branches diverged. Merge manually; local records preserved.");
        const preview = join(runtimeDir, `m-${randomUUID().replaceAll('-', '').slice(0, 16)}`);
        await git(['worktree', 'add', '--detach', preview, before]);
        try {
          try { await git(['-c', 'user.name=AIPA Hub', '-c', 'user.email=aipa-hub@localhost', 'merge', '--no-ff', '--no-edit', target], { cwd: preview }); }
          catch (error) {
            const conflicts = files(await git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: preview }));
            if (!conflicts.length) throw error;
            if (!autoResolve || conflicts.some(path => !owns(path))) return blocked('merge_conflict', "Conflicts exist outside the sync scope or without automatic handling; commits on both sides preserved");
            await resolveConflicts({ preview, paths: conflicts, before, target, git });
          }
          candidate = (await git(['rev-parse', 'HEAD'], { cwd: preview })).text;
        } finally {
          if (dirname(resolve(preview)) === resolve(runtimeDir) && /^m-[a-f0-9]{16}$/.test(basename(preview))) await git(['worktree', 'remove', '--force', preview]);
        }
      }
    }
    const incoming = files(await git(['diff', '--no-renames', '--name-only', '-z', before, candidate]));
    const dirty = [...files(await git(['diff', '--no-renames', '--name-only', '-z', 'HEAD'])), ...files(await git(['ls-files', '--others', '-z']))];
    const overlays = localOnly.filter(file => incoming.includes(file));
    const overlaps = incoming.filter(a => dirty.some(b => !overlays.includes(b) && (a === b || a.startsWith(b + '/') || b.startsWith(a + '/'))));
    if (overlaps.length) return { ...blocked('local_changes', `There are ${overlaps.length} files with both local changes and remote updates. Resolve them and retry; no records overwritten.`), conflictingFiles: overlaps.length };
    if (candidate !== before) {
      if (overlays.length) {
        writeJson(journalPath, { root: realpathSync(root), files: overlays.map(path => {
          const full = safeInstancePath(root, join(root, path));
          if (!existsSync(full)) return { path, absent: true };
          if (!lstatSync(full).isFile()) throw new Error("Local session path must be a regular file");
          return { path, base64: readFileSync(full).toString('base64') };
        }) });
      }
      try {
        if (overlays.length) {
          const tracked = files(await git(['ls-tree', '-r', '--name-only', '-z', before, '--', ...overlays]));
          if (tracked.length) await git(['restore', '--source=HEAD', '--worktree', '--', ...tracked]);
          for (const file of overlays.filter(file => !tracked.includes(file))) {
            const full = safeInstancePath(root, join(root, file)); if (existsSync(full)) unlinkSync(full);
          }
        }
        await git(['merge', '--ff-only', '--no-edit', candidate]);
      } finally { restoreOverlay(); }
    }
    try { await afterUpdate({ commit: candidate, changed: candidate !== before }); }
    catch (error) {
      if (error.code !== 'core_restart_required') throw error;
      return { status: 'blocked', code: error.code, summary: error.publicMessage, commit: candidate.slice(0, 12), changedFiles: incoming.length, checkpoint, pushed: false };
    }
    let pushed = false;
    if (push && !testMode && candidate !== target) {
      try { await git(['push', '--porcelain', '--', remote, `${candidate}:${mergeRef}`]); }
      catch (error) {
        if (attempt < 2 && /\[rejected\]|fetch first|non-fast-forward/i.test((error.cause?.stderr || '') + (error.cause?.stdout || ''))) return sync(attempt + 1);
        throw error;
      }
      pushed = true;
    }
    const pushSuppressed = testMode && push && candidate !== target;
    return { status: 'success', code: pushSuppressed ? 'local_only' : pushed ? 'synced' : incoming.length ? 'updated' : 'current', summary: pushSuppressed ? "Test mode: local save and merge complete; no remote push performed" : push ? `Bidirectional repository synchronization complete${pushed ? "; web records pushed" : "; both sides already match"}; pulled updates for ${incoming.length} files` : incoming.length ? `Repository updates pulled; changed ${incoming.length} files` : "Remote checked; current records are up to date", commit: candidate.slice(0, 12), changedFiles: incoming.length, checkpoint, pushed, pushSuppressed };
  };
}
