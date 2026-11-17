import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { mediaStore, type BlobStore } from '../blob-store.js';
import type { Transaction } from '../firestore.js';
import type { ProfilePhotoCandidate } from '@minions/contracts';
import { PROGRESS_LIMITS } from '@minions/contracts';
import { db, githubAccounts, profiles, type Profile } from '../firestore.js';
import { identity } from '../identity/index.js';
import { Refusal } from '../errors.js';
import { assertCommunityActor, type CommunityActor } from './identity.js';
import { normalizeStillImage } from '../projects/image-codec.js';
import { moderatePublicImage, assertImageAllowed, currentImageReview, type ImageModeration } from '../projects/image-moderation.js';

const DAY = 86_400_000, SLOTS = 8;
const ID = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
export type PhotoRecord = {
  source: 'upload' | 'github'; fingerprint: string; sourceUrl: string | null; createdAt: number; expiresAt: number;
  status: 'pending' | 'ready' | 'deleting' | 'deleted'; attached: boolean; objectKey: string;
  digest: string | null; media: { mimeType: 'image/webp'; byteSize: number; width: number; height: number } | null;
  moderation: ImageModeration | null;
};
export const photoCandidates = (personId: string) => profiles.doc(personId).collection('photoCandidates');
export const profileOperations = (personId: string) => profiles.doc(personId).collection('profileOperations');
export { publicProfilePhoto } from './profile-photo-ref.js';
import { publicProfilePhoto } from './profile-photo-ref.js';
function requireId(id: string) { if (!UUID.test(id)) throw new Refusal('bad_input', 'Use a stable UUID for this photo request.'); }
const media = (): BlobStore => mediaStore('profile-photos');
const readObject = (key: string): Promise<Buffer> => media().read(key);
const deleteObject = (key: string) => media().remove(key);
async function storeObject(key: string, bytes: Buffer) {
  await media().createOnce(key, bytes, 'image/webp');
  if (hash(await readObject(key)) !== hash(bytes)) throw new Error('Immutable profile photo storage mismatch.');
}
/** A testable transport; production always uses the fixed URL guard below. */
export const githubPhotoTransport = { fetch: (url: string, signal: AbortSignal) => fetch(url, { signal, redirect: 'error' }) };
export function validateGithubPhotoUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Refusal('bad_input', 'Your GitHub photo isn’t available. Upload a photo instead.'); }
  if (input.length > 2048 || url.protocol !== 'https:' || url.hostname !== 'avatars.githubusercontent.com' || url.port || url.username || url.password || url.hash)
    throw new Refusal('bad_input', 'Your GitHub photo can’t be used. Upload a photo instead.');
  return url.href;
}
export async function githubPhotoSource(actor: CommunityActor): Promise<string | null> {
  if (!actor.firebaseUid || actor.verifiedGithubSession !== true) return null;
  const [user, person] = await Promise.all([identity().account(actor.firebaseUid), profiles.doc(actor.operatorId).get()]);
  if (!user) throw new Error('The sign-in account no longer exists.');
  const account = user.githubId ? (await githubAccounts.doc(user.githubId).get()).data() : undefined;
  if (!person.exists || person.data()!.removedAt !== null || user.disabled || account?.firebaseUid !== user.subject
    || !account.emails.includes(person.data()!.email.toLowerCase()) || !account.avatarUrl) return null;
  return validateGithubPhotoUrl(account.avatarUrl);
}
async function fetchGithubPhoto(url: string) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await githubPhotoTransport.fetch(validateGithubPhotoUrl(url), controller.signal);
    if (!response.ok || response.redirected || !response.body) throw new Refusal('bad_input', 'Your GitHub photo could not be imported. Upload a photo instead.');
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > PROGRESS_LIMITS.uploadBytes)) throw new Refusal('bad_input', 'Use a photo up to 2 MiB.');
    const chunks: Buffer[] = []; let total = 0;
    const reader = response.body.getReader();
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength;
        if (total > PROGRESS_LIMITS.uploadBytes) { controller.abort(); throw new Refusal('bad_input', 'Use a photo up to 2 MiB.'); }
        chunks.push(Buffer.from(value)); }
    } finally { reader.releaseLock(); }
    return { bytes: Buffer.concat(chunks), mime: (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal('bad_input', 'Your GitHub photo could not be imported. Retry or upload a photo instead.');
  } finally { clearTimeout(timer); }
}
const receipt = (id: string, row: PhotoRecord): ProfilePhotoCandidate => ({ id,
  previewPath: `/community/my-profile/photo/${id}`, expiresAt: row.expiresAt, source: row.source });
