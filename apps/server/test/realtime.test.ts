import express from 'express';
import { FieldValue, Query } from 'firebase-admin/firestore';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { db } from '../src/firestore.js';
import { realtimeRoutes } from '../src/realtime.js';
import { membershipDoc } from '../src/projects/access.js';
import { resetEmulator, seed, TEST_PROJECT, idTokenFor } from './helpers.js';
import { QueryPrototype } from './store-prototypes.js';

beforeEach(resetEmulator);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks(); });
async function fixture() {
  const data = await seed({ profiles: [{ name: 'Alice', email: 'alice@example.test' }, { name: 'Bob', email: 'bob@example.test' }] });
  const app = express(); app.use('/api/realtime', realtimeRoutes());
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const token = await idTokenFor('alice@example.test');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/realtime`;
  const open = async (project = TEST_PROJECT, topics?: string) => {
    const abort = new AbortController(); cleanups.unshift(async () => { abort.abort(); });
    const query = new URLSearchParams({ ...(project ? { project_id: project } : {}), ...(topics === undefined ? {} : { topics }) });
    return fetch(base + (query.size ? '?' + query : ''), { headers: { authorization: `Bearer ${token}` }, signal: abort.signal });
  };
  return { ...data, base, token, open };
}
async function collect(response: globalThis.Response) {
  const events: string[][] = [], reader = response.body!.getReader(); let ended = false;
  cleanups.unshift(async () => { await reader.cancel().catch(() => {}); });
  void (async () => {
    let buffer = '';
    try { for (;;) {
      const value = await reader.read(); if (value.done) break;
      buffer += new TextDecoder().decode(value.value);
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)).topics);
      }
    } } catch { /* client abort */ } finally { ended = true; }
  })();
  return { events, ended: () => ended };
}
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) { for (let i = 0; i < 100; i++) { if (predicate()) return; await settle(50); } throw Error('Realtime event did not arrive.'); }

test('stream requires a human account, exact project membership and valid scope', async () => {
  const f = await fixture();
  expect((await fetch(f.base)).status).toBe(401);
  expect((await fetch(f.base, { headers: { authorization: `Bearer ${f.token}`, 'X-Minions-Profile-Id': f.personIds[1] } })).status).toBe(401);
  expect((await f.open('invalid')).status).toBe(400);
  expect((await f.open('a'.repeat(64))).status).toBe(401);
});
test('Firestore changes notify only the subscribed project; events carry topic names alone', async () => {
  const f = await fixture(), response = await f.open();
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const stream = await collect(response); await until(() => stream.events.length > 0); await settle(1200); stream.events.length = 0;
  await db.doc(`projects/${'a'.repeat(64)}/conversationEntries/other`).set({ createdAt: 1, body: 'not this project' });
  await settle(1200); expect(stream.events).toEqual([]);
  await db.doc(`projects/${TEST_PROJECT}/conversationEntries/new`).set({ createdAt: 2, body: 'sensitive body must never appear in SSE' });
  await until(() => stream.events.some(topics => topics.includes('conversations')));
  expect(stream.events).toEqual([['conversations']]);
  stream.events.length = 0;
  await db.doc(`projects/${TEST_PROJECT}/chatReactions/human-test`).set({ counts: { '👍': 1 }, updatedAt: FieldValue.serverTimestamp() });
  await until(() => stream.events.some(topics => topics.includes('conversations')));
  expect(stream.events).toEqual([['conversations']]); stream.events.length = 0;
  await db.doc(`projects/${TEST_PROJECT}/currentStateProgress/00`).set({ sequence: 1 });
  await until(() => stream.events.some(topics => topics.includes('agents')));
  expect(stream.events).toEqual([['agents']]);
  stream.events.length = 0;
  await db.doc(`projects/${TEST_PROJECT}/nativeTeamProgress/00`).set({ revision: 1 });
  await settle(1200);
  expect(stream.events).toEqual([]); // Already-open clients did not opt in to the new topic.
  await membershipDoc(TEST_PROJECT, f.personIds[0]).update({ status: 'removed' });
  await db.doc(`projects/${TEST_PROJECT}/conversationEntries/new`).update({ createdAt: 3 });
  stream.events.length = 0; await until(stream.ended); expect(stream.events).toEqual([]);
});
test('opted-in team streams observe bounded revision shards and recheck project access', async () => {
  const f = await fixture();
  expect((await f.open('', 'teams')).status).toBe(400);
  expect((await f.open(TEST_PROJECT, 'teams,private-record')).status).toBe(400);
  const stream = await collect(await f.open(TEST_PROJECT, 'teams'));
  await until(() => stream.events.length > 0); await settle(1200); stream.events.length = 0;
  await db.doc(`projects/${'a'.repeat(64)}/nativeTeamProgress/00`).set({ revision: 1 });
  await db.doc(`projects/${TEST_PROJECT}/conversationEntries/unrelated`).set({ createdAt: 1 });
  await settle(1200); expect(stream.events).toEqual([]);
  await db.doc(`projects/${TEST_PROJECT}/nativeTeamProgress/00`).set({ revision: 1 });
  await until(() => stream.events.length > 0); expect(stream.events).toEqual([['teams']]); stream.events.length = 0;
  // No timestamp or newest-team selector: another change on the same shard is visible.
  await db.doc(`projects/${TEST_PROJECT}/nativeTeamProgress/00`).set({ revision: 2 });
  await until(() => stream.events.length > 0); expect(stream.events).toEqual([['teams']]); stream.events.length = 0;
  await membershipDoc(TEST_PROJECT, f.personIds[0]).update({ status: 'removed' });
  await db.doc(`projects/${TEST_PROJECT}/nativeTeamProgress/00`).set({ revision: 3 });
  await until(stream.ended); expect(stream.events).toEqual([]);
});
test('Needs you watches preserve private visibility and observe status transitions', async () => {
  const f = await fixture(), stream = await collect(await f.open());
  await until(() => stream.events.length > 0); await settle(1200); stream.events.length = 0;
  const hidden = db.doc('humanRequests/' + 'b'.repeat(64)), visible = db.doc('humanRequests/' + 'c'.repeat(64));
  await hidden.set({ projectId: TEST_PROJECT, assigneeProfileId: f.personIds[1], visibility: 'private', status: 'open', createdAt: 1 });
  await settle(1200); expect(stream.events).toEqual([]);
  await visible.set({ projectId: TEST_PROJECT, assigneeProfileId: f.personIds[0], visibility: 'private', status: 'open', createdAt: 2 });
  await until(() => stream.events.length > 0); expect(stream.events).toEqual([['needs-you']]); stream.events.length = 0;
  await visible.update({ status: 'answered' });
  await until(() => stream.events.length > 0); expect(stream.events.every(topics => topics.every(topic => topic === 'needs-you'))).toBe(true);
});
test('account invalidations exclude requests and notifications after project removal', async () => {
  const f = await fixture(), stream = await collect(await f.open(''));
  await until(() => stream.events.length > 0); await settle(1200); stream.events.length = 0;
  const request = db.doc('humanRequests/' + 'd'.repeat(64)), notification = db.doc(`profiles/${f.personIds[0]}/notifications/notice`);
  await request.set({ projectId: TEST_PROJECT, assigneeProfileId: f.personIds[0], visibility: 'private', status: 'open', createdAt: 1 });
  await until(() => stream.events.length > 0); stream.events.length = 0;
  await notification.set({ projectId: TEST_PROJECT, readAt: null, createdAt: 1 });
  await until(() => stream.events.length > 0); stream.events.length = 0;
  await membershipDoc(TEST_PROJECT, f.personIds[0]).update({ status: 'removed' });
  await request.update({ question: 'Excluded activity' }); await notification.update({ reason: 'Excluded activity' });
  await settle(1500); expect(stream.events).toEqual([]); expect(stream.ended()).toBe(false);
});
test('a hidden insertion cannot signal by evicting a visible row from a full account window', async () => {
  const f = await fixture(), stream = await collect(await f.open(''));
  await until(() => stream.events.length > 0); await settle(1200); stream.events.length = 0;
  const batch = db.batch();
  for (let index = 1; index <= 21; index++) batch.set(db.doc(`humanRequests/visible-${index}`), {
    projectId: TEST_PROJECT, assigneeProfileId: f.personIds[0], visibility: 'private', status: 'open', createdAt: index,
  });
  await batch.commit(); await until(() => stream.events.length > 0); await settle(1200); stream.events.length = 0;
  await db.doc('humanRequests/hidden-newest').set({ projectId: TEST_PROJECT, assigneeProfileId: f.personIds[0], visibility: 'moderators', status: 'open', createdAt: 99 });
  await settle(1500); expect(stream.events).toEqual([]);
  await db.doc('humanRequests/hidden-newest').delete();
  await settle(1500); expect(stream.events).toEqual([]);
  await db.doc('humanRequests/visible-21').delete();
  await until(() => stream.events.length > 0); expect(stream.events).toEqual([['needs-you']]);
});
test('a slow initial account listener invalidates again after its read boundary is established', async () => {
  const original = QueryPrototype.onSnapshot;
  vi.spyOn(QueryPrototype, 'onSnapshot').mockImplementation(function(this: Query, ...args: any[]) {
    let stop: (() => void) | undefined;
    const timer = setTimeout(() => { stop = (original as (...values: any[]) => () => void).apply(this, args); }, 2500);
    return () => { clearTimeout(timer); stop?.(); };
  });
  const f = await fixture(), stream = await collect(await f.open(''));
  await until(() => stream.events.length > 0); stream.events.length = 0;
  // This write happens after the initial HTTP refresh but before SDK attachment.
  await db.doc('humanRequests/slow-initial-request').set({ projectId: TEST_PROJECT, assigneeProfileId: f.personIds[0], visibility: 'private', status: 'open', createdAt: 1 });
  await until(() => stream.events.length > 0); expect(stream.events).toEqual([['needs-you']]);
});
