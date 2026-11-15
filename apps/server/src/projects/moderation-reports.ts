import { z } from 'zod';
import type { Transaction } from '../firestore.js';
import type { ModerationReport } from '@minions/contracts';
import { agents, profiles, projectDoc, projectCollection } from '../firestore.js';
import { membershipDoc } from './access.js';
import { currentProjectId } from '../firestore.js';
import { messagesV2 } from '../v2/records.js';
import { Refusal } from '../errors.js';

export const MODERATION_INPUT = z.object({
  subject: z.object({ kind: z.enum(['person','agent']), id: z.string().regex(/^[\w-]{1,200}$/) }).strict(),
  category: z.enum(['security','conduct','project_rules']),
  evidence: z.array(z.object({ kind: z.enum(['agent_message','project_update','repository']),
    reference: z.string().min(1).max(2048) }).strict()).min(1).max(5),
}).strict();
// Moderation reports reach the project owner; the admin and moderator roles were removed (owner decision, 10 November 2026).
export const isModerator = (role: string) => role === 'owner';
export const moderationInputOf = (report: ModerationReport | undefined) => report ? {
  subject: { kind: report.subject.kind, id: report.subject.id }, category: report.category, evidence: report.evidence,
} : undefined;

/** References only: do not copy private messages or fetch external pages. */
export async function validateModeration(tx: Transaction, input: z.infer<typeof MODERATION_INPUT>): Promise<ModerationReport> {
  const project = (await tx.get(projectDoc())).data()!;
  const id = input.subject.id;
  let subject: ModerationReport['subject'];
  if (input.subject.kind === 'agent') {
    const agent = (await tx.get(agents().doc(id))).data();
    if (!agent) throw new Refusal('not_found','Choose an agent registered in this project.');
    const owner = (await tx.get(profiles.doc(agent.ownerProfileId))).data();
    subject = { kind:'agent', id, name:agent.name, ownerProfileId:agent.ownerProfileId, ownerName:owner?.name ?? null };
  } else {
    const [profile, member] = await Promise.all([tx.get(profiles.doc(id)),tx.get(membershipDoc(currentProjectId(),id))]);
    if (!profile.exists || id !== project.ownerProfileId && (!member.exists || member.data()!.projectId !== currentProjectId() || member.data()!.profileId !== id))
      throw new Refusal('not_found','Choose a participant registered in this project.');
    subject = { kind:'person', id, name:profile.data()!.name, ownerProfileId:null, ownerName:null };
  }
  for (const item of input.evidence) {
    if (item.kind === 'repository') {
      try {
        const repo = new URL(project.setup.repoUrl!), link = new URL(item.reference);
        const base = repo.pathname.replace(/\.git\/?$/,'').replace(/\/$/,'');
        if (repo.hostname !== 'github.com' || link.origin !== 'https://github.com' || link.username || link.password || link.search
          || !link.pathname.startsWith(base + '/') || !/^(issues|pull|commit|blob)\//.test(link.pathname.slice(base.length + 1))) throw new Error();
      } catch { throw new Refusal('bad_input','Use an evidence link in this project’s GitHub repository, without credentials or query parameters.'); }
    } else {
      if (!/^[\w-]{1,200}$/.test(item.reference)) throw new Refusal('bad_input','Use an existing project evidence ID.');
      const ref = item.kind === 'agent_message' ? messagesV2().doc(item.reference) : projectCollection('updates').doc(item.reference);
      if (!(await tx.get(ref)).exists) throw new Refusal('not_found','Evidence must belong to this project. Private steering and person-to-person messages are not evidence sources.');
    }
  }
  return { subject, category:input.category, evidence:input.evidence };
}
