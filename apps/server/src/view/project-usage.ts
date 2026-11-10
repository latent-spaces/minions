import { combineReportedUsage, type ReportedUsage, type ProjectUsage } from '@mlswarm/contracts';
import type { DocumentData, Transaction } from '../firestore.js';
import { agents, currentProjectId, db } from '../firestore.js';
import { runnerUsage } from '../v2/records.js';
import { usageProgress, usageChanges, usageShard, validUsageProgress, USAGE_SHARDS, type UsageProgress } from '../v2/usage-progress.js';
import { requireCurrentStateCutover } from './current-state-cutover.js';

const FIELDS = ['turns', 'input', 'output', 'cacheRead', 'cacheWrite', 'inputSemantics', 'tokenCoverage', 'lastReportedAt'];
type Row = ReportedUsage & { lastReportedAt: number | null };
type Fence = { readiness: string; versions: string[]; shards: UsageProgress[] };
type Data = { rows: Map<string, Row>; agents: number; summary: Omit<ProjectUsage, 'serverTime'>; fence: Fence; bytes: number };
type Entry = { data?: Data; pending?: Promise<Omit<ProjectUsage, 'serverTime'>>; readers: number };
const entries = new Map<string, Entry>();
const defaults = { bytes: 32 * 1024 * 1024, projects: 512 };
let limits = { ...defaults };
export const usageReadStats = { attempts: 0, seeds: 0, seedRows: 0, quiet: 0, deltas: 0, dirtyRows: 0, headReads: 0, evictions: 0, errors: 0 };
export const projectUsageStats = () => ({ ...usageReadStats, projects: entries.size, bytes: [...entries.values()].reduce((n, e) => n + (e.data?.bytes ?? 0), 0) });
export function configureProjectUsage(value: Partial<typeof defaults>) { limits = { ...limits, ...value }; return () => { limits = { ...defaults }; }; }
export function stopProjectUsage() { entries.clear(); for (const key of Object.keys(usageReadStats) as (keyof typeof usageReadStats)[]) usageReadStats[key] = 0; }

