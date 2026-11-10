// Synthetic memory characterization. Run each sample in a fresh foreground Node process with --expose-gc.
// Example: node --expose-gc --import tsx tools/benchmarks/limiter-tenant-memory.ts runner-dense
import { requestStateSourceBlob } from './limiter-tenant-capacity.js';
import { WindowLimitStore } from '../../apps/server/src/request-state.js';
const modes = ['runner-sparse', 'runner-dense', 'ordinary-full-sparse', 'ordinary-full-dense', 'terminal-sparse', 'terminal-dense'] as const;
const mode = process.argv[2] as typeof modes[number];
if (!modes.includes(mode)) throw Error(`Choose ${modes.join(', ')}`);
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw Error('Explicit --expose-gc is required for this local memory study.');
const collect = () => { gc(); gc(); gc(); return process.memoryUsage(); };
// Warm the real operations before the baseline, then release the warm-up object.
{ const warm = new WindowLimitStore(); for (let n = 0; n < 1000; n++) warm.limiter(() => 'warm', 60, 60_000)(String(n), 1_000_000); }
const before = collect();
const terminal = mode.startsWith('terminal'), dense = mode.endsWith('dense'), full = mode.startsWith('ordinary-full');
const store = terminal ? new WindowLimitStore(5000, 1) : new WindowLimitStore();
const routeNames = terminal ? ['v2-stop'] : full ? ['v2-wait', 'v2-tools', 'v2-control', 'viewer'] : ['v2-wait', 'v2-tools', 'v2-control'];
let keys = 0, retainedTimestamps = 0;
for (const name of routeNames) {
  const namespace = `${name}:${'p'.repeat(64)}`, max = name === 'v2-wait' ? 1 : terminal ? 6 : 60;
  const limit = store.limiter(() => namespace, max, name === 'v2-wait' ? 10_000 : 60_000), density = dense ? max : 1;
  for (let a = 0; a < 5000; a++) {
    const key = `agent_${String(a).padStart(14, '0')}`;
    for (let call = 0; call < density; call++) {
      const result = limit(key, 1_000_000 + call);
      if (result !== 0) throw Error('Synthetic fill unexpectedly refused');
    }
    keys++; retainedTimestamps += density;
  }
}
const after = collect();
console.log(JSON.stringify({ evidence: 'Synthetic retained local heap, not production RSS/capacity or an upper byte bound.',
  mode, node: process.version, platform: process.platform, arch: process.arch, sourceBlob: requestStateSourceBlob(),
  keys, retainedTimestamps, store: store.stats(), heapDeltaBytes: after.heapUsed - before.heapUsed,
  heapDeltaPerKey: (after.heapUsed - before.heapUsed) / keys, rssDeltaBytes: after.rss - before.rss }));
