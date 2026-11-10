import express from 'express';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { db, inProject, profiles, projectDoc } from '../src/firestore.js';
import { PROPOSAL_CONTENT, STORED_PROPOSAL_CONTENT } from '../src/community/content.js';
import { PROJECT_RECORD, readProjectRecord } from '../src/projects/schema.js';
import { approvalOriginalDoc, runtimeOf } from '../src/projects/records.js';
import { cardDoc, CARD_EDIT } from '../src/projects/card.js';
import { projectManagementRoutes } from '../src/projects/routes.js';
import { readWorkspace, CONFIGURE } from '../src/projects/store.js';
import { serverFor } from '../src/v2/routes.js';
import { idTokenFor, resetEmulator, seed, TEST_PROJECT } from './helpers.js';

let server: Server, base: string;
beforeAll(async () => {
  const app = express(); app.use('/api/projects', projectManagementRoutes(() => 1000));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/projects/${TEST_PROJECT}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(resetEmulator);

test('stored project policy stays readable without exposing voting or rewriting archival records', async () => {
  const { personIds: [ownerId] } = await seed({ profiles: [{ name: 'Owner', email: 'owner@example.test' }] });
  const ref = db.doc(`projects/${TEST_PROJECT}`), original = (await ref.get()).data()!;
  const old = { ...original, approval: { ...original.approval, proposedGovernance: { outcome: 'binding' } },
    setup: { ...original.setup, governance: { outcome: 'binding' }, minCountdownS: 60, maxCountdownS: 86400 } };
  await ref.set(old);
  expect(PROJECT_RECORD.safeParse(old).success).toBe(false);
  const parsed = readProjectRecord(old);
  expect(parsed.setup).not.toHaveProperty('governance');
  expect(runtimeOf(parsed)).not.toHaveProperty('minCountdownS');
  expect(() => readProjectRecord({ ...old, setup: { ...old.setup, arbitraryAuthority: true } })).toThrow();
  await inProject(TEST_PROJECT, async () => { expect((await projectDoc().get()).data()).toEqual(parsed); });
  const workspace = await readWorkspace({ id: ownerId, ...(await profiles.doc(ownerId).get()).data()! }, TEST_PROJECT);
  expect(workspace).not.toHaveProperty('governance'); expect(workspace).not.toHaveProperty('proposedGovernance');
  expect((await ref.get()).data()).toEqual(old);
  const approvalRef = db.doc(`projects/${TEST_PROJECT}/approval/original`);
  const approval = (await approvalRef.get()).data()!;
  await approvalRef.update({ 'definition.governance': { outcome: 'binding' } });
  expect((await approvalOriginalDoc(TEST_PROJECT).get()).data()!.definition).not.toHaveProperty('governance');
  const cardRef = db.doc(`projects/${TEST_PROJECT}/card/current`);
  await cardRef.update({ 'definition.governance': { outcome: 'binding' } });
  expect((await cardDoc(TEST_PROJECT).get()).data()!.definition).not.toHaveProperty('governance');
  expect(PROPOSAL_CONTENT.safeParse({ ...approval.definition, governance: {} }).success).toBe(false);
  expect(STORED_PROPOSAL_CONTENT.parse({ ...approval.definition, governance: {} })).not.toHaveProperty('governance');
  expect(CARD_EDIT.safeParse({ client_request_id: 'edit', expected_version: 1, definition: { ...approval.definition, governance: {} } }).success).toBe(false);
  expect(CONFIGURE.safeParse({ client_request_id: 'setup', expected_revision: 1, repoUrl: 'https://github.com/example/game', governance: null }).success).toBe(false);
});

test('authenticated owners cannot reach retired voting configuration or direction endpoints', async () => {
  await seed({ profiles: [{ name: 'Owner', email: 'owner@example.test' }] });
  const token = await idTokenFor('owner@example.test');
  for (const [method, path] of [['GET','/directions'], ['GET','/directions/probe'], ['POST','/directions'], ['POST','/directions/probe/votes'], ['POST','/directions/probe/close'], ['POST','/directions/probe/retry'], ['POST','/directions/probe/outcome'], ['POST','/directions/probe/end'], ['POST','/voting']]) {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
    expect(response.status, `${method} ${path}`).toBe(404);
  }
});

test('MCP catalog removes every ballot tool while retaining progress and human-help tools', async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = serverFor({ id: 'catalog', name: 'Catalog' } as never, undefined, Date.now, () => 0, async () => ({ count: 0, observedAt: 0 }));
  const client = new Client({ name: 'retirement-test', version: '1' });
  try {
    await mcp.connect(b); await client.connect(a);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ['open_vote','cast_vote','get_vote','list_votes','resolve_vote','open_decision','vote','get_decision','list_decisions','decide_direction']) expect(names).not.toContain(name);
    for (const name of ['get_project','publish_project_update','list_project_updates','request_human_help','list_human_requests','resolve_human_request']) expect(names).toContain(name);
  } finally { await client.close(); await mcp.close(); }
});
