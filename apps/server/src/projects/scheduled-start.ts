import { isPrivateProject } from './schema.js';
// The private scheduler advances project lifecycle only. It never creates native model work.
import { FieldPath } from '../firestore.js';
import { collection, db, inProject, projectCollection } from '../firestore.js';
import { DEFAULT_WORKSPACE_ID } from '../workspaces/schema.js';
import { createFanout } from '../v2/fanout.js';
import { writeStartAnnouncement } from './start-announcement.js';
import { cardDoc } from './card.js';
import { projectListings } from './catalog.js';
import { projects, runtimeWithCard, recordWithRuntime } from './records.js';
import { STORED_PROJECT_RECORD } from './schema.js';

const SCAN_LIMIT = 100;
type ScanCursor = { deadline: string; id: string } | null;
const scanState = collection<{ cursor: ScanCursor; observedAt: number }>('workerReconciliation').doc('scheduledProjectStarts');

/** A transaction fences retries and races against manual start, close, unlisting and rescheduling. */
export async function startScheduledProject(id: string, now: () => number): Promise<{ started: boolean; lagMs: number }> {
  if (!/^[a-f0-9]{64}$/.test(id)) return { started: false, lagMs: 0 };
  return inProject(id, () => db.runTransaction(async tx => {
    const [snapshot, card, listing] = await Promise.all([tx.get(db.collection('projects').doc(id)), tx.get(cardDoc(id)), tx.get(projectListings.doc(id))]);
    const parsed = STORED_PROJECT_RECORD.safeParse(snapshot.exists ? snapshot.data() : undefined);
    if (!parsed.success) return { started: false, lagMs: 0 };
    const record = parsed.data, at = now(), scheduledAt = Date.parse(record.setup.startDeadline ?? '');
    if (record.workspaceId !== DEFAULT_WORKSPACE_ID || isPrivateProject(record) || !record.publication.listed
      || record.setup.finalizedAt === null || record.setup.configuredAt === null
      || record.execution.started || record.execution.completedAt !== null || !listing.exists
      || listing.data()!.workspaceId !== DEFAULT_WORKSPACE_ID || !card.exists
      || !Number.isFinite(scheduledAt) || scheduledAt > at) return { started: false, lagMs: 0 };
    const before = runtimeWithCard(record, card.data());
    if (!before) return { started: false, lagMs: 0 };
    const revision = record.revision + 1;
    // A scheduled start starts the job with no end, like a manual start.
    const project = { ...before, revision, started: true, paused: false, awaitingKickoff: false, startsAt: scheduledAt };
    tx.set(projects.doc(id), recordWithRuntime(record, project));
    tx.create(projectCollection('projectHistory').doc(String(revision).padStart(12, '0')), {
      at, operatorId: null, source: 'scheduled_start', scheduledAt, control: { action: 'start' }, project,
    });
    createFanout(tx, 'project_started', { projectId: id, revision }, at);
    writeStartAnnouncement(tx, { revision, startedAt: scheduledAt, actorName: null, scheduled: true });
    return { started: true, lagMs: Math.max(0, at - scheduledAt) };
  }));
}

// R3: many projects scheduled for the same second would otherwise start 100 per Scheduler minute.
// One call keeps paging while the previous page was full and started something, within a time budget,
// so retained ineligible due records (private, unpublished) never multiply the per-call scan.
const PAGE_BUDGET = 10;
const TIME_BUDGET_MS = 20_000;

export async function reconcileScheduledStarts(now: () => number) {
  const began = now();
  const upper = new Date(began + 1000).toISOString();
  const total = { scanned: 0, started: 0, failed: 0, maximumLagMs: 0, pages: 0 };
  for (;;) {
    const page = await reconcilePage(now, upper);
    total.pages++;
    total.scanned += page.scanned; total.started += page.started; total.failed += page.failed;
    total.maximumLagMs = Math.max(total.maximumLagMs, page.maximumLagMs);
    if (!page.full || !page.started || total.pages >= PAGE_BUDGET || now() - began >= TIME_BUDGET_MS) break;
  }
  console.info(JSON.stringify({ event: 'scheduled_project_start_reconcile', ...total }));
  return total;
}

/** Bounded wraparound scanning prevents old ineligible records from starving later schedules.
 * ISO second-only strings sort after their fractional equivalent; the one-second query margin
 * includes them at the exact boundary. The transaction always compares parsed timestamps.
 * Cursor advancement is conditional, so concurrent rounds cannot move a newer scan backward.
 */
async function reconcilePage(now: () => number, upper: string) {
  const previous = (await scanState.get()).data()?.cursor ?? null;
  // Start and close keep the deadline, so these filters stop retained projects from delaying new starts.
  const query = collection<Record<string, unknown>>('projects').where('workspaceId', '==', DEFAULT_WORKSPACE_ID)
    .where('execution.started', '==', false).where('execution.completedAt', '==', null).where('setup.startDeadline', '>', '').where('setup.startDeadline', '<=', upper)
    .orderBy('setup.startDeadline').orderBy(FieldPath.documentId()).limit(SCAN_LIMIT);
  let page = await (previous ? query.startAfter(previous.deadline, previous.id) : query).get();
  if (page.empty && previous) page = await query.get();
  let started = 0, failed = 0, maximumLagMs = 0;
  for (let offset = 0; offset < page.size; offset += 4) {
    const results = await Promise.allSettled(page.docs.slice(offset, offset + 4).map(doc => startScheduledProject(doc.id, now)));
    for (const result of results) {
      if (result.status === 'rejected') failed++;
      else if (result.value.started) { started++; maximumLagMs = Math.max(maximumLagMs, result.value.lagMs); }
    }
  }
  const last = page.docs.at(-1);
  const cursor: ScanCursor = page.size === SCAN_LIMIT && last ? { deadline: last.get('setup.startDeadline') as string, id: last.id } : null;
  await db.runTransaction(async tx => {
    const current = (await tx.get(scanState)).data()?.cursor ?? null;
    if (JSON.stringify(current) === JSON.stringify(previous)) tx.set(scanState, { cursor, observedAt: now() });
  });
  return { scanned: page.size, started, failed, maximumLagMs, full: page.size === SCAN_LIMIT };
}
