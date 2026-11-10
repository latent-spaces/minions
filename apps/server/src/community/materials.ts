import { createHash } from 'node:crypto';
import { mediaStore, type BlobStore } from '../blob-store.js';
import { z } from 'zod';
import { collection, db } from '../firestore.js';
import { Refusal } from '../errors.js';
import { assertCommunityActor, type CommunityActor } from './identity.js';
import { proposals, proposalHistory, type SupportingMaterial, type ProposalDTO, proposalDTO } from './records.js';
import { PROPOSAL_ID, REQUEST_ID, REVISION } from './proposals.js';
import { membershipDoc } from '../projects/access.js';

type UploadResult = { proposal: ProposalDTO & { id: string }; material: SupportingMaterial };
const files = collection<{ proposalId: string; operatorId: string; digest: string; material: SupportingMaterial; expectedRevision?: number; result?: UploadResult }>('proposalMaterials');
export const MATERIAL_MAX_BYTES = 10 * 1024 * 1024;
const MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Refusal('bad_input', z.prettifyError(result.error));
  return result.data;
}
const materials = (): BlobStore => mediaStore('proposal-materials');
async function blob(action: 'write' | 'read' | 'delete', id: string, data?: Buffer): Promise<Buffer | void> {
  if (action === 'write') await materials().replace(id, data!, 'application/octet-stream');
  else if (action === 'read') return materials().read(id);
  else await materials().remove(id);
}
function validateBytes(bytes: Buffer, mime: string) {
  if (!bytes.length || bytes.length > MATERIAL_MAX_BYTES || !MIME.has(mime)) throw new Refusal('bad_input', 'Choose an image, PDF, text document or DOCX up to 10 MB.');
  const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : mime === 'image/webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    : mime === 'application/pdf' ? bytes.toString('ascii', 0, 5) === '%PDF-'
    : mime.endsWith('document') ? bytes[0] === 80 && bytes[1] === 75
    : !bytes.includes(0);
  if (!valid) throw new Refusal('bad_input', 'The file contents do not match its file type.');
}
async function writable(actor: CommunityActor, proposalId: string, expectedRevision: number) {
  return db.runTransaction(async tx => {
    const { operator } = await assertCommunityActor(tx, actor);
    const stored = (await tx.get(proposals.doc(proposalId))).data();
    if (!stored || stored.ownerProfileId !== operator.id) throw new Refusal('not_found', 'No proposal of yours has this ID.');
    const proposal = stored;
    if (!['draft', 'changes_requested'].includes(proposal.status)) throw new Refusal('proposal_state', 'You can only change files before you send the proposal.');
    if (proposal.revision !== expectedRevision) throw new Refusal('proposal_conflict', 'This proposal changed. Reload it, then change its files.');
    return proposal;
  });
}
export async function uploadMaterial(actor: CommunityActor, proposalId: string, expectedRevision: number, uploadId: string, name: string, mime: string, bytes: Buffer, now: () => number) {
  parse(PROPOSAL_ID, proposalId); parse(REVISION, expectedRevision); parse(REQUEST_ID, uploadId);
  name = name.trim();
  if (!name || name.length > 180 || /[\x00-\x1f/\\]/.test(name)) throw new Refusal('bad_input', 'Use a short filename without folder paths.');
  validateBytes(bytes, mime);
  const id = createHash('sha256').update(`${proposalId}:${actor.operatorId}:${uploadId}`).digest('hex');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const existing = (await files.doc(id).get()).data();
  if (existing) {
    if (existing.operatorId !== actor.operatorId || existing.digest !== digest || existing.material.name !== name || existing.material.mimeType !== mime || existing.expectedRevision !== expectedRevision) throw new Refusal('bad_input', 'This upload ID was already used for another file.');
    const current = await db.runTransaction(async tx => { await assertCommunityActor(tx, actor); return (await tx.get(proposals.doc(proposalId))).data(); });
    if (!current || !current.supportingMaterials?.some(m => m.id === id)) throw new Refusal('not_found', 'This supporting file is no longer attached.');
    if (!existing.result) throw new Refusal('proposal_conflict', 'Reload the proposal, then try again.');
    return existing.result;
  }
  const before = await writable(actor, proposalId, expectedRevision);
  if ((before.supportingMaterials?.length ?? 0) >= 8) throw new Refusal('bad_input', 'A proposal can include up to 8 supporting files.');
  await blob('write', `${id}-${digest}`, bytes);
  const material = { id, name, mimeType: mime, size: bytes.length, createdAt: now() };
  // Recheck the revision after the object write; a concurrent submit must never acquire a late file.
  return db.runTransaction(async tx => {
    await assertCommunityActor(tx, actor);
    const stored = (await tx.get(proposals.doc(proposalId))).data();
    const receipt = await tx.get(files.doc(id));
    if (receipt.exists) {
      const saved = receipt.data()!;
      if (saved.operatorId !== actor.operatorId || saved.digest !== digest || saved.material.name !== name || saved.material.mimeType !== mime || saved.expectedRevision !== expectedRevision) throw new Refusal('bad_input', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      if (!stored?.supportingMaterials?.some(m => m.id === id)) throw new Refusal('not_found', 'This supporting file is no longer attached.');
      if (!saved.result) throw new Refusal('proposal_conflict', 'Reload the proposal before continuing.');
      return saved.result;
    }
    if (!stored || stored.ownerProfileId !== actor.operatorId || stored.revision !== expectedRevision || !['draft', 'changes_requested'].includes(stored.status)) throw new Refusal('proposal_conflict', 'This proposal changed. Reload it, then upload again.');
    const proposal = { ...stored, supportingMaterials: [...(stored.supportingMaterials ?? []), material], revision: stored.revision + 1, updatedAt: now() };
    const result = { proposal: { id: proposalId, ...proposalDTO(proposal) }, material };
    tx.create(files.doc(id), { proposalId, operatorId: actor.operatorId, digest, material, expectedRevision, result });
    tx.set(proposals.doc(proposalId), proposal);
    tx.create(proposalHistory(proposalId).doc(String(proposal.revision).padStart(16, '0')), { action: 'material_added', revision: proposal.revision, at: now(), actorKind: 'person', actorId: actor.operatorId, operatorId: actor.operatorId, content: null, feedback: null, reviewedRevision: null });
    return result;
  });
}
export async function listMaterials(actor: CommunityActor, proposalId: string) {
  parse(PROPOSAL_ID, proposalId);
  return db.runTransaction(async tx => {
    const { operator, canReview } = await assertCommunityActor(tx, actor);
    const stored = (await tx.get(proposals.doc(proposalId))).data();
    const membership = stored?.status === 'approved' ? (await tx.get(membershipDoc(proposalId, operator.id))).data() : null;
    const member = membership?.profileId === operator.id && membership.projectId === proposalId && membership.status === 'active';
    if (!stored || (stored.ownerProfileId !== operator.id && !(canReview && !['draft','withdrawn'].includes(stored.status)) && !member)) throw new Refusal('not_found', 'These files weren’t found, or you can’t see them.');
    return { supportingMaterials: stored.supportingMaterials ?? [] };
  });
}
export async function downloadMaterial(actor: CommunityActor, proposalId: string, fileId: string) {
  parse(PROPOSAL_ID, proposalId); parse(PROPOSAL_ID, fileId);
  const found = await db.runTransaction(async tx => {
    const { operator, canReview } = await assertCommunityActor(tx, actor);
    const stored = (await tx.get(proposals.doc(proposalId))).data();
    const file = (await tx.get(files.doc(fileId))).data();
    const membership = stored?.status === 'approved' ? (await tx.get(membershipDoc(proposalId, operator.id))).data() : null;
    const member = membership?.profileId === operator.id && membership.projectId === proposalId && membership.status === 'active';
    if (!stored || !file || file.proposalId !== proposalId || !stored.supportingMaterials?.some(m => m.id === fileId)
      || (stored.ownerProfileId !== operator.id && !(canReview && !['draft','withdrawn'].includes(stored.status)) && !member)) throw new Refusal('not_found', 'This file wasn’t found, or you can’t see it.');
    return { material: file.material, digest: file.digest };
  });
  return { material: found.material, bytes: (await blob('read', `${fileId}-${found.digest}`)) as Buffer };
}
export async function removeMaterial(actor: CommunityActor, proposalId: string, fileId: string, expectedRevision: number, now: () => number, clientId?: string) {
  parse(PROPOSAL_ID, proposalId); parse(PROPOSAL_ID, fileId); parse(REVISION, expectedRevision);
  if (clientId !== undefined) parse(REQUEST_ID, clientId);
  const removalId = createHash('sha256').update(`${actor.operatorId}:${proposalId}:${clientId ?? `${fileId}:${expectedRevision}`}`).digest('hex');
  const removals = collection<{ fileId: string; expectedRevision: number; result: { proposal: import('./records.js').ProposalDTO & { id: string } } }>('materialRemovalOperations');
  const result = await db.runTransaction(async tx => {
    await assertCommunityActor(tx, actor);
    const receipt = await tx.get(removals.doc(removalId));
    if (receipt.exists) {
      if (receipt.data()!.fileId !== fileId || receipt.data()!.expectedRevision !== expectedRevision) throw new Refusal('bad_input', 'This removal request ID was already used for another file.');
      return receipt.data()!.result;
    }
    const stored = (await tx.get(proposals.doc(proposalId))).data();
    if (!stored || stored.ownerProfileId !== actor.operatorId || stored.revision !== expectedRevision) throw new Refusal('proposal_conflict', 'This proposal changed. Reload it, then remove the file.');
    if (!['draft','changes_requested','rejected'].includes(stored.status)) throw new Refusal('proposal_state', 'You can only change files before you send the proposal.');
    if (!stored.supportingMaterials?.some(m => m.id === fileId)) throw new Refusal('not_found', 'This file is no longer attached.');
    const proposal = { ...stored, revision: stored.revision + 1, updatedAt: now(), supportingMaterials: stored.supportingMaterials.filter(m => m.id !== fileId) };
    tx.set(proposals.doc(proposalId), proposal);
    tx.create(proposalHistory(proposalId).doc(String(proposal.revision).padStart(16, '0')), { action: 'material_removed', revision: proposal.revision, at: now(), actorKind: 'person', actorId: actor.operatorId, operatorId: actor.operatorId, content: null, feedback: null, reviewedRevision: null });
    const result = { proposal: { id: proposalId, ...proposalDTO(proposal) } };
    tx.create(removals.doc(removalId), { fileId, expectedRevision, result });
    // Retain metadata for upload-id replay fencing; detached bytes are deleted below.
    return result;
  });
  const file = (await files.doc(fileId).get()).data();
  if (file) await blob('delete', `${fileId}-${file.digest}`);
  return result;
}
