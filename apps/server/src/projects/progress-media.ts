import { isPrivateProject } from './schema.js';
import type { StoredUpdate } from './progress.js';
import { createHash } from 'node:crypto';
import { mediaStore, type BlobStore } from '../blob-store.js';
import type { Transaction } from '../firestore.js';
import { normalizeStillImage as normalize } from './image-codec.js';
import { PROGRESS_LIMITS, type ProgressScreenshot, type ProgressUploadReceipt, type ScreenshotInput } from '@mlswarm/contracts';
import { db, inProject, projectCollection } from '../firestore.js';
import { Refusal } from '../errors.js';
import { authorizeProgressPublisher, assertNewProgressAction, authorizeProgressRead, progressPublisherKey, type ProgressActor } from './progress-authority.js';
import { projects } from './records.js';
import { assertImageAllowed, currentImageReview, moderatePublicImage, type ImageModeration } from './image-moderation.js';

type Upload = {
  projectId: string; publisherKey: string; fingerprint: string; createdAt: number;
  ready: boolean; attachedUpdateId: string | null; objectKey: string;
  media: Omit<ProgressUploadReceipt, 'uploadId' | 'replayed'> | null;
  storedDigest: string | null;
  moderation?: ImageModeration;
};
const uploads = () => projectCollection<Upload>('progressUploads');
const reviewFor = (upload: Upload) => {
  const review = currentImageReview(upload.moderation);
  return review && (!upload.ready || review.imageSha256 === upload.storedDigest) ? review : null;
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const safeId = (id: string) => /^[a-f0-9]{64}$/.test(id);
function inputError(message: string): never { throw new Refusal('bad_input', message); }
const media = (): BlobStore => mediaStore('progress-media');
const readObject = (key: string): Promise<Buffer> => media().read(key);
async function storeObject(key: string, bytes: Buffer, mimeType: string) {
  await media().createOnce(key, bytes, mimeType);
  // The immutable object must be readable and match before readiness is committed.
  if (hash(await readObject(key)) !== hash(bytes)) throw new Error('Progress screenshot immutable storage mismatch.');
}

const receipt = (uploadId: string, record: Upload, replayed: boolean): ProgressUploadReceipt => ({ uploadId, ...record.media!, replayed });

export async function uploadProgressScreenshot(projectId: string, actor: ProgressActor, uploadRequestId: string, mime: string, bytes: Buffer, now: () => number): Promise<ProgressUploadReceipt> {
  if (!/^[\w-]{1,128}$/.test(uploadRequestId)) inputError('Use a stable screenshot upload request ID of up to 128 characters.');
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > PROGRESS_LIMITS.uploadBytes) inputError('Choose a screenshot up to 2 MiB.');
  const publisherKey = progressPublisherKey(actor);
  const id = hash(JSON.stringify([projectId, publisherKey, uploadRequestId]));
  const fingerprint = hash(Buffer.concat([Buffer.from(mime + '\0'), bytes]));
  return inProject(projectId, async () => {
    // Reservation fixes request identity before any object write, including interrupted uploads.
    const before = await db.runTransaction(async tx => {
      await authorizeProgressPublisher(tx, actor);
      const project = (await tx.get(projects.doc(projectId))).data();
      const existing = (await tx.get(uploads().doc(id))).data();
      if (existing && existing.fingerprint !== fingerprint) inputError('This upload ID was already used for a different image. Use a new upload ID.');
      const isPublic = !isPrivateProject(project);
      if (existing?.ready && (!isPublic || reviewFor(existing))) return { upload: existing, isPublic };
      await assertNewProgressAction(tx, actor, { whilePaused: true });
      if (existing) return { upload: existing, isPublic };
      const record: Upload = { projectId, publisherKey, fingerprint, createdAt: now(), ready: false,
        attachedUpdateId: null, objectKey: `${id}-${fingerprint}`, media: null, storedDigest: null };
      tx.create(uploads().doc(id), record);
      return { upload: record, isPublic };
    });
    let upload = before.upload;
    if (before.isPublic && reviewFor(upload)) assertImageAllowed(upload.moderation!);
    if (upload.ready && (!before.isPublic || reviewFor(upload))) return receipt(id, upload, true);
    const normalized = await normalize(bytes, mime);
    if (before.isPublic) {
      // Existing ready objects retain their pixels/metadata: screen exactly those
      // bytes, rather than applying today's encoding to yesterday's screenshot.
      const screeningBytes = upload.ready ? await readObject(upload.objectKey) : normalized.bytes;
      if (upload.ready && hash(screeningBytes) !== upload.storedDigest) throw new Error('Image screening content integrity failed.');
      const review = reviewFor(upload) ?? await moderatePublicImage(screeningBytes, now);
      upload = await db.runTransaction(async tx => {
        await authorizeProgressPublisher(tx, actor);
        const current = (await tx.get(uploads().doc(id))).data();
        if (!current || current.fingerprint !== fingerprint) throw new Error('Image screening reservation changed.');
        const saved = reviewFor(current);
        if (saved) return current;
        if (current.ready && current.storedDigest !== review.imageSha256)
          throw new Refusal('moderation_required', 'The image changed while it was being checked. Upload it again.');
        await assertNewProgressAction(tx, actor, { whilePaused: true });
        tx.update(uploads().doc(id), { moderation: review });
        return { ...current, moderation: review };
      });
      assertImageAllowed(upload.moderation!);
      if (upload.ready) return receipt(id, upload, true);
    }
    // Version encoding separately from request identity: an interrupted pre-compression
    // upload may already own its original immutable object. Publish only the winner's
    // complete key+metadata+digest in the final transaction; never overwrite that object.
    const objectKey = `${id}-${fingerprint}-webp-v1`;
    await storeObject(objectKey, normalized.bytes, normalized.media.mimeType);
    return db.runTransaction(async tx => {
      await authorizeProgressPublisher(tx, actor);
      const current = (await tx.get(uploads().doc(id))).data();
      if (!current || current.fingerprint !== fingerprint) throw new Error('Progress screenshot upload reservation changed.');
      if (current.ready) return receipt(id, current, true);
      await assertNewProgressAction(tx, actor, { whilePaused: true });
      if (before.isPublic && currentImageReview(current.moderation)?.decision !== 'allowed')
        throw new Refusal('moderation_required', 'This image hasn’t been checked yet. Upload it again before adding it to an update on a public project.');
      const ready: Upload = { ...current, objectKey, ready: true, media: normalized.media, storedDigest: hash(normalized.bytes) };
      tx.set(uploads().doc(id), ready);
      return receipt(id, ready, false);
    });
  });
}

