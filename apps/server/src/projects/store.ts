import { isPrivateProject } from './schema.js';
import { readProjectAdmission } from './project-admission.js';
import { canonicalGithubRepo, githubRepositoryUrl, nativeTasksEnabled, nativeTeamsEnabled } from '@minions/contracts';
import { prepareProjectJourney } from '../onboarding/journeys.js';
import { endProjectWork } from './close-work.js';
import { readStartAnnouncement, writeStartAnnouncement } from './start-announcement.js';
import { archiveState, projectArchives, projectStars, starState } from './personal-archive.js';
import { DEFAULT_WORKSPACE_ID } from '../workspaces/schema.js';
import { deriveProjectLifecycle, projectExecution, RUN_LENGTH, validRunMinutes, type ProjectLifecycle } from '@minions/contracts';
import { platformSettings } from '../platform/settings.js';
import { FieldPath, type Transaction } from '../firestore.js';
import { z } from 'zod';
import { hashToken } from '../auth.js';
import { projects, proposals, type ProjectRecord } from '../community/records.js';
import { cursorAfter, nextCursor } from '../community/pagination.js';
import { Refusal } from '../errors.js';
import { jobTokensCounted } from './worker-sessions.js';
import { agents, collection, db, inProject, profiles, projectCollection, type Profile, type WithId } from '../firestore.js';
import { createFanout, deliverProjectWide } from '../v2/fanout.js';
import { membershipEpoch, membershipFenceDoc, membershipDoc, membershipsOf, projectRole, type ProjectRole } from './access.js';

import { assertMembership, assertProjectWritable } from './access.js';
import { CARD_EDIT, agentText, cardDefinition, cardDoc, cardVersionId, cardVersions, currentCard, type CardVersion } from './card.js';
import { projectListings, searchPrefixes } from './catalog.js';
import { artworkOf } from './artwork.js';
import { latestUpdateAt, latestUpdateScreenshotId } from './progress.js';
import { messagesV2 } from '../v2/records.js';
import { runtimeOf, runtimeWithCard, recordWithRuntime, type WorkspaceProject, type RuntimeState } from './records.js';
import { communityRulesDoc, communitySettingsDoc, setCommunityPublication } from './community-schema.js';
import { communityRulesView } from './community-rules.js';
import { previewDoc, previewUpdatedAtView, previewView } from './preview.js';
export type { WorkspaceProject } from './records.js';
export const CONFIGURE = z.object({
  client_request_id: z.string().regex(/^[\w-]{1,64}$/), expected_revision: z.number().int().nonnegative(),
  repoUrl: z.string().max(300).refine(url => githubRepositoryUrl(url) !== null).transform(url => githubRepositoryUrl(url)!),
}).strict();
export const CONTROL = z.object({ client_request_id: z.string().regex(/^[\w-]{1,64}$/), expected_revision: z.number().int().nonnegative(), action: z.enum(['start', 'pause', 'resume', 'close', 'reopen', 'add_time', 'set_tokens']), start_without_minimum: z.boolean().optional(),
  // The job's time: required for add_time; a start without it gets RUN_LENGTH.defaultMinutes.
  minutes: z.number().refine(validRunMinutes).optional(),
  // set_tokens only: the job's token cap, one pool for all the owner's agents, or null for no cap.
  tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional() }).strict();
// The job's one end time, shared by all its workers. Time is added from now once the end has passed.
function endAfterAdding(endsAt: number | undefined, minutes: number, at: number) {
  const next = Math.max(endsAt ?? 0, at) + minutes * 60_000;
  if (next - at > RUN_LENGTH.maxMinutes * 60_000) throw new Refusal('bad_input', 'A job can have up to 24 hours left. Choose a shorter time.');
  return next;
}

