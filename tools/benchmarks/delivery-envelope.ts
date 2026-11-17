// Hypothetical work accounting, not a scheduler simulation or measured capacity.
// Source: integration 3517fbc8, v2/fanout.ts MAX_BATCHES=4 and config fanoutBatch=100.
export type SourceShape = {
  name: string;
  sourcesPerSecond: number;
  discoveryRows: number;
  eligibleRecipients: number;
  // Fraction completing exactly one successful inline slice. No partial/crashed inline work.
  inlineSuccessFraction: number;
};
export type QueueAssumptions = {
  dispatchesPerSecond: number;
  concurrency: number;
  invocationSeconds: number;
  outageSeconds: number;
};

function finite(name: string, value: number, minimum = 0) {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`Invalid ${name}.`);
}
function integer(name: string, value: number) {
  finite(name, value);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${name}.`);
}

export function sourceWork(shape: SourceShape) {
  finite('sourcesPerSecond', shape.sourcesPerSecond);
  integer('discoveryRows', shape.discoveryRows);
  integer('eligibleRecipients', shape.eligibleRecipients);
  finite('inlineSuccessFraction', shape.inlineSuccessFraction);
  if (shape.eligibleRecipients > shape.discoveryRows || shape.inlineSuccessFraction > 1) {
    throw new Error('Recipients must fit discovery rows; inline fraction must be at most one.');
  }
  // Completion requires a short page. An exact multiple of 400 needs an empty final page.
  const invocationsPerSource = Math.floor(shape.discoveryRows / 400) + 1;
  const inlineInvocationsPerSecond = shape.sourcesPerSecond * shape.inlineSuccessFraction;
  const result = {
    name: shape.name,
    invocationsPerSource,
    inlineInvocationsPerSecond,
    queuedInvocationsPerSecond: shape.sourcesPerSecond * (invocationsPerSource - shape.inlineSuccessFraction),
    recipientDeliveriesPerSecond: shape.sourcesPerSecond * shape.eligibleRecipients,
  };
  for (const [name, value] of Object.entries(result)) if (typeof value === 'number') finite(name, value);
  return result;
}

export function deliveryEnvelope(shapes: SourceShape[], queue: QueueAssumptions) {
  finite('dispatchesPerSecond', queue.dispatchesPerSecond);
  integer('concurrency', queue.concurrency);
  finite('invocationSeconds', queue.invocationSeconds);
  finite('outageSeconds', queue.outageSeconds);
  if (queue.dispatchesPerSecond === 0 || queue.concurrency === 0 || queue.invocationSeconds === 0) {
    throw new Error('Service assumptions must be positive.');
  }
  const work = shapes.map(sourceWork);
  const queuedInvocationsPerSecond = work.reduce((sum, row) => sum + row.queuedInvocationsPerSecond, 0);
  // No retries, cold starts, selector delay, database contention, or hint overhead included.
  const serviceCeilingPerSecond = Math.min(queue.dispatchesPerSecond, queue.concurrency / queue.invocationSeconds);
  const spareCeilingPerSecond = serviceCeilingPerSecond - queuedInvocationsPerSecond;
  const backlogInvocationWork = queuedInvocationsPerSecond * queue.outageSeconds;
  const result = {
    evidence: 'hypothetical static-source work; no observed, billed, or cloud capacity' as const,
    work,
    queuedInvocationsPerSecond,
    serviceCeilingPerSecond,
    optimisticHasSpareCapacity: spareCeilingPerSecond > 0,
    optimisticOfferedLoadRatio: queuedInvocationsPerSecond / serviceCeilingPerSecond,
    backlogInvocationWork,
    // null means no finite fluid drain with ongoing arrivals under these assumptions.
    optimisticDrainSeconds: backlogInvocationWork === 0 ? 0
      : spareCeilingPerSecond > 0 ? backlogInvocationWork / spareCeilingPerSecond : null,
  };
  for (const [name, value] of Object.entries(result)) if (typeof value === 'number') finite(name, value);
  return result;
}
