import { isPrivateProject } from '../projects/schema.js';
import { exportActivePhoto } from '../community/profile-photos.js';
import type { Profile } from '../firestore.js';
// A read-only export of one person's service records, for a data request the operator handles by
// hand (OPE-71, owner decision D10 option A). Nothing here writes to Firestore or Auth.
//
// records: the person's own documents and what they or their agents wrote, with their data. Text
//          someone else wrote into them is withheld. Other profiles's IDs and agent names are kept on
//          purpose, as the references that make a record readable; whether they count as the other
//          person's data is an open owner decision.
// copies:  other documents that duplicate that content, by path and the record they copy, without
//          their data. The same file is the checklist for a deletion, which is not decided yet.
// Every read is a direct document read, a single-field equality query or a bounded page in
// document-ID order. There is no collection-group query: projects are iterated one by one.
import { FieldPath, isDocumentReference, Timestamp, type DocumentSnapshot, type Query, type QueryDocumentSnapshot } from '../firestore.js';
import { createHash } from 'node:crypto';
import { hashToken } from '../auth.js';
import { Refusal } from '../errors.js';
import { db } from '../firestore.js';
import { identity } from '../identity/index.js';
import { cardVersionId } from '../projects/card.js';
import { fanoutJobId } from '../v2/fanout-jobs.js';
import { itemId } from '../v2/records.js';

type PersonExport = {
  personId: string; exportedAt: string;
  records: { path: string; data: unknown }[];
  copies: { path: string; of: string }[];
  notCovered: string[];
};

const PAGE = 100;
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const VERIFIER = '[withheld: credential verifier]';
const OTHERS = '[withheld: written by someone else]';
const DELIVERED = '[withheld: delivered content; the source is sourceId]';
// A review writes the revision right after the one it read. A proposer's submission is also 'approved' (D1), so the
// status alone does not tell a review from a write.
const isReview = (proposal: { revision: number; feedback: { reviewedRevision: number } | null }) =>
  proposal.feedback !== null && proposal.feedback.reviewedRevision === proposal.revision - 1;
// Legacy Issue claim records keep their document key: a hash of the canonical repository URL and number.
const issueClaimKey = (repoUrl: string, issueNumber: number) => createHash('sha256').update(`${repoUrl}#${issueNumber}`).digest('hex');
const versionId = (revision: number) => String(revision).padStart(16, '0');
const NOT_COVERED = [
  'Photo copies already downloaded or cached by other people cannot be recalled. Expired unused preparations may have been cleaned; their lifecycle metadata is included, and only the current normalized photo bytes are exported.',
  'GitHub Issues, pull requests, comments and commits by the person or their agents. GitHub holds them; the service keeps observations without authors.',
  'Data model providers hold about the turns of the person\'s agents.',
  'The operator\'s local Minions files: worker logs, turn records and the agent credentials on that machine.',
  'Cloud Logging entries, such as request logs and errors.',
  'Firestore backups and exports, if any were made.',
  'Direction vote receipts in directionOperations. They store no voter, and their IDs hash the voter with a request ID the service does not keep.',
  'Other profiles\'s records that only name the person or their agents, such as messages other agents addressed to the person\'s agents. They are the other profiles\'s records.',
];

