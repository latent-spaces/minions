import { isPrivateProject } from './schema.js';
import type { Transaction } from '../firestore.js';
import { collection, type Profile, type WithId } from '../firestore.js';
import { projects } from './records.js';
import { cardDoc } from './card.js';
import { communitySettingsDoc } from './community-schema.js';
import { assertMembership, membershipDoc } from './access.js';
import { projectListings } from './catalog.js';
import { Refusal } from '../errors.js';

export type ChatAttachment = { id: string; name: string; contentType: string; size: number };
export type HumanMessage = { sender: { id: string; name: string }; body: string; createdAt: number;
  reply?: { id: string; body: string; sender: { id: string; name: string } } | null;
  attachments?: ChatAttachment[] };
export const humanMessages = (id: string) => collection<HumanMessage>(`projects/${id}/humanChat`);
export async function chatReadAccess(tx: Transaction, id: string, operator: WithId<Profile> | null, now: () => number) {
  const [project, listing, settings, card] = await Promise.all([tx.get(projects.doc(id)), tx.get(projectListings.doc(id)), tx.get(communitySettingsDoc(id)), tx.get(cardDoc(id))]);
  if (!project.exists || !settings.exists) throw new Refusal('not_found', 'This chat is unavailable.');
  let canSend = false, isMember = false;
  if (operator) {
    try {
      const role = await assertMembership(tx, operator.id); isMember = true;
      const member = role === 'owner' ? null : (await tx.get(membershipDoc(id, operator.id))).data();
      canSend = settings.data()!.chatSend === 'members' && (!member?.restrictions.chatMutedUntil || member.restrictions.chatMutedUntil <= now());
    } catch (error) { if (!(error instanceof Refusal)) throw error; }
  }
  if ((isPrivateProject(project.data()) || settings.data()!.chatRead !== 'public') && !isMember) throw new Refusal('not_found', 'This chat is unavailable.');
  if (project.data()!.execution.completedAt !== null) canSend = false;
  return { closed: project.data()!.execution.completedAt !== null, projectTitle: listing.data()?.title ?? card.data()!.definition.title, canSend,
    public: !isPrivateProject(project.data()) && settings.data()!.chatRead === 'public' };
}
export async function assertChatWrite(tx: Transaction, id: string, operator: WithId<Profile>, now: () => number) {
  const role = await assertMembership(tx, operator.id);
  if ((await tx.get(projects.doc(id))).data()?.execution.completedAt != null) throw new Refusal('forbidden', 'This project is closed. Reopen it before sending messages.');
  const settings = (await tx.get(communitySettingsDoc(id))).data();
  if (!settings || settings.chatSend !== 'members') throw new Refusal('forbidden', 'Chat is unavailable.');
  const member = role === 'owner' ? null : (await tx.get(membershipDoc(id, operator.id))).data();
  if (member?.restrictions.chatMutedUntil && member.restrictions.chatMutedUntil > now()) throw new Refusal('forbidden', 'Your messages in this chat are paused for now.');
}
