// Private project chat attachments. Storage is never exposed through a public object URL.
import { createHash } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import type { Transaction } from '../firestore.js';
import { mediaStore, type BlobStore } from '../blob-store.js';
import sharp from 'sharp';
import { db, inProject, projectCollection } from '../firestore.js';
import { personFromIdToken } from '../auth.js';
import { bearerToken } from '../bearer.js';
import { Refusal, sendRefusal } from '../errors.js';
import { requestLimits } from '../request-state.js';
import { assertProjectWritable, assertMembership, membershipDoc, validProjectId } from './access.js';
import { communitySettingsDoc } from './community-schema.js';

export type ChatAttachment = { id: string; name: string; contentType: string; size: number };
type Upload = ChatAttachment & { projectId: string; ownerProfileId: string; fingerprint: string; digest: string;
  objectKey: string; ready: boolean; messageId: string | null; createdAt: number };
const LIMIT = 5 * 1024 * 1024;
const allowed = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain'];
const safeId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
const uploads = () => projectCollection<Upload>('chatUploads');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const metadata = ({ id, name, contentType, size }: ChatAttachment): ChatAttachment => ({ id, name, contentType, size });
const bad = (message: string): never => { throw new Refusal('bad_input', message); };
const media = (): BlobStore => mediaStore('chat-media');
const readObject = (key: string) => media().read(key);
async function storeObject(key: string, bytes: Buffer, contentType: string) {
  await media().createOnce(key, bytes, contentType);
  if (hash(await readObject(key)) !== hash(bytes)) throw new Error('Chat attachment storage integrity failed.');
}
async function checkedBytes(bytes: Buffer, mime: string): Promise<Buffer> {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > LIMIT || !allowed.includes(mime))
    bad('Choose a PNG, JPEG, WebP, PDF or plain-text file up to 5 MiB.');
  if (mime.startsWith('image/')) {
    try {
      const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 16_000_000, animated: true });
      const data = await image.metadata();
      const expected = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }[mime];
      if (data.format !== expected || (data.pages ?? 1) !== 1 || !data.width || !data.height || data.width > 4096 || data.height > 4096)
        bad('Use a valid still image up to 4096 pixels per side.');
      const normalized = await image.rotate().toFormat(expected as 'png' | 'jpeg' | 'webp').toBuffer();
      if (normalized.length > LIMIT) bad('The decoded image is too large.');
      return normalized;
    } catch (error) { if (error instanceof Refusal) throw error; bad('This image could not be decoded.'); }
  }
  if (mime === 'application/pdf') {
    // Download-only; signatures reject a mislabeled HTML/executable, not a claim of malware scanning.
    if (!/^%PDF-[12]\.[0-9]/.test(bytes.subarray(0, 8).toString('ascii')) || !bytes.subarray(-2048).includes(Buffer.from('%%EOF')))
      bad('Choose a PDF file with a valid PDF header and ending.');
    return bytes;
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { bad('Plain-text files must use UTF-8.'); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text!)) bad('Choose a plain-text file without binary control characters.');
  if (/^\s*(?:<!doctype\s+html|<html\b|<svg\b|#!)/i.test(text!)) bad('HTML, SVG and executable scripts are not supported chat attachments.');
  return bytes;
}
async function canUpload(tx: Transaction, projectId: string, personId: string, now: number) {
  const role = await assertMembership(tx, personId);
  await assertProjectWritable(tx, projectId);
  const [settings, member] = await Promise.all([tx.get(communitySettingsDoc(projectId)),
    role === 'owner' ? Promise.resolve(null) : tx.get(membershipDoc(projectId, personId))]);
  if (settings.data()?.chatSend !== 'members' || (member?.data()?.restrictions.chatMutedUntil ?? 0) > now)
    throw new Refusal('forbidden', 'You can’t send attachments in this chat right now.');
}
export async function uploadChatAttachment(projectId: string, personId: string, requestId: string,
  name: string, mime: string, bytes: Buffer, now: () => number) {
  if (!validProjectId(projectId) || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) bad('Use a project and a stable upload request ID.');
  if (!name || name.length > 160 || /[\x00-\x1f\x7f/\\]/.test(name)) bad('Choose a filename of up to 160 characters without path separators.');
  if (/\.(?:html?|svg|exe|com|bat|cmd|sh|bash|zsh|ps1|js|mjs|cjs|app|dmg|pkg|msi|jar)$/i.test(name))
    bad('HTML, SVG and executable files are not supported chat attachments.');
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > LIMIT || !allowed.includes(mime)) bad('Choose a supported file up to 5 MiB.');
  const id = hash(JSON.stringify([projectId, personId, requestId]));
  const fingerprint = hash(Buffer.concat([Buffer.from(`${name}\0${mime}\0`), bytes]));
  return inProject(projectId, async () => {
    const previous = await db.runTransaction(async tx => {
      await canUpload(tx, projectId, personId, now());
      const old = (await tx.get(uploads().doc(id))).data();
      if (old && old.fingerprint !== fingerprint) throw new Refusal('intent_conflict', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      return old;
    });
    if (previous?.ready) return metadata(previous);
    const normalized = await checkedBytes(bytes, mime);
    const record: Upload = { id, name, contentType: mime, size: normalized.length, projectId, ownerProfileId: personId,
      fingerprint, digest: hash(normalized), objectKey: `${projectId}/${id}-${fingerprint}`, ready: true, messageId: null, createdAt: now() };
    // Local objects use a project subdirectory, created by the store; no user-derived path component is used.
    await storeObject(record.objectKey, normalized, mime);
    return db.runTransaction(async tx => {
      await canUpload(tx, projectId, personId, now());
      const old = (await tx.get(uploads().doc(id))).data();
      if (old && old.fingerprint !== fingerprint) throw new Refusal('intent_conflict', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      if (!old) tx.create(uploads().doc(id), record);
      return metadata(old ?? record);
    });
  });
}
export async function validateChatAttachments(tx: Transaction, projectId: string, personId: string,
  ids: string[], messageId?: string): Promise<ChatAttachment[]> {
  if (ids.length > 3 || new Set(ids).size !== ids.length || ids.some(id => !safeId(id))) bad('Attach up to three different ready files.');
  if (!ids.length) return [];
  if (!validProjectId(projectId)) bad('Choose a project.');
  const rows = await tx.getAll(...ids.map(id => db.doc(`projects/${projectId}/chatUploads/${id}`)));
  return rows.map(row => {
    const data = row.data() as Upload | undefined;
    if (!data?.ready || data.projectId !== projectId || data.ownerProfileId !== personId || data.messageId !== null && data.messageId !== messageId)
      throw new Refusal('not_found', 'An attachment is unavailable. Upload your own file again.');
    return metadata(data);
  });
}
export function commitChatAttachments(tx: Transaction, projectId: string, ids: string[], messageId: string) {
  for (const id of ids) tx.update(db.doc(`projects/${projectId}/chatUploads/${id}`), { messageId });
}
export async function readChatAttachment(projectId: string, personId: string, id: string) {
  if (!validProjectId(projectId) || !safeId(id)) throw new Refusal('not_found', 'This attachment wasn’t found.');
  const record = await inProject(projectId, () => db.runTransaction(async tx => {
    await assertMembership(tx, personId);
    const upload = (await tx.get(uploads().doc(id))).data();
    if (!upload?.ready || upload.projectId !== projectId) throw new Refusal('not_found', 'This attachment is unavailable.');
    if (upload.messageId) {
      const message = await tx.get(db.doc(`projects/${projectId}/humanChat/${upload.messageId}`));
      if (!message.exists || !message.get('attachments')?.some((a: ChatAttachment) => a.id === id))
        throw new Refusal('not_found', 'This attachment is not part of a message.');
    } else if (upload.ownerProfileId !== personId) throw new Refusal('not_found', 'This attachment is not part of a message.');
    return upload;
  }));
  const bytes = await readObject(record.objectKey);
  if (hash(bytes) !== record.digest) throw new Error('Chat attachment integrity failed.');
  return { ...metadata(record), bytes };
}
export function chatMediaRoutes(now: () => number) {
  const router = express.Router();
  const limit = requestLimits.limiter(() => 'chat-attachment-uploads', 12, 60_000);
  async function person(req: Request) {
    const token = bearerToken(req.headers.authorization);
    if (!token) throw new Refusal('unauthorized', 'Sign in to use chat attachments.');
    return personFromIdToken(token);
  }
  const fail = (res: Response, error: unknown) => {
    if (error instanceof Refusal) sendRefusal(res, error);
    else { console.error('Chat attachment request failed', error); res.status(500).json({ error: 'internal_error', message: 'Something went wrong loading this attachment. Try again in a moment.' }); }
  };
  router.post('/:id/attachments', async (req, res, next) => {
    try {
      if (!validProjectId(req.params.id)) throw new Refusal('not_found', 'This project is unavailable.');
      const operator = await person(req), retry = limit(operator.id, now());
      if (retry) throw new Refusal('rate_limited', 'Wait a moment before uploading another attachment.', Math.ceil(retry / 1000));
      res.locals.personId = operator.id; next();
    } catch (error) { fail(res, error); }
  }, express.raw({ type: () => true, limit: LIMIT }), (req, res) => {
    let name: string;
    try { name = decodeURIComponent(req.get('X-File-Name') ?? ''); } catch { fail(res, new Refusal('bad_input', 'Choose a valid filename.')); return; }
    void uploadChatAttachment(String(req.params.id), res.locals.personId, req.get('X-Upload-Request-Id') ?? '', name,
      req.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ?? '', req.body, now)
      .then(attachment => res.json({ attachment }), error => fail(res, error));
  });
  router.get('/:id/attachments/:attachmentId', (req, res) => {
    const projectId = String(req.params.id), attachmentId = String(req.params.attachmentId);
    if (!validProjectId(projectId) || !safeId(attachmentId)) { fail(res, new Refusal('not_found', 'This attachment wasn’t found.')); return; }
    // Downloads are reads by the one local owner, so they have no budget.
    void person(req).then(operator => readChatAttachment(projectId, operator.id, attachmentId))
      .then(result => res.set({ 'Content-Type': result.contentType, 'Content-Length': String(result.size),
        'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(result.name)}`,
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "sandbox; default-src 'none'" }).send(result.bytes), error => fail(res, error));
  });
  router.use((error: { type?: string }, _req: Request, res: Response, next: express.NextFunction) => {
    if (error.type === 'entity.too.large') { res.status(413).json({ error: 'bad_input', message: 'Choose a file up to 5 MiB.' }); return; }
    next(error);
  });
  return router;
}
