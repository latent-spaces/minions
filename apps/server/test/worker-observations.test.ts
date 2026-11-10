import { expect, test, vi } from 'vitest';
import type { Transaction } from 'firebase-admin/firestore';
vi.mock('../src/v2/records.js', () => ({
  presence: () => ({ doc: (id: string) => `presence/${id}` }),
  runnerUsage: () => ({ doc: (id: string) => `usage/${id}` }),
}));
import { readWorkerObservation } from '../src/projects/worker-observations.js';

test('own-agent observations preserve the execution provider without adding reads or exposing the model', async () => {
  const get = vi.fn(async (ref: string) => ({ data: () => ref.startsWith('usage/')
    ? { provider: 'codex', model: 'claude-rerouted', lastReportedAt: 120, input: 3, output: 2, turns: 1 }
    : { lastContactAt: 100 } }));
  const result = await readWorkerObservation({ get } as unknown as Transaction, 'agent');
  expect(result.usage?.provider).toBe('codex');
  expect(result.usage).not.toHaveProperty('model');
  expect(result.lastActivityAt).toBe(120);
  expect(get.mock.calls.map(([ref]) => ref)).toEqual(['presence/agent', 'usage/agent']);
});

test('missing usage stays unknown instead of manufacturing a tool identity', async () => {
  const get = vi.fn(async () => ({ data: () => undefined }));
  expect(await readWorkerObservation({ get } as unknown as Transaction, 'agent')).toEqual({ usage: null, lastActivityAt: null });
});
