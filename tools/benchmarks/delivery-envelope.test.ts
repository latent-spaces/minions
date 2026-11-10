import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryEnvelope, sourceWork, type SourceShape } from './delivery-envelope.js';

const shape = (patch: Partial<SourceShape> = {}): SourceShape => ({
  name: 'small queued', sourcesPerSecond: 1, discoveryRows: 5,
  eligibleRecipients: 5, inlineSuccessFraction: 0, ...patch,
});
const queue = { dispatchesPerSecond: 4, concurrency: 4, invocationSeconds: 1, outageSeconds: 600 };

test('equal recipient demand can overload small-source queue while large sources fit', () => {
  const small = deliveryEnvelope([shape({ sourcesPerSecond: 288 / 5 })], queue);
  const large = deliveryEnvelope([shape({ discoveryRows: 5000, eligibleRecipients: 5000, sourcesPerSecond: 288 / 5000 })], queue);
  assert.equal(small.work[0].recipientDeliveriesPerSecond, 288);
  assert.equal(large.work[0].recipientDeliveriesPerSecond, 288);
  assert.equal(small.optimisticOfferedLoadRatio, 14.4);
  assert.ok(large.optimisticOfferedLoadRatio < 0.19);
  assert.equal(small.optimisticDrainSeconds, null);
  assert.ok(large.optimisticDrainSeconds! > 120);
});

test('completion counts short final discovery page, independently of eligible recipients', () => {
  for (const [rows, invocations] of [[0, 1], [399, 1], [400, 2], [401, 2], [799, 2], [800, 3]]) {
    assert.equal(sourceWork(shape({ discoveryRows: rows, eligibleRecipients: 0 })).invocationsPerSource, invocations);
  }
  assert.equal(sourceWork(shape({ discoveryRows: 400, eligibleRecipients: 399 })).invocationsPerSource, 2);
});

test('successful inline slice moves work to API but cannot pack unrelated sources', () => {
  const allInline = sourceWork(shape({ sourcesPerSecond: 1000, inlineSuccessFraction: 1 }));
  assert.equal(allInline.queuedInvocationsPerSecond, 0);
  assert.equal(allInline.inlineInvocationsPerSecond, 1000);
  const mixed = sourceWork(shape({ sourcesPerSecond: 1000, inlineSuccessFraction: 0.25 }));
  assert.equal(mixed.queuedInvocationsPerSecond, 750);
  assert.equal(mixed.inlineInvocationsPerSecond, 250);
  assert.equal(sourceWork(shape({ discoveryRows: 400, inlineSuccessFraction: 1 })).queuedInvocationsPerSecond, 1);
});

test('service duration and concurrency constrain the optimistic ceiling', () => {
  const slow = deliveryEnvelope([shape()], { ...queue, invocationSeconds: 4 });
  assert.equal(slow.serviceCeilingPerSecond, 1);
  assert.equal(slow.optimisticDrainSeconds, null);
  assert.equal(deliveryEnvelope([shape()], { ...queue, concurrency: 40 }).serviceCeilingPerSecond, 4);
});

test('outage debt drains only against spare service while new sources continue', () => {
  const result = deliveryEnvelope([shape({ sourcesPerSecond: 2 })], queue);
  assert.equal(result.backlogInvocationWork, 1200);
  assert.equal(result.optimisticDrainSeconds, 600);
  assert.equal(deliveryEnvelope([shape({ sourcesPerSecond: 4 })], queue).optimisticDrainSeconds, null);
  assert.equal(deliveryEnvelope([shape({ sourcesPerSecond: 5 })], queue).optimisticDrainSeconds, null);
  assert.equal(deliveryEnvelope([], queue).optimisticDrainSeconds, 0);
  assert.equal(deliveryEnvelope([shape()], { ...queue, outageSeconds: 0 }).optimisticDrainSeconds, 0);
  const noOutageOverload = deliveryEnvelope([shape({ sourcesPerSecond: 5 })], { ...queue, outageSeconds: 0 });
  assert.equal(noOutageOverload.optimisticDrainSeconds, 0);
  assert.equal(noOutageOverload.optimisticHasSpareCapacity, false);
});

test('mixed source paths add invocation demand before comparing with service', () => {
  const result = deliveryEnvelope([shape(), shape({ discoveryRows: 5000, sourcesPerSecond: 0.1, inlineSuccessFraction: 1 })], queue);
  assert.equal(result.queuedInvocationsPerSecond, 2.2);
  assert.equal(result.work[1].inlineInvocationsPerSecond, 0.1);
});

test('invalid populations and nonfinite assumptions cannot silently produce a capacity result', () => {
  for (const patch of [{ discoveryRows: -1 }, { discoveryRows: 1.5 }, { discoveryRows: Infinity },
    { eligibleRecipients: 6 }, { inlineSuccessFraction: 1.1 }, { sourcesPerSecond: NaN }]) {
    assert.throws(() => sourceWork(shape(patch)));
  }
  for (const patch of [{ dispatchesPerSecond: 0 }, { concurrency: 0 }, { concurrency: 1.5 },
    { invocationSeconds: 0 }, { outageSeconds: -1 }, { dispatchesPerSecond: Infinity }]) {
    assert.throws(() => deliveryEnvelope([shape()], { ...queue, ...patch }));
  }
  assert.throws(() => sourceWork(shape({ sourcesPerSecond: Number.MAX_VALUE })));
  assert.throws(() => deliveryEnvelope([shape({ sourcesPerSecond: 1e300 })], { ...queue, outageSeconds: 1e300 }));
});
