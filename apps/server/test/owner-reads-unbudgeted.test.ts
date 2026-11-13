import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { viewRoutes } from '../src/view/routes.js';
import { projectManagementRoutes } from '../src/projects/routes.js';
import { idTokenFor, resetEmulator, scoped, seed } from './helpers.js';

// The engine serves one owner on this computer. Reloading a project page or switching its tabs a few times sent more
// than the former per-viewer budgets (60 view reads, 120 management reads a minute) and showed "Too many requests".
let server: Server, base: string;
const now = 1_000_000;
beforeAll(async () => {
  const app = express();
  app.use('/view', scoped(viewRoutes(() => now)));
  app.use('/projects', projectManagementRoutes(() => now));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });

test('the owner\'s project reads are never refused for volume within a minute', async () => {
  await resetEmulator();
  await seed({ profiles: [{ name: 'Owner', email: 'owner-reads@example.test' }] });
  const token = await idTokenFor('owner-reads@example.test'), headers = { authorization: `Bearer ${token}` };
  for (let i = 0; i < 150; i++) {
    const [view, projects] = await Promise.all([fetch(`${base}/view/overview`, { headers }), fetch(`${base}/projects`, { headers })]);
    expect([view.status, projects.status]).toEqual([200, 200]);
    await Promise.all([view.arrayBuffer(), projects.arrayBuffer()]);
  }
});
