import { isPrivateProject } from './schema.js';
import { DEFAULT_WORKSPACE_ID } from '../workspaces/schema.js';
import { deriveProjectLifecycle, projectExecution, type ProjectLifecycle } from '@minions/contracts';
import { FieldPath } from '../firestore.js';
import { z } from 'zod';
import { hashToken } from '../auth.js';
import { projects } from '../community/records.js';
import { Refusal } from '../errors.js';
import { collection, db, profiles, type Profile, type WithId } from '../firestore.js';
import { membershipDoc, validProjectId } from './access.js';
import { cardDoc, currentCard } from './card.js';
import { STORED_PROJECT_RECORD } from './schema.js';
import { runtimeWithCard } from './records.js';
import { communitySettingsDoc, setCommunityPublication } from './community-schema.js';
import { artworkOf } from './artwork.js';
import { decodeCursor, encodeCursor } from '../cursor.js';

export const CATEGORIES = ['games', 'developer-tools', 'personal-tools', 'research', 'creative', 'community'] as const;
export const CATALOG_INPUT = z.object({
  client_request_id: z.string().regex(/^[\w-]{1,64}$/), expected_revision: z.number().int().nonnegative(),
  listed: z.boolean(), summary: z.string().trim().min(1).max(240), category: z.enum(CATEGORIES),
  tags: z.array(z.string().trim().regex(/^[a-z0-9-]{1,24}$/)).max(5),
}).strict();
export const CATALOG_QUERY = z.object({
  q: z.string().trim().max(40).optional(), category: z.enum(CATEGORIES).optional(),
  cursor: z.string().max(500).optional(),
  project: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine(query => !query.project || !query.cursor && !query.q && !query.category, 'A project lookup does not accept search filters or a cursor.');
type CatalogEntry = { workspaceId: string; title: string; summary: string; category: typeof CATEGORIES[number]; tags: string[];
  coverImage?: string; ownerName: string; revision: number; publishedAt: number; updatedAt: number; prefixes: string[] };
export const projectListings = collection<CatalogEntry>('projectListings');
const receipts = collection<{ fingerprint: string; result: object }>('listingOperations');
const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export function searchPrefixes(title: string, tags: string[]) {
  // Bounded index keys for title/tag word prefixes; no definition or private transcript enters discovery.
  const words = normalize(`${title} ${tags.join(' ')}`).split(/[^\p{L}\p{N}-]+/u).filter(Boolean).slice(0, 25);
  const prefixes = new Set<string>();
  for (const word of words) for (let length = 1; length <= Math.min(40, word.length); length++) prefixes.add(word.slice(0, length));
  return [...prefixes].slice(0, 500);
}

export async function publishCatalog(operator: WithId<Profile>, id: string, input: z.infer<typeof CATALOG_INPUT>, now: () => number) {
  if (!validProjectId(id)) throw new Refusal('bad_input', 'Choose one of your projects to publish.');
  input = CATALOG_INPUT.parse(input);
  const receiptId = hashToken(`${operator.id}:${input.client_request_id}`), fingerprint = hashToken(JSON.stringify({ id, input }));
  return db.runTransaction(async tx => {
    const [owner, approved, current, receipt, card, community] = await Promise.all([tx.get(profiles.doc(operator.id)), tx.get(projects.doc(id)), tx.get(projectListings.doc(id)), tx.get(receipts.doc(receiptId)), tx.get(cardDoc(id)), tx.get(communitySettingsDoc(id))]);
    if (!owner.exists || owner.data()!.removedAt !== null) throw new Refusal('unauthorized', 'Your account is no longer active.');
    if (!approved.exists || approved.data()!.ownerProfileId !== operator.id) throw new Refusal('forbidden', 'Only the owner can publish this project to Explore.');
    if (isPrivateProject(approved.data())) throw new Refusal('forbidden', 'Private projects can’t be published to Explore. Send a public proposal instead.');
    if (receipt.exists) {
      if (receipt.data()!.fingerprint !== fingerprint) throw new Refusal('bad_input', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      return { ...receipt.data()!.result, replayed: true };
    }
    if (input.listed && approved.data()!.execution.completedAt !== null) throw new Refusal('forbidden', 'Reopen this closed project before publishing it.');
    if (input.listed && approved.data()!.setup.required && approved.data()!.setup.finalizedAt === null) throw new Refusal('bad_input', 'Finish setting up the project before publishing it to Explore.');
    // A private revision receipt persists after unlisting, so stale writes cannot resurrect a listing.
    if (approved.data()!.publication.revision !== input.expected_revision) throw new Refusal('proposal_conflict', 'This project’s Explore listing changed. Reload, then try again.');
    const at = now(), revision = input.expected_revision + 1;
    if (input.listed) {
      // The current Card title; an owner's Card edit also rewrites a published listing's copy (store.ts editCard).
      const title = currentCard(approved.data()!, card.data()).definition.title, tags = [...new Set(input.tags)];
      tx.set(projectListings.doc(id), { workspaceId: DEFAULT_WORKSPACE_ID, title, summary: input.summary, category: input.category, tags,
        ownerName: owner.data()!.name.includes('@') ? 'Project owner' : owner.data()!.name,
        revision, publishedAt: current.data()?.publishedAt ?? at, updatedAt: at, prefixes: searchPrefixes(title, tags) });
    } else tx.delete(projectListings.doc(id));
    tx.set(projects.doc(id), { ...approved.data()!, publication: { listed: input.listed, revision } });
    setCommunityPublication(tx, id, input.listed, at, community.data()!, operator.id);
    const result = { id, revision, listed: input.listed, replayed: false };
    tx.create(receipts.doc(receiptId), { fingerprint, result });
    tx.create(collection('listingHistory').doc(`${id}-${revision}`), { id, operatorId: operator.id, at, input, revision });
    return result;
  });
}

export async function readCatalogSettings(operator: WithId<Profile>, id: string) {
  if (!validProjectId(id)) throw new Refusal('bad_input', 'Choose one of your projects.');
  return db.runTransaction(async tx => {
    const [person, project, listing] = await Promise.all([tx.get(profiles.doc(operator.id)), tx.get(projects.doc(id)), tx.get(projectListings.doc(id))]);
    if (!person.exists || person.data()!.removedAt !== null) throw new Refusal('unauthorized', 'Your account is no longer active.');
    if (!project.exists || project.data()!.ownerProfileId !== operator.id) throw new Refusal('forbidden', 'Only the owner can change how this project appears in Explore.');
    const entry = listing.data();
    return { id, revision: project.data()!.publication.revision, listed: listing.exists,
      summary: entry?.summary ?? null, category: entry?.category ?? null, tags: entry?.tags ?? [] };
  });
}

export async function readCatalog(query: z.infer<typeof CATALOG_QUERY>, now: () => number) {
  query = CATALOG_QUERY.parse(query);
  const q = normalize(query.q ?? ''), scope = JSON.stringify([q, query.category ?? null]);
  let after: [number, string] | null = null;
  if (query.cursor) {
    try {
      const value = decodeCursor(query.cursor);
      if (!Array.isArray(value) || value.length !== 3 || value[0] !== scope || !Number.isSafeInteger(value[1]) || (value[1] as number) < 0 || typeof value[2] !== 'string' || !/^[a-f0-9]{64}$/.test(value[2])) throw new Error();
      after = [value[1] as number, value[2]];
    } catch { throw new Refusal('bad_input', 'Use the cursor returned for these filters.'); }
  }
  let request = projectListings.where('workspaceId', '==', DEFAULT_WORKSPACE_ID).orderBy('publishedAt', 'desc').orderBy(FieldPath.documentId()).limit(21);
  if (q) request = request.where('prefixes', 'array-contains', q);
  if (query.category) request = request.where('category', '==', query.category);
  if (after) request = request.startAfter(...after);
  const rows = query.project ? null : await request.get();
  const lookup = query.project ? await projectListings.doc(query.project).get() : null;
  const page = rows ? rows.docs.slice(0, 20) : lookup?.exists ? [lookup] : [];
  const entries: { id: string; title: string; summary: string; category: typeof CATEGORIES[number]; tags: string[];
    publishedAt: number; updatedAt: number; status: 'queued' | 'paused' | 'running' | 'closed'; participantCount: number | null;
    coverImage?: string; state: ProjectLifecycle; stars: null; trending: null; setupPending: boolean; minContributors: number | null; startDeadline: string | null }[] = [];
  // At most twenty published rows and four aggregate reads at once. No member rows or identities
  // are returned. Registered membership counts do not claim that participants are online or working.
  for (let start = 0; start < page.length; start += 4) {
    const scanned = await Promise.all(page.slice(start, start + 4).map(async d => {
      const entry = d.data()!;
      const [approved, card, members] = await Promise.all([
        projects.doc(d.id).get(), cardDoc(d.id).get(),
        collection(`projects/${d.id}/members`).where('status', '==', 'active').count().get(),
      ]);
      const record = approved.data();
      // A search projection never grants publication or workspace authority.
      if (!record || isPrivateProject(record) || !record.publication.listed || record.workspaceId !== DEFAULT_WORKSPACE_ID
        || entry.workspaceId !== record.workspaceId) return null;
      const ownerId = record.ownerProfileId;
      // Owner authority lives on the approved definition, usually without a membership row.
      // Avoid counting an owner twice if an older/imported membership row exists.
      const ownerMember = ownerId ? await membershipDoc(d.id, ownerId).get() : null;
      const participantCount = ownerId ? members.data().count + 1 - Number(ownerMember?.data()?.status === 'active') : null;
      const state = runtimeWithCard(approved.data(), card.data());
      const status = state?.completedAt != null ? 'closed' as const : !state?.started ? 'queued' as const : state.paused ? 'paused' as const : 'running' as const;
      const stateObservation = deriveProjectLifecycle({ kind: 'project', role: 'guest', execution: approved.exists ? projectExecution(state) : 'unknown', runtimeStarted: state?.started,
        listed: true, setupRequired: approved.data()?.setup.required === true, setupFinalizedAt: state?.setupFinalizedAt ?? null, participantCount,
        minContributors: state?.minContributors ?? approved.data()?.setup.minContributors ?? null });
      const { coverImage } = artworkOf(approved.data()?.artwork, entry.coverImage);
      // Explicit allowlist: future storage fields (credentials, identities, internal metadata) never
      // become public through object spread. Owner display names remain private too.
      return { id: d.id, title: entry.title, summary: entry.summary, category: entry.category, tags: entry.tags,
        ...(coverImage ? { coverImage } : {}),
        publishedAt: entry.publishedAt, updatedAt: entry.updatedAt, status, state: stateObservation, participantCount, setupPending: !state || approved.data()?.setup.required === true && !('setupFinalizedAt' in state && state.setupFinalizedAt), minContributors: state?.minContributors ?? approved.data()?.setup.minContributors ?? null, startDeadline: state?.startDeadline ?? null, stars: null, trending: null };
    }));
    entries.push(...scanned.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
  }
  const observedAt = now();
  return { projects: entries,
    next: rows && rows.size > 20 ? encodeCursor([scope, page.at(-1)!.data()!.publishedAt, page.at(-1)!.id]) : null,
    generatedAt: observedAt, observedAt, participantCountSemantics: 'registered_project_members_plus_owner', ranking: { kind: 'newest', trendingAvailable: false, reason: 'Popularity and recent participation are not collected yet.' } };
}

/** The three earliest starts across the matching catalog, independent of the results cursor.
 * Range reads use the saved schedule index, not an unbounded whole-catalog browser scan.
 * A one-second envelope admits legacy ISO timestamps without fractional seconds; numeric
 * comparisons enforce the exact seven-day window. Small batches keep memory/RPC fanout bounded.
 */
export async function readStartingSoon(query: Pick<z.infer<typeof CATALOG_QUERY>, 'q' | 'category'>, now: () => number) {
  const at = now(), end = at + 7 * 24 * 60 * 60 * 1000, q = normalize(query.q ?? '');
  let request = db.collection('projects').where('workspaceId', '==', DEFAULT_WORKSPACE_ID)
    .where('setup.startDeadline', '>=', new Date(at - 1000).toISOString())
    .where('setup.startDeadline', '<=', new Date(end + 1000).toISOString())
    .orderBy('setup.startDeadline').orderBy(FieldPath.documentId()).limit(40);
  const entries: Awaited<ReturnType<typeof readCatalog>>['projects'] = [];
  for (;;) {
    const page = await request.get();
    for (let start = 0; start < page.docs.length; start += 4) {
      const batch = await Promise.all(page.docs.slice(start, start + 4).map(async doc => {
        const parsed = STORED_PROJECT_RECORD.safeParse(doc.data());
        if (!parsed.success) return null;
        const record = parsed.data, scheduledAt = Date.parse(record.setup.startDeadline ?? '');
        if (!Number.isFinite(scheduledAt) || scheduledAt <= at || scheduledAt > end || isPrivateProject(record) || !record.publication.listed
          || record.setup.finalizedAt === null || record.setup.configuredAt === null || !record.setup.repoUrl
          || record.execution.started || record.execution.completedAt !== null) return null;
        const listing = (await projectListings.doc(doc.id).get()).data();
        if (!listing || listing.workspaceId !== DEFAULT_WORKSPACE_ID || q && !listing.prefixes.includes(q) || query.category && listing.category !== query.category) return null;
        // Reuse the same explicit projection and current publication/privacy fences as normal discovery.
        const project = (await readCatalog({ project: doc.id }, () => at)).projects[0];
        if (!project || !['recruiting', 'ready_to_start'].includes(project.state.status)) return null;
        const finalAt = Date.parse(project.startDeadline ?? '');
        return finalAt > at && finalAt <= end && (!query.category || project.category === query.category)
          && (!q || searchPrefixes(project.title, project.tags).includes(q)) ? project : null;
      }));
      entries.push(...batch.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
    }
    entries.sort((a, b) => Date.parse(a.startDeadline!) - Date.parse(b.startDeadline!) || a.id.localeCompare(b.id));
    entries.splice(3);
    const last = page.docs.at(-1);
    // Finish the third result's whole second before stopping: ISO strings with different
    // fractional precision may sort differently inside that second.
    if (!last || page.size < 40 || entries.length >= 3 && Math.floor(Date.parse(last.get('setup.startDeadline')) / 1000) > Math.floor(Date.parse(entries[2].startDeadline!) / 1000)) break;
    request = request.startAfter(last);
  }
  return entries.slice(0, 3);
}
