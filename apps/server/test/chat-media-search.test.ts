import { indexConversations } from '../scripts/index-conversations.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import sharp from 'sharp';
import { db, inProject, profiles, agents, projectDoc } from '../src/firestore.js';
import { chatMediaRoutes, uploadChatAttachment, readChatAttachment, validateChatAttachments, commitChatAttachments } from '../src/projects/chat-media.js';
import { humanChatRoutes } from '../src/projects/chat.js';
import { membershipDoc } from '../src/projects/access.js';
import { viewRoutes } from '../src/view/routes.js';
import { publicProjectRoutes } from '../src/projects/public.js';
import { publishCatalog } from '../src/projects/catalog.js';
import { searchConversationMessages } from '../src/projects/chat-search.js';
import { encodeCursor } from '../src/cursor.js';
import { createHash } from 'node:crypto';
import { messagesV2 } from '../src/v2/records.js';
import { idTokenFor, resetEmulator, scoped, seed, TEST_PROJECT } from './helpers.js';

let server: Server, base: string, media: string;
const oldMediaDir = process.env.MLSWARM_BLOB_DIR;
beforeAll(async () => {
  media = await mkdtemp(join(tmpdir(), 'mlswarm-chat-media-test-'));
  process.env.MLSWARM_BLOB_DIR = media;
  const app = express(); app.use('/chat', chatMediaRoutes(() => 10000)); app.use('/chat', humanChatRoutes(() => 10000)); app.use('/view', scoped(viewRoutes(() => 10000)));
  app.use('/public/:id', publicProjectRoutes(() => 10000));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  if (oldMediaDir === undefined) delete process.env.MLSWARM_BLOB_DIR; else process.env.MLSWARM_BLOB_DIR = oldMediaDir;
  await rm(media, { recursive: true, force: true });
});
beforeEach(resetEmulator);
async function fixture() {
  const f = await seed({ profiles: [{ name: 'Reader', email: 'reader@example.test' }, { name: 'Other', email: 'other@example.test' }] });
  return { ids: f.personIds, token: await idTokenFor('reader@example.test') };
}
test('attachments require membership, exact upload replay and atomic publication before another member can download', async () => {
  const { ids: [reader, other], token } = await fixture();
  const bytes = Buffer.from('Synthetic research notes.\n'), request = randomUUID();
  const attachment = await uploadChatAttachment(TEST_PROJECT, reader, request, 'notes.txt', 'text/plain', bytes, () => 10000);
  expect(await uploadChatAttachment(TEST_PROJECT, reader, request, 'notes.txt', 'text/plain', bytes, () => 10000)).toEqual(attachment);
  await expect(uploadChatAttachment(TEST_PROJECT, reader, request, 'other.txt', 'text/plain', bytes, () => 10000)).rejects.toThrow('original');
  expect((await readChatAttachment(TEST_PROJECT, reader, attachment.id)).bytes).toEqual(bytes);
  await expect(readChatAttachment(TEST_PROJECT, other, attachment.id)).rejects.toThrow('not part');
  const messageId = 'a'.repeat(64);
  await inProject(TEST_PROJECT, () => db.runTransaction(async tx => {
    const attachments = await validateChatAttachments(tx, TEST_PROJECT, reader, [attachment.id], messageId);
    commitChatAttachments(tx, TEST_PROJECT, [attachment.id], messageId);
    tx.create(db.doc(`projects/${TEST_PROJECT}/humanChat/${messageId}`), { sender: { id: reader, name: 'Reader' }, body: '', createdAt: 10000, attachments });
  }));
  expect((await readChatAttachment(TEST_PROJECT, other, attachment.id)).bytes).toEqual(bytes);
  await expect(db.runTransaction(tx => validateChatAttachments(tx, TEST_PROJECT, other, [attachment.id], 'b'.repeat(64)))).rejects.toThrow();
  const download = await fetch(`${base}/chat/${TEST_PROJECT}/attachments/${attachment.id}`, { headers: { authorization: `Bearer ${token}` } });
  expect(download.status).toBe(200); expect(download.headers.get('content-disposition')).toBe(`attachment; filename="download"; filename*=UTF-8''notes.txt`);
  expect(download.headers.get('content-type')).toContain('text/plain');
  expect(download.headers.get('x-content-type-options')).toBe('nosniff'); expect(download.headers.get('cache-control')).toContain('no-store');
  expect((await fetch(`${base}/chat/${TEST_PROJECT}/attachments/${attachment.id}`)).status).toBe(401);
  await membershipDoc(TEST_PROJECT, other).update({ status: 'removed' });
  await expect(readChatAttachment(TEST_PROJECT, other, attachment.id)).rejects.toThrow();
});

