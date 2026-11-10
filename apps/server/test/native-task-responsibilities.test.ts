import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { inProject, profiles, projectCollection } from '../src/firestore.js';
import { publicProjectRoutes } from '../src/projects/public.js';
import { viewRoutes } from '../src/view/routes.js';
import { mutateNativeTask } from '../src/projects/native-tasks.js';
import { idTokenFor, resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';

let server: Server, base: string;
beforeAll(async () => {
  const app = express(); app.use(scoped(viewRoutes(Date.now)));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(resetEmulator);

test('personal responsibility reads native assignments and ignores retired Issue claims', async () => {
  const fixture = await seed({ profiles: [{ name: 'A', email: 'a@example.test', role: 'owner' }, { name: 'B', email: 'b@example.test' }], agents: [{ person: 0, name: 'scout' }, { person: 1, name: 'owl' }] });
  const token = await idTokenFor('a@example.test');
  await inProject(TEST_PROJECT, async () => {
    const person = { id: fixture.personIds[0], ...(await profiles.doc(fixture.personIds[0]).get()).data()! };
    for (const [index, title] of ['Native responsibility', 'Another agent'].entries()) {
      const { task } = await mutateNativeTask({ kind: 'person', person }, { operation: 'create', clientRequestId: randomUUID(), title });
      await mutateNativeTask({ kind: 'person', person }, { operation: 'assign', clientRequestId: randomUUID(), taskId: task.id, expectedRevision: task.revision, assignedAgentId: fixture.agents[index].agentId });
    }
    await projectCollection('issueClaims').doc('retired').set({ ownerAgentId: fixture.agents[0].agentId, issueNumber: 99, issueUrl: 'https://github.com/example/game/issues/99' });
  });
  const reply = await fetch(`${base}/agents/${fixture.agents[0].agentId}/responsibilities`, { headers: { authorization: `Bearer ${token}` } });
  expect(reply.status).toBe(200); const body = await reply.json();
  expect(body.tasks).toHaveLength(1); expect(body.tasks[0]).toMatchObject({ title: 'Native responsibility', status: 'backlog', revision: 2 });
  expect(body.issues).toBeUndefined(); expect(JSON.stringify(body)).not.toContain('github.com');
  expect((await fetch(`${base}/agents/${fixture.agents[1].agentId}/responsibilities`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
});


test('published project readers expose no retired GitHub Issue board or native task access', () => {
  const routes = publicProjectRoutes(Date.now).stack.flatMap(layer => layer.route ? [layer.route.path] : []);
  expect(routes).not.toContain('/issues');
  expect(routes).not.toContain('/tasks');
});