// Read preparation is separate from writes so callers can complete every transaction read first.
export async function prepareProgressScreenshot(tx: Transaction, projectId: string, publisherKey: string, input: ScreenshotInput, updateId: string): Promise<{ screenshot: ProgressScreenshot; commit(): void }> {
  if (!safeId(input.uploadId) || !input.alt?.trim() || [...input.alt].length > PROGRESS_LIMITS.alt
    || (input.caption !== undefined && [...input.caption].length > PROGRESS_LIMITS.caption)
    || !['output_screenshot', 'concept_image'].includes(input.representation)) inputError('Use a ready screenshot upload, descriptive alternate text and a supported representation.');
  const ref = uploads().doc(input.uploadId), record = (await tx.get(ref)).data();
  if (!record || !record.ready || !record.media || !record.storedDigest || record.projectId !== projectId || record.publisherKey !== publisherKey
    || record.attachedUpdateId !== null && record.attachedUpdateId !== updateId) throw new Refusal('not_found', 'No screenshot of yours has this upload ID. Upload it again.');
  const project = (await tx.get(projects.doc(projectId))).data();
  if (!isPrivateProject(project) && (currentImageReview(record.moderation)?.decision !== 'allowed' || record.moderation?.imageSha256 !== record.storedDigest))
    throw new Refusal('moderation_required', 'This public-project image needs screening. Retry its original upload before publishing, or retain the draft until an image is accepted.');
  return {
    screenshot: { id: input.uploadId, contentPath: `/api/project-progress/public/${projectId}/media/${input.uploadId}`,
      ...record.media, alt: input.alt.trim(), caption: input.caption?.trim() || null, representation: input.representation, provenance: 'author_upload' },
    commit: () => tx.update(ref, { attachedUpdateId: updateId }),
  };
}

export async function readProgressScreenshot(projectId: string, actor: ProgressActor | null, uploadId: string): Promise<{ bytes: Buffer; mimeType: ProgressScreenshot['mimeType'] }> {
  if (!safeId(uploadId)) throw new Refusal('not_found', 'No published screenshot has this ID.');
  return inProject(projectId, async () => {
    const record = await db.runTransaction(async tx => {
      const access = await authorizeProgressRead(tx, actor);
      const upload = (await tx.get(uploads().doc(uploadId))).data();
      if (!upload?.ready || !upload.media || !upload.attachedUpdateId || upload.projectId !== projectId) throw new Refusal('not_found', 'This screenshot is not published.');
      if (currentImageReview(upload.moderation)?.decision === 'blocked') throw new Refusal('not_found', 'This image is unavailable.');
      const project = (await tx.get(projects.doc(projectId))).data();
      const update = (await tx.get(projectCollection<StoredUpdate>('updates').doc(upload.attachedUpdateId))).data();
      if (!update || update.projectId !== projectId || update.screenshot?.id !== uploadId) throw new Refusal('not_found', 'This screenshot is not attached to a published update.');
      const convertedAt = project?.privacy?.visibility === 'public' ? project.privacy.convertedAt : null;
      const retainedPrivate = convertedAt !== null && update.publicConversionAt !== convertedAt;
      if (access.audience === 'public' && retainedPrivate) throw new Refusal('not_found', 'This screenshot is available only to project members.');
      if (!isPrivateProject(project) && !retainedPrivate && (currentImageReview(upload.moderation)?.decision !== 'allowed' || upload.moderation?.imageSha256 !== upload.storedDigest))
        throw new Refusal('moderation_required', 'This image is waiting to be checked and can’t be shown yet. Whoever posted it can upload it again.');
      return upload;
    });
    const bytes = await readObject(record.objectKey);
    if (hash(bytes) !== record.storedDigest) throw new Error('Progress screenshot content integrity failed.');
    return { bytes, mimeType: record.media!.mimeType };
  });
}
// No deletion job yet: pending/ready unattached objects remain private. Retain them until
// cleanup has a durable attachment/deletion fence; a timer must never race publication.
