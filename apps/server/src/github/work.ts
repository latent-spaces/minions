import { runtimeOf } from '../projects/records.js';
// Compact, source-ordered projections. GitHub observations never establish accepted output.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db, projectCollection, projectDoc } from '../firestore.js';
import { Refusal } from '../errors.js';
import { githubContext, type GitHubResource } from './context.js';
import { githubNumberIdentity } from './resource-identity.js';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const timestamp = z.string().datetime({ offset: true });
const common = { number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  title: z.string().max(256), state: z.enum(['open', 'closed']), updated_at: timestamp };
const labels = z.array(z.object({ name: z.string().max(100) })).max(100);
const milestone = z.object({ number: common.number, title: common.title }).nullable();
const ISSUE = z.object({ ...common, state_reason: z.enum(['completed', 'not_planned', 'reopened']).nullable().optional(),
  labels, milestone, pull_request: z.unknown().optional() });
const PR = z.object({ ...common, labels, milestone, draft: z.boolean(), merged_at: timestamp.nullable(),
  head: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/) }), base: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/) }) });
const MILESTONE = z.object({ ...common, due_on: timestamp.nullable(),
  open_issues: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), closed_issues: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
const PAYLOAD = z.object({ action: z.string().max(100),
  repository: z.object({ id: common.number, full_name: z.string().max(300) }),
  issue: z.unknown().optional(), pull_request: z.unknown().optional(), milestone: z.unknown().optional() });
const kinds = { issues: 'issue', pull_requests: 'pull_request', milestones: 'milestone' } as const;
const collections = { issues: 'githubIssues', pull_requests: 'githubPullRequests', milestones: 'githubMilestones' } as const;
type Base = { repositoryId: number; repoUrl: string; number: number; title: string; url: string; state: 'open' | 'closed';
  sourceUpdatedAt: number; observedAt: number; fingerprint: string; reconciliationRequired: boolean };
type WithMilestone = { labels: string[]; milestone: { number: number; title: string } | null; milestoneNumber: number | null };
export type WorkObservation = Base & (
  { kind: 'issue'; stateReason: string | null } & WithMilestone
  | { kind: 'pull_request'; draft: boolean; mergedAt: number | null; headSha: string; baseSha: string } & WithMilestone
  | { kind: 'milestone'; dueAt: number | null; openIssues: number; closedIssues: number });
export const observations = (resource: GitHubResource) => projectCollection<WorkObservation>(collections[resource]);
const deliveries = () => projectCollection<{ fingerprint: string; at: number; result: object }>('githubDeliveries');
type RepositoryBinding = { repositoryId: number };

export function observation(resource: GitHubResource, repoUrl: string, repositoryId: number, raw: unknown, at: number): WorkObservation {
  const row = (resource === 'issues' ? ISSUE : resource === 'pull_requests' ? PR : MILESTONE).parse(raw);
  if (resource === 'issues' && 'pull_request' in row) throw new Refusal('bad_input', 'A pull request is not an Issue observation.');
  const identity = githubNumberIdentity(repoUrl, row.number);
  const facts = 'head' in row ? { draft: row.draft, mergedAt: row.merged_at === null ? null : Date.parse(row.merged_at), headSha: row.head.sha, baseSha: row.base.sha }
    : 'open_issues' in row ? { dueAt: row.due_on === null ? null : Date.parse(row.due_on), openIssues: row.open_issues, closedIssues: row.closed_issues }
    : { stateReason: row.state_reason ?? null };
  const grouping = 'labels' in row ? { labels: [...new Set(row.labels.map(l => l.name))].sort(),
    milestone: row.milestone, milestoneNumber: row.milestone?.number ?? null } : {};
  const content = { kind: kinds[resource], repositoryId, repoUrl: identity.repoUrl, number: row.number, title: row.title,
    url: `${identity.repoUrl}/${resource === 'issues' ? 'issues' : resource === 'pull_requests' ? 'pull' : 'milestone'}/${row.number}`,
    state: row.state, sourceUpdatedAt: Date.parse(row.updated_at), ...facts, ...grouping };
  return { ...content, fingerprint: hash(JSON.stringify(content)), observedAt: at, reconciliationRequired: false } as WorkObservation;
}
export function mergeObservation(prior: WorkObservation | undefined, incoming: WorkObservation) {
  const applied = !prior || prior.sourceUpdatedAt < incoming.sourceUpdatedAt;
  const conflict = prior?.sourceUpdatedAt === incoming.sourceUpdatedAt && prior.fingerprint !== incoming.fingerprint;
  const reconciliationRequired = Boolean(conflict || prior?.reconciliationRequired);
  // List pagination is not stronger proof than a contradictory same-timestamp webhook.
  const write = applied ? { ...incoming, reconciliationRequired } : conflict ? { ...prior!, reconciliationRequired: true } : null;
  return { applied, reconciliationRequired, write };
}

export async function ingestGitHub(resource: GitHubResource, raw: Buffer, deliveryId: string, binding: RepositoryBinding, now: () => number) {
  if (!/^[\w-]{1,128}$/.test(deliveryId)) throw new Refusal('bad_input', 'Invalid GitHub delivery ID.');
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new Refusal('bad_input', 'Invalid GitHub payload.'); }
  const validation = PAYLOAD.safeParse(parsed);
  if (!validation.success) throw new Refusal('bad_input', 'Unsupported GitHub payload.');
  const payload = validation.data;
  if (payload.repository.id !== binding.repositoryId) throw new Refusal('forbidden', 'Repository binding does not match.');
  if (payload.action === 'deleted' || payload.action === 'transferred') throw new Refusal('bad_input', 'This event requires object reconciliation.');
  // Validate before opening a transaction; strip unneeded bodies, profiles and branch names.
  let incoming: WorkObservation;
  try { incoming = observation(resource, `https://github.com/${payload.repository.full_name}`, binding.repositoryId, payload[kinds[resource]], now()); }
  catch (error) { if (error instanceof Refusal) throw error; throw new Refusal('bad_input', 'Unsupported GitHub object payload.'); }
  const receiptKey = hash(deliveryId), fingerprint = hash(JSON.stringify([resource, raw.toString('base64')]));
  return db.runTransaction(async tx => {
    const [project, receipt, contextSnap] = await Promise.all([tx.get(projectDoc()), tx.get(deliveries().doc(receiptKey)), tx.get(githubContext())]);
    if (!runtimeOf(project.data())) throw new Refusal('not_found', 'No repository is configured.');
    const identity = githubNumberIdentity(runtimeOf(project.data())!.repoUrl, incoming.number);
    if (incoming.repoUrl !== identity.repoUrl) throw new Refusal('forbidden', 'The event is outside this project repository.');
    const context = contextSnap.data();
    if (context?.repoUrl === identity.repoUrl && context.repositoryId !== binding.repositoryId) throw new Refusal('forbidden', 'The project’s GitHub repository changed. Ask the MyLittleSwarm team to reconnect it.');
    if (receipt.exists) {
      if (receipt.data()!.fingerprint !== fingerprint) throw new Refusal('delivery_conflict', 'This delivery ID has different content.');
      return { ...receipt.data()!.result, replayed: true };
    }
    const ref = observations(resource).doc(identity.key), prior = (await tx.get(ref)).data();
    const at = now(), update = mergeObservation(prior, { ...incoming, observedAt: at });
    if (update.write) tx.set(ref, update.write);
    if (!context || context.repoUrl !== identity.repoUrl) tx.set(githubContext(), { repoUrl: identity.repoUrl, repositoryId: binding.repositoryId });
    const result = { kind: incoming.kind, number: incoming.number, applied: update.applied, reconciliationRequired: update.reconciliationRequired, replayed: false };
    tx.create(deliveries().doc(receiptKey), { fingerprint, at, result });
    return result;
  });
}