function allowed(row: PhotoRecord) { const review = currentImageReview(row.moderation ?? undefined); return review?.decision === 'allowed' && review.imageSha256 === row.digest; }
/** Claims before deletion so an expired candidate cannot race a profile publication. Each call reads at most eight records. */
export async function cleanupProfilePhotos(personId: string, now: () => number): Promise<void> {
  const claimed = await db.runTransaction(async tx => {
    const person = await tx.get(profiles.doc(personId));
    const rows = await tx.get(photoCandidates(personId).where('status', 'in', ['pending', 'ready', 'deleting']).limit(SLOTS));
    const result: { id: string; key: string }[] = [];
    for (const doc of rows.docs) {
      const row = doc.data() as PhotoRecord;
      if (person.data()?.removedAt === null && (row.attached || row.expiresAt > now()) && row.status !== 'deleting') continue;
      // An active selected photo is never collected, even after its staging expiry.
      if (person.data()?.removedAt === null && person.data()?.photo?.id === doc.id && row.status !== 'deleting') continue;
      tx.update(doc.ref, { status: 'deleting', attached: false }); result.push({ id: doc.id, key: row.objectKey });
    }
    return result;
  });
  for (const row of claimed) { await deleteObject(row.key); await photoCandidates(personId).doc(row.id).update({ status: 'deleted', sourceUrl: null }); }
}
export async function prepareProfilePhoto(actor: CommunityActor, requestId: string, input: { source: 'upload'; mime: string; bytes: Buffer } | { source: 'github' }, now: () => number): Promise<ProfilePhotoCandidate> {
  requireId(requestId);
  if (input.source === 'upload' && (!Buffer.isBuffer(input.bytes) || !input.bytes.length || input.bytes.length > PROGRESS_LIMITS.uploadBytes)) throw new Refusal('bad_input', 'Use a photo up to 2 MiB.');
  await cleanupProfilePhotos(actor.operatorId, now);
  const id = hash(JSON.stringify([actor.operatorId, requestId]));
  const fingerprint = input.source === 'upload' ? hash(Buffer.concat([Buffer.from(input.mime + '\0'), input.bytes])) : 'github';
  const before = await photoCandidates(actor.operatorId).doc(id).get();
  // For a retry the reserved source URL wins, even if the GitHub account photo has since changed.
  const sourceUrl = input.source === 'github' && !before.exists ? await githubPhotoSource(actor) : null;
  if (input.source === 'github' && !before.exists && !sourceUrl) throw new Refusal('bad_input', 'No GitHub photo is available. Upload a photo instead.');
  let row = await db.runTransaction(async tx => {
    const { operator } = await assertCommunityActor(tx, actor);
    const ref = photoCandidates(actor.operatorId).doc(id), existing = (await tx.get(ref)).data() as PhotoRecord | undefined;
    if (existing) {
      if (existing.source !== input.source || existing.fingerprint !== fingerprint) throw new Refusal('intent_conflict', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      if (existing.status === 'deleting' || existing.status === 'deleted' || (!existing.attached && existing.expiresAt <= now())) throw new Refusal('proposal_state', 'This photo expired before you saved it. Choose it again.');
      return existing;
    }
    const slots = await tx.get(photoCandidates(actor.operatorId).where('status', 'in', ['pending', 'ready', 'deleting']).limit(SLOTS));
    if (slots.size >= SLOTS) throw new Refusal('rate_limited', 'You’ve chosen too many photos without saving. Wait a few minutes, then try again.', 3600);
    const created: PhotoRecord = { source: input.source, fingerprint, sourceUrl, createdAt: now(), expiresAt: now() + DAY,
      status: 'pending', attached: false, objectKey: id, digest: null, media: null, moderation: null };
    // All admissions share a written parent fence, including previously empty candidate queries.
    tx.update(profiles.doc(actor.operatorId), { photoPreparationRevision: (operator.photoPreparationRevision ?? 0) + 1 });
    tx.create(ref, created); return created;
  });
  if (row.status === 'ready') return receipt(id, row);
  // The first normalized bytes are immutable; parallel retries use the stored object as the authority.
  let normalized: { bytes: Buffer; media: NonNullable<PhotoRecord['media']> };
  if (row.digest && row.media) normalized = { bytes: await readObject(row.objectKey), media: row.media };
  else {
    // Recover an object whose durable write succeeded before its Firestore acknowledgement.
    const stored = await readObject(row.objectKey).catch((error: { code?: string | number }) => {
      if (error.code === 'ENOENT' || error.code === 404) return null;
      throw error;
    });
    if (stored) {
      const metadata = await sharp(stored, { limitInputPixels: PROGRESS_LIMITS.imagePixels }).metadata();
      if (metadata.format !== 'webp' || !metadata.width || !metadata.height || stored.length > PROGRESS_LIMITS.storedImageBytes) throw new Error('Invalid stored profile photo.');
      normalized = { bytes: stored, media: { mimeType: 'image/webp', byteSize: stored.length, width: metadata.width, height: metadata.height } };
    } else {
      const source = input.source === 'upload' ? input : await fetchGithubPhoto(row.sourceUrl!);
      normalized = await normalizeStillImage(source.bytes, source.mime);
      await storeObject(row.objectKey, normalized.bytes);
    }
    await db.runTransaction(async tx => {
      await assertCommunityActor(tx, actor); const ref = photoCandidates(actor.operatorId).doc(id), current = (await tx.get(ref)).data() as PhotoRecord;
      if (!['pending', 'ready'].includes(current.status) || current.expiresAt <= now()) throw new Refusal('proposal_state', 'This photo expired before you saved it. Choose it again.');
      if (current.digest && current.digest !== hash(normalized.bytes)) throw new Refusal('intent_conflict', 'This photo changed. Choose it again.');
      tx.update(ref, { digest: hash(normalized.bytes), media: normalized.media });
    }).catch(async error => {
      const state = (await photoCandidates(actor.operatorId).doc(id).get()).data()?.status;
      if (state === 'deleting' || state === 'deleted') await deleteObject(row.objectKey);
      throw error;
    });
  }
  if (hash(normalized.bytes) !== (row.digest ?? hash(normalized.bytes))) throw new Error('Profile photo content integrity failed.');
  const moderation = await moderatePublicImage(normalized.bytes, now);
  assertImageAllowed(moderation);
  row = await db.runTransaction(async tx => {
    await assertCommunityActor(tx, actor); const ref = photoCandidates(actor.operatorId).doc(id), current = (await tx.get(ref)).data() as PhotoRecord;
    if (current.status !== 'pending' && current.status !== 'ready' || current.expiresAt <= now()) throw new Refusal('proposal_state', 'This photo expired before you saved it. Choose it again.');
    if (moderation.imageSha256 !== current.digest) throw new Error('Profile photo moderation hash mismatch.');
    const ready = { ...current, moderation, status: 'ready' as const, sourceUrl: null }; tx.set(ref, ready); return ready;
  });
  return receipt(id, row);
}
export async function preparePhotoPublication(tx: Transaction, personId: string, profile: Profile, photo: null | { id: string; publicConsent: true }, now: () => number) {
  const oldId = profile.photo?.id;
  const next = photo ? await tx.get(photoCandidates(personId).doc(photo.id)) : null;
  const row = next?.data() as PhotoRecord | undefined;
  if (photo && (!ID.test(photo.id) || !row || row.status !== 'ready' || !allowed(row)
    || (photo.id !== oldId && row.expiresAt <= now()))) throw new Refusal('proposal_state', 'Choose a photo and confirm it can be shown publicly.');
  return { photo: photo ? { id: photo.id, publicConsent: true as const, publishedAt: oldId === photo.id ? profile.photo!.publishedAt : now() } : null,
    commit: () => {
      if (oldId && oldId !== photo?.id) tx.update(photoCandidates(personId).doc(oldId), { attached: false, expiresAt: now() });
      if (photo) tx.update(photoCandidates(personId).doc(photo.id), { attached: true });
    } };
}
export async function readProfilePhoto(personId: string, photoId: string, actor: CommunityActor | null, now: () => number) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(personId) || !ID.test(photoId)) throw new Refusal('not_found', 'This photo is unavailable.');
  const row = await db.runTransaction(async tx => {
    if (actor) { await assertCommunityActor(tx, actor); if (actor.operatorId !== personId) throw new Refusal('not_found', 'This photo is unavailable.'); }
    const [person, doc] = await Promise.all([tx.get(profiles.doc(personId)), tx.get(photoCandidates(personId).doc(photoId))]);
    const current = doc.data() as PhotoRecord | undefined;
    if (!person.exists || person.data()!.removedAt !== null || !current || current.status !== 'ready' || !allowed(current)
      || (!actor && publicProfilePhoto(person.data()!, personId)?.id !== photoId)
      || (actor && !current.attached && current.expiresAt <= now())) throw new Refusal('not_found', 'This photo is unavailable.');
    return current;
  });
  const bytes = await readObject(row.objectKey);
  if (hash(bytes) !== row.digest) throw new Error('Profile photo content integrity failed.');
  return bytes;
}
