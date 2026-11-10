import { beforeEach, expect, test } from 'vitest';
import { profiles } from '../src/firestore.js';
import { editLiveLink } from '../src/projects/live-link.js';
import { readWorkspace } from '../src/projects/store.js';
import { seed, resetEmulator, TEST_PROJECT } from './helpers.js';

beforeEach(resetEmulator);
const now = () => 1_000;
async function people() {
  const f = await seed({ profiles: [{ name: 'Bob', email: 'bob@example.test' }] });
  await profiles.doc('seed-owner').set({ name: 'Owner', email: 'owner@example.test', removedAt: null });
  return Promise.all(['seed-owner', ...f.personIds].map(async id => ({ id, ...(await profiles.doc(id).get()).data()! })));
}

test('the owner sets, shows and clears the live link; others and non-https links are refused', async () => {
  const [owner, member] = await people();
  expect(await readWorkspace(owner, TEST_PROJECT)).toMatchObject({ liveUrl: null });
  expect(await editLiveLink(owner, TEST_PROJECT, { url: 'https://example.com/game', expectedUrl: null }, now)).toEqual({ liveUrl: 'https://example.com/game' });
  expect(await readWorkspace(member, TEST_PROJECT)).toMatchObject({ liveUrl: 'https://example.com/game' });
  await expect(editLiveLink(member, TEST_PROJECT, { url: 'https://example.com/other', expectedUrl: 'https://example.com/game' }, now)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(editLiveLink(owner, TEST_PROJECT, { url: 'http://example.com/game', expectedUrl: null }, now)).rejects.toMatchObject({ code: 'bad_input' });
  await expect(editLiveLink(owner, TEST_PROJECT, { url: 'javascript:alert(1)', expectedUrl: null }, now)).rejects.toMatchObject({ code: 'bad_input' });
  expect(await editLiveLink(owner, TEST_PROJECT, { url: '', expectedUrl: 'https://example.com/game' }, now)).toEqual({ liveUrl: null });
  expect(await readWorkspace(owner, TEST_PROJECT)).toMatchObject({ liveUrl: null });
});
