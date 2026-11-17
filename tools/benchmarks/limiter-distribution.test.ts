import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admittedBurst, steadyKeys } from './limiter-distribution.js';

test('random routing multiplies one identity\'s budget by the instances it reaches; affinity keeps it', () => {
  assert.equal(admittedBurst({ instances: 1, routing: 'random' }), 60);
  assert.equal(admittedBurst({ instances: 4, routing: 'random' }), 240);
  for (const instances of [2, 4, 10]) assert.equal(admittedBurst({ instances, routing: 'affinity' }), 60);
});

test('affinity puts a 5,000-agent project\'s keys on one process at its namespace cap; random spreads them', () => {
  const affinity = steadyKeys({ projects: 1, perProject: 5000, instances: 4, routing: 'affinity' });
  assert.deepEqual([affinity.maxKeysPerProcess, affinity.largestNamespace], [15_000, 5000]);
  const random = steadyKeys({ projects: 1, perProject: 5000, instances: 4, routing: 'random' });
  assert.ok(random.largestNamespace < 5000 && random.maxKeysPerProcess < 15_000);
  // Agent 5,001 on the affinity process is refused for 60 s (the namespace bound).
  const over = steadyKeys({ projects: 1, perProject: 5001, instances: 4, routing: 'affinity' });
  assert.ok(over.refusedNewKeys > 0);
});

test('many small projects spread evenly under affinity and no namespace fills', () => {
  const small = steadyKeys({ projects: 1000, perProject: 5, instances: 4, routing: 'affinity' });
  assert.equal(small.largestNamespace, 5);
  assert.ok(small.maxKeysPerProcess < 15_000 / 2);
  assert.equal(small.refusedNewKeys, 0);
});

test('agent affinity keeps every per-agent budget exact and spreads a flagship project across processes', () => {
  for (const instances of [2, 4, 10]) assert.equal(admittedBurst({ instances, routing: 'agent' }), 60);
  const agent = steadyKeys({ projects: 1, perProject: 5001, instances: 4, routing: 'agent' });
  assert.equal(agent.refusedNewKeys, 0);
  assert.ok(agent.largestNamespace < 5000 / 2 && agent.maxKeysPerProcess < 15_000 / 2);
});
