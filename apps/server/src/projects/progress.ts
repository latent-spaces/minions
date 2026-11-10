import { z } from 'zod';
import { FieldPath } from '../firestore.js';
import type { PublishUpdateInput, PublishUpdateReceipt, PublishedUpdate, ProgressPage, ProgressSource } from '@mlswarm/contracts';
import { PROGRESS_LIMITS as L } from '@mlswarm/contracts';
import { collection, db, inProject, profiles, type Profile } from '../firestore.js';
import { hashToken } from '../auth.js';
import { Refusal } from '../errors.js';
import { authorizeProgressPublisher, authorizeProgressRead, assertNewProgressAction, progressPublisherKey, type ProgressActor } from './progress-authority.js';
import { prepareProgressScreenshot } from './progress-media.js';
import { effectiveProjectUpdateSettings } from './progress-settings.js';
import { publicProfilePhoto } from '../community/profile-photo-ref.js';
import { projects } from './records.js';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
// Limits count Unicode characters, so they live in a refinement; say them in the schema and the refusal.
const text = (max: number) => z.string().describe(`At most ${max} Unicode characters.`)
  .refine(value => [...value].length <= max, `Use at most ${max} Unicode characters.`);
const nonempty = (max: number) => text(max).refine(value => value.trim().length > 0, 'Write some text.');
const webUrl = z.string().max(L.url).refine(value => {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password; }
  catch { return false; }
});
const screenshotInput = z.object({ uploadId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), alt: nonempty(L.alt),
  caption: text(L.caption).optional(), representation: z.enum(['output_screenshot', 'concept_image']) }).strict();