test('uploads reject executable/mismatched content and normalize bounded images; HTTP uses a private binary body', async () => {
  const { ids: [reader], token } = await fixture();
  for (const [name, mime, bytes] of [
    ['page.html', 'text/plain', Buffer.from('<html>bad</html>')],
    ['notes.txt', 'text/plain', Buffer.from('<svg onload="alert(1)"/>')],
    ['notes.txt', 'text/plain', Buffer.from([0, 1, 2])],
    ['document.pdf', 'application/pdf', Buffer.from('<html>not a PDF</html>')],
    ['image.png', 'image/png', Buffer.from('not an image')],
    ['large.txt', 'text/plain', Buffer.alloc(5 * 1024 * 1024 + 1, 65)],
  ] as const) await expect(uploadChatAttachment(TEST_PROJECT, reader, randomUUID(), name, mime, bytes, () => 10000)).rejects.toThrow();
  const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#567890' } }).png().toBuffer();
  const response = await fetch(`${base}/chat/${TEST_PROJECT}/attachments`, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'image/png', 'x-file-name': 'concept.png', 'x-upload-request-id': randomUUID(),
  }, body: new Uint8Array(png) });
  expect(response.status).toBe(200); const result = await response.json();
  expect(result.attachment).toMatchObject({ name: 'concept.png', contentType: 'image/png' });
  expect((await readChatAttachment(TEST_PROJECT, reader, result.attachment.id)).bytes).toBeInstanceOf(Buffer);
  const intent = { client_request_id: randomUUID(), body: '', attachmentIds: [result.attachment.id] };
  const send = () => fetch(`${base}/chat/${TEST_PROJECT}`, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }, body: JSON.stringify(intent) });
  const posted = await send(); expect(posted.status).toBe(200);
  expect((await posted.json()).message.attachments).toEqual([result.attachment]);
  expect((await (await send()).json()).replayed).toBe(true);
});

test('agent message links preserve public root visibility, member attribution and publication revocation', async () => {
  const { ids: [reader], token } = await fixture();
  const person = { id: reader, ...(await profiles.doc(reader).get()).data()! };
  await inProject(TEST_PROJECT, async () => {
    await projectDoc().update({ ownerProfileId: reader });
    const batch = db.batch();
    batch.set(agents().doc('writer'), { ownerProfileId: reader, name: 'Writer', tokenHash: 'disabled', tokenIssuedAt: null, createdAt: 0, revokedAt: 0, connectionEpoch: 0 });
    for (const [id, threadId, audience, to] of [
      ['public_root', 'public_root', 'project', ['project']],
      ['private_root', 'private_root', 'direct', ['recipient']],
      ['private_reply', 'public_root', 'direct', ['recipient']],
      ['public_reply_private_root', 'private_root', 'project', ['project']],
    ] as const) batch.set(messagesV2().doc(id), { id, threadId, audience, to: [...to], agentId: 'writer', agentName: 'Writer',
      body: `Synthetic ${id}`, createdAt: 1, protocol: 2 });
    await batch.commit(); await indexConversations(TEST_PROJECT);
  });
  await publishCatalog(person, TEST_PROJECT, { client_request_id: 'publish-link-test', expected_revision: 0, listed: true, summary: 'Message links', category: 'games', tags: [] }, () => 10000);
  const publicRead = (id: string) => fetch(`${base}/public/${TEST_PROJECT}/messages/${id}`);
  const published = await publicRead('public_root'); expect(published.status).toBe(200);
  const publicRow = (await published.json()).message;
  expect(publicRow.sender).toEqual({ id: 'writer', name: 'Writer' });
  expect(JSON.stringify(publicRow)).not.toContain('reader@example.test');
  for (const id of ['private_root', 'private_reply', 'public_reply_private_root']) expect((await publicRead(id)).status).toBe(404);
  const member = await fetch(`${base}/view/messages/private_reply`, { headers: { authorization: `Bearer ${token}` } });
  expect(member.status).toBe(200); expect((await member.json()).message.sender).toMatchObject({ operatorId: reader, operatorName: 'Reader' });
  expect((await fetch(`${base}/view/messages/public_root`)).status).toBe(401);
  await inProject(TEST_PROJECT, () => projectDoc().update({ 'publication.listed': false }));
  expect((await publicRead('public_root')).status).toBe(404);
});

test('conversation search trims before its length check and rejects malformed continuation cursors', async () => {
  await fixture();
  await inProject(TEST_PROJECT, async () => {
    const padded = `  ${'x'.repeat(100)}  `;
    expect((await searchConversationMessages({ q: padded, cursor: undefined })).messages).toEqual([]);
    await expect(searchConversationMessages({ q: 'x'.repeat(101), cursor: undefined })).rejects.toThrow('1–100');
    const scope = createHash('sha256').update(JSON.stringify(['conversations', TEST_PROJECT, null, 'notes', null])).digest('hex');
    expect((await searchConversationMessages({ q: 'notes', cursor: encodeCursor([scope, 5, 'message_id']) })).messages).toEqual([]);
    for (const cursor of [encodeCursor([scope, -1, 'message_id']), encodeCursor([scope, 5, 'message_id', 'x'.repeat(500)]), 7])
      await expect(searchConversationMessages({ q: 'notes', cursor })).rejects.toThrow('search cursor');
  });
});
