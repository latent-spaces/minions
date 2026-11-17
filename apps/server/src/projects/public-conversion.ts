import { z } from 'zod';
import { hashToken } from '../auth.js';
import { collection, db, profiles, type Profile, type WithId } from '../firestore.js';
import { Refusal } from '../errors.js';
import { projects } from './records.js';
import { PROJECT_RECORD, isPrivateProject } from './schema.js';
import { cardDoc, currentCard } from './card.js';
import { CATEGORIES, projectListings, searchPrefixes } from './catalog.js';
import { communitySettingsDoc, setCommunityPublication } from './community-schema.js';
import { DEFAULT_WORKSPACE_ID } from '../workspaces/schema.js';
import { validProjectId } from './access.js';

export const PUBLIC_CONVERSION = z.object({
  client_request_id: z.string().regex(/^[\w-]{1,64}$/),
  expected_revision: z.number().int().nonnegative(),
  expected_card_version: z.number().int().positive(),
  expected_listing_revision: z.number().int().nonnegative(),
  expected_community_revision: z.number().int().positive(),
  confirm_public_chat: z.literal(true), confirm_public_joining: z.literal(true),
  summary: z.string().trim().min(1).max(240), category: z.enum(CATEGORIES),
  tags: z.array(z.string().trim().regex(/^[a-z0-9-]{1,24}$/)).max(5),
}).strict();
const operations = collection<{ fingerprint: string; result: { id: string; revision: number; listingRevision: number; convertedAt: number; listed: true } }>('projectPublicationOperations');

export async function readPublicConversion(actor: WithId<Profile>, id: string) {
  if (!validProjectId(id)) throw new Refusal('bad_input', 'Choose a project you own.');
  return db.runTransaction(async tx => {
    const [person, current, card, settings] = await Promise.all([tx.get(profiles.doc(actor.id)), tx.get(projects.doc(id)), tx.get(cardDoc(id)), tx.get(communitySettingsDoc(id))]);
    const record = current.data();
    if (person.data()?.removedAt !== null || !record || record.ownerProfileId !== actor.id || !isPrivateProject(record))
      throw new Refusal('forbidden', 'Only the owner can review making this private project public.');
    if (!card.exists || !settings.exists) throw new Refusal('not_found', 'This project’s settings are unavailable.');
    const definition = currentCard(record, card.data()).definition;
    return { id, revision: record.revision, cardVersion: card.data()!.version, listingRevision: record.publication.revision, communityRevision: settings.data()!.revision,
      title: definition.title, definition, suggestedSummary: definition.goal.slice(0, 240), repository: record.setup.repoUrl,
      canConvert: record.execution.completedAt === null && record.setup.configuredAt !== null && !!record.setup.repoUrl };
  });
}

/** One explicit disclosure, retaining direct creation provenance and execution. */
export async function convertProjectToPublic(actor: WithId<Profile>, id: string, raw: unknown, now: () => number) {
  if (!validProjectId(id)) throw new Refusal('bad_input', 'Choose a project you own.');
  const input = PUBLIC_CONVERSION.parse(raw);
  const operationId = hashToken(`${actor.id}:${input.client_request_id}`), fingerprint = hashToken(JSON.stringify({ id, input }));
  return db.runTransaction(async tx => {
    const [person, current, operation, card, settings, listing] = await Promise.all([
      tx.get(profiles.doc(actor.id)), tx.get(projects.doc(id)), tx.get(operations.doc(operationId)),
      tx.get(cardDoc(id)), tx.get(communitySettingsDoc(id)), tx.get(projectListings.doc(id)),
    ]);
    if (!person.exists || person.data()!.removedAt !== null) throw new Refusal('unauthorized', 'Your account is no longer active.');
    const record = current.data();
    if (!record || record.ownerProfileId !== actor.id) throw new Refusal('forbidden', 'Only the project owner can make it public.');
    if (operation.exists) {
      if (operation.data()!.fingerprint !== fingerprint) throw new Refusal('intent_conflict', 'Retry the original public-project decision with its original request ID.');
      return { ...operation.data()!.result, replayed: true };
    }
    if (!isPrivateProject(record) || record.privacy!.visibility !== 'private' || record.approval !== null)
      throw new Refusal('intent_conflict', 'This project is no longer private. Reload before changing its publication.');
    if (record.workspaceId !== DEFAULT_WORKSPACE_ID || !card.exists || !settings.exists || listing.exists || record.publication.listed)
      throw new Refusal('intent_conflict', 'This project’s publication needs attention before it can become public.');
    if (record.execution.completedAt !== null) throw new Refusal('forbidden', 'Reopen this project before making it public.');
    if (record.setup.configuredAt === null || !record.setup.repoUrl) throw new Refusal('bad_input', 'Configure the project repository before making it public.');
    if (record.revision !== input.expected_revision || card.data()!.version !== input.expected_card_version || record.publication.revision !== input.expected_listing_revision
      || settings.data()!.revision !== input.expected_community_revision)
      throw new Refusal('proposal_conflict', 'The project or chat settings changed. Reload and review the public-project decision again.');
    const at = now();
    if (!Number.isSafeInteger(at) || at < record.privacy!.createdAt) throw new Error('Invalid conversion time.');
    const revision = record.revision + 1, listingRevision = record.publication.revision + 1;
    const converted = PROJECT_RECORD.parse({ ...record, revision,
      privacy: { ...record.privacy, visibility: 'public', convertedAt: at, convertedByProfileId: actor.id, disclosure: 'card_output_human_chat_v1' },
      publication: { listed: true, revision: listingRevision },
    });
    const title = currentCard(record, card.data()).definition.title, tags = [...new Set(input.tags)];
    tx.set(projects.doc(id), converted);
    tx.create(projectListings.doc(id), { workspaceId: record.workspaceId, title, summary: input.summary, category: input.category, tags,
      ownerName: person.data()!.name.includes('@') ? 'Project owner' : person.data()!.name,
      revision: listingRevision, publishedAt: at, updatedAt: at, prefixes: searchPrefixes(title, tags) });
    setCommunityPublication(tx, id, true, at, settings.data()!, actor.id);
    const result = { id, revision, listingRevision, convertedAt: at, listed: true as const };
    tx.create(operations.doc(operationId), { fingerprint, result });
    tx.create(collection('listingHistory').doc(`${id}-${listingRevision}`), { id, operatorId: actor.id, at,
      input: { ...input, action: 'convert_private_to_public' }, revision: listingRevision });
    return { ...result, replayed: false };
  });
}