// Timestamps become ISO strings and references their paths. Everything else is plain JSON already.
function plain(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (isDocumentReference(value)) return value.path;
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

// One bounded page at a time, in document-ID order.
async function* pages(query: Query): AsyncGenerator<QueryDocumentSnapshot> {
  const ordered = query.orderBy(FieldPath.documentId()).limit(PAGE);
  for (let page = await ordered.get(); ; page = await ordered.startAfter(page.docs.at(-1)!).get()) {
    yield* page.docs;
    if (page.size < PAGE) return;
  }
}

async function existing(paths: string[]): Promise<DocumentSnapshot[]> {
  const found: DocumentSnapshot[] = [];
  for (let i = 0; i < paths.length; i += PAGE) {
    const batch = paths.slice(i, i + PAGE);
    if (batch.length) found.push(...(await db.getAll(...batch.map(path => db.doc(path)))).filter(d => d.exists));
  }
  return found;
}

const withoutVerifiers = (data: Record<string, unknown>) => ({ ...data,
  ...(data.tokenHash != null ? { tokenHash: VERIFIER } : {}), ...(data.pendingSetupHash != null ? { pendingSetupHash: VERIFIER } : {}) });
// The person's own records keep their structure; text someone else wrote into them is withheld.
type Feedback = { body: string; reviewerProfileId: string } | null;
const ownProposal = (proposal: { feedback: Feedback }, personId: string) =>
  proposal.feedback && proposal.feedback.reviewerProfileId !== personId ? { ...proposal, feedback: { ...proposal.feedback, body: OTHERS } } : proposal;
const ownHistory = (entry: { actorKind: string; actorId: string; feedback: string | null }, personId: string) =>
  entry.actorKind === 'person' && entry.actorId !== personId && entry.feedback !== null ? { ...entry, feedback: OTHERS } : entry;
type Action = { actor: { operatorId: string }; reason: string } | null;
const ownDirection = (direction: { result: { action: Action } | null }, personId: string) =>
  direction.result?.action && direction.result.action.actor.operatorId !== personId
    ? { ...direction, result: { ...direction.result, action: { ...direction.result.action, reason: OTHERS } } } : direction;
// In an admin's control entry, the card's text is the owner's, from their proposal.
const ownProjectHistory = (entry: { project: { configuredBy?: string } }, personId: string) =>
  entry.project.configuredBy !== undefined && entry.project.configuredBy !== personId
    ? { ...entry, project: { ...entry.project, name: OTHERS, mission: OTHERS, rules: OTHERS } } : entry;

// The Card version a workspace or history snapshot repeats: an owner's edit, or version 1, the approved proposal.
const cardOf = (project: string, version: number | undefined, privateProject: boolean) =>
  privateProject || version !== undefined && version > 1 ? `projects/${project}/cardVersions/${cardVersionId(version ?? 1)}` : `proposals/${project}`;

class Collected {
  records = new Map<string, unknown>();
  copies = new Map<string, string>();
  record(path: string, data: unknown) { this.copies.delete(path); this.records.set(path, plain(data)); }
  copy(path: string, of: string) { if (!this.records.has(path)) this.copies.set(path, of); }
}

export async function exportPerson(personId: string, now: () => number): Promise<PersonExport> {
  if (!ID.test(personId)) throw new Refusal('bad_input', 'Give a person ID as invite or bootstrap-owner prints it.');
  const person = await db.doc(`profiles/${personId}`).get();
  if (!person.exists) throw new Refusal('not_found', 'No person has this ID. Nothing was exported.');
  const exportedAt = new Date(now()).toISOString();
  const out = new Collected();
  out.record(person.ref.path, person.data());
  const browserPresence = await db.doc(`webPresence/${personId}`).get();
  if (browserPresence.exists) out.record(browserPresence.ref.path, browserPresence.data());
  for (const name of ['photoCandidates', 'profileOperations']) {
    for await (const doc of pages(person.ref.collection(name))) out.record(doc.ref.path, doc.data());
  }
  const activePhoto = await exportActivePhoto(personId, person.data() as Profile);
  if (activePhoto) out.record(`managed-profile-photo:${personId}/${activePhoto.id}`, activePhoto);
  const projects = await community(out, personId);
  for (const project of projects) await projectRecords(out, personId, project);
  const notCovered = [...NOT_COVERED];
  const user = await authUser(String(person.data()!.email ?? ''));
  if (user) out.record(`firebase-auth:users/${user.uid}`, user);
  else notCovered.unshift('Firebase Auth: no account has the person\'s invitation email. An account under another email is not linked to the person.');
  return {
    personId, exportedAt,
    records: [...out.records].sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => ({ path, data })),
    copies: [...out.copies].sort(([a], [b]) => a.localeCompare(b)).map(([path, of]) => ({ path, of })),
    notCovered,
  };
}

// The sign-in account, without tokens, password hashes or custom claims.
async function authUser(email: string) {
  return email ? identity().exportAccount(email) : null;
}

