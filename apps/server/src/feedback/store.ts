import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FEEDBACK_KINDS, FEEDBACK_PAGES, FEEDBACK_STATUSES, type FeedbackReport, type FeedbackSummary } from '@mlswarm/contracts';
import { db, profiles } from '../firestore.js';
import { assertCommunityActor, type CommunityActor } from '../community/identity.js';
import { Refusal } from '../errors.js';
import { normalizeStillImage } from '../projects/image-codec.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const idSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const SUBMIT_FEEDBACK = z.object({ client_request_id: z.uuid(), kind: z.enum(FEEDBACK_KINDS), body: z.string().trim().min(1).max(4000), page: z.enum(FEEDBACK_PAGES).nullable(),
  screenshot: z.object({ mime: z.enum(['image/png', 'image/jpeg', 'image/webp']), base64: z.string().max(2_800_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict().nullable() }).strict();
export const FEEDBACK_UPDATE = z.object({ client_request_id: z.uuid(), expected_revision: z.number().int().nonnegative(), status: z.enum(FEEDBACK_STATUSES) }).strict();
const reports = db.collection('feedbackReports'), attachments = db.collection('feedbackScreenshots');
const preferenceInput = z.object({ promptsEnabled: z.boolean(), expected_revision: z.number().int().nonnegative(), client_request_id: z.uuid() }).strict();
export async function feedbackPreferences(actor: CommunityActor, input?: unknown) {
  if (actor.kind !== 'person') throw new Refusal('forbidden', 'Only you can change your feedback preferences.');
  const parsed = input === undefined ? null : preferenceInput.safeParse(input);
  if (parsed && !parsed.success) throw new Refusal('bad_input', 'Choose whether to show feedback prompts and send the current revision.');
  return db.runTransaction(async tx => {
    const { operator } = await authority(tx, actor);
    const current = operator.feedbackPreferences ?? { promptsEnabled: true, revision: 0, lastRequestId: null };
    const data = parsed?.success ? parsed.data : null;
    if (!data) return { promptsEnabled: current.promptsEnabled, revision: current.revision };
    if (current.lastRequestId === data.client_request_id) {
      if (current.promptsEnabled !== data.promptsEnabled || current.revision !== data.expected_revision + 1) throw new Refusal('intent_conflict', 'Retry the original preference change.');
      return { promptsEnabled: current.promptsEnabled, revision: current.revision };
    }
    if (current.revision !== data.expected_revision) throw new Refusal('proposal_conflict', 'Your feedback preferences changed elsewhere. Reload them before saving.');
    const saved = { promptsEnabled: data.promptsEnabled, revision: current.revision + 1, lastRequestId: data.client_request_id };
    tx.update(profiles.doc(operator.id), { feedbackPreferences: saved });
    return { promptsEnabled: saved.promptsEnabled, revision: saved.revision };
  });
}
type Stored = FeedbackReport & { authorId: string; fingerprint: string; updatedBy: string | null; lastRequestId: string | null };
const summary = (id: string, d: Stored): FeedbackSummary => ({ id, authorName: d.authorName, kind: d.kind, status: d.status, preview: d.body.slice(0, 140), createdAt: d.createdAt, revision: d.revision, hasScreenshot: d.hasScreenshot });
const report = (id: string, d: Stored): FeedbackReport => ({ ...summary(id, d), body: d.body, page: d.page, updatedAt: d.updatedAt });
async function authority(tx: import('../firestore.js').Transaction, actor: CommunityActor, admin = false) {
  const current = await assertCommunityActor(tx, actor);
  if (admin && !current.canAdminPlatform) throw new Refusal('forbidden', 'Only platform admins can review feedback.');
  return current;
}
export async function submitFeedback(actor: CommunityActor, input: unknown, now = Date.now) {
  const parsed = SUBMIT_FEEDBACK.safeParse(input);
  if (!parsed.success) throw new Refusal('bad_input', 'Choose a feedback type and write 1–4,000 characters. Attach only a PNG, JPEG or WebP up to 2 MiB.');
  const data = parsed.data, id = hash(`${actor.operatorId}:${data.client_request_id}`), fingerprint = hash(JSON.stringify(data));
  // Authenticate before decoding untrusted pixels. Duplicate handoffs bypass repeated image decoding.
  const prior = await db.runTransaction(async tx => { await authority(tx, actor); return (await tx.get(reports.doc(id))).data() as Stored | undefined; });
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new Refusal('intent_conflict', 'This feedback request was already used with different content.');
    return report(id, prior);
  }
  let screenshot: { base64: string; mime: string; width: number; height: number } | null = null;
  if (data.screenshot) {
    const bytes = Buffer.from(data.screenshot.base64, 'base64');
    if (bytes.toString('base64') !== data.screenshot.base64) throw new Refusal('bad_input', 'Use a valid image file.');
    const normalized = await normalizeStillImage(bytes, data.screenshot.mime);
    if (normalized.bytes.length > 512 * 1024) throw new Refusal('bad_input', 'Crop or reduce this screenshot; its optimized size must fit 512 KiB.');
    screenshot = { base64: normalized.bytes.toString('base64'), mime: 'image/webp', width: normalized.media.width, height: normalized.media.height };
  }
  return db.runTransaction(async tx => {
    const { operator } = await authority(tx, actor);
    const [existing, budget] = await Promise.all([tx.get(reports.doc(id)), tx.get(db.doc(`feedbackBudgets/${operator.id}`))]);
    if (existing.exists) {
      const d = existing.data() as Stored;
      if (d.fingerprint !== fingerprint) throw new Refusal('intent_conflict', 'This feedback request was already used with different content.');
      return report(id, d);
    }
    const at = now(), b = budget.data(), fresh = !b || at >= b.startedAt + 3_600_000;
    if (!fresh && b.count >= 10) throw new Refusal('rate_limited', 'You can send up to 10 reports per hour. Please try later.', Math.max(1, Math.ceil((b.startedAt + 3_600_000 - at) / 1000)));
    const saved: Stored = { id, authorId: operator.id, authorName: operator.name, kind: data.kind, body: data.body, page: data.page, status: 'new', createdAt: at, updatedAt: at, revision: 0, hasScreenshot: screenshot !== null, fingerprint, updatedBy: null, lastRequestId: null, preview: data.body.slice(0, 140) };
    tx.create(reports.doc(id), saved);
    if (screenshot) tx.create(attachments.doc(id), screenshot);
    tx.set(budget.ref, { startedAt: fresh ? at : b!.startedAt, count: fresh ? 1 : b!.count + 1 });
    return report(id, saved);
  });
}
export async function readFeedback(actor: CommunityActor, id: string, image = false) {
  if (!idSchema.safeParse(id).success) throw new Refusal('not_found', 'Feedback is unavailable.');
  return db.runTransaction(async tx => {
    const { canAdminPlatform } = await authority(tx, actor), found = await tx.get(reports.doc(id)), d = found.data() as Stored | undefined;
    if (!d || d.authorId !== actor.operatorId && !canAdminPlatform) throw new Refusal('not_found', 'Feedback is unavailable.');
    if (!image) return report(id, d);
    const picture = await tx.get(attachments.doc(id));
    if (!picture.exists) throw new Refusal('not_found', 'No screenshot is attached.');
    return { bytes: Buffer.from(picture.data()!.base64, 'base64') };
  });
}
export async function listFeedback(actor: CommunityActor, status: string, cursor?: string) {
  if (!FEEDBACK_STATUSES.includes(status as typeof FEEDBACK_STATUSES[number]) || cursor && !idSchema.safeParse(cursor).success) throw new Refusal('bad_input', 'Choose a feedback status and valid page cursor.');
  return db.runTransaction(async tx => {
    const { operator } = await authority(tx, actor, true);
    let query = reports.where('status', '==', status).orderBy('createdAt', 'desc').limit(21);
    if (cursor) { const start = await tx.get(reports.doc(cursor)); if (!start.exists || start.data()!.status !== status) throw new Refusal('bad_input', 'This page changed. Return to the first page.'); query = query.startAfter(start); }
    const page = await tx.get(query), visible = page.docs.slice(0, 20);
    return { actorProfileId: operator.id, items: visible.map(d => summary(d.id, d.data() as Stored)), next: page.size > 20 ? visible.at(-1)!.id : null };
  });
}
export async function updateFeedback(actor: CommunityActor, id: string, input: unknown, now = Date.now) {
  const parsed = FEEDBACK_UPDATE.safeParse(input);
  if (!idSchema.safeParse(id).success || !parsed.success) throw new Refusal('bad_input', 'Choose a status and current report revision.');
  return db.runTransaction(async tx => {
    await authority(tx, actor, true);
    const found = await tx.get(reports.doc(id)), d = found.data() as Stored | undefined, data = parsed.data;
    if (!d) throw new Refusal('not_found', 'Feedback is unavailable.');
    if (d.lastRequestId === data.client_request_id) {
      if (d.updatedBy !== actor.operatorId || d.status !== data.status || d.revision !== data.expected_revision + 1) throw new Refusal('intent_conflict', 'Retry this request with its original details.');
      return report(id, d);
    }
    if (d.revision !== data.expected_revision) throw new Refusal('proposal_conflict', 'Another admin changed this report. Reload it before updating.');
    const saved = { ...d, status: data.status, revision: d.revision + 1, updatedAt: now(), updatedBy: actor.operatorId, lastRequestId: data.client_request_id };
    tx.update(found.ref, saved); return report(id, saved);
  });
}
/** One bounded cleanup page, after account revocation; no active account can be purged. */
export async function cleanupFeedback(operatorId: string) {
  return db.runTransaction(async tx => {
    const person = await tx.get(profiles.doc(operatorId));
    if (!person.exists || typeof person.data()!.removedAt !== 'number') throw new Refusal('forbidden', 'Remove the account before cleaning up feedback.');
    const page = await tx.get(reports.where('authorId', '==', operatorId).limit(20));
    for (const d of page.docs) { tx.delete(d.ref); tx.delete(attachments.doc(d.id)); }
    tx.delete(db.doc(`feedbackBudgets/${operatorId}`));
    return page.size < 20;
  });
}