function row(data: DocumentData): Row {
  // Retain only accounting inputs, never SDK snapshots, credentials or activity.
  const number = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  return { turns: number(data.turns), input: number(data.input), output: number(data.output), cacheRead: number(data.cacheRead), cacheWrite: number(data.cacheWrite),
    inputSemantics: ['uncached', 'includes-cache'].includes(data.inputSemantics) ? data.inputSemantics : 'unknown',
    tokenCoverage: { input: number(data.tokenCoverage?.input), output: number(data.tokenCoverage?.output),
      cacheRead: number(data.tokenCoverage?.cacheRead), cacheWrite: number(data.tokenCoverage?.cacheWrite) },
    lastReportedAt: Number.isFinite(data.lastReportedAt) ? data.lastReportedAt : null } as Row;
}
function summarize(rows: Map<string, Row>, count: number): Omit<ProjectUsage, 'serverTime'> {
  const total = Math.max(count, rows.size), values = [...rows.values()];
  return { ...combineReportedUsage([...values, ...Array<null>(total - rows.size).fill(null)]),
    lastReportedAt: values.reduce<number | null>((last, r) => r.lastReportedAt === null ? last : Math.max(last ?? 0, r.lastReportedAt), null) };
}
async function fence(tx: Transaction): Promise<Fence> {
  const readiness = await requireCurrentStateCutover(tx);
  const docs = await tx.get(usageProgress().limit(USAGE_SHARDS + 1));
  if (docs.size > USAGE_SHARDS) throw new Error('Malformed usage progress.');
  const shards = Array.from({ length: USAGE_SHARDS }, () => ({ schema: 1 as const, epoch: 'usage-sequence-v1', revision: 0, usageRevision: 0, created: 0 }));
  const versions = Array<string>(USAGE_SHARDS).fill('');
  for (const doc of docs.docs) {
    if (!/^(0[0-9]|1[0-5])$/.test(doc.id) || !validUsageProgress(doc.data())) throw new Error('Malformed usage progress.');
    shards[Number(doc.id)] = doc.data(); versions[Number(doc.id)] = `${doc.updateTime.seconds}.${doc.updateTime.nanoseconds}`;
  }
  return { readiness, shards, versions };
}
async function refresh(previous?: Data): Promise<Data> {
  // Each attempt has one consistent read point: admission, progress, baseline or
  // dirty IDs and current heads. No request joins an older in-flight proof.
  return db.runTransaction(async tx => {
    usageReadStats.attempts++;
    const next = await fence(tx), old = previous?.fence;
    const full = !old || old.readiness !== next.readiness || next.shards.some((s, i) => s.revision < old.shards[i]!.revision
      || s.usageRevision < old.shards[i]!.usageRevision || s.created < old.shards[i]!.created
      || s.revision === old.shards[i]!.revision && (s.usageRevision !== old.shards[i]!.usageRevision || s.created !== old.shards[i]!.created))
      || next.shards.some((s, i) => s.revision === old!.shards[i]!.revision && next.versions[i] !== old!.versions[i]);
    if (!full && old!.versions.every((v, i) => v === next.versions[i])) { usageReadStats.quiet++; return { ...previous!, fence: next }; }
    let rows: Map<string, Row>, count: number;
    if (full) {
      const [usage, total] = await Promise.all([tx.get(runnerUsage().select(...FIELDS)), tx.get(agents().count())]);
      usageReadStats.seeds++; usageReadStats.seedRows += Math.max(1, usage.size);
      rows = new Map(usage.docs.map(doc => [doc.id, row(doc.data())])); count = total.data().count;
    } else {
      rows = new Map(previous!.rows);
      count = previous!.agents + next.shards.reduce((n, s, i) => n + s.created - old!.shards[i]!.created, 0);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid usage roster proof.');
      const changed = next.shards.flatMap((s, i) => s.usageRevision > old!.shards[i]!.usageRevision ? [i] : []);
      const queries = await Promise.all(changed.map(i => tx.get(usageChanges().where('shard', '==', String(i).padStart(2, '0'))
        .where('revision', '>', old!.shards[i]!.usageRevision))));
      const dirty = queries.flatMap(s => s.docs);
      if (queries.some(q => q.empty)) throw new Error('Usage progress advanced without replay evidence.');
      for (const doc of dirty) {
        const d = doc.data(), index = Number(d.shard);
        if (d.shard !== usageShard(doc.id) || d.schema !== 1 || d.epoch !== next.shards[index]?.epoch || !Number.isSafeInteger(d.revision)
          || d.revision <= old!.shards[index]!.usageRevision || d.revision > next.shards[index]!.usageRevision)
          throw new Error('Malformed usage replay evidence.');
      }
      usageReadStats.deltas++; usageReadStats.dirtyRows += dirty.length;
      for (let i = 0; i < dirty.length; i += 500) {
        const heads = await tx.getAll(...dirty.slice(i, i + 500).map(doc => runnerUsage().doc(doc.id)));
        usageReadStats.headReads += heads.length;
        for (const doc of heads) if (doc.exists) rows.set(doc.id, row(doc.data()!)); else rows.delete(doc.id);
      }
    }
    // Recompute whole normalized contributions on change, avoiding overflow and
    // subtract/re-add drift; this also handles a decreasing/deleted latest time.
    const summary = summarize(rows, count);
    const bytes = 1024 + [...rows].reduce((n, [id, r]) => n + 256 + id.length * 2 + JSON.stringify(r).length * 2, 0);
    return { rows, agents: count, summary, fence: next, bytes };
  }, { readOnly: true });
}
function retain(project: string, entry: Entry) {
  while (entries.size > limits.projects || projectUsageStats().bytes > limits.bytes) {
    const victim = [...entries].find(([, e]) => e !== entry && e.readers === 0);
    if (!victim) { if (entries.get(project) === entry) entries.delete(project); break; }
    entries.delete(victim[0]); usageReadStats.evictions++;
  }
}
export async function readProjectUsage(now: () => number): Promise<ProjectUsage> {
  const project = currentProjectId();
  let entry = entries.get(project);
  if (!entry) { entry = { readers: 0 }; entries.set(project, entry); }
  else { entries.delete(project); entries.set(project, entry); }
  entry.readers++;
  try {
    while (entry.pending) await entry.pending;
    const own = entry;
    const pending = (async () => {
      const data = await refresh(own.data); // Publish proof, inputs and summary together only on success.
      own.data = data; retain(project, own); return data.summary;
    })();
    entry.pending = pending;
    try { return { ...structuredClone(await pending), serverTime: now() }; }
    finally { if (entry.pending === pending) entry.pending = undefined; }
  } catch (error) {
    usageReadStats.errors++;
    if (entries.get(project) === entry) entries.delete(project);
    throw error;
  } finally { entry.readers--; }
}