// Community-level records, at the root. Returns both approved public and directly created private projects.
async function community(out: Collected, personId: string): Promise<string[]> {
  for (const field of ['requesterProfileId','answer.profileId']) {
    for await (const d of pages(db.collection('humanRequests').where(field,'==',personId))) {
      const request=d.data(), own=request.requesterProfileId===personId;
      // blockerTitle and attemptedTitle remain on requests stored before 12 November 2026.
      const requesterText = ['attempted', 'blockerTitle', 'attemptedTitle'] as const;
      // Moderation is resolved by the human reviewer; ordinary resolutions belong to the requesting agent.
      const ownResolution = request.moderation && request.answer ? request.answer.profileId === personId : own;
      out.record(d.ref.path,{...request,...(!own ? {title:OTHERS,question:OTHERS,context:OTHERS,
        ...Object.fromEntries(requesterText.filter(key => request[key] !== undefined).map(key => [key, OTHERS])),
        ...(request.suggestedOptions !== undefined ? {suggestedOptions:request.suggestedOptions.map(() => OTHERS)} : {}),
        ...(request.moderation ? {moderation:OTHERS} : {})}:{}),
        resolution:request.resolution && !ownResolution ? {...request.resolution,body:OTHERS}:request.resolution,
        answer:request.answer && request.answer.profileId!==personId ? {...request.answer,body:OTHERS,
          ...(request.answer.customAnswer !== undefined ? {customAnswer:OTHERS} : {})}:request.answer});
    }
    for await (const d of pages(db.collection('humanRequestOperations').where(`request.${field}`,'==',personId))) out.copy(d.ref.path,`humanRequests/${d.data().request.id}`);
  }

  for await (const row of pages(db.collection('feedbackReports').where('authorId', '==', personId))) {
    const { fingerprint: _fingerprint, updatedBy: _reviewer, lastRequestId: _request, ...own } = row.data();
    out.record(row.ref.path, own);
    const screenshot = await db.doc(`feedbackScreenshots/${row.id}`).get();
    if (screenshot.exists) out.record(screenshot.ref.path, screenshot.data());
  }
  const feedbackBudget = await db.doc(`feedbackBudgets/${personId}`).get();
  if (feedbackBudget.exists) out.record(feedbackBudget.ref.path, feedbackBudget.data());
  // Captures contain invitation/stop capabilities; export only their lifecycle metadata.
  for (const field of ['ownerProfileId', 'recipientProfileId']) {
    for await (const row of pages(db.collection('invitationEmails').where(field, '==', personId))) {
      const { request: _request, recipientEmail, addressHash, ...metadata } = row.data();
      out.record(row.ref.path, row.data().recipientProfileId === personId ? { ...metadata, ...(recipientEmail ? { recipientEmail } : {}), addressHash } : metadata);
      const captured = await db.doc(`invitationEmailCaptures/${row.id}`).get();
      if (captured.exists) {
        const { capturedAt, expiresAt } = captured.data()!;
        out.record(captured.ref.path, { capturedAt, expiresAt, content: '[withheld: invitation and stop capabilities]' });
      }
    }
  }
  // Token verifiers and their document IDs are never exported.
  const email = (await db.doc(`profiles/${personId}`).get()).data()?.email;
  if (typeof email === 'string') {
    const stop = await db.doc(`invitationEmailStops/${hashToken(email.toLowerCase())}`).get();
    if (stop.exists) out.record(stop.ref.path, stop.data());
  }
  for await (const d of pages(db.collection(`profiles/${personId}/memberships`))) out.record(d.ref.path, d.data());
  for await (const d of pages(db.collection(`profiles/${personId}/projectArchives`))) out.record(d.ref.path, d.data());
  for await (const d of pages(db.collection(`profiles/${personId}/notifications`))) out.record(d.ref.path,d.data());
  for await (const d of pages(db.collection(`profiles/${personId}/projectStars`))) out.record(d.ref.path, d.data());
  for (const d of await existing([`onboardingProgress/${personId}`, `accountCleanup/${personId}`])) out.record(d.ref.path, d.data());
  const settings = await db.doc('platformSettings/ownership').get();
  if (settings.data()?.ownerProfileId === personId) out.record(settings.ref.path, settings.data());
  for (const field of ['ownerProfileId', 'recipientProfileId']) {
    for await (const d of pages(db.collection('privateProjectInvitations').where(field, '==', personId))) {
      const { recipientEmail, ...metadata } = d.data();
      out.record(d.ref.path, d.data().recipientProfileId === personId && recipientEmail ? { ...metadata, recipientEmail } : metadata);
    }
  }
  for await (const d of pages(db.collection('privateProjectOperations').where('actorProfileId', '==', personId))) {
    const data = d.data(), invitation = data.result?.invitation;
    if (invitation && invitation.recipientProfileId !== personId) {
      const { recipientEmail: _, ...safeInvitation } = invitation;
      out.record(d.ref.path, { ...data, result: { ...data.result, invitation: safeInvitation } });
    } else out.record(d.ref.path, data);
  }

  // Computer approvals contain credential verifiers, never export reusable proof material.
  for await (const d of pages(db.collection('onboardingJourneys').where('profileId', '==', personId))) out.record(d.ref.path, d.data());
  for await (const d of pages(db.collection('computerConnections').where('profileId', '==', personId))) {
    const { pollingSecretHash: _polling, candidateTokenHash: _candidate, ...metadata } = d.data();
    out.record(d.ref.path, { ...metadata, pollingSecretHash: VERIFIER, candidateTokenHash: VERIFIER });
    // This fence only serializes starts on the person's approved computer.
    for (const fence of await existing([`webAgentStartOwners/${d.id}`])) out.record(fence.ref.path,fence.data());
  }
  for await (const row of pages(db.collection('backgroundControls').where('profileId','==',personId))) out.record(row.ref.path,row.data());
  for (const name of ['webAgentStarts','ownerRuntimeReadiness','agentStartCancellations']) {
    for await (const row of pages(db.collection(name).where('profileId','==',personId))) out.record(row.ref.path,row.data());
  }
  for (const d of await existing([`privateMessageSendState/${personId}`])) out.record(d.ref.path, d.data());
  for await (const d of pages(db.collection(`profiles/${personId}/privateMessageOperations`))) out.record(d.ref.path, d.data());
  for await (const thread of pages(db.collection('privateMessageThreads').where('participantIds', 'array-contains', personId))) {
    const data = thread.data(), last = data.lastMessage;
    out.record(thread.ref.path, { ...data, lastMessage: last?.sender?.id === personId ? last : { ...last, body: OTHERS } });
    for await (const message of pages(thread.ref.collection('messages').where('sender.id', '==', personId))) out.record(message.ref.path, message.data());
    for (const participant of data.participantIds as string[]) {
      if (participant === personId) continue;
      const inboxPath = `profiles/${participant}/messageThreads/${thread.id}`;
      if (last?.sender?.id === personId) out.copy(inboxPath, `${thread.ref.path}/messages/${last.id}`);
    }
  }
  for await (const d of pages(db.collection(`profiles/${personId}/messageThreads`))) {
    const data = d.data(), last = data.lastMessage;
    out.record(d.ref.path, { ...data, lastMessage: last?.sender?.id === personId ? last : { ...last, body: OTHERS } });
  }

  // Proposals the person wrote, with every revision.
  for await (const d of pages(db.collection('proposals').where('ownerProfileId', '==', personId))) {
    out.record(d.ref.path, ownProposal(d.data() as { feedback: Feedback }, personId));
    for await (const h of pages(d.ref.collection('history'))) out.record(h.ref.path, ownHistory(h.data() as Parameters<typeof ownHistory>[0], personId));
  }
  // Reviews the person wrote as community owner. A proposal keeps a copy of its latest feedback.
  for await (const d of pages(db.collection('proposals').where('feedback.reviewerProfileId', '==', personId))) {
    if (d.data().ownerProfileId === personId) continue;
    for await (const h of pages(d.ref.collection('history').where('actorId', '==', personId))) out.record(h.ref.path, h.data());
    out.copy(d.ref.path, `${d.ref.path}/history/${versionId(d.data().feedback.reviewedRevision + 1)}`);
  }
  // A receipt holds the proposal as it was after the write. A review's receipt is the reviewer's.
  for await (const d of pages(db.collection('proposalOperations').where('result.proposal.operatorId', '==', personId))) {
    const proposal = d.data().result.proposal;
    if (isReview(proposal)) out.copy(d.ref.path, `proposals/${proposal.id}`);
    else out.record(d.ref.path, { ...d.data(), result: { ...d.data().result, proposal: proposal.feedback && proposal.feedback.reviewerId !== personId ? { ...proposal, feedback: { ...proposal.feedback, body: OTHERS } } : proposal } });
  }
  // A proposer's later update, submit or withdraw keeps the latest feedback, so its receipt copies the review too.
  for await (const d of pages(db.collection('proposalOperations').where('result.proposal.feedback.reviewerId', '==', personId))) {
    const proposal = d.data().result.proposal;
    out.copy(d.ref.path, `proposals/${proposal.id}/history/${versionId(proposal.feedback.reviewedRevision + 1)}`);
  }

  // A scan of project parents, in bounded pages: they are the projects every project route
  // checks, and no per-person index lists the projects someone wrote in.
  const projects: string[] = [], owned: string[] = [];
  for await (const d of pages(db.collection('projects'))) {
    projects.push(d.id);
    const approved = d.data();
    if (approved.ownerProfileId === personId) {
      owned.push(d.id);
      if (approved.approval) out.copy(d.ref.path, `proposals/${approved.approval.proposalId}`);
    } else if (approved.approval?.reviewerProfileId === personId) {
      out.copy(d.ref.path, `proposals/${approved.approval.proposalId}/history/${versionId(approved.approval.submittedRevision + 1)}`);
    }
  }
  // Only the owner publishes a listing, configures the workspace or edits its Card, which starts as the proposal.
  for await (const d of pages(db.collection('listingHistory').where('operatorId', '==', personId))) out.record(d.ref.path, d.data());
  for (const id of owned) {
    for await (const d of pages(db.collection('listingOperations').where('result.id', '==', id))) out.record(d.ref.path, d.data());
    for (const d of await existing([`projectListings/${id}`, `projects/${id}`])) {
      if (d.ref.parent.id === 'projectListings') out.copy(d.ref.path, `listingHistory/${id}-${d.data()!.revision}`);
      else out.record(d.ref.path, d.data());
    }
  }
  return projects;
}

