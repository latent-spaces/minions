// Explicit, model-free sample. All populations and invocation durations are synthetic.
import { deliveryEnvelope } from './delivery-envelope.js';

const cases = [5, 50, 500, 5000].flatMap(discoveryRows => [0, 1].map(inlineSuccessFraction => ({
  discoveryRows, inlineSuccessFraction,
})));
console.log(JSON.stringify({
  sourceCommit: '3517fbc8',
  caveat: 'Hypothetical static discovery sets, no retries or extra request-assisted recovery. Not cloud capacity or a selected SLO.',
  cases: cases.map(({ discoveryRows, inlineSuccessFraction }) => ({
    discoveryRows, inlineSuccessFraction,
    ...deliveryEnvelope([{
      name: `${discoveryRows} recipients; ${inlineSuccessFraction ? 'inline first slice' : 'queued only'}`,
      discoveryRows, eligibleRecipients: discoveryRows, inlineSuccessFraction,
      sourcesPerSecond: 288 / discoveryRows,
    }], { dispatchesPerSecond: 4, concurrency: 4, invocationSeconds: 1, outageSeconds: 600 }),
  })),
}, null, 2));
