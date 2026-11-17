// Pure scheduling simulation; no network, model, API or database load.
import { createWorkController } from '../../../packages/agent-cli/runtime/work-controller.mjs';
import { performance } from 'node:perf_hooks';
let time = 0;
const began = performance.now();
const controllers = Array.from({ length: 5000 }, (_, i) => createWorkController({
  now: () => time, random: () => i / 5000, quietIntervalMs: 900000, quietJitterMs: 90000,
}));
for (const controller of controllers) {
  const news = { project: { started: true, paused: false }, pending: 0, work: { runnable: false, revision: 0 } };
  controller.beginTurn(news);
  controller.recordOutcome({ kind: 'ok', news });
}
time = 60000;
const earlyIdleModelWakes = controllers.filter(controller => controller.decide({
  news: { project: { started: true, paused: false }, pending: 0 },
}).action === 'run').length;
const wakes = controllers.map(controller => controller.status().quietAt);
console.log(JSON.stringify({
  kind: 'pure in-memory scheduler only; not production capacity proof', controllers: controllers.length,
  earlyIdleModelWakes, quietSpreadMilliseconds: Math.max(...wakes) - Math.min(...wakes),
  milliseconds: performance.now() - began,
}));
if (earlyIdleModelWakes !== 0 || Math.max(...wakes) === Math.min(...wakes)) process.exitCode = 1;
