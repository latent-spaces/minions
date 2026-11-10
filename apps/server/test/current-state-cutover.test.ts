import express from 'express';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { agents, profiles, projectDoc, db, inProject } from '../src/firestore.js';
import { CURRENT_STATE_CUTOVER_RECEIPT } from '../src/view/current-state-cutover.js';
import { configureCurrentState, currentStateStats, readCurrentState, stopCurrentState } from '../src/view/current-state.js';
import { updateCanonicalStatus } from './canonical-status-fixture.js';
import { presence } from '../src/v2/records.js';
import { canonicalStatusSources, readReadyCanonicalContacts } from '../src/view/communication-agents.js';
import { findAgents } from '../src/v2/agents.js';
import { publishCatalog } from '../src/projects/catalog.js';
import { publicProjectRoutes } from '../src/projects/public.js';
import { viewRoutes } from '../src/view/routes.js';
import { resetEmulator, seed, seedCurrentStateReady, idTokenFor, scoped, TEST_PROJECT } from './helpers.js';

let owner = '', id = '', undo = () => {};
const read = () => inProject(TEST_PROJECT, () => readCurrentState(owner, true, undefined, 1000));
const receipt = () => db.doc(CURRENT_STATE_CUTOVER_RECEIPT);
beforeEach(async () => {
  stopCurrentState(); await resetEmulator();
  const f = await seed({ profiles: [{ name: 'Owner', email: 'barrier@example.test' }], agents: [{ person: 0, name: 'Current' }] });
  owner = f.personIds[0]!; id = f.agents[0]!.agentId;
  undo = configureCurrentState({});
});
afterEach(() => { undo(); stopCurrentState(); });

test('no shared proof or canonical seed is published until the operator receipt exists', async () => {
  await receipt().delete();
  await expect(read()).rejects.toMatchObject({ code: 'project_busy' });
  expect(currentStateStats()).toMatchObject({ canonicalReads: 0, cachedProjects: 0, readinessReads: 1 });
  // An old writer can still commit during the drain window. Activation must seed
  // after that window, never reuse an input retained while the barrier was shut.
  await inProject(TEST_PROJECT, () => presence().doc(id).update({ 'agent.focus': { text: 'last old writer', updatedAt: 1000 } }));
  await seedCurrentStateReady();
  expect((await read()).rows).toContainEqual(expect.objectContaining({ id, focus: { text: 'last old writer', updatedAt: 1000 } }));
  expect(currentStateStats()).toMatchObject({ canonicalReads: 1, cachedProjects: 1 });
});

test('malformed receipts and unsupported epochs cannot admit a reader', async () => {
  for (const patch of [{ schema: 0 }, { epoch: 'timestamp-wip' }, { writerSource: 'unknown' }, { evidenceSha256: '' }]) {
    await seedCurrentStateReady(); await receipt().update(patch);
    await expect(read()).rejects.toMatchObject({ code: 'project_busy' });
    expect(currentStateStats().canonicalReads).toBe(0);
  }
});

