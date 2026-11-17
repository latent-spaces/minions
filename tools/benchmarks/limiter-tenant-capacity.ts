// Local, model-free capacity/fairness study. Runs the real process-local store, not a proposed policy.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { WindowLimitStore } from '../../apps/server/src/request-state.js';
export function requestStateSourceBlob() {
  const source = readFileSync(new URL('../../apps/server/src/request-state.ts', import.meta.url));
  return createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
}
export const START = 1_000_000;
const routes = ['v2-wait', 'v2-tools', 'v2-control'] as const;
export type Session = { project: string; agent: string };
export type TenantOutcome = { keys: number; completeSessions: number; partialSessions: number; refusedKeys: number };
export function sessions(projects: number, perProject: number, prefix: string): Session[] {
  return Array.from({ length: projects }, (_, p) => Array.from({ length: perProject }, (_, a) => ({
    project: `${prefix}${p}`.padEnd(64, 'p'), agent: `agent_${String(a).padStart(14, '0')}`,
  }))).flat();
}
export function touchSession(store: WindowLimitStore, session: Session, at: number): number {
  let accepted = 0;
  for (const route of routes) {
    const wait = route === 'v2-wait';
    if (store.limiter(() => `${route}:${session.project}`, wait ? 1 : 60, wait ? 10_000 : 60_000)(session.agent, at) === 0) accepted++;
  }
  return accepted;
}
export function admitGroup(store: WindowLimitStore, group: Session[], at = START): TenantOutcome {
  let keys = 0, completeSessions = 0, partialSessions = 0;
  for (const session of group) {
    const accepted = touchSession(store, session, at); keys += accepted;
    if (accepted === 3) completeSessions++; else if (accepted > 0) partialSessions++;
  }
  return { keys, completeSessions, partialSessions, refusedKeys: group.length * 3 - keys };
}
export function mixedTenants(order: 'flagship-first' | 'small-first') {
  const store = new WindowLimitStore(), flagship = sessions(1, 5000, 'flagship'), small = sessions(1000, 5, 'small');
  let flagshipResult: TenantOutcome, smallResult: TenantOutcome;
  if (order === 'flagship-first') { flagshipResult = admitGroup(store, flagship); smallResult = admitGroup(store, small); }
  else { smallResult = admitGroup(store, small); flagshipResult = admitGroup(store, flagship); }
  return { order, flagship: flagshipResult, small: smallResult, stats: store.stats() };
}
export function capacityReport() {
  return { evidence: 'Synthetic single-process real WindowLimitStore; no fleet routing, policy selection or cloud evidence.',
    sourceBlob: requestStateSourceBlob(), rows: [mixedTenants('flagship-first'), mixedTenants('small-first')] };
}
