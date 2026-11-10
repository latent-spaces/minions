import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BUNDLED_SKILL, GUIDE_SECTIONS, bundledGuideFiles, guideFile, installedSkill, readBundledGuide, referenceHash, skillTextHash } from '../src/skill-bundle.mjs';
import { main } from '../src/cli.mjs';
import { createRuntimeApplication } from '../src/service/application.mjs';
import { connectClients } from '../src/client-setup.mjs';
import { ensureInstallation } from '../src/service/installation.mjs';
import { GUIDE_REVISION } from '../src/version.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mlswarm skill bundle '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const where = { home: join(root, 'service'), userHome: join(root, 'user'), env: {} };
  await ensureInstallation({ home: where.home, site: 'http://127.0.0.1:8787' });
  mkdirSync(join(where.userHome, '.claude'), { recursive: true });
  mkdirSync(join(where.userHome, '.codex'), { recursive: true });
  return { ...where, root, skill: join(where.userHome, '.agents', 'skills', 'mlswarm'), setup: () => connectClients(where) };
}
const status = root => installedSkill({ path: join(root, 'SKILL.md') }, BUNDLED_SKILL).status;
const run = async args => {
  const out = [], err = [];
  return { exit: await main(args, text => out.push(text), text => err.push(text)), out: out.join('\n'), err: err.join('\n') };
};

test('MCP serves the router by default and only the selected workflow; invalid sections cannot select paths', async () => {
  const principal = { site: 'http://127.0.0.1:8787', ownerId: 'synthetic-owner' };
  const caller = { kind: 'owner', ...principal };
  const app = createRuntimeApplication({ principal });
  const read = async args => {
    const result = await app.callTool(caller, 'get_mlswarm_guide', args);
    assert.equal(result.isError, undefined);
    return result.content[0].text;
  };
  assert.equal(await read({}), readBundledGuide());
  for (const section of GUIDE_SECTIONS) assert.equal(await read({ section }), readBundledGuide(section));
  for (const args of [{ section: '../../package.json' }, { section: 'all' }, { section: null }, { extra: true }]) {
    const result = await app.callTool(caller, 'get_mlswarm_guide', args);
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, 'bad_input');
  }
});

test('CLI exports all installable files explicitly and reads one workflow without loading the others', async () => {
  const router = await run(['skill']);
  assert.equal(router.exit, 0); assert.equal(router.out, readBundledGuide());
  const bundle = JSON.parse((await run(['skill', '--json'])).out);
  assert.deepEqual(bundle.files, bundledGuideFiles());
  assert.equal(bundle.sha256, BUNDLED_SKILL.sha256);
  assert.equal(bundle.references_sha256, referenceHash(bundle.files));
  for (const section of GUIDE_SECTIONS) {
    const result = await run(['skill', '--section', section, '--json']);
    assert.equal(result.exit, 0);
    const value = JSON.parse(result.out);
    assert.equal(value.content, bundle.files[guideFile(section)]);
    assert.equal(value.sha256, skillTextHash(value.content));
    assert.equal(value.files, undefined);
  }
  assert.equal((await run(['skill', '--section', '../package.json'])).exit, 2);
});

test('setup installs and repairs the complete bundle for both clients in paths with spaces, leaving unrelated files', async t => {
  const f = await fixture(t);
  assert.ok(f.setup().every(result => result.connected));
  for (const client of ['.claude', '.agents']) {
    const root = join(f.userHome, client, 'skills', 'mlswarm');
    for (const [file, text] of Object.entries(bundledGuideFiles())) assert.equal(readFileSync(join(root, file), 'utf8'), text);
    assert.equal(status(root), 'current');
  }
  writeFileSync(join(f.skill, 'notes.md'), 'personal notes');
  rmSync(join(f.skill, guideFile('agents')));
  assert.equal(status(f.skill), 'incomplete');
  f.setup();
  assert.equal(status(f.skill), 'current');
  assert.equal(readFileSync(join(f.skill, 'notes.md'), 'utf8'), 'personal notes');
});

test('edited references are preserved even on an older revision or alongside a missing reference', async t => {
  const f = await fixture(t); f.setup();
  const path = join(f.skill, guideFile('agents'));
  writeFileSync(path, 'My agent instructions\n');
  assert.equal(status(f.skill), 'modified');
  // The reference digest is checked before comparing revisions.
  const router = join(f.skill, 'SKILL.md');
  writeFileSync(router, readFileSync(router, 'utf8').replace(`guide-revision: "${GUIDE_REVISION}"`, `guide-revision: "${GUIDE_REVISION - 1}"`));
  assert.equal(status(f.skill), 'modified');
  rmSync(join(f.skill, guideFile('projects')));
  assert.match(f.setup().find(result => result.client === 'Codex').note, /kept your own/);
  assert.equal(readFileSync(path, 'utf8'), 'My agent instructions\n');
  assert.ok(readFileSync(router, 'utf8').includes(`guide-revision: "${GUIDE_REVISION - 1}"`));
});

test('setup preserves orphaned customized references when the router is missing', async t => {
  const f = await fixture(t);
  const path = join(f.skill, guideFile('agents'));
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'My agent instructions');
  assert.match(f.setup().find(result => result.client === 'Codex').note, /kept your own/);
  assert.equal(readFileSync(path, 'utf8'), 'My agent instructions');
});

test('a canonical guide saved with CRLF line endings is current, and a newer guide is left as newer', async t => {
  const f = await fixture(t);
  for (const [file, text] of Object.entries(bundledGuideFiles())) {
    const dest = join(f.skill, file); mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
  }
  assert.equal(status(f.skill), 'current');
  writeFileSync(join(f.skill, 'SKILL.md'), `---\nname: mlswarm\nmetadata:\n  guide-revision: "${GUIDE_REVISION + 1}"\n---\nLater guide.\n`);
  assert.equal(status(f.skill), 'newer');
});

test('setup upgrades an earlier single-file guide to the full router bundle', async t => {
  const f = await fixture(t);
  mkdirSync(f.skill, { recursive: true });
  writeFileSync(join(f.skill, 'SKILL.md'), `---\nname: mlswarm\nmetadata:\n  guide-revision: "${GUIDE_REVISION - 1}"\n---\nEarlier guide.\n`);
  assert.equal(status(f.skill), 'update_available');
  assert.equal(f.setup().find(result => result.client === 'Codex').note, null);
  assert.equal(status(f.skill), 'current');
  for (const [file, text] of Object.entries(bundledGuideFiles())) assert.equal(readFileSync(join(f.skill, file), 'utf8'), text);
});

for (const linked of ['references', guideFile('agents'), '.']) {
  test(`setup and inspection leave a linked ${linked} unchanged`, async t => {
    const f = await fixture(t); f.setup();
    const path = join(f.skill, linked), target = join(f.root, 'outside');
    const directory = linked === 'references' || linked === '.';
    rmSync(path, { recursive: true });
    if (directory) mkdirSync(target); else writeFileSync(target, 'outside instructions');
    try { symlinkSync(target, path, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'); }
    catch (error) { if (error.code === 'EPERM') return t.skip('Symlink creation requires extra rights.'); throw error; }
    assert.equal(status(f.skill), 'symlink_review_required');
    assert.match(f.setup().find(result => result.client === 'Codex').note, /kept your own/);
    if (!directory) assert.equal(readFileSync(target, 'utf8'), 'outside instructions');
  });
}