test('the authorized HTTP reader returns retryable no-store 503 while the barrier is closed', async () => {
  await receipt().delete();
  const app = express(); app.use(scoped(viewRoutes(() => 1000)));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const token = await idTokenFor('barrier@example.test');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const path of ['/communication/agents/current', '/agents', `/communication/agents?ids=${id}`]) {
      const response = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status, path).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('retry-after')).toBe('2');
      expect(await response.json()).toMatchObject({ error: 'project_busy' });
    }
    expect((await fetch(base + '/agents?view=labels', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


test('owned page inputs cannot bypass a closed readiness barrier', async () => {
  configureCurrentState({ maxProjects: 0, currentBytes: 0, pageSize: 1 });
  await seed({ profiles: [{ name: 'Second owner', email: 'second-barrier@example.test' }], agents: [{ person: 0, name: 'Second' }] });
  const first = await read();
  expect(first.more).toBe(true);
  expect(currentStateStats().ownedChains).toBe(1);
  await receipt().delete();
  await expect(inProject(TEST_PROJECT, () => readCurrentState(owner, true, first.cursor, 1000)))
    .rejects.toMatchObject({ code: 'project_busy' });
  expect(currentStateStats().ownedChains).toBe(0);
});


test('a changed receipt always discards prior proof even when a dirty delta is nonempty', async () => {
  const second = await seed({ profiles: [{ name: 'Second', email: 'receipt-second@example.test' }], agents: [{ person: 0, name: 'Other' }] });
  const first = await read();
  await inProject(TEST_PROJECT, async () => {
    await presence().doc(id).update({ 'agent.focus': { text: 'unfenced before attestation', updatedAt: 1000 } });
    await updateCanonicalStatus(second.agents[0]!.agentId, { 'agent.focus': { text: 'fenced', updatedAt: 1000 } });
  });
  await receipt().update({ evidenceSha256: 'c'.repeat(64) });
  const next = await inProject(TEST_PROJECT, () => readCurrentState(owner, true, first.cursor, 1000));
  expect(next.rows).toContainEqual(expect.objectContaining({ id, focus: { text: 'unfenced before attestation', updatedAt: 1000 } }));
  expect(currentStateStats().canonicalReads).toBe(2);
});

test('a changed valid receipt reseeds owned input while continuing from the held floor', async () => {
  configureCurrentState({ maxProjects: 0, currentBytes: 0, pageSize: 1 });
  await seed({ profiles: [{ name: 'Other', email: 'owned-receipt@example.test' }], agents: [{ person: 0, name: 'Other' }] });
  const first = await read();
  expect(first.more).toBe(true);
  const sent = first.rows[0]!.id;
  expect(currentStateStats()).toMatchObject({ oneShots: 1, ownedChains: 1 });
  await receipt().update({ evidenceSha256: 'd'.repeat(64) });
  const next = await inProject(TEST_PROJECT, () => readCurrentState(owner, true, first.cursor, 1000));
  expect(next).toMatchObject({ complete: true, more: false });
  expect(next.rows).toHaveLength(1);
  expect(next.rows[0]!.id).not.toBe(sent);
  expect(currentStateStats()).toMatchObject({ oneShots: 2, ownedChains: 0 });
});


test('MCP and direct canonical acquisition refuse admission; raw pre-barrier snapshots are not trusted', async () => {
  const docs = await inProject(TEST_PROJECT, () => agents().get());
  const raw = await inProject(TEST_PROJECT, () => presence().doc(id).get());
  await receipt().delete();
  await expect(inProject(TEST_PROJECT, () => findAgents({}, () => 1000, owner))).rejects.toMatchObject({ code: 'project_busy' });
  await expect(inProject(TEST_PROJECT, () => readReadyCanonicalContacts([id]))).rejects.toMatchObject({ code: 'project_busy' });
  await seedCurrentStateReady();
  await expect(inProject(TEST_PROJECT, () => canonicalStatusSources(docs.docs, owner, undefined, [raw] as never)))
    .rejects.toThrow('status documents must match found');
  await inProject(TEST_PROJECT, () => updateCanonicalStatus(id, { 'agent.focus': { text: 'after barrier', updatedAt: 1000 } }));
  const admitted = await inProject(TEST_PROJECT, () => readReadyCanonicalContacts([id]));
  expect(admitted.docs[0]!.get('agent.focus.text')).toBe('after barrier');
});

test('public status and raw contact views return uncached retryable 503 before admission', async () => {
  await inProject(TEST_PROJECT, () => projectDoc().update({ ownerProfileId: owner }));
  const person = { id: owner, ...(await profiles.doc(owner).get()).data()! };
  await publishCatalog(person as never, TEST_PROJECT, { client_request_id: 'publish-barrier', expected_revision: 0,
    listed: true, summary: 'Synthetic barrier fixture', category: 'games', tags: [] }, () => 1000);
  await receipt().delete();
  const app = express(); app.use('/public/:id', publicProjectRoutes(() => 1000));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    for (const path of ['/agents', `/agents/${id}`]) {
      const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/public/${TEST_PROJECT}${path}`);
      expect(response.status, path).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('retry-after')).toBe('2');
      expect(await response.json()).toMatchObject({ error: 'project_busy' });
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
