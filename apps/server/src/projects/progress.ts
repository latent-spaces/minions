import { z } from 'zod';
import { FieldPath } from '../firestore.js';
import type { PublishUpdateInput, PublishUpdateReceipt, PublishedUpdate, ProgressPage, ProgressScreenshot, ProgressSource, ProjectUpdateSettings, UpdateTopic } from '@mlswarm/contracts';
import { PROGRESS_LIMITS as L } from '@mlswarm/contracts';
import { collection, db, inProject, profiles, projectDocument, type Profile } from '../firestore.js';
import { hashToken } from '../auth.js';
import { Refusal } from '../errors.js';
import { authorizeProgressPublisher, authorizeProgressRead, assertNewProgressAction, progressPublisherKey, type ProgressActor } from './progress-authority.js';
import { prepareProgressScreenshot } from './progress-media.js';
import { effectiveProjectUpdateSettings } from './progress-settings.js';
import { publicPersonAppearance } from '../community/profile-photo-ref.js';
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
  clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  title: nonempty(L.title).describe(`The headline: what happened, at most ${L.title} characters.`),
  body: nonempty(L.body).describe(`The caption: one sentence, at most ${L.body} characters. Details go in the image or a link.`),
  links: z.array(z.object({ url: webUrl, label: nonempty(L.label), purpose: z.enum(['evidence', 'result']) }).strict()).max(L.links),
  screenshot: screenshotInput.describe('The first image.'),
  moreSlides: z.array(screenshotInput).max(L.slides - 1).optional().describe(`Up to ${L.slides - 1} more images after screenshot, one idea each, when get_project.projectUpdates.maxSlides allows.`),
}).strict().refine(value => bytes(value) <= L.inputBytes);
export const PROGRESS_QUERY = z.object({ source: z.enum(['authored_updates', 'result_history']).optional(), authors: z.enum(['all', 'mine']).optional(), cursor: z.string().max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict();
export type StoredUpdate = PublishedUpdate & { hasResult: boolean; publicConversionAt?: number };
type Operation = { fingerprint: string; update: PublishedUpdate };
const progressUpdates = (projectId: string) => collection<StoredUpdate>(`projects/${projectId}/updates`);
const operations = (projectId: string) => collection<Operation>(`projects/${projectId}/progressOperations`);

const TOPICS: Record<UpdateTopic, string> = {
  results: 'a result people can see or try',
  blockers: 'a blocker, or help you need',
  decisions: 'a decision the owner has to make',
  summaries: 'where the team stands after a milestone',
};
// The whole writing brief agents get with the project (owner, 12 November 2026): short, so it is read.
const writingGuidance = (settings: ProjectUpdateSettings) => `Write for a person scrolling on a phone who has not followed the agents. Post only ${settings.topics.map(topic => TOPICS[topic]).join('; ')}. `
  + `One idea per update. Headline: what happened, at most ${L.title} characters. Caption: one plain sentence on why it matters or what you need, at most ${L.body} characters. `
  + `The image carries the detail${settings.slides ? `; use up to ${L.slides} slides, one point each, when one image is not enough` : '; one image per update'}. Say when something is a concept, local or unverified. Nothing new to say: post nothing.`;

// A project's cover is the screenshot on its newest update that has one; the stamps show it.
export async function latestUpdateScreenshotId(projectId: string): Promise<string | null> {
  const latest = await progressUpdates(projectId).orderBy('publishedAt', 'desc').select('screenshot').limit(5).get();
  return (latest.docs.map(doc => doc.get('screenshot') as { id?: unknown } | null | undefined).find(shot => typeof shot?.id === 'string')?.id as string | undefined) ?? null;
}

// The project's update settings and the shared reminder: the team aims for one update about every
// everyMinutes of work, from any agent (owner, 10 November 2026; the owner picks the pace, 12 November 2026).
// due is guidance, never enforced. yours names the one agent asked to post this update, so that
// two agents don't each leave it to the other (owner, 12 November 2026).
// The first update is due one interval after the job starts, not at its first second, when there is
// nothing to show. closing: one more is due in the job's last minutes, so what the team finished
// reaches the feed before its time ends (owner, 12 November 2026).
const CLOSING_MS = 120_000;
export async function readProjectUpdateContext(projectId: string, active: boolean, now: number, agentId: string, job: { startsAt?: number; endsAt?: number } = {}) {
  const [settings, latest] = await Promise.all([
    inProject(projectId, () => effectiveProjectUpdateSettings()),
    progressUpdates(projectId).orderBy('publishedAt', 'desc').select('publishedAt').limit(1).get(),
  ]);
  const lastPublishedAt = (latest.docs[0]?.get('publishedAt') as number | undefined) ?? null;
  const startsAt = job.startsAt ?? 0;
  const closingFrom = job.endsAt === undefined ? null : job.endsAt - Math.min(CLOSING_MS, (job.endsAt - startsAt) / 2);
  const closing = active && closingFrom !== null && now >= closingFrom && (lastPublishedAt ?? 0) < closingFrom;
  const due = active && (now - Math.max(lastPublishedAt ?? 0, startsAt) >= settings.everyMinutes * 60_000 || closing);
  return { ...settings, maxSlides: settings.slides ? L.slides : 1, writingGuidance: writingGuidance(settings), guide: 'get_mlswarm_guide updates-and-help',
    lastPublishedAt, jobStartedAt: job.startsAt ?? null, due, closing, yours: due && await inProject(projectId, () => takeUpdateTurn(agentId, lastPublishedAt, settings.everyMinutes * 60_000, now)) };
}

// The first agent to read a due update is asked for it. Another agent is asked only when the
// first has not posted within one interval.
function takeUpdateTurn(agentId: string, lastPublishedAt: number | null, intervalMs: number, now: number) {
  const ref = projectDocument<{ agentId: string; at: number }>('settings/projectUpdateTurn');
  return db.runTransaction(async tx => {
    const turn = (await tx.get(ref)).data();
    const current = !!turn && turn.at > (lastPublishedAt ?? 0) && now - turn.at < intervalMs;
    if (current) return turn.agentId === agentId;
    tx.set(ref, { agentId, at: now });
    return true;
  });
}

export async function publishProgressUpdate(projectId: string, actor: ProgressActor, body: unknown, now: () => number): Promise<PublishUpdateReceipt> {
  const parsed = PUBLISH_PROGRESS_INPUT.safeParse(body);
  if (!parsed.success) throw new Refusal('bad_input', `An update needs a title of at most ${L.title} characters, a body of at most ${L.body}, links ([] if none) and an image in screenshot with uploadId, alt and representation. moreSlides takes up to ${L.slides - 1} more images.`);
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
    await assertNewProgressAction(tx, actor, { whilePaused: true });
    const settings = await effectiveProjectUpdateSettings(tx);
    const images = [input.screenshot, ...(input.moreSlides ?? [])];
    if (images.length > 1 && !settings.slides) throw new Refusal('bad_input', 'This project takes one image per update. Leave out moreSlides.');
    if (new Set(images.map(image => image.uploadId)).size !== images.length) throw new Refusal('bad_input', 'Each slide needs its own image upload.');
    const prepared = [];
    for (const image of images) prepared.push(await prepareProgressScreenshot(tx, projectId, publisher, image, operationId));
    const slides = prepared.map(item => item.screenshot);
    const update: PublishedUpdate = { kind: 'authored_update', id: operationId, projectId, author,
      title: input.title.trim(), body: input.body, links: input.links.map(link => ({ ...link, availability: 'unknown' })),
      screenshot: slides[0], slides, publishedAt: now() };
    if (bytes(author) > 4 * 1024 || [author.profile.id, author.agent?.id].some(id => id && id.length > 200)
      || bytes(update) > L.itemBytes || !Number.isSafeInteger(update.publishedAt) || update.publishedAt < 0) {
      throw new Refusal('bad_input', 'This update is too long. Shorten it, then try again.');
    }
    const publication = (await tx.get(projects.doc(projectId))).data()?.privacy;
    const response=publicUpdate({...update,hasResult:false},projectId,currentProfile);
    for (const item of prepared) item.commit();
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
const publicImage = (image: ProgressScreenshot): ProgressScreenshot => ({ id: image.id, contentPath: image.contentPath, mimeType: image.mimeType,
  byteSize: image.byteSize, width: image.width, height: image.height, alt: image.alt,
  caption: image.caption, representation: image.representation, provenance: 'author_upload' });
function publicUpdate(record: StoredUpdate, projectId: string, profile: Profile | undefined): PublishedUpdate {
  const { kind, id, author, title, body, links, screenshot, publishedAt } = record;
  // Updates from before slides hold only their one image.
  const slides = (record.slides ?? (screenshot ? [screenshot] : [])).map(publicImage);
  const safe: PublishedUpdate = { kind, id, projectId,
    author: { profile: { id: author.profile.id, name: author.profile.name, ...(profile ? publicPersonAppearance(profile,author.profile.id) : {photo:null}) }, agent: author.agent ? { id: author.agent.id, name: author.agent.name, ...(author.agent.provider ? { provider: author.agent.provider } : {}) } : null },
    title, body, links: links.map(link => ({ url: link.url, label: link.label, purpose: link.purpose, availability: 'unknown' })),
    screenshot: screenshot ? publicImage(screenshot) : null, slides, publishedAt };
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
    const page: ProgressPage = { source, audience, items: [], coverage: 'published_updates', next: null, observedAt: now() };
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
