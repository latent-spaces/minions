import { beforeEach, expect, test } from 'vitest';
import { profiles } from '../src/firestore.js';
import { setProjectPreview } from '../src/projects/preview.js';
import { readWorkspace } from '../src/projects/store.js';
import { seed, resetEmulator, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);
const now = () => 1_000;

test('a member sets, shows and clears the preview; only https or this computer’s http links are kept', async () => {
  const f = await seed({ profiles: [{ name: 'Bob', email: 'bob@example.test' }] });
  const person = { id: f.personIds[0], ...(await profiles.doc(f.personIds[0]).get()).data()! };
  const actor = { kind: 'person' as const, person };
  expect(await readWorkspace(person, TEST_PROJECT)).toMatchObject({ previewUrl: null });
  for (const url of ['http://localhost:5173/', 'http://127.0.0.1:8080/game/index.html', 'http://[::1]:3000', 'https://example.com/game']) {
    expect(await setProjectPreview(TEST_PROJECT, actor, { url }, now)).toEqual({ previewUrl: url });
    expect(await readWorkspace(person, TEST_PROJECT)).toMatchObject({ previewUrl: url });
  }
  for (const url of ['http://example.com/game', 'http://192.168.1.4:5173/', 'javascript:alert(1)', 'file:///tmp/game.html', 'ftp://localhost/x'])
    await expect(setProjectPreview(TEST_PROJECT, actor, { url }, now)).rejects.toMatchObject({ code: 'bad_input' });
  expect(await readWorkspace(person, TEST_PROJECT)).toMatchObject({ previewUrl: 'https://example.com/game' });
  expect(await setProjectPreview(TEST_PROJECT, actor, { url: '' }, now)).toEqual({ previewUrl: null });
  expect(await readWorkspace(person, TEST_PROJECT)).toMatchObject({ previewUrl: null });
});
