import { performance } from 'node:perf_hooks';
import { FieldPath } from '../firestore.js';
import { z } from 'zod';
import { db, inProject, profiles, agents } from '../firestore.js';
import { runtimeReadiness, readinessView } from '../owner/web-agent-starts.js';
import { assertCommunityActor, type CommunityActor } from '../community/identity.js';
import { activeRecipientOperators, connectionAllowed, membershipsOf, validProjectId } from '../projects/access.js';
import { projects } from '../projects/records.js';
import { cardDoc } from '../projects/card.js';
import { presence, runs } from '../v2/records.js';
import { deploymentKind } from '../deployment.js';
import { Refusal } from '../errors.js';
import { requestLimits, terminalRequestLimits } from '../request-state.js';
import { projectControlStats } from '../projects/project-control.js';
import { fanoutCheckStats } from '../v2/fanout.js';

async function authorize(actor: CommunityActor) {
  await db.runTransaction(async tx => {
    const { canAdminPlatform } = await assertCommunityActor(tx, actor);
    if (!canAdminPlatform) throw new Refusal('forbidden', 'Only pre-approved co-founders can inspect platform diagnostics.');
  }, { readOnly: true });
}
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw new Refusal('bad_input', 'Supply an exact email or a valid connection page.');
  return result.data;
};
const profileSummary = (id: string, p: { name: string; email: string; removedAt: number | null }) => ({ id, name: p.name, email: p.email, removedAt: p.removedAt });

// What the admin health card shows. A self-hosted engine says so instead of passing as MyLittleSwarm production.
export function environmentLabel(env: NodeJS.ProcessEnv = process.env): string {
  return deploymentKind(env);
}

export async function readPlatformHealth(actor: CommunityActor, now: () => number) {
  await authorize(actor);
  const started = performance.now();
  let status: 'reachable' | 'unavailable' = 'reachable';
  // A real, read-only dependency probe; missing document is still a successful read.
  try { await db.doc('platformSettings/limits').get(); } catch { status = 'unavailable'; }
  return { observedAt: now(), api: { status: 'responding' as const, revision: process.env.K_REVISION ?? null },
    database: { status, latencyMs: Math.round(performance.now() - started) },
    environment: environmentLabel(),
    infrastructure: { status: 'not_measured' as const },
    // Only the replica that answered; key counts never identify a person or project.
    replica: { requestState: requestLimits.stats(), terminalRequestState: terminalRequestLimits.stats(), projectControl: projectControlStats(),
      fanoutChecks: fanoutCheckStats() } };
}

export async function lookupPlatformUsers(actor: CommunityActor, query: unknown, now: () => number) {
  await authorize(actor);
  const { email } = parse(z.object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) }).strict(), query);
  const found = await profiles.where('email', '==', email).limit(2).get();
  return { observedAt: now(), email, users: found.docs.map(d => profileSummary(d.id, d.data())), limit: 2, ambiguous: found.size === 2 };
}


async function readAgents(profileId: string, at: number) {
  const [joined, owned] = await Promise.all([
    membershipsOf(profileId).orderBy(FieldPath.documentId()).limit(11).get(),
    projects.where('ownerProfileId', '==', profileId).orderBy(FieldPath.documentId()).limit(11).get(),
  ]);
  // Discovery includes inactive memberships so revoked or fenced credentials can be explained.
  const ids = [...new Set([...joined.docs.slice(0, 10).map(d => d.data().projectId), ...owned.docs.slice(0, 10).map(d => d.id)])].filter(validProjectId);
  let agentsTruncated = false;
  const entries = [];
  for (const projectId of ids) {
    const result = await inProject(projectId, async () => {
      const [found, card] = await Promise.all([
        agents().where('ownerProfileId', '==', profileId).orderBy(FieldPath.documentId()).limit(11).get(),
        cardDoc(projectId).get(),
      ]);
      const projectTitle = card.data()?.definition.title ?? null;
      const page = found.docs.slice(0, 10);
      const eligible = await db.runTransaction(tx => activeRecipientOperators(tx, [profileId]), { readOnly: true });
      const [contacts, sessions] = await Promise.all([
        page.length ? db.getAll(...page.map(d => presence().doc(d.id))) : [],
        page.length ? db.getAll(...page.map(d => runs().doc(d.id))) : [],
      ]);
      return { truncated: found.size > 10, entries: page.map((d, i) => {
        const agent = d.data(), run = sessions[i]?.data(), contact = contacts[i]?.data();
        const seen = run && contact?.runId === run.runId ? contact : undefined;
        const lastContactAt = typeof seen?.lastContactAt === 'number' && Number.isFinite(seen.lastContactAt) && seen.lastContactAt <= at ? seen.lastContactAt : null;
        return { id: d.id, projectId, projectTitle, name: agent.name,
          approvalStatus: agent.revokedAt !== null ? 'revoked' : !connectionAllowed(agent, eligible) ? 'membership_inactive' : agent.tokenIssuedAt === null ? 'unpaired' : 'credential_issued',
          contactStatus: lastContactAt === null ? 'unknown' : at - lastContactAt < 90_000 ? 'recent' : 'stale',
          lastContactAt, phase: lastContactAt === null ? null : seen?.phase ?? null };
      }) };
    });
    agentsTruncated ||= result.truncated;
    entries.push(...result.entries);
  }
  return { agents: entries, agentScope: { projectLimit: 20, perProjectLimit: 10, projectsTruncated: joined.size > 10 || owned.size > 10, agentsTruncated } };
}

export async function readUserConnections(actor: CommunityActor, rawProfileId: unknown, query: unknown, now: () => number) {
  await authorize(actor);
  const profileId = parse(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), rawProfileId);
  parse(z.object({}).strict(), query);
  const profile = (await profiles.doc(profileId).get()).data();
  if (!profile) throw new Refusal('not_found', 'No registered account has this ID.');
  const at = now();
  // The engine's one computer: its shared service's last report (owner decision, 15 November 2026).
  const [readiness, agentResult] = await Promise.all([runtimeReadiness.doc(profileId).get(), readAgents(profileId, at)]);
  return { observedAt: at, profile: profileSummary(profileId, profile), computer: readinessView(readiness.data(), at), ...agentResult };
}
