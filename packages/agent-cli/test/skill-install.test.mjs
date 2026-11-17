import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureInstallation } from '../src/service/installation.mjs';
import { connectClients } from '../src/client-setup.mjs';
import { skillTextHash } from '../src/skill-bundle.mjs';

const older = text => text.replace(/guide-revision: "(\d+)"/, (_, n) => `guide-revision: "${Number(n) - 1}"`);

// Setup keeps a skill the person changed. Before a guide update the installed router has an older revision, so only
// the hash setup recorded when it wrote that router shows whether it was edited since.
test('a guide update replaces the skill setup wrote, and keeps one the person edited since', async t => {
  const root = await mkdtemp(join(tmpdir(), 'minions-skill-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'service'), userHome = join(root, 'user'), env = { CODEX_HOME: join(root, 'no-codex') };
  await mkdir(home, { mode: 0o700 }); await mkdir(join(userHome, '.claude'), { recursive: true });
  await ensureInstallation({ home, site: 'http://127.0.0.1:8787' });
  const skill = join(userHome, '.claude/skills/minions/SKILL.md'), records = join(home, 'installed-skills.json');
  const setup = () => connectClients({ home, userHome, env })[0];
  assert.equal(setup().note, null);
  const bundled = await readFile(skill, 'utf8');
  // As if an earlier setup had written the previous revision: the record names what it wrote.
  const pretendInstalled = async text => { await writeFile(skill, text); await writeFile(records, JSON.stringify({ [skill]: skillTextHash(text) }), { mode: 0o600 }); };

  await pretendInstalled(older(bundled));
  assert.equal(setup().note, null);
  assert.equal(await readFile(skill, 'utf8'), bundled, 'an unchanged older skill is updated');

  await pretendInstalled(older(bundled));
  await writeFile(skill, older(bundled) + '\n## My own note\n');
  assert.match(setup().note, /kept your own Minions skill/);
  assert.match(await readFile(skill, 'utf8'), /My own note/, 'an edited older skill is kept');

  // An unreadable record keeps the skill rather than guessing.
  await writeFile(records, '{broken', { mode: 0o600 });
  assert.match(setup().note, /could not read/);
  assert.match(await readFile(skill, 'utf8'), /My own note/, 'an unreadable record keeps the skill');

  // An install from before the record existed is updated, and its old router is saved first.
  await rm(records);
  const note = setup().note;
  assert.equal(await readFile(skill, 'utf8'), bundled);
  const saved = /saved at (\S+\.md)/.exec(note)?.[1];
  assert.ok(saved, note);
  assert.match(await readFile(saved, 'utf8'), /My own note/, 'the previous router can be recovered');
});
