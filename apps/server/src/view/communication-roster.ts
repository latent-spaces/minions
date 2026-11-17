import { FieldPath } from '../firestore.js';
import { agents, currentProjectId, db } from '../firestore.js';
import { runnerUsage } from '../v2/records.js';
import { Refusal } from '../errors.js';
import { decodeCursor, encodeCursor } from '../cursor.js';

/** Complete, paged active map identity: no credentials, private setup or run state. */
export async function communicationRoster(query: Record<string, unknown>, now: number) {
  if (Object.keys(query).some(key => key !== 'cursor')) throw new Refusal('bad_input', 'Use the map roster pagination.');
  const scope = `communication-roster:${currentProjectId()}`;
  let scan = agents().where('revokedAt', '==', null).orderBy(FieldPath.documentId()).limit(201);
  if (query.cursor !== undefined) {
    const cursor = typeof query.cursor === 'string' ? decodeCursor(query.cursor) : null;
    if (!cursor || cursor.length !== 2 || cursor[0] !== scope || typeof cursor[1] !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(cursor[1])) throw new Refusal('bad_input', 'Use this project’s map roster pagination.');
    scan = scan.startAfter(cursor[1]);
  }
  const found = await scan.select('name', 'ownerProfileId', 'createdAt').get(), page = found.docs.slice(0, 200);
  // The existing usage report is the authoritative coding-tool identity. Read
  // it once per paged agent, never guess from names, models or ownership.
  const usage = page.length ? await db.getAll(...page.map(doc => runnerUsage().doc(doc.id))) : [];
  return { agents: page.map((doc, index) => ({ id: doc.id, name: doc.get('name'), operatorId: doc.get('ownerProfileId') ?? null, createdAt: doc.get('createdAt'),
    ...(usage[index]?.get('provider') ? { provider: usage[index].get('provider') } : {}) })),
    next: found.size > 200 ? encodeCursor([scope, page.at(-1)!.id]) : null, serverTime: now };
}