// One project's records, under projects/{id}/.
async function projectRecords(out: Collected, personId: string, project: string): Promise<void> {
  const base = `projects/${project}/`;
  const col = (path: string) => db.collection(base + path);
  const privateProject = isPrivateProject((await db.doc(`projects/${project}`).get()).data());
  const record = (d: DocumentSnapshot) => out.record(d.ref.path, d.data());
  (await existing([`${base}membershipCleanup/${personId}`, `${base}members/${personId}`, `${base}membershipFences/${personId}`, `${base}invitationTargets/${personId}`, `${base}humanChatSendState/${personId}`, `${base}moderatorNominations/${personId}`])).forEach(record);
  for await (const row of pages(col('moderatorNominations').where('nominatedBy', '==', personId))) record(row);
  for await (const d of pages(col('humanChat').where('sender.id', '==', personId))) record(d);

  for await (const d of pages(col('updates').where('author.profile.id', '==', personId))) record(d);
  for await (const d of pages(col('progressOperations').where('update.author.profile.id', '==', personId))) record(d);

  // Community records remain private; export the requester's authored content only.
  for await (const d of pages(col('ruleVersions').where('authorProfileId', '==', personId))) record(d);
  const original = await db.doc(`${base}approval/original`).get();
  if (original.exists && original.data()!.ownerProfileId === personId) out.record(original.ref.path, original.data());

  for await (const d of pages(col('ownerAgentConnections').where('ownerProfileId', '==', personId))) record(d);

  // The person's agents and everything kept per agent. Content in their inboxes is someone's message.
  const agentIds: string[] = [];
  for await (const d of pages(col('agents').where('ownerProfileId', '==', personId))) {
    agentIds.push(d.id);
    out.record(d.ref.path, withoutVerifiers(d.data()));
  }
  for await(const d of pages(col('conversationEntries').where('actorProfileId','==',personId))) record(d);
  const sources = new Map<string, string>(), direct = new Map<string, string[]>(), projectWide: string[] = [];
  const participants: string[] = [];
  for (const agentId of agentIds) {
    for (const sub of ['workIntents', 'workIntentOperations', 'workIntentControl']) {
      for await (const d of pages(col(`agents/${agentId}/${sub}`))) record(d);
    }
    (await existing(['runs', 'presence', 'runnerUsage', 'inboxes', 'workerSessions', 'agentEnvironments', 'backgroundControls'].map(c => `${base}${c}/${agentId}`))).forEach(record);
    for await (const d of pages(col(`workerSessions/${agentId}/runs`).where('profileId', '==', personId))) record(d);
    for await (const d of pages(col(`workerSessions/${agentId}/extensions`).where('profileId', '==', personId))) record(d);
    for (const sub of ['runHistory', 'turnReports']) {
      for await (const d of pages(col(sub).where('agentId', '==', agentId))) record(d);
    }
    for await (const d of pages(col(`inboxes/${agentId}/items`))) out.record(d.ref.path, { ...d.data(), payload: DELIVERED });
    for (const sub of ['sources', 'receipts']) for await (const d of pages(col(`inboxes/${agentId}/${sub}`))) record(d);
    for await (const d of pages(col('messages').where('agentId', '==', agentId))) {
      record(d);
      sources.set(d.id, d.ref.path);
      // Direct messages name their recipients. Project-wide ones have no direct recipients.
      if (d.data().audience === 'direct') for (const to of d.data().to as string[]) direct.set(to, [...direct.get(to) ?? [], d.id]);
    }
    for await (const d of pages(col('fanouts').where('senderId', '==', agentId))) {
      out.copy(d.ref.path, `${base}messages/${d.data().messageId}`);
      projectWide.push(d.id);
    }
    for await (const d of pages(col('issueClaims').where('ownerAgentId', '==', agentId))) {
      record(d);
      participants.push(`${d.ref.path}/participants/${agentId}`);
    }
    for await (const d of pages(col('issueOperations').where('agentId', '==', agentId))) {
      record(d);
      const { repoUrl, issueNumber } = d.data().result.coordination;
      participants.push(`${base}issueClaims/${issueClaimKey(repoUrl, issueNumber)}/participants/${agentId}`);
    }
    // Another agent's receipt for joining or reporting on the agent's claim repeats that claim.
    for await (const d of pages(col('issueOperations').where('result.coordination.ownerAgentId', '==', agentId))) {
      const { repoUrl, issueNumber } = d.data().result.coordination;
      out.copy(d.ref.path, `${base}issueClaims/${issueClaimKey(repoUrl, issueNumber)}`);
    }
  }
  (await existing([...new Set(participants)])).forEach(record);

  // Native task text the person or their agents wrote. Others can rewrite a task's title, description
  // and links, so each field is exported only when its recorded author (contract v1.2) is theirs; a task
  // without field authors falls back to its creator. Activity snapshots and receipt results repeat the
  // whole task, so those rows keep their own action and IDs without the snapshot.
  const actors = new Set([`person:${personId}`, ...agentIds.map(id => `agent:${id}`)]);
  type Actor = { kind: string; id: string } | undefined;
  const own = (actor: Actor) => !!actor && actors.has(`${actor.kind}:${actor.id}`);
  for await (const t of pages(col('nativeTasks'))) {
    const task = t.data();
    const wrote = (field: Actor) => own(field ?? task.createdBy);
    const references = (task.references ?? []).filter((r: { id: string }) => wrote(task.referenceAuthors?.[r.id]));
    if (own(task.createdBy) || wrote(task.titleAuthor) || wrote(task.descriptionAuthor) || references.length) {
      out.record(t.ref.path, { ...task, title: wrote(task.titleAuthor) ? task.title : OTHERS,
        description: wrote(task.descriptionAuthor) ? task.description : OTHERS, references });
    }
    for await (const c of pages(col(`nativeTasks/${t.id}/comments`))) if (own(c.data().author)) record(c);
    for await (const a of pages(col(`nativeTasks/${t.id}/activity`))) {
      if (!own(a.data().actor)) continue;
      const { task: snapshot, comment, ...rest } = a.data();
      out.record(a.ref.path, { ...rest, ...(snapshot ? { task: OTHERS } : {}), ...(comment ? { comment: OTHERS } : {}) });
    }
  }
  // Teams retain each agent's own membership and actions. Other agents' authored team text
  // stays withheld from repeated history/receipt snapshots, as with native tasks above.
  for await (const t of pages(col('nativeTeams'))) {
    const team = t.data();
    if (agentIds.includes(team.createdByAgentId)) record(t);
    for (const id of agentIds) {
      const membership = await col(`nativeTeams/${t.id}/members`).doc(id).get();
      if (membership.exists) record(membership);
      for await (const a of pages(col(`nativeTeams/${t.id}/activity`).where('actorAgentId', '==', id))) {
        const { team: snapshot, ...rest } = a.data();
        out.record(a.ref.path, { ...rest, team: snapshot && agentIds.includes(snapshot.createdByAgentId) ? snapshot : OTHERS });
      }
    }
  }
  for (const id of agentIds) {
    for await (const r of pages(col('nativeTeamReceipts').where('actorAgentId', '==', id))) {
      const { result, ...rest } = r.data();
      out.record(r.ref.path, { ...rest, result: { teamId: result?.team?.id ?? null, revision: result?.team?.revision ?? null } });
    }
  }
  // Owner/admin capability-setting changes name their author.
  for (const name of ['nativeTaskSettingOperations', 'nativeTaskSettingHistory', 'nativeTeamSettingOperations', 'nativeTeamSettingHistory']) {
    for await (const d of pages(col(name).where('actorProfileId', '==', personId))) record(d);
  }
  for (const actor of actors) {
    const [kind, id] = actor.split(':');
    for await (const r of pages(col('nativeTaskReceipts').where('actor.id', '==', id))) {
      if (r.data().actor?.kind !== kind) continue;
      const { result, ...rest } = r.data();
      out.record(r.ref.path, { ...rest, result: { taskId: result?.task?.id ?? null, revision: result?.task?.revision ?? null,
        ...(result?.comment ? { commentId: result.comment.id } : {}) } });
    }
  }

  // What the person did as a project owner, admin or member, and what was recorded about them.
  // A settings or control receipt stores no actor; it has the revision of its history entry. A
  // membership receipt also has a revision, of the membership, and names the member.
  for await (const d of pages(col('projectHistory').where('operatorId', '==', personId))) {
    out.record(d.ref.path, ownProjectHistory(d.data() as Parameters<typeof ownProjectHistory>[0], personId));
    for await (const r of pages(col('projectOperations').where('result.revision', '==', d.data().project.revision))) {
      if (r.data().result.operatorId === undefined) out.copy(r.ref.path, d.ref.path);
    }
  }
  // An admin's control entry repeats the card the owner configured from their proposal or a later Card version.
  for await (const d of pages(col('projectHistory').where('project.configuredBy', '==', personId))) out.copy(d.ref.path, cardOf(project, d.data().project.cardVersion, privateProject));
  // The owner's Card versions. The current Card repeats the latest, and an edit's receipt, which stores no actor, its version.
  for await (const d of pages(col('cardVersions').where('editorProfileId', '==', personId))) {
    record(d);
    for await (const r of pages(col('projectOperations').where('result.version', '==', d.data().version))) out.copy(r.ref.path, d.ref.path);
  }
  for (const d of await existing([`${base}card/current`])) if (d.data()!.editorProfileId === personId) out.copy(d.ref.path, `${base}cardVersions/${cardVersionId(d.data()!.version)}`);
  for (const field of ['operatorId', 'member.profileId']) {
    for await (const d of pages(col('membershipHistory').where(field, '==', personId))) record(d);
  }
  // A membership receipt repeats the membership the owner set.
  for await (const d of pages(col('projectOperations').where('result.operatorId', '==', personId))) out.copy(d.ref.path, `${base}members/${personId}`);
  // Each history entry shares its ID with the receipt of the same request.
  for (const [history, receipts, field] of [['deliveryHistory', 'deliveryOperations', 'operatorId'],
    ['directionRecoveryHistory', 'directionRetryOperations', 'actor.operatorId']] as const) {
    for await (const d of pages(col(history).where(field, '==', personId))) {
      record(d);
      (await existing([`${base}${receipts}/${d.id}`])).forEach(record);
    }
  }
  // The owner's early end of voting, keyed by its direction. Its receipt is the direction's receipt with a deadline
  // after revision 1, the opening's.
  for await (const d of pages(col('directionEndHistory').where('actor.operatorId', '==', personId))) {
    record(d);
    for await (const r of pages(col('directionOperations').where('result.id', '==', d.id))) {
      if (r.data().result.deadline !== undefined && r.data().result.revision > 1) record(r);
    }
  }
  const outcomes: { path: string; directionId: string; at: number }[] = [];
  for await (const d of pages(col('directionOutcomeHistory').where('actor.operatorId', '==', personId))) {
    record(d);
    (await existing([`${base}directionOutcomeOperations/${d.id}`])).forEach(record);
    outcomes.push({ path: d.ref.path, directionId: d.data().directionId, at: d.data().at });
  }

  // A scan of the project's directions, in bounded pages: votes are kept under each direction,
  // keyed by voter, and there is no collection-group index for them.
  const voters = [hashToken(`person:${personId}`), ...agentIds.map(id => hashToken(`agent:${id}`))];
  for await (const d of pages(col('directions'))) {
    const direction = d.data();
    if (direction.openedBy?.operatorId === personId) {
      out.record(d.ref.path, ownDirection(direction as Parameters<typeof ownDirection>[0], personId));
      out.copy(`${base}fanouts/${direction.openingSourceId}`, d.ref.path);
      sources.set(direction.openingSourceId, d.ref.path);
      projectWide.push(direction.openingSourceId);
      // The opening receipt stores no actor. Of the direction's receipts, it alone has a deadline at revision 1; an
      // early end's receipt has a later one.
      for await (const r of pages(col('directionOperations').where('result.id', '==', d.id))) {
        if (r.data().result.deadline !== undefined && r.data().result.revision === 1) out.copy(r.ref.path, d.ref.path);
      }
    } else if (direction.result?.action?.actor?.operatorId === personId) {
      const outcome = outcomes.find(o => o.directionId === d.id && o.at === direction.result.action.at);
      if (outcome) out.copy(d.ref.path, outcome.path);
    }
    (await existing(voters.map(key => `${d.ref.path}/votes/${key}`))).forEach(record);
  }

  // Deliveries of the person's messages and direction openings into other agents' inboxes. A source
  // marker gives the item's position; the item itself may have expired after acknowledgment.
  if (projectWide.length) {
    // A scan of the project's agents, in bounded pages: project-wide content reached all of them.
    for await (const d of pages(col('agents'))) direct.set(d.id, [...direct.get(d.id) ?? [], ...projectWide]);
  }
  const pairs = [...direct].filter(([agentId]) => !agentIds.includes(agentId))
    .flatMap(([agentId, ids]) => [...new Set(ids)].map(sourceId => ({ agentId, sourceId })));
  const markers = await existing(pairs.map(p => `${base}inboxes/${p.agentId}/sources/${p.sourceId}`));
  for (const marker of markers) out.copy(marker.ref.path, sources.get(marker.id)!);
  const items = new Map(markers.map(m => [`${m.ref.parent.parent!.path}/items/${itemId(m.data()!.seq)}`, m.id]));
  for (const item of await existing([...items.keys()])) out.copy(item.ref.path, sources.get(items.get(item.ref.path)!)!);
  // The root dispatch job of each project-wide source names it.
  for (const job of await existing([...new Set(projectWide)].map(id => `fanoutJobs/${fanoutJobId(project, id)}`))) {
    out.copy(job.ref.path, sources.get(job.data()!.sourceId)!);
  }
}
