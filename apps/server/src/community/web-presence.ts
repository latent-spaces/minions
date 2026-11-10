import { z } from 'zod';
import { WEB_PRESENCE_FRESH_MS, type WebPresence, type WebPresencePage } from '@mlswarm/contracts';
import { collection, db, profiles } from '../firestore.js';
import { Refusal } from '../errors.js';
import type { CommunityActor } from './identity.js';

export const webPresence = collection<{ lastSeenAt: number }>('webPresence');
export function presenceView(report: { lastSeenAt: number } | undefined, at: number): WebPresence {
  const online = !!report && Number.isFinite(report.lastSeenAt) && report.lastSeenAt <= at && at - report.lastSeenAt < WEB_PRESENCE_FRESH_MS;
  return { online, freshUntil: online ? report!.lastSeenAt + WEB_PRESENCE_FRESH_MS : null };
}
const input = z.object({ profileIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)).max(100) }).strict();

/** Browser-only report: verified account, server time, no client-supplied actor/time/status.
 * Aggregate the latest visible tab. A closing tab never clears another tab's heartbeat. */
export async function reportWebPresence(actor: CommunityActor, body: unknown, now: () => number): Promise<WebPresencePage> {
  const parsed = input.safeParse(body);
  if (!parsed.success) throw new Refusal('bad_input', 'Supply up to 100 person IDs.');
  return db.runTransaction(async tx => {
    const own = await tx.get(profiles.doc(actor.operatorId));
    if (!own.exists || own.data()!.removedAt !== null) throw new Refusal('unauthorized', 'Your MyLittleSwarm account is no longer active.');
    const ids = [...new Set([...parsed.data.profileIds, actor.operatorId])];
    const [people, reports] = await Promise.all([
      tx.getAll(...ids.map(id => profiles.doc(id))), tx.getAll(...ids.map(id => webPresence.doc(id))),
    ]);
    const at = now();
    tx.set(webPresence.doc(actor.operatorId), { lastSeenAt: at });
    return { generatedAt: at, people: Object.fromEntries(ids.map((id, index) => [id,
      people[index].exists && people[index].data()!.removedAt === null
        ? presenceView(id === actor.operatorId ? { lastSeenAt: at } : reports[index].data(), at)
        : { online: false, freshUntil: null },
    ])) };
  });
}
