// Model-free study of the per-process admission limiter (apps/server/src/request-state.ts) under several
// API/control processes. It runs the real WindowLimitStore, one per simulated instance, and routes each request
// at random (Cloud Run today), by project (affinity) or by agent (agent affinity, c8 §4f). It measures what the limiter actually enforces:
// the effective per-identity budget, keys held per process, and new-identity refusals. No product limit changes.
import { WindowLimitStore } from '../../apps/server/src/request-state.js';

export type Routing = 'random' | 'affinity' | 'agent';
// Small deterministic PRNG so runs are reproducible.
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const hash = (text: string) => { let h = 2166136261; for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
function route(routing: Routing, instances: number, project: string, random: () => number, agent = '') {
  if (routing === 'random') return Math.floor(random() * instances);
  return hash(routing === 'agent' ? `${project}/${agent}` : project) % instances;
}

// One agent asks as fast as it can for a minute against a `max`-per-minute window (e.g. toolCalls 60/min).
// Returns how many calls the fleet admitted: the configured budget times the instances it reached.
export function admittedBurst({ instances, routing, max = 60, attempts = 600, seed = 1 }:
  { instances: number; routing: Routing; max?: number; attempts?: number; seed?: number }) {
  const stores = Array.from({ length: instances }, () => new WindowLimitStore());
  const limiters = stores.map(store => store.limiter(() => 'v2-tools:p', max, 60_000));
  const random = rng(seed);
  let admitted = 0;
  for (let i = 0; i < attempts; i++) {
    const at = 1_000_000 + Math.floor(i * 60_000 / attempts);
    if (limiters[route(routing, instances, 'p', random, 'agent')]('agent', at) === 0) admitted++;
  }
  return admitted;
}

// Steady connected sessions: each touches its wait, tools and control windows once per 20 s for a minute (the
// idle protocol's three keys per session, TEAM-PLAN "3·C"). Reports keys on the busiest process and refusals.
export function steadyKeys({ projects, perProject, instances, routing, seed = 1 }:
  { projects: number; perProject: number; instances: number; routing: Routing; seed?: number }) {
  const stores = Array.from({ length: instances }, () => new WindowLimitStore());
  const random = rng(seed);
  const names = ['v2-wait', 'v2-tools', 'v2-control'] as const;
  const limiters = stores.map(store => Object.fromEntries(names.map(name =>
    [name, (project: string) => store.limiter(() => `${name}:${project}`, name === 'v2-wait' ? 1 : 60, name === 'v2-wait' ? 10_000 : 60_000)])));
  let refusedRequests = 0;
  for (let tick = 0; tick < 3; tick++) for (let p = 0; p < projects; p++) for (let a = 0; a < perProject; a++) {
    const project = `p${p}`, at = 1_000_000 + tick * 20_000 + ((p * perProject + a) % 1000);
    for (const name of names) {
      const index = route(routing, instances, project, random, `a${a}`);
      // A full namespace or store answers with the 60 s refusal (request-state.ts), not a window retry.
      if (limiters[index][name](project)(`a${a}`, at) === 60_000) refusedRequests++;
    }
  }
  const stats = stores.map(store => store.stats());
  return { maxKeysPerProcess: Math.max(...stats.map(s => s.keys)), largestNamespace: Math.max(...stats.map(s => s.largestNamespaceKeys)),
    refusedNewKeys: stats.reduce((sum, s) => sum + s.refusedNewKeys, 0), refusedRequests };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = [];
  for (const instances of [1, 2, 4, 10]) for (const routing of ['random', 'affinity', 'agent'] as const) {
    rows.push({ instances, routing, burstAdmittedPerMinute: admittedBurst({ instances, routing }),
      '1x5000': steadyKeys({ projects: 1, perProject: 5000, instances, routing }),
      '1000x5': steadyKeys({ projects: 1000, perProject: 5, instances, routing }) });
  }
  console.log(JSON.stringify({ note: 'Model-free, real WindowLimitStore per simulated process; not cloud behaviour.', rows }, null, 2));
}
