import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionUser } from '../src/session-identity';
import type { ProgressScreenshot } from '@mlswarm/contracts';
import { ApiError } from '../src/authorized-request';
import { createProgressClient } from '../src/progress-client';

const image: ProgressScreenshot = { id: 'image/id', contentPath: '/synthetic-image', mimeType: 'image/png', byteSize: 1,
  width: 1, height: 1, alt: 'Synthetic test image', caption: null, representation: 'concept_image', provenance: 'author_upload' };
const operations = [
  (client: ReturnType<typeof createProgressClient>, user: SessionUser) => client.readProjectProgress('project', user),
  (client: ReturnType<typeof createProgressClient>, user: SessionUser) => client.readProjectScreenshot('project', user, image),
];

test('update reads fence account changes before token, after token, and after JSON/blob decoding', async t => {
  for (const operation of operations) {
    for (const phase of ['before', 'token', 'body'] as const) {
      let uid: string | undefined = phase === 'before' ? 'other-owner' : 'owner';
      let tokens = 0;
      const user = { uid: 'owner', getIdToken: async () => { tokens++; if (phase === 'token') uid = undefined; return 'synthetic-token'; } } as unknown as SessionUser;
      const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
        ok: true,
        json: async () => { uid = 'other-owner'; return { items: [] }; },
        blob: async () => { uid = 'other-owner'; return new Blob(['private pixels']); },
      } as Response));
      await assert.rejects(operation(createProgressClient(() => uid), user),
        (error: unknown) => error instanceof ApiError && error.status === 401);
      assert.equal(tokens, phase === 'before' ? 0 : 1);
      assert.equal(fetchMock.mock.callCount(), phase === 'body' ? 1 : 0);
      fetchMock.mock.restore();
    }
  }
});

test('signed-in reads keep paging and media paths and send authorization', async t => {
  const user = { uid: 'owner', getIdToken: async () => 'synthetic-token' } as unknown as SessionUser;
  const client = createProgressClient(() => user.uid);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{"items":[]}'));
  assert.deepEqual(await client.readProjectProgress('project', user, 'cursor +/'), { items: [] });
  assert.ok(await client.readProjectScreenshot('project', user, image) instanceof Blob);
  const [page, media] = fetchMock.mock.calls;
  assert.equal(page.arguments[0], '/api/project-progress/project?cursor=cursor+%2B%2F');
  assert.equal(media.arguments[0], '/api/project-progress/project/media/image%2Fid');
  for (const call of fetchMock.mock.calls) assert.equal(new Headers(call.arguments[1]?.headers).get('authorization'), 'Bearer synthetic-token');
  assert.equal(media.arguments[1]?.cache, 'no-store');
});

test('update refusals keep their status and server message', async t => {
  const user = { uid: 'owner', getIdToken: async () => 'synthetic-token' } as unknown as SessionUser;
  t.mock.method(globalThis, 'fetch', async () => new Response('{"message":"This update is unavailable."}', { status: 403 }));
  await assert.rejects(createProgressClient(() => user.uid).readProjectScreenshot('project', user, image),
    (error: unknown) => error instanceof ApiError && error.status === 403 && error.message === 'This update is unavailable.');
});
