import { createHash } from 'node:crypto';
import { FieldPath, FieldValue, type Transaction } from '../firestore.js';
import { z } from 'zod';
import type { NativeTeam, NativeTeamMember, NativeTeamActivity, NativeTeamDetail, NativeTeamMutationResult, NativeTeamPage } from '@minions/contracts';
import { agents, currentProjectId, db, projectCollection } from '../firestore.js';
import { Refusal } from '../errors.js';
import { assertMembership } from './access.js';
import { assertRunInTransaction } from '../v2/runs.js';
import { assertNewProgressAction, type ProgressActor } from './progress-authority.js';
import { assertNativeTeamsEnabled } from './native-team-settings.js';

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1);
const request = { clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) };
const change = { ...request, teamId: ID, expectedRevision: revision };
export const NATIVE_TEAM_MUTATION = z.discriminatedUnion('operation', [
  z.object({ ...request, operation: z.literal('create'), name: z.string().trim().min(1).max(120), purpose: z.string().trim().max(4000).default('') }).strict(),
  ...(['join', 'leave', 'archive', 'restore'] as const).map(operation => z.object({ ...change, operation: z.literal(operation) }).strict()),
]);
const PAGE = { cursor: ID.optional(), limit: z.coerce.number().int().min(1).max(50).default(20) };
export const NATIVE_TEAM_QUERY = z.object({ ...PAGE, archived: z.enum(['true', 'false']).default('false'), search: z.string().trim().max(120).optional() }).strict();
const DETAIL_QUERY = z.object({ memberCursor: ID.optional(), activityCursor: z.string().regex(/^\d{16}_[a-f0-9]{64}$/).optional(), limit: PAGE.limit }).strict();
export const nativeTeams = () => projectCollection<NativeTeam>('nativeTeams');
export const nativeTeamMembers = (id: string) => projectCollection<NativeTeamMember>(`nativeTeams/${id}/members`);
export const nativeTeamActivity = (id: string) => projectCollection<NativeTeamActivity>(`nativeTeams/${id}/activity`);
export const NATIVE_TEAM_PROGRESS_SHARDS = 16;
const receipts = () => projectCollection<{ actorAgentId: string; fingerprint: string; result: NativeTeamMutationResult }>('nativeTeamReceipts');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function bytePage<T>(rows: T[]): T[] {
  const page: T[] = []; let bytes = 0;
  for (const row of rows) { const size = Buffer.byteLength(JSON.stringify(row)); if (bytes + size > 64 * 1024) break; page.push(row); bytes += size; }
  return page;
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Refusal('bad_input', 'Check team fields, IDs, revision and request ID.');
  return result.data;
}
async function authorize(tx: Transaction, actor: ProgressActor, now: () => number) {
  if (actor.kind === 'person') { await assertMembership(tx, actor.person.id); return; }
  await assertRunInTransaction(tx, actor.agent.id, actor.runId, now);
  const current = (await tx.get(agents().doc(actor.agent.id))).data();
  if (!current || current.tokenHash !== actor.agent.tokenHash || current.ownerProfileId !== actor.agent.ownerProfileId)
    throw new Refusal('unauthorized', 'This agent connection changed. Reconnect before continuing.');
}

/** Reads remain available when Teams is off. All collections are project-scoped. */
export async function listNativeTeams(actor: ProgressActor, value: unknown = {}, now: () => number = Date.now): Promise<NativeTeamPage> {
  const input = parse(NATIVE_TEAM_QUERY, value);
  return db.runTransaction(async tx => {
    await authorize(tx, actor, now);
    const scanLimit = input.search ? 200 : input.limit;
    let query = nativeTeams().where('archived', '==', input.archived === 'true').orderBy(FieldPath.documentId()).limit(scanLimit + 1);
    if (input.cursor) query = query.startAfter(input.cursor);
    const rows = await tx.get(query), teams: NativeTeam[] = [];
    let consumed = 0, last: string | null = null, bytes = 0;
    for (const row of rows.docs.slice(0, scanLimit)) {
      const team = row.data(), matches = !input.search || team.name.toLocaleLowerCase().includes(input.search.toLocaleLowerCase());
      if (matches) {
        const size = Buffer.byteLength(JSON.stringify(team));
        if (bytes + size > 64 * 1024) break;
        teams.push(team); bytes += size;
      }
      consumed++; last = row.id;
      if (teams.length === input.limit) break;
    }
    return { teams, nextCursor: rows.size > consumed ? last : null };
  });
}

