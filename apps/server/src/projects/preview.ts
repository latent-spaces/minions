// The project's preview: a page an agent points at to show live work (a local game, site or app),
// shown in the Preview tab (owner, 10 November 2026, “Agent sets a link”). Saving it starts nothing and grants no powers.
import { z } from 'zod';
import { db, inProject, validatedCollection } from '../firestore.js';
import { Refusal } from '../errors.js';
import { projectSettingsPath } from './community-schema.js';
import { authorizeProgressPublisher, assertNewProgressAction, type ProgressActor } from './progress-authority.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
// https anywhere, or http on this computer for a server the agent started.
export const isPreviewUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  } catch { return false; }
};
// A link to a server on an agent's computer. Those servers end when the project is closed.
export const isLocalPreview = (value: string | null | undefined) => {
  try { return !!value && new URL(value).protocol === 'http:' && LOOPBACK.has(new URL(value).hostname); } catch { return false; }
};
const PREVIEW_URL = z.string().max(500).refine(isPreviewUrl, 'Use an https:// link, or http://localhost:PORT for a server on this computer.');
const PREVIEW = z.object({ schemaVersion: z.literal(1), url: PREVIEW_URL.nullable(), updatedBy: z.string().min(1).max(200), updatedAt: z.number().int().nonnegative() }).strict();
export const PREVIEW_INPUT = { url: z.union([PREVIEW_URL, z.literal('')]).describe('The page to show in Preview: http://localhost:PORT/… for a server you started on this computer, or an https:// link. An empty string removes it.') };
export type Preview = z.infer<typeof PREVIEW>;

export const previewDoc = (id: string) => validatedCollection(`${projectSettingsPath(id)}`, value => {
  const parsed = PREVIEW.safeParse(value);
  if (!parsed.success) throw new Refusal('bad_input', 'The project preview has an invalid shape.');
  return parsed.data;
}).doc('preview');

export const previewView = (record: Preview | undefined) => record?.url ?? null;

// The newest save wins; saving the same link again changes nothing.
export async function setProjectPreview(id: string, actor: ProgressActor, input: { url: string }, now: () => number) {
  const parsed = PREVIEW_INPUT.url.safeParse(input.url);
  if (!parsed.success) throw new Refusal('bad_input', 'Use an https:// link, or http://localhost:PORT for a server on this computer. An empty string removes the preview.');
  const url = parsed.data || null;
  return inProject(id, () => db.runTransaction(async tx => {
    const author = await authorizeProgressPublisher(tx, actor);
    await assertNewProgressAction(tx, actor, { whilePaused: true });
    if (((await tx.get(previewDoc(id))).data()?.url ?? null) === url) return { previewUrl: url };
    tx.set(previewDoc(id), PREVIEW.parse({ schemaVersion: 1, url, updatedBy: author.agent?.id ?? author.profile.id, updatedAt: now() }));
    return { previewUrl: url };
  }));
}
