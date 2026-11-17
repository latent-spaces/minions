import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connectClients } from '../src/client-setup.mjs';
import { ensureInstallation } from '../src/service/installation.mjs';
import { bundledGuideFiles } from '../src/skill-bundle.mjs';

for (const client of ['.claude', '.agents']) {
  test(`setup preserves the retired ${client} skill while installing Minions`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'minions-retired-skill-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, 'service'), userHome = join(root, 'user');
    const codexHome = join(userHome, '.codex');
    await mkdir(join(userHome, client === '.claude' ? '.claude' : '.codex'), { recursive: true });
    await ensureInstallation({ home, site: 'http://127.0.0.1:8787' });
    const retired = join(userHome, client, 'skills', 'mlswarm');
    const files = bundledGuideFiles();
    const setup = () => connectClients({ home, userHome, env: { CODEX_HOME: codexHome } });

    // An older router's metadata does not establish its original contents. An exact
    // current router also says nothing about ownership of other files in its directory.
    for (const router of [
      files['SKILL.md'].replace(/guide-revision: "(\d+)"/, (_, n) => `guide-revision: "${Number(n) - 1}"`) + '\nMy own instructions.\n',
      files['SKILL.md'],
    ]) {
      const saved = { ...files, 'SKILL.md': router, 'personal-notes.txt': 'Keep these notes.\n' };
      for (const [relative, content] of Object.entries(saved)) {
        const path = join(retired, relative);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      }
      assert.ok(setup().every(result => result.connected));
      for (const [relative, content] of Object.entries(saved)) {
        assert.equal(await readFile(join(retired, relative), 'utf8'), content, relative);
      }
      assert.equal(await readFile(join(userHome, client, 'skills', 'minions', 'SKILL.md'), 'utf8'), files['SKILL.md']);
    }
  });
}
