import { prepareCurrentStateProgress } from '../view/current-state-progress.js';
import { db, inProject } from '../firestore.js';
import { webAgentStarts } from '../owner/web-agent-starts.js';
import { presence, runs } from '../v2/records.js';
import { previewDoc, isLocalPreview } from './preview.js';
import { projects } from './records.js';

// Each chat has run + status + durable change + progress writes.
// 100 queued + 75 chats = at most 400 document writes in one transaction.
const PAGE_SIZE = 100, CHAT_PAGE_SIZE = 75;

// Closing a project ends its agents' work. Background agents see the project closed and stop on their
// computers; chat sessions end here, so their next Minions call says to stop; queued runs are cancelled.
// A localhost preview is cleared: its server ended with the agents, and the tab would show a dead address
// (wave 10, 13 November 2026). An https preview is hosted elsewhere and stays.
// Best effort after the close itself committed: a retry of the same close repeats it safely.
export async function endProjectWork(projectId: string, now: () => number, closeRevision: number, closedBy: string) {
  return inProject(projectId, async () => {
    let more: boolean;
    do {
      more = await db.runTransaction(async tx => {
        const project = (await tx.get(projects.doc(projectId))).data();
        // A delayed cleanup/retry must never affect work admitted after Reopen, even if
        // the project has since closed again. Reading this fence also serializes a race.
        if (!project || project.execution.completedAt === null || project.revision !== closeRevision) return false;
        const [queued, chats, preview] = await Promise.all([
          tx.get(webAgentStarts.where('projectId', '==', projectId).where('state', '==', 'pending').limit(PAGE_SIZE)),
          tx.get(runs().where('endedAt', '==', null).where('mode', '==', 'current_chat').limit(CHAT_PAGE_SIZE)),
          tx.get(previewDoc(projectId)),
        ]);
        const statusProgress = await prepareCurrentStateProgress(tx, chats.docs.map(doc => presence().doc(doc.id)));
        const at = now();
        // At most 400 writes per transaction; eligible rows disappear from these queries.
        // Transactional reads prevent a concurrent pickup or replacement run being overwritten.
        if (isLocalPreview(preview.data()?.url)) tx.set(previewDoc(projectId), { schemaVersion: 1, url: null, updatedBy: closedBy, updatedAt: at });
        for (const doc of queued.docs) tx.update(doc.ref, { state: 'expired', code: 'cancelled' });
        for (const doc of chats.docs) {
          tx.update(doc.ref, { endedAt: at, endReason: 'project_closed' });
          statusProgress(presence().doc(doc.id));
          tx.set(presence().doc(doc.id), { runEndedAt: at }, { mergeFields: ['runEndedAt'] });
        }
        return queued.size === PAGE_SIZE || chats.size === CHAT_PAGE_SIZE;
      });
    } while (more);
  });
}
