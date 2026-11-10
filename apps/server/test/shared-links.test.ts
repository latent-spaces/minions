import express from 'express';
import { beforeEach, expect, test } from 'vitest';
import { sharedDestination, sharedLinkRoutes, shortSharedLink } from '../src/shared-links.js';
import { resetEmulator } from './helpers.js';

beforeEach(resetEmulator);
const now = () => 10_000_000;
async function withServer(work: (origin: string) => Promise<void>) {
  const app = express(); app.use(sharedLinkRoutes(now));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  try { await work(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('short addresses are stable across retries and preserve the entire destination', async () => {
  const path = `/viewer/?project=${'a'.repeat(64)}&section=conversations&thread=thread_1&message=message_2`;
  const results = await Promise.all([shortSharedLink(path), shortSharedLink(path)]);
  expect(results[0]).toMatch(/^\/s\/[A-Za-z0-9_-]{22}$/);
  expect(results[0]).toBe(results[1]);
  expect(results[0].length).toBeLessThan(path.length);
  await withServer(async origin => {
    const response = await fetch(origin + results[0] + '?project=attacker', { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(path);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await fetch(origin + '/s/' + 'x'.repeat(22))).status).toBe(404);
    expect((await fetch(origin + '/s/bad')).status).toBe(404);
  });
});

test('only internal viewer destinations can be shortened, and creation requires access', async () => {
  for (const path of ['https://evil.test', '//evil.test', '/api/owner/connect', '/s/code', '/viewer/?view=join\n', '/viewer/?view=join#other', '/viewer/?next=\\evil']) {
    expect(sharedDestination(path)).toBe(false);
    await expect(shortSharedLink(path)).rejects.toMatchObject({ code: 'bad_input' });
  }
  await withServer(async origin => {
    const response = await fetch(origin + '/api/shared-links', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: `/viewer/?project=${'a'.repeat(64)}` }) });
    expect(response.status).toBe(401);
  });
});