export const FINALIZE = z.object({ client_request_id: z.string().regex(/^[\w-]{1,64}$/), expected_revision: z.number().int().nonnegative(),
  minContributors: z.number().int().min(1).max(10000).optional(), startDeadline: z.iso.datetime().optional(),
}).strict();
export function setupSnapshot(record: ProjectRecord, runtime: RuntimeState | undefined) {
  return { required: record.setup.required, finalizedAt: runtime?.setupFinalizedAt ?? null,
    minContributors: runtime?.minContributors ?? record.setup.minContributors, startDeadline: runtime?.startDeadline ?? null };
}
export async function registeredParticipantCount(id: string, ownerId: string, tx?: Transaction): Promise<number> {
  const aggregate = collection(`projects/${id}/members`).where('status', '==', 'active').count();
  const [members, owner] = await Promise.all([tx ? tx.get(aggregate) : aggregate.get(), tx ? tx.get(membershipDoc(id, ownerId)) : membershipDoc(id, ownerId).get()]);
  return members.data().count + 1 - Number(owner.data()?.status === 'active');
}
export async function finalizeWorkspace(operator: WithId<Profile>, id: string, input: z.infer<typeof FINALIZE>, now: () => number) {
  return inProject(id, () => db.runTransaction(async tx => {
    const receiptRef = projectCollection<{ fingerprint: string; result: object }>('projectOperations').doc(hashToken(`${operator.id}:finalize:${input.client_request_id}`));
    const [person, approved, card, settings, listing, version, receipt] = await Promise.all([
      tx.get(profiles.doc(operator.id)), tx.get(projects.doc(id)), tx.get(cardDoc(id)), tx.get(platformSettings), tx.get(projectListings.doc(id)), tx.get(communitySettingsDoc(id)), tx.get(receiptRef),
    ]);
    if (!person.exists || person.data()!.removedAt !== null) throw new Refusal('unauthorized', 'Your account is no longer active.');
    if (!approved.exists || approved.data()!.ownerProfileId !== operator.id) throw new Refusal('forbidden', 'Only the owner can finish project setup.');
    if (isPrivateProject(approved.data())) throw new Refusal('forbidden', 'Private projects aren’t listed in Explore. To list it, send a public proposal.');
    const fingerprint = hashToken(JSON.stringify(input));
    if (receipt.exists) {
      if (receipt.data()!.fingerprint !== fingerprint) throw new Refusal('bad_input', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      return { ...receipt.data()!.result, replayed: true };
    }
    await assertProjectWritable(tx, id);
    const before = runtimeWithCard(approved.data(), card.data()), at = now();
    const current = currentCard(approved.data()!, card.data()), definition = current.definition;
    const repoUrl = before?.repoUrl ?? definition.githubUrl?.replace(/\/$/, '');
    if (!repoUrl) throw new Refusal('bad_input', 'Add the GitHub repository in Settings before publishing.');
    if (approved.data()!.revision !== input.expected_revision) throw new Refusal('proposal_conflict', 'Someone else changed the project setup. Reload, then publish again.');
    if (before?.started) throw new Refusal('bad_input', 'You can’t change recruitment settings after the project has started.');
    if (input.startDeadline && Date.parse(input.startDeadline) <= at) throw new Refusal('bad_input', 'Choose a future scheduled start date.');
    const minContributors = input.minContributors ?? before?.minContributors ?? definition.minContributors ?? 1;
    const maximum = settings.data()?.maxContributors;
    if (maximum != null && minContributors > maximum) throw new Refusal('bad_input', `The minimum number of contributors can be at most ${maximum}.`);
    if (!definition.goal) throw new Refusal('bad_input', 'Add the project description before publishing.');
    const revision = approved.data()!.revision + 1, catalogRevision = approved.data()!.publication.revision + 1;
    const configured = before ?? { ...agentText(definition), cardVersion: current.version,
      startsAt: 0, paused: true, started: false, awaitingKickoff: true,
      repoUrl, configuredAt: at, configuredBy: operator.id };
    const project: WorkspaceProject = { ...configured, revision, setupFinalizedAt: before?.setupFinalizedAt ?? at,
      minContributors, ...(input.startDeadline ? { startDeadline: new Date(input.startDeadline).toISOString() } : {}) };
    const tags = listing.data()?.tags ?? [], category = listing.data()?.category ?? 'community';
    tx.set(projectListings.doc(id), { workspaceId: DEFAULT_WORKSPACE_ID, title: definition.title, summary: definition.goal.slice(0, 240), category, tags,
      ownerName: person.data()!.name.includes('@') ? 'Project owner' : person.data()!.name,
      revision: catalogRevision, publishedAt: listing.data()?.publishedAt ?? at, updatedAt: at, prefixes: searchPrefixes(definition.title, tags) });
    tx.set(projects.doc(id), { ...recordWithRuntime(approved.data()!, project), publication: { listed: true, revision: catalogRevision } });
    setCommunityPublication(tx, id, true, at, version.data()!, operator.id);
    tx.create(collection('listingHistory').doc(`${id}-${catalogRevision}`), { id, operatorId: operator.id, at, revision: catalogRevision, source: 'owner_finalization' });
    tx.create(projectCollection('projectHistory').doc(String(revision).padStart(12, '0')), { at, operatorId: operator.id, action: 'setup_finalized', project });
    const result = { revision, execution: projectExecution(project), listed: true, replayed: false };
    tx.create(receiptRef, { fingerprint, result });
    return result;
  }));
}
export async function listProjects(operator: WithId<Profile>, cursor?: string, view: ArchiveView = 'all') {
  return listDirectory(operator, cursor, false, view);
}
export async function listMyProjects(operator: WithId<Profile>, cursor?: string, view: ArchiveView = 'all', size = 20) {
  return listDirectory(operator, cursor, true, view, size);
}
// Stars are read independently of the ordinary directory cursor. Both paths are bounded:
// at most 100 saved stars and 100 ordinary candidates, yielding 20 shortcuts.
export async function listProjectShortcuts(operator: WithId<Profile>) {
  const stars = await projectStars(operator.id).where('starred', '==', true).orderBy(FieldPath.documentId()).limit(100).get();
  const pinned: Awaited<ReturnType<typeof listDirectoryPage>>['projects'] = [];
  for (let start = 0; start < stars.docs.length && pinned.length < 20; start += 20) {
    const page = await listDirectoryPage(operator, undefined, false, stars.docs.slice(start, start + 20).map(row => row.id));
    pinned.push(...page.projects.filter(project => project.starred && !project.archived));
  }
  const active = await listProjects(operator, undefined, 'active');
  const seen = new Set(pinned.map(project => project.id));
  // The menu lists the most recently active projects first; starred ones stay on top (owner, 13 November 2026).
  const withActivity = async <T extends { id: string }>(rows: T[]) => {
    const dated = await Promise.all(rows.map(async row => ({ ...row, lastActivityAt: await projectLastActivityAt(row.id) })));
    return dated.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  };
  const [starred, rest] = await Promise.all([withActivity(pinned), withActivity(active.projects.filter(project => !seen.has(project.id)))]);
  return { projects: [...starred, ...rest].slice(0, 20), next: null };
}
// A project's last activity is its newest update or message (Unix ms), or null when it has neither.
async function projectLastActivityAt(id: string): Promise<number | null> {
  const [update, message] = await Promise.all([latestUpdateAt(id),
    inProject(id, () => messagesV2().orderBy('createdAt', 'desc').select('createdAt').limit(1).get()).then(page => (page.docs[0]?.get('createdAt') as number | undefined) ?? null)]);
  return update === null && message === null ? null : Math.max(update ?? 0, message ?? 0);
}
type ArchiveView = 'all' | 'current' | 'archived' | 'active';
async function listDirectory(operator: WithId<Profile>, cursor: string | undefined, includeProposals: boolean, view: ArchiveView, size = 20) {
  const baseScope = `${includeProposals ? 'my-projects' : 'projects'}:${operator.id}`;
  if (view === 'all') return listDirectoryPage(operator, cursor, includeProposals, undefined, size);
  const scope = `${baseScope}:${view}`, after = cursorAfter(cursor, scope);
  let pageCursor = after ? nextCursor(baseScope, after) : undefined;
  const rows: Awaited<ReturnType<typeof listDirectoryPage>>['projects'] = [];
  // Fill a page from at most 100 candidate entries. Sparse pages retain a cursor;
  // counts are page-local, and neither client nor server crawls an entire account.
  for (let batch = 0; batch < 5; batch++) {
    const page = await listDirectoryPage(operator, pageCursor, includeProposals, undefined, size);
    for (let index = 0; index < page.projects.length; index++) {
      const project = page.projects[index];
      // The menu column's view: projects that aren't closed, including ones waiting to start, plus any the person
      // starred (owner, 19 October 2026; waiting projects added 21 October 2026).
      if (view === 'active' ? !project.archived && (project.starred || project.kind === 'project' && project.state.status !== 'closed') : project.archived === (view === 'archived')) rows.push(project);
      if (rows.length === size) return { projects: rows, next: index < page.projects.length - 1 || page.next ? nextCursor(scope, project.id) : null };
    }
    if (!page.next) return { projects: rows, next: null };
    pageCursor = page.next;
  }
  return { projects: rows, next: nextCursor(scope, cursorAfter(pageCursor, baseScope)!) };
}
async function listDirectoryPage(operator: WithId<Profile>, cursor: string | undefined, includeProposals: boolean, selectedIds?: string[], size = 20) {
  const scope = `${includeProposals ? 'my-projects' : 'projects'}:${operator.id}`, after = cursorAfter(cursor, scope);
  let own = projects.where('workspaceId', '==', DEFAULT_WORKSPACE_ID).where('ownerProfileId', '==', operator.id).orderBy(FieldPath.documentId()).limit(size + 1);
  let memberships = membershipsOf(operator.id).orderBy(FieldPath.documentId()).limit(size + 1);
  if (after) { own = own.startAfter(after); memberships = memberships.startAfter(after); }
  let proposed = proposals.where('workspaceId', '==', DEFAULT_WORKSPACE_ID).where('ownerProfileId', '==', operator.id).orderBy(FieldPath.documentId()).limit(size + 1);
  if (after) proposed = proposed.startAfter(after);
  const [authored, joined, proposalPage] = selectedIds ? [{ docs: [], size: 0 }, { docs: await db.getAll(...selectedIds.map(id => membershipDoc(id, operator.id))), size: selectedIds.length }, null] : await Promise.all([own.get(), memberships.get(), includeProposals ? proposed.get() : null]);
  const ids = selectedIds ?? [...new Set([...authored.docs.map(d => d.id), ...joined.docs.map(d => d.id), ...(proposalPage?.docs.map(d => d.id) ?? [])])].sort();
  const page = ids.slice(0, size);
  const definitions = page.length ? await db.getAll(...page.map(id => projects.doc(id))) : [];
  const cards = page.length ? await db.getAll(...page.map(cardDoc)) : [];
  const listings = page.length ? await db.getAll(...page.map(id => projectListings.doc(id))) : [];
  const currentMemberships = page.length ? await db.getAll(...page.map(id => membershipDoc(id, operator.id))) : [];
  const preferences = page.length ? await db.getAll(...page.map(id => projectArchives(operator.id).doc(id))) : [];
  const stars = page.length ? await db.getAll(...page.map(id => projectStars(operator.id).doc(id))) : [];
  const covers = await Promise.all(page.map(id => latestUpdateScreenshotId(id)));
  const counts: (number | null)[] = page.map(() => null);
  for (let start = 0; start < page.length; start += 4) {
    await Promise.all(definitions.slice(start, start + 4).map(async (definition, offset) => {
      if (definition.exists) counts[start + offset] = await registeredParticipantCount(definition.id, definition.data()!.ownerProfileId);
    }));
  }
  const rows = definitions.flatMap<{ id: string; name: string; summary: string; coverImage?: string; cover?: string; execution: string; role: ProjectRole; kind: 'project' | 'proposal'; proposalStatus: string | null; revision: number | null; participantCount?: number | null; listed?: boolean; lifecycle?: string; minContributors?: number | null; startDeadline?: string | null; state: ProjectLifecycle; private: boolean; repository?: string | null; archived: boolean; archiveRevision: number; starred: boolean; endsAt?: number | null }>((definition, index) => {
    if (!definition.exists) {
      const proposal = proposalPage?.docs.find(d => d.id === definition.id)?.data();
      if (!proposal) return [];
      return [{ ...archiveState(preferences[index].data()), ...starState(stars[index].data()), id: definition.id, name: proposal.content.title, summary: proposal.content.goal, execution: 'not_configured' as const, role: 'owner' as const,
        kind: 'proposal' as const, proposalStatus: proposal.status, revision: proposal.revision, state: deriveProjectLifecycle({ kind: 'proposal', proposalStatus: proposal.status, role: 'owner' }), private: false }];
    }
    const p = definition.data()! as ProjectRecord, member = currentMemberships[index]?.data();
    if (p.workspaceId !== DEFAULT_WORKSPACE_ID) return [];
    if (p.ownerProfileId !== operator.id && (!member || member.status !== 'active' || member.profileId !== operator.id || member.projectId !== definition.id)) return [];
    const projectRole: ProjectRole = p.ownerProfileId === operator.id ? 'owner' : member?.role ?? 'member';
    const listed = !isPrivateProject(p) && listings[index].exists;
    const { coverImage } = artworkOf(p.artwork, listings[index].data()?.coverImage);
    const current = runtimeWithCard(definition.data() as ProjectRecord | undefined, cards[index].data() as CardVersion | undefined), setup = setupSnapshot(p as ProjectRecord, current);
    const state = deriveProjectLifecycle({ kind: 'project', role: projectRole, execution: p.execution.completedAt !== null ? 'closed' : projectExecution(current), runtimeStarted: current?.started, listed,
      privateProject: !!isPrivateProject(p), setupRequired: setup.required, setupFinalizedAt: setup.finalizedAt, participantCount: counts[index], minContributors: setup.minContributors });
    // Members' agents match GitHub invitations to their projects by this repository.
    return [{ ...archiveState(preferences[index].data()), ...starState(stars[index].data()), id: definition.id, repository: current?.repoUrl ?? null, ...(coverImage ? { coverImage } : {}), ...(covers[index] ? { cover: covers[index]! } : {}), name: currentCard(p, cards[index].data() as CardVersion | undefined).definition.title, summary: currentCard(p, cards[index].data() as CardVersion | undefined).definition.goal, state, execution: p.execution.completedAt !== null ? 'closed' : projectExecution(current), role: projectRole, kind: 'project' as const, proposalStatus: null, revision: null, participantCount: counts[index], listed, lifecycle: p.setup.required ? state.setup === 'pending' ? 'setup' : !current?.started ? 'recruiting' : current.paused ? 'paused' : 'active' : undefined, minContributors: current?.minContributors ?? definition.data()!.setup.minContributors ?? null, startDeadline: current?.startDeadline ?? null, private: !!isPrivateProject(p), endsAt: p.execution.endsAt ?? null }];
  });
  return { projects: rows, next: selectedIds ? null : ids.length > size || authored.size === size + 1 || (joined.size === size + 1 || proposalPage?.size === size + 1) ? nextCursor(scope, page.at(-1) ?? joined.docs.at(-1)?.id ?? authored.docs.at(-1)!.id) : null };
}

export async function readWorkspace(operator: WithId<Profile>, id: string) {
  const role = await projectRole(operator, id);
  const [approvedSnap, cardSnap, listingSnap, rulesSnap, previewSnap] = await Promise.all([projects.doc(id).get(), cardDoc(id).get(), projectListings.doc(id).get(), communityRulesDoc(id).get(), previewDoc(id).get()]);
  const approved = approvedSnap.data()!, card = currentCard(approved, cardSnap.data());
  const listed = !isPrivateProject(approved) && listingSnap.exists;
  const p = runtimeWithCard(approved, cardSnap.data()), setup = setupSnapshot(approved, p), participantCount = await registeredParticipantCount(id, approved.ownerProfileId);
  const execution = approved.execution.completedAt !== null ? 'closed' as const : projectExecution(p);
  const state = deriveProjectLifecycle({ kind: 'project', role, execution, runtimeStarted: p?.started, listed, privateProject: !!isPrivateProject(approved), setupRequired: setup.required, setupFinalizedAt: setup.finalizedAt, participantCount, minContributors: setup.minContributors });
  const [preference, star, cover] = await Promise.all([projectArchives(operator.id).doc(id).get(), projectStars(operator.id).doc(id).get(), latestUpdateScreenshotId(id)]);
  return { id, role, nativeTeams: { enabled: nativeTeamsEnabled(approved.nativeTeams), revision: approved.nativeTeams?.revision ?? 0 }, nativeTasks: { enabled: nativeTasksEnabled(approved.nativeTasks), revision: approved.nativeTasks?.revision ?? 0 }, ...archiveState(preference.data()), ...starState(star.data()), state, listed, ...artworkOf(approved.artwork, listingSnap.data()?.coverImage), ...(cover ? { cover } : {}), definition: card.definition, cardVersion: card.version, project: p ?? null, revision: approved.revision,
    publicationOrigin: approved.privacy?.visibility === 'public' ? 'owner_conversion' as const : approved.privacy ? 'private' as const : 'reviewed_proposal' as const,
    ...(isPrivateProject(approved) ? { privacy: { ...approved.privacy, memberLimit: (await db.runTransaction(tx => readProjectAdmission(tx, id, approved.ownerProfileId))).capacity } } : {}),
    ...(role === 'owner' && approved.setupPlan ? { setupPlan: approved.setupPlan } : {}),
    startAnnouncement: await readStartAnnouncement(operator.id, id),
    communityRules: communityRulesView(rulesSnap.data()), previewUrl: previewView(previewSnap.data()), previewUpdatedAt: previewUpdatedAtView(previewSnap.data()), setup, participantCount, execution, endsAt: approved.execution.endsAt ?? null, tokenLimit: approved.execution.tokenLimit ?? null,
    // What the job's token pool has counted, for the owner's job bar; read only while a cap is set.
    ...(role === 'owner' && approved.execution.tokenLimit ? { tokensUsed: await inProject(id, () => jobTokensCounted(approved.ownerProfileId, approved.execution.startsAt)) } : {}), canConfigure: role === 'owner' };
}

async function mutate(operator: WithId<Profile>, id: string, input: z.infer<typeof CONFIGURE> | z.infer<typeof CONTROL>, now: () => number) {
  return inProject(id, async () => {
    const requestId = hashToken(`${operator.id}:${input.client_request_id}`);
    const receipts = projectCollection<{ fingerprint: string; result: { revision: number; execution: string; endsAt: number | null; tokenLimit?: { tokens: number } | null; replayed: boolean } }>('projectOperations');
    const fingerprint = hashToken(JSON.stringify(input));
    const result = await db.runTransaction(async tx => {
      const [person, approved, receipt, cardSnap] = await Promise.all([
        tx.get(profiles.doc(operator.id)), tx.get(projects.doc(id)), tx.get(receipts.doc(requestId)), tx.get(cardDoc(id)),
      ]);
      if (!person.exists || person.data()!.removedAt !== null) throw new Refusal('unauthorized', 'Your account is no longer active.');
      const owner = approved.exists && approved.data()!.ownerProfileId === operator.id;
      if (!owner) throw new Refusal('forbidden', 'Only the project owner can do this.');
      if (receipt.exists) {
        if (receipt.data()!.fingerprint !== fingerprint) throw new Refusal('bad_input', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
        return { result: { ...receipt.data()!.result, replayed: true }, fanout: null };
      }
      const record = approved.data()!;
      if (record.execution.completedAt !== null && (!('action' in input) || input.action !== 'reopen')) throw new Refusal('bad_input', 'Reopen this closed project before changing it.');
      const before = runtimeWithCard(record, cardSnap.data());
      if (record.revision !== input.expected_revision) throw new Refusal('proposal_conflict', 'Someone else changed this project. Reload, then try again.');
      const at = now(), revision = record.revision + 1;
      if (!before && 'action' in input && ['close', 'reopen'].includes(input.action)) {
        if (input.action === 'reopen' && record.execution.completedAt === null) throw new Refusal('bad_input', 'This project is not closed.');
        const next = { ...record, revision, execution: { ...record.execution, paused: true, completedAt: input.action === 'close' ? at : null } };
        tx.set(projects.doc(id), next);
        tx.create(projectCollection('projectHistory').doc(String(revision).padStart(12, '0')), { at, operatorId: operator.id, control: { action: input.action }, execution: next.execution });
        const result = { revision, execution: input.action === 'close' ? 'closed' : 'not_configured', endsAt: record.execution.endsAt ?? null, replayed: false };
        tx.create(receipts.doc(requestId), { fingerprint, result });
        return { result, fanout: null };
      }
      let project: WorkspaceProject, kind: 'card_changed' | 'project_started' | 'paused' | 'resumed' | null;
      if ('action' in input) {
        if (!before) throw new Refusal('bad_input', 'Add the GitHub repository in Settings first.');
        if (input.action === 'add_time' ? input.minutes === undefined : input.action !== 'start' && input.minutes !== undefined)
          throw new Refusal('bad_input', input.action === 'add_time' ? 'Choose how much time to add.' : 'Time can be set only when starting the project or adding time.');
        if (input.action === 'set_tokens' ? input.tokens === undefined : input.tokens !== undefined)
          throw new Refusal('bad_input', input.action !== 'set_tokens' ? 'A token cap can be set only with set_tokens.' : 'Choose a token amount, or null for no cap.');
        if (input.action === 'reopen' ? before.completedAt == null : before.completedAt != null) throw new Refusal('bad_input', input.action === 'reopen' ? 'This project is not closed.' : 'Reopen this project before starting, pausing or resuming it.');
        if (input.action === 'pause' && before.paused) throw new Refusal('bad_input', 'This project is already paused.');
        if (input.action === 'resume' && !before.paused) throw new Refusal('bad_input', 'This project is already active.');
        if (input.action === 'start' && approved.data()!.setup.required === true) {
          if (!before.setupFinalizedAt) throw new Refusal('bad_input', 'Finish setup and publish the project before starting it.');
          // This shared membership fence changes on every admission/removal, so a simultaneous
          // membership change retries this transaction before the kickoff decision commits.
          await tx.get(collection(`projects/${id}/capacity`).doc('membership'));
          const count = await registeredParticipantCount(id, approved.data()!.ownerProfileId, tx);
          if (count < (before.minContributors ?? 1) && (!owner || input.start_without_minimum !== true)) {
            throw new Refusal('bad_input', 'Not enough contributors have joined yet. Only the owner can start with fewer.');
          }
        }
        if (input.action === 'start' && before.started) throw new Refusal('bad_input', 'This project has already started.');
        if (['pause', 'resume'].includes(input.action) && !before.started) throw new Refusal('bad_input', 'Start the project first.');
        project = { ...before, revision, ...(input.action === 'start' ? { started: true, paused: false, awaitingKickoff: false, startsAt: at } : input.action === 'close' ? { completedAt: at, paused: true } : input.action === 'reopen' ? { paused: true } : ['add_time', 'set_tokens'].includes(input.action) ? {} : { paused: input.action === 'pause' }),
          ...(input.minutes !== undefined || input.action === 'start' ? { endsAt: endAfterAdding(before.endsAt, input.minutes ?? RUN_LENGTH.defaultMinutes, at) } : {}) };
        if (input.action === 'pause') project.pauseRequest = { revision, requestedAt: at };
        else if (!['add_time', 'set_tokens'].includes(input.action)) delete project.pauseRequest;
        if (input.action === 'reopen') delete project.completedAt;
        if (input.action === 'set_tokens') {
          if (input.tokens) project.tokenLimit = { tokens: input.tokens };
          else delete project.tokenLimit;
        }
        // Added time and the token cap reach each worker in the reply to its own contact; nothing is announced to agents.
        kind = ['add_time', 'set_tokens'].includes(input.action) ? null : input.action === 'start' ? 'project_started' : ['pause', 'close', 'reopen'].includes(input.action) ? 'paused' : 'resumed';
      } else {
        if (before && canonicalGithubRepo(before.repoUrl) !== canonicalGithubRepo(input.repoUrl)) {
          const active = await tx.get(agents().where('revokedAt', '==', null).limit(1));
          if (!before.paused || !active.empty) throw new Refusal('bad_input', 'Pause the project and remove its connected agents before changing the repository.');
        }
        // The first configure derives agent text from the current Card version; later Card saves derive it again.
        const card = currentCard(approved.data()!, cardSnap.data());
        project = { ...agentText(card.definition), cardVersion: card.version,
          startsAt: 0, paused: true, started: false, awaitingKickoff: true,
          ...before, repoUrl: input.repoUrl, revision, configuredAt: before?.configuredAt ?? at, configuredBy: operator.id };
        kind = 'card_changed';
      }
      const saved = recordWithRuntime(approved.data()!, project);
      if (!('action' in input) && canonicalGithubRepo(before?.repoUrl) !== canonicalGithubRepo(project.repoUrl))
        saved.setup.repositoryRevision = revision;
      tx.set(projects.doc(id), saved);
      if ('action' in input && input.action === 'start') writeStartAnnouncement(tx, { revision, startedAt: at, actorName: person.data()!.name, scheduled: false });
      tx.create(projectCollection('projectHistory').doc(String(revision).padStart(12, '0')), { at, operatorId: operator.id, project, ...('action' in input ? { control: { action: input.action, startWithoutMinimum: input.start_without_minimum === true, ...(input.minutes !== undefined ? { minutes: input.minutes } : {}), ...(input.tokens !== undefined ? { tokens: input.tokens } : {}) } } : {}) });
      const fanout = kind ? createFanout(tx, kind, { projectId: id, revision }, at) : null;
      const result = { revision, execution: projectExecution(project), endsAt: project.endsAt ?? null, tokenLimit: project.tokenLimit ?? null, replayed: false };
      tx.create(receipts.doc(requestId), { fingerprint, result });
      return { result, fanout };
    });
    if (result.fanout) await deliverProjectWide(result.fanout, now);
    if ('action' in input && input.action === 'close') {
      try { await endProjectWork(id, now, result.result.revision, operator.id); } catch (error) { console.error('Closing could not end all agent work.', error); }
    }
    return result.result;
  });
}
export const configureWorkspace = (operator: WithId<Profile>, id: string, input: z.infer<typeof CONFIGURE>, now: () => number) => mutate(operator, id, input, now);
export const controlWorkspace = (operator: WithId<Profile>, id: string, input: z.infer<typeof CONTROL>, now: () => number) => mutate(operator, id, input, now);

// The owner edits the Card. Each save is the next version, fenced by its own version and not
// by the runtime revision, so an edit and an execution control do not refuse each other. Agents read the new text on
// their next get_project; an edit wakes no one.
export async function editCard(operator: WithId<Profile>, id: string, body: unknown, now: () => number) {
  const parsed = CARD_EDIT.safeParse(body);
  if (!parsed.success) throw new Refusal('bad_input', z.prettifyError(parsed.error));
  const input = parsed.data, definition = cardDefinition(input.definition);
  if (!definition.goal) throw new Refusal('bad_input', 'Add a project description.');
  const fingerprint = hashToken(JSON.stringify({ expected_version: input.expected_version, definition }));
  return inProject(id, () => db.runTransaction(async tx => {
    const receiptRef = projectCollection<{ fingerprint: string; result: { version: number; replayed: boolean } }>('projectOperations').doc(hashToken(`${operator.id}:card:${input.client_request_id}`));
    const [person, approved, card, receipt, listing] = await Promise.all([
      tx.get(profiles.doc(operator.id)), tx.get(projects.doc(id)), tx.get(cardDoc(id)), tx.get(receiptRef), tx.get(projectListings.doc(id)),
    ]);
    if (!person.exists || person.data()!.removedAt !== null) throw new Refusal('unauthorized', 'Your account is no longer active.');
    const role = await assertMembership(tx, operator.id);
    if (role !== 'owner') throw new Refusal('forbidden', 'Only the owner can edit the project card.');
    if (receipt.exists) {
      if (receipt.data()!.fingerprint !== fingerprint) throw new Refusal('bad_input', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      return { ...receipt.data()!.result, replayed: true };
    }
    await assertProjectWritable(tx, id);
    const current = currentCard(approved.data()!, card.data()).version;
    if (current !== input.expected_version) throw new Refusal('proposal_conflict', `Someone else changed the project card (now version ${current}). Reload it, then edit again.`);
    const at = now(), version = current + 1, entry = { version, definition, at, editorProfileId: operator.id };
    // The approved record stays as written at approval; it remains version 1 and the proposal's provenance.
    tx.set(cardDoc(id), entry);
    tx.create(cardVersions(id).doc(cardVersionId(version)), entry);
    // Runtime text is derived from this Card on read, rather than copied into project storage.
    // A published Explore listing keeps a copy of the title and its search prefixes; both follow the edit.
    if (listing.exists) tx.update(projectListings.doc(id), { title: definition.title, prefixes: searchPrefixes(definition.title, listing.data()!.tags) });
    const result = { version, replayed: false };
    tx.create(receiptRef, { fingerprint, result });
    return result;
  }));
}

const CARD_PAGE = 10;
// Newest first, with one-row lookahead so a full last page never advertises an empty page.
export async function listCardVersions(operator: WithId<Profile>, id: string, cursor?: string) {
  await projectRole(operator, id);
  const project = (await projects.doc(id).get()).data()!;
  const scope = `history:card:${id}`, after = cursorAfter(cursor, scope);
  let query = cardVersions(id).orderBy('version', 'desc').limit(CARD_PAGE + 1);
  if (after) query = query.startAfter(Number(after));
  const found = await query.get();
  const more = found.size > CARD_PAGE;
  const page = found.docs.slice(0, CARD_PAGE).map(d => ({ ...d.data(), source: d.data().version === 1 ? project.privacy ? 'created' as const : 'approved' as const : 'edit' as const }));
  const versions = page;
  const editors = versions.length ? await db.getAll(...[...new Set(versions.map(v => v.editorProfileId))].map(editor => profiles.doc(editor))) : [];
  const names = new Map(editors.map(d => [d.id, d.data()?.name ?? null]));
  return { versions: versions.map(({ editorProfileId, ...v }) => ({ ...v, editorName: names.get(editorProfileId) ?? null })),
    next: more ? nextCursor(scope, cardVersionId(page.at(-1)!.version)) : null };
}

export const JOIN_PROJECT = z.object({ client_request_id: z.string().regex(/^[\w-]{1,64}$/) }).strict();
export async function joinWorkspace(operator: WithId<Profile>, id: string, input: z.infer<typeof JOIN_PROJECT>, now: () => number) {
  const outcome = await inProject(id, () => db.runTransaction(async tx => {
    const capacityRef = collection<{ revision: number }>(`projects/${id}/capacity`).doc('membership');
    const receiptRef = projectCollection<{ result: object }>('projectOperations').doc(hashToken(`${operator.id}:join:${input.client_request_id}`));
    const [person, approved, catalog, member, fence, settings, capacity, receipt, community] = await Promise.all([
      tx.get(profiles.doc(operator.id)), tx.get(projects.doc(id)), tx.get(projectListings.doc(id)),
      tx.get(membershipDoc(id, operator.id)), tx.get(membershipFenceDoc(id, operator.id)), tx.get(platformSettings), tx.get(capacityRef), tx.get(receiptRef), tx.get(communitySettingsDoc(id)),
    ]);
    if (!person.exists || person.data()!.removedAt !== null) throw new Refusal('unauthorized', 'You need a Minions invitation to join.');
    if (!approved.exists || isPrivateProject(approved.data()) || approved.data()!.workspaceId !== DEFAULT_WORKSPACE_ID || !approved.data()!.publication.listed || !catalog.exists || !community.exists || community.data()!.joining !== 'invited_users' || approved.data()!.setup.required && !runtimeOf(approved.data())?.setupFinalizedAt) throw new Refusal('not_found', 'This project isn’t open for new members.');
    if (runtimeOf(approved.data())?.completedAt != null) throw new Refusal('bad_input', 'This project is closed and isn’t taking new members.');
    const ownerId = approved.data()!.ownerProfileId;
    if (member.exists && member.data()!.status !== 'active') throw new Refusal('forbidden', 'The owner removed you from this project. Ask them to add you back.');
    const count = await registeredParticipantCount(id, ownerId, tx);
    if (ownerId === operator.id || member.data()?.status === 'active') return { joined: true, role: ownerId === operator.id ? 'owner' : member.data()!.role, participantCount: count, replayed: receipt.exists };
    const maximum = settings.data()?.maxContributors;
    if (maximum != null && count >= maximum) throw new Refusal('bad_input', 'This project is full.');
    const epoch = membershipEpoch(id, operator.id, member.data(), fence.data());
    if (epoch < 0 || fence.exists) throw new Refusal('forbidden', 'Ask the owner to add you back to this project.');
    const at = now();
    const membership: import('./access.js').Membership = { profileId: operator.id, projectId: id, role: 'member', status: 'active', statusChangedAt: at, restrictions: { chatMutedUntil: null }, revision: 1, updatedAt: at, connectionEpoch: epoch };
    const progress = await prepareProjectJourney(tx, operator.id, id, at); progress(['joined']);
    tx.set(capacityRef, { revision: (capacity.data()?.revision ?? 0) + 1 });
    tx.set(membershipFenceDoc(id, operator.id), { profileId: operator.id, projectId: id, epoch });
    tx.create(membershipDoc(id, operator.id), membership);
    tx.set(membershipsOf(operator.id).doc(id), membership);
    tx.create(projectCollection('membershipHistory').doc(hashToken(`${operator.id}:1`)), { operatorId: operator.id, at, source: 'self_join', member: membership });
    const result = { joined: true, role: 'member', participantCount: count + 1, replayed: false, newMember: true };
    tx.create(receiptRef, { result });
    return result;
  }));
  return outcome;
}