export const PUBLISH_PROGRESS_INPUT = z.object({
  clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), title: text(L.title).optional(), body: nonempty(L.body),
  links: z.array(z.object({ url: webUrl, label: nonempty(L.label), purpose: z.enum(['evidence', 'result']) }).strict()).max(L.links),
  screenshot: screenshotInput,
}).strict().refine(value => bytes(value) <= L.inputBytes);
export const PROGRESS_QUERY = z.object({ source: z.enum(['authored_updates', 'result_history']).optional(), authors: z.enum(['all', 'mine']).optional(), cursor: z.string().max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict();
export type StoredUpdate = PublishedUpdate & { hasResult: boolean; publicConversionAt?: number };
type Operation = { fingerprint: string; update: PublishedUpdate };
const progressUpdates = (projectId: string) => collection<StoredUpdate>(`projects/${projectId}/updates`);
const operations = (projectId: string) => collection<Operation>(`projects/${projectId}/progressOperations`);

const WRITING = {
  brief: 'Write for a person who has not read the agent conversations. Use one or two short, plain-language sentences with familiar words. Lead with the useful result, concern or help needed and why it matters to the project. Explain what people can try and include the next step or human decision when relevant. Use a clear title; avoid jargon, internal tool names and detailed test procedures. Link supporting details, keep caveats that affect trust or use, and do not force a template or repeat teammates. The server enforces a maximum of 300 Unicode characters in the update body.',
  detailed: 'Use at most 4000 Unicode characters in the update body; an image is required. Write for a person who has not read the agent conversations. Let the attached visual carry the main point. Start the caption with the useful change and why it matters, then add relevant explanation in short, plain-language paragraphs. Keep important caveats (local, unverified, deployed) and link technical evidence. Add a next step or question only when useful. Skip unchanged filler.',
} as const;

export const UPDATE_EVERY_MINUTES = 5;
// The project's update settings and the shared reminder: the team aims for one update about every
// five minutes of work, from any agent (owner, 10 November 2026). due is guidance, never enforced.
export async function readProjectUpdateContext(projectId: string, active: boolean, now: number) {
  const [settings, latest] = await Promise.all([
    inProject(projectId, () => effectiveProjectUpdateSettings()),
    progressUpdates(projectId).orderBy('publishedAt', 'desc').select('publishedAt').limit(1).get(),
  ]);
  const lastPublishedAt = (latest.docs[0]?.get('publishedAt') as number | undefined) ?? null;
  const due = active && (lastPublishedAt === null || now - lastPublishedAt >= UPDATE_EVERY_MINUTES * 60_000);
  return { ...settings, writingGuidance: WRITING[settings.writingStyle], guide: 'get_mlswarm_guide updates-and-help',
    everyMinutes: UPDATE_EVERY_MINUTES, lastPublishedAt, due };
}

export async function publishProgressUpdate(projectId: string, actor: ProgressActor, body: unknown, now: () => number): Promise<PublishUpdateReceipt> {
  const parsed = PUBLISH_PROGRESS_INPUT.safeParse(body);
  if (!parsed.success) throw new Refusal('bad_input', 'Every new update requires an image in screenshot with uploadId, alt and representation; use bounded text and web links without author or authority fields.');
  const input: PublishUpdateInput = parsed.data;
  // The receipt fingerprints exact input, including omitted versus supplied fields.
  const fingerprint = hashToken(JSON.stringify(input));
  const publisher = progressPublisherKey(actor);
  const operationId = hashToken(`${publisher}:progress:${input.clientRequestId}`);
  return inProject(projectId, () => db.runTransaction(async tx => {
    const author = await authorizeProgressPublisher(tx, actor);
    const currentProfile=(await tx.get(profiles.doc(author.profile.id))).data();
    const receiptRef = operations(projectId).doc(operationId);
    const receipt = (await tx.get(receiptRef)).data();
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new Refusal('intent_conflict', 'This request ID was already used with different details. Send the original request again, or use a new request ID.');
      return { update: publicUpdate({...receipt.update,hasResult:false},projectId,currentProfile), replayed: true };
    }
    await assertNewProgressAction(tx, actor);
    const settings = await effectiveProjectUpdateSettings(tx);
    if (settings.writingStyle === 'brief' && [...input.body].length > L.briefBody)
      throw new Refusal('bad_input', `Brief project updates allow at most ${L.briefBody} characters in the body. Shorten the update and link to details.`);
    const prepared = await prepareProgressScreenshot(tx, projectId, publisher, input.screenshot, operationId);
    const update: PublishedUpdate = { kind: 'authored_update', id: operationId, projectId, author,
      title: input.title?.trim() || null, body: input.body, links: input.links.map(link => ({ ...link, availability: 'unknown' })),
      screenshot: prepared.screenshot, publishedAt: now() };
    if (bytes(author) > 4 * 1024 || [author.profile.id, author.agent?.id].some(id => id && id.length > 200)
      || bytes(update) > L.itemBytes || !Number.isSafeInteger(update.publishedAt) || update.publishedAt < 0) {
      throw new Refusal('bad_input', 'This update is too long. Shorten it, then try again.');
    }
    const publication = (await tx.get(projects.doc(projectId))).data()?.privacy;
    const response=publicUpdate({...update,hasResult:false},projectId,currentProfile);
    prepared.commit();
    tx.create(progressUpdates(projectId).doc(operationId), { ...update, hasResult: !!update.screenshot || update.links.some(link => link.purpose === 'result'),
      ...(publication?.visibility === 'public' ? { publicConversionAt: publication.convertedAt } : {}) });
    tx.create(receiptRef, { fingerprint, update });
    return { update:response, replayed: false };
  }));
}

const cursorSchema = z.object({ v: z.literal(1), projectId: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.enum(['authored_updates', 'result_history']), owner: z.string().optional(), audience: z.enum(['public', 'member']),
  at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), id: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type Cursor = z.infer<typeof cursorSchema>;
const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');
function decodeCursor(value: string): Cursor {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Refusal('bad_input', 'Use the cursor returned with the last page of project updates.');
  try { return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))); }
  catch { throw new Refusal('bad_input', 'Use the cursor returned with the last page of project updates.'); }
}

