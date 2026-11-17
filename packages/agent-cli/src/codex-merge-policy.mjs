// Generated native rules belong to the exclusively claimed worker checkout. They
// are not a second command filter: Codex parses and enforces its own rule file.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, lstatSync, readFileSync, appendFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { digest, lstatExists, readPrivate, writePrivate, physicalPath } from './state.mjs';

const execute = promisify(execFile);
// Each worker checkout's receipt and .git/info/exclude name this file, so it keeps its name from before the rename to
// Minions (15 November 2026).
const relative = '.codex/rules/mlswarm-worker-merge.rules';
const ignored = `/${relative}`;
const unavailable = () => new Error('Codex merge policy could not be installed safely. Update Codex and inspect the reserved .codex/rules/mlswarm-worker-merge.rules file before retrying.');

export function createCodexMergePolicy({ folder, stateDir, env = process.env, run = execute }) {
  folder = physicalPath(folder);
  const file = join(folder, ...relative.split('/')), receipt = join(stateDir, 'codex-merge-policy.json');
  const directories = [join(folder, '.codex'), join(folder, '.codex', 'rules')];
  const git = async args => (await run('git', ['-C', folder, ...args], { env, encoding: 'utf8', timeout: 5000, maxBuffer: 1048576, windowsHide: true })).stdout.trim();
  function verifyDirectories() {
    for (const path of directories) if (lstatExists(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || physicalPath(path) !== path)) throw unavailable();
  }
  function record() {
    if (!lstatExists(receipt)) return null;
    const value = readPrivate(receipt, true);
    if (value.version !== 1 || value.file !== file || !Array.isArray(value.hashes) || value.hashes.length > 2 || value.hashes.some(hash => !/^[a-f0-9]{64}$/.test(hash)) || !Array.isArray(value.created) || value.created.some(path => !directories.includes(path))) throw unavailable();
    return value;
  }
  function verify(value) {
    verifyDirectories();
    if (!lstatExists(file)) return;
    if (!value || !value.hashes.includes(digest(readPrivate(file)))) throw unavailable();
  }
  async function cleanup() {
    const value = record(); if (!value) { if (lstatExists(file)) throw unavailable(); return; }
    verify(value);
    if (lstatExists(file)) unlinkSync(file);
    for (const path of [...value.created].reverse()) {
      verifyDirectories();
      try { rmdirSync(path); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    }
    unlinkSync(receipt);
  }
  return {
    file, cleanup,
    async prepare(content, { signal } = {}) {
      signal?.throwIfAborted();
      if (physicalPath(await git(['rev-parse', '--show-toplevel'])) !== folder) throw unavailable();
      const previous = record(); verify(previous);
      const created = previous?.created ?? [];
      for (const path of directories) {
        if (!lstatExists(path)) { mkdirSync(path, { mode: 0o700 }); if (!created.includes(path)) created.push(path); }
        if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || physicalPath(path) !== path) throw unavailable();
      }
      // Never conceal an existing tracked file or override repository contents.
      let tracked = false;
      try { await git(['ls-files', '--error-unmatch', '--', relative]); tracked = true; }
      catch (error) { if (error.code !== 1) throw error; }
      if (tracked) throw unavailable();
      const exclude = await git(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
      if (!exclude) throw unavailable();
      if (lstatExists(exclude) && (!lstatSync(exclude).isFile() || lstatSync(exclude).isSymbolicLink() || lstatSync(exclude).size > 1048576)) throw unavailable();
      const existing = lstatExists(exclude) ? readFileSync(exclude, 'utf8') : '';
      if (!existing.split(/\r?\n/).includes(ignored)) {
        mkdirSync(dirname(exclude), { recursive: true });
        // Linked worktrees may share info/exclude. Append one exact reserved path;
        // never rewrite that shared file or remove another checkout's exclusion.
        appendFileSync(exclude, `${existing && !existing.endsWith('\n') ? '\n' : ''}${ignored}\n`);
      }
      await git(['check-ignore', '--no-index', '--', relative]);
      signal?.throwIfAborted();
      const hashes = [...new Set([...(lstatExists(file) ? [digest(readPrivate(file))] : []), digest(content)])];
      writePrivate(receipt, { version: 1, file, hashes, created });
      writePrivate(file, content);
      writePrivate(receipt, { version: 1, file, hashes: [digest(content)], created });
      return file;
    },
  };
}