export async function getNativeTeam(actor: ProgressActor, teamId: string, value: unknown = {}, now: () => number = Date.now): Promise<NativeTeamDetail> {
  parse(ID, teamId); const input = parse(DETAIL_QUERY, value);
  return db.runTransaction(async tx => {
    await authorize(tx, actor, now);
    const team = (await tx.get(nativeTeams().doc(teamId))).data();
    if (!team) throw new Refusal('not_found', 'This team is unavailable in this project.');
    let members = nativeTeamMembers(teamId).where('active', '==', true).orderBy(FieldPath.documentId()).limit(input.limit + 1);
    let activity = nativeTeamActivity(teamId).orderBy('revision', 'desc').limit(input.limit + 1);
    if (input.memberCursor) members = members.startAfter(input.memberCursor);
    if (input.activityCursor) activity = activity.startAfter(Number(input.activityCursor.slice(0, 16)));
    const [mr, ar] = await Promise.all([tx.get(members), tx.get(activity)]);
    const events = bytePage(ar.docs.slice(0, input.limit).map(row => row.data()));
    return { team, members: mr.docs.slice(0, input.limit).map(row => row.data()), activity: events,
      nextMemberCursor: mr.size > input.limit ? mr.docs[input.limit - 1].id : null,
      nextActivityCursor: ar.size > events.length ? events.at(-1)!.id : null };
  });
}

/** No target-agent argument: membership always acts for the authenticated caller. */
export async function mutateNativeTeam(actor: ProgressActor, value: unknown, now: () => number = Date.now): Promise<NativeTeamMutationResult> {
  const input = parse(NATIVE_TEAM_MUTATION, value);
  if (actor.kind !== 'agent') throw new Refusal('forbidden', 'Team changes in this interface act only as the calling agent.');
  const actorId = actor.agent.id, key = hash([actorId, input.clientRequestId]), fingerprint = hash(input);
  return db.runTransaction(async tx => {
    await authorize(tx, actor, now);
    await assertNativeTeamsEnabled(tx);
    const receipt = (await tx.get(receipts().doc(key))).data();
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new Refusal('intent_conflict', 'This request ID was used with different team details. Use a new ID.');
      // Historical result only: replay cannot rejoin a departed member or undo a later archive.
      return { ...receipt.result, replayed: true };
    }
    await assertNewProgressAction(tx, actor);
    const at = now();
    let team: NativeTeam, member: NativeTeamMember | undefined;
    if (input.operation === 'create') {
      team = { id: `team_${key}`, projectId: currentProjectId(), name: input.name, purpose: input.purpose,
        createdByAgentId: actorId, archived: false, memberCount: 1, revision: 1, createdAt: at, updatedAt: at };
      member = { agentId: actorId, active: true, joinedAt: at, leftAt: null };
    } else {
      const saved = (await tx.get(nativeTeams().doc(input.teamId))).data();
      if (!saved) throw new Refusal('not_found', 'This team is unavailable in this project.');
      const membership = (await tx.get(nativeTeamMembers(saved.id).doc(actorId))).data();
      // Team creation and project-admin ownership never substitute for current team membership.
      if (input.operation !== 'join' && !membership?.active) throw new Refusal('forbidden', 'Only a current team member can leave, archive or restore this team.');
      if (saved.revision !== input.expectedRevision) throw new Refusal('intent_conflict', 'This team changed. Read it again and reconcile before saving.');
      team = { ...saved, revision: saved.revision + 1, updatedAt: at };
      if (input.operation === 'join') {
        if (saved.archived) throw new Refusal('forbidden', 'This team is archived. A member must restore it before new members can join.');
        if (membership?.active) throw new Refusal('intent_conflict', 'You already belong to this team.');
        if (saved.memberCount >= Number.MAX_SAFE_INTEGER - 1) throw new Refusal('bad_input', 'This team cannot accept more members.');
        member = { agentId: actorId, active: true, joinedAt: at, leftAt: null }; team.memberCount++;
      } else if (input.operation === 'leave') {
        member = { ...membership!, active: false, leftAt: at }; team.memberCount--;
      } else {
        const archived = input.operation === 'archive';
        if (saved.archived === archived) throw new Refusal('intent_conflict', archived ? 'This team is already archived.' : 'This team is already active.');
        team.archived = archived;
      }
    }
    const result = { team, replayed: false };
    const eventId = `${String(team.revision).padStart(16, '0')}_${key}`;
    // State, membership, history and retry receipt commit together after every authority read.
    tx.set(nativeTeams().doc(team.id), team);
    if (member) tx.set(nativeTeamMembers(team.id).doc(actorId), member);
    tx.create(nativeTeamActivity(team.id).doc(eventId), { id: eventId, teamId: team.id, actorAgentId: actorId,
      action: input.operation, revision: team.revision, at, team });
    tx.create(receipts().doc(key), { actorAgentId: actorId, fingerprint, result });
    // A bounded shared watch must observe every mutation, including writes to
    // teams outside the current directory window and identical timestamps.
    const shard = String(parseInt(key.slice(0, 2), 16) % NATIVE_TEAM_PROGRESS_SHARDS).padStart(2, '0');
    tx.set(projectCollection('nativeTeamProgress').doc(shard), { revision: FieldValue.increment(1) }, { merge: true });
    return result;
  });
}
