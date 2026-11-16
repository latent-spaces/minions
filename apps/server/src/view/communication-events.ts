import { FieldPath, Filter } from '../firestore.js';
import type { CommunicationEvent } from '@minions/contracts';
import { collection, currentProjectId } from '../firestore.js';
import { Refusal } from '../errors.js';
import { humanRequests } from '../projects/human-requests.js';

const EVENTS_PER_KIND = 10;
const STATUSES = ['open', 'answered', 'resolved'] as const;
const updates = (projectId: string) => collection<{
  id: string; title: string | null; body: string; publishedAt: number;
  author: { profile: { id: string; name: string | null }; agent: { id: string; name: string | null } | null };
}>(`projects/${projectId}/updates`);
const headline = (title: string | null, body: string) => {
  const text = (title?.trim() || body.trim()).replace(/\s+/g, ' ');
  return [...text].length > 160 ? [...text].slice(0, 159).join('') + '…' : text;
};

/** What agents did besides talking to each other, for the Home stage (owner, from the 19 October onboarding test):
 *  published project updates and questions to people, up to the replay time. Only what this member may already read:
 *  every update, the project's shared questions, and private questions assigned to them. */
export async function communicationEvents(query: Record<string, unknown>, viewerId: string, now: number) {
  if (Object.keys(query).some(k => k !== 'at')) throw new Refusal('bad_input', 'Choose a replay time.');
  const at = query.at === undefined ? now : typeof query.at === 'string' && /^\d{1,16}$/.test(query.at) ? Number(query.at) : NaN;
  if (!Number.isSafeInteger(at) || at < 0 || at > now) throw new Refusal('bad_input', 'Choose an available replay time.');
  const projectId = currentProjectId();
  const [posted, ...asked] = await Promise.all([
    updates(projectId).where('publishedAt', '<=', at).orderBy('publishedAt', 'desc').limit(EVENTS_PER_KIND).get(),
    ...STATUSES.map(status => humanRequests.where('status', '==', status).where('projectId', '==', projectId).where('createdAt', '<=', at)
      .where(Filter.or(Filter.where('visibility', '==', 'project'),
        Filter.and(Filter.where('visibility', '==', 'private'), Filter.where('assigneeProfileId', '==', viewerId))))
      .orderBy('createdAt', 'desc').orderBy(FieldPath.documentId()).limit(EVENTS_PER_KIND).get()),
  ]);
  const events: CommunicationEvent[] = [
    ...posted.docs.map(doc => doc.data()).map(u => ({ kind: 'update' as const, id: `update:${u.id}`, at: u.publishedAt,
      agent: u.author.agent ? { id: u.author.agent.id, name: u.author.agent.name } : null, authorName: u.author.profile.name,
      title: headline(u.title, u.body), status: null })),
    ...asked.flatMap(page => page.docs.map(doc => doc.data()))
      .map(r => ({ kind: 'question' as const, id: `question:${r.id}`, at: r.createdAt,
        agent: { id: r.agentId, name: r.agentName }, authorName: null, title: headline(r.title, r.question), status: r.status })),
  ].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)).slice(-EVENTS_PER_KIND);
  return { at, events, serverTime: now };
}
