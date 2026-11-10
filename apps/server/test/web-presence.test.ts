import express from 'express';
import { beforeEach, expect, test } from 'vitest';
import { profiles } from '../src/firestore.js';
import { presenceView, reportWebPresence, webPresence } from '../src/community/web-presence.js';
import { exportPerson } from '../src/store/person-export.js';
import { removePerson } from '../src/store/profiles.js';
import { communityRoutes } from '../src/community/routes.js';
import { idTokenFor, resetEmulator, seed } from './helpers.js';

beforeEach(resetEmulator);
const T = 1_000_000;

test('browser observations expire exactly at 45 seconds and reject future or invalid reports', () => {
  expect(presenceView({ lastSeenAt: T - 44_999 }, T)).toEqual({ online: true, freshUntil: T + 1 });
  for (const report of [undefined, { lastSeenAt: T - 45_000 }, { lastSeenAt: T + 1 }, { lastSeenAt: NaN }]) {
    expect(presenceView(report, T)).toEqual({ online: false, freshUntil: null });
  }
});

test('reports are server stamped, aggregate tabs, and omit last-seen history and removed people', async () => {
  const { personIds: [self, other, removed] } = await seed({ profiles: [
    { name: 'Self', email: 'self@example.test' }, { name: 'Other', email: 'other@example.test' }, { name: 'Removed', email: 'removed@example.test' },
  ] });
  const actor = { kind: 'person' as const, operatorId: self };
  await profiles.doc(removed).update({ removedAt: T });
  await webPresence.doc(removed).set({ lastSeenAt: T });
  const report = await reportWebPresence(actor, { profileIds: [self, other, removed, 'missing', self] }, () => T);
  expect(report).toEqual({ generatedAt: T, people: {
    [self]: { online: true, freshUntil: T + 45_000 }, [other]: { online: false, freshUntil: null },
    [removed]: { online: false, freshUntil: null }, missing: { online: false, freshUntil: null },
  } });
  await reportWebPresence(actor, { profileIds: [] }, () => T + 15_000);
  const peer = { kind: 'person' as const, operatorId: other };
  expect((await reportWebPresence(peer, { profileIds: [self] }, () => T + 50_000)).people[self].online).toBe(true);
  expect((await reportWebPresence(peer, { profileIds: [self] }, () => T + 60_000)).people[self].online).toBe(false);
  expect(JSON.stringify(report)).not.toMatch(/lastSeenAt|email|computer|provider/);
  await expect(reportWebPresence({ ...actor, operatorId: removed }, { profileIds: [] }, () => T)).rejects.toMatchObject({ code: 'unauthorized' });
  for (const body of [{ profileIds: ['../private'] }, { profileIds: Array(101).fill(self) }, { profileIds: [], lastSeenAt: T }, { profileIds: [], operatorId: other }]) {
    await expect(reportWebPresence(actor, body, () => T)).rejects.toMatchObject({ code: 'bad_input' });
  }
});

test('HTTP requires a signed-in browser account bound to the same immutable profile', async () => {
  const { personIds: [self] } = await seed({ profiles: [{ name: 'Browser', email: 'browser@example.test' }] });
  const app = express(); app.use('/community', communityRoutes(() => T));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/community/web-presence`;
  const token = await idTokenFor('browser@example.test');
  const call = (headers: Record<string, string>, body: object = { profileIds: [self] }) => fetch(base, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  try {
    expect((await call({})).status).toBe(401);
    expect((await call({ authorization: `Bearer ${token}` })).status).toBe(403);
    expect((await call({ authorization: `Bearer ${token}`, 'x-mlswarm-profile-id': 'another-account' })).status).toBe(403);
    expect((await webPresence.doc(self).get()).exists).toBe(false);
    const headers = { authorization: `Bearer ${token}`, 'x-mlswarm-profile-id': self };
    const response = await call(headers); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).people[self]).toEqual({ online: true, freshUntil: T + 45_000 });
    expect((await call(headers, { profileIds: [], online: true })).status).toBe(400);
    await profiles.doc(self).update({ removedAt: T }); expect((await call(headers)).status).toBe(401);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('presence is included in the person export and removed with their account', async () => {
  const { personIds: [self] } = await seed({ profiles: [{ name: 'Person', email: 'person@example.test' }] });
  await reportWebPresence({ kind: 'person', operatorId: self }, { profileIds: [] }, () => T);
  expect((await exportPerson(self, () => T)).records).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: `webPresence/${self}`, data: { lastSeenAt: T } }),
  ]));
  await removePerson(self, () => T + 1);
  expect((await webPresence.doc(self).get()).exists).toBe(false);
});