// Shape stored data explicitly: internal query flags and receipts never enter a page.
function publicUpdate(record: StoredUpdate, projectId: string, profile: Profile | undefined): PublishedUpdate {
  const { kind, id, author, title, body, links, screenshot, publishedAt } = record;
  const safe: PublishedUpdate = { kind, id, projectId,
    author: { profile: { id: author.profile.id, name: author.profile.name, photo: profile ? publicProfilePhoto(profile,author.profile.id) : null }, agent: author.agent ? { id: author.agent.id, name: author.agent.name } : null },
    title, body, links: links.map(link => ({ url: link.url, label: link.label, purpose: link.purpose, availability: 'unknown' })),
    screenshot: screenshot ? { id: screenshot.id, contentPath: screenshot.contentPath, mimeType: screenshot.mimeType,
      byteSize: screenshot.byteSize, width: screenshot.width, height: screenshot.height, alt: screenshot.alt,
      caption: screenshot.caption, representation: screenshot.representation, provenance: 'author_upload' } : null,
    publishedAt };
  if (record.projectId !== projectId || kind !== 'authored_update' || bytes(safe) > L.itemBytes) throw new Refusal('bad_input', 'Something went wrong saving this. Try again in a moment; if it keeps happening, tell the MyLittleSwarm team.');
  return safe;
}

export async function readProgressUpdates(projectId: string, actor: ProgressActor | null,
  input: { source?: ProgressSource; cursor?: string; authors?: 'all' | 'mine'; limit?: number }, now: () => number,
  measureItem: (item: PublishedUpdate) => unknown = item => item): Promise<ProgressPage> {
  const parsed = PROGRESS_QUERY.safeParse(input);
  if (!parsed.success) throw new Refusal('bad_input', 'Use a supported source and the cursor returned with it.');
  const source = parsed.data.source ?? 'authored_updates';
  if (parsed.data.authors === 'mine' && !actor) throw new Refusal('unauthorized', 'Sign in to see your updates.');
  const owner = parsed.data.authors === 'mine' && actor ? (actor.kind === 'person' ? actor.person.id : actor.agent.ownerProfileId) : undefined;
  const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null, size = parsed.data.limit ?? L.pageItems;
  return inProject(projectId, () => db.runTransaction(async tx => {
    const { audience, publicConversionAt } = await authorizeProgressRead(tx, actor);
    if (cursor && (cursor.projectId !== projectId || cursor.source !== source || cursor.audience !== audience || cursor.owner !== owner)) {
      throw new Refusal('bad_input', 'This cursor is from a different project or list. Use the one returned with this list.');
    }
    let query = progressUpdates(projectId).orderBy('publishedAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
    if (publicConversionAt !== null) query = query.where('publicConversionAt', '==', publicConversionAt);
    if (owner) query = query.where('author.profile.id', '==', owner);
    if (source === 'result_history') query = query.where('hasResult', '==', true);
    if (cursor) query = query.startAfter(cursor.at, cursor.id);
    const records = (await tx.get(query.limit(size + 1))).docs;
    const ids=[...new Set(records.slice(0,size).map(record=>record.data().author.profile.id))].filter(id=>/^[A-Za-z0-9_-]{1,200}$/.test(id));
    const people=ids.length?await tx.getAll(...ids.map(id=>profiles.doc(id))):[];
    const currentProfiles=new Map(people.map(person=>[person.id,person.data()]));
    const settings = await effectiveProjectUpdateSettings(tx);
    const page: ProgressPage = { source, audience, items: [], coverage: 'published_updates', next: null, observedAt: now(),
      bodyMaxLength: settings.writingStyle === 'brief' ? L.briefBody : L.body };
    for (let index = 0; index < Math.min(records.length, size); index++) {
      const record=records[index].data();
      const item = publicUpdate(record, projectId, currentProfiles.get(record.author.profile.id));
      const next = index + 1 < records.length ? encodeCursor({ v: 1, projectId, source, audience, ...(owner ? { owner } : {}), at: item.publishedAt, id: item.id }) : null;
      const candidate = { ...page, items: [...page.items, item], next };
      if (bytes(candidate) > L.pageBytes || bytes({ ...candidate, items: candidate.items.map(measureItem) }) > L.pageBytes) break;
      page.items.push(item); page.next = next;
    }
    if (records.length && !page.items.length) throw new Refusal('bad_input', 'Something went wrong saving this. Try again in a moment; if it keeps happening, tell the MyLittleSwarm team.');
    return page;
  }));
}
